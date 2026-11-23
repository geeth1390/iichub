-- ============================================================
-- PROTOHUB — 02_functions.sql
-- Every function in final form, each defined exactly once.
-- (The hardened, role-guarded versions of issue_quote / advance_job.)
-- ============================================================

-- ============================================================
-- MATCHING & SCHEDULING
-- ============================================================

-- Capability matcher: given a part, return machines that can make it.
-- Rotation-aware (sorts dimensions), guards non-positive input, ranks
-- by availability → distance → snugness of fit.
CREATE OR REPLACE FUNCTION match_machines(
    p_x_mm NUMERIC, p_y_mm NUMERIC, p_z_mm NUMERIC,
    p_material TEXT DEFAULT NULL, p_tolerance_mm NUMERIC DEFAULT NULL,
    p_min_feature_mm NUMERIC DEFAULT NULL,
    p_lat NUMERIC DEFAULT NULL, p_lng NUMERIC DEFAULT NULL,
    p_quantity INT DEFAULT 1
)
RETURNS TABLE (
    machine_id BIGINT, centre_name TEXT, district TEXT, machine TEXT,
    process_label TEXT, distance_km NUMERIC, status TEXT, rate_per_hour NUMERIC,
    material_ok BOOLEAN, in_stock_g NUMERIC, fit_score NUMERIC, reason TEXT
) AS $$
BEGIN
-- A part must have positive dimensions. Zero/negative is invalid input,
-- not "fits everything" — return no matches rather than nonsense.
IF p_x_mm IS NULL OR p_y_mm IS NULL OR p_z_mm IS NULL
   OR p_x_mm <= 0 OR p_y_mm <= 0 OR p_z_mm <= 0 THEN
    RETURN;
END IF;

RETURN QUERY
WITH oriented AS (
    -- sort part dims largest→smallest so rotation is handled
    SELECT GREATEST(p_x_mm,p_y_mm,p_z_mm) AS d1,
           (p_x_mm+p_y_mm+p_z_mm)-GREATEST(p_x_mm,p_y_mm,p_z_mm)-LEAST(p_x_mm,p_y_mm,p_z_mm) AS d2,
           LEAST(p_x_mm,p_y_mm,p_z_mm) AS d3
),
envelope AS (
    SELECT mc.machine_id,
           GREATEST(mc.max_x_mm,mc.max_y_mm,mc.max_z_mm) AS e1,
           (mc.max_x_mm+mc.max_y_mm+mc.max_z_mm)-GREATEST(mc.max_x_mm,mc.max_y_mm,mc.max_z_mm)-LEAST(mc.max_x_mm,mc.max_y_mm,mc.max_z_mm) AS e2,
           LEAST(mc.max_x_mm,mc.max_y_mm,mc.max_z_mm) AS e3,
           mc.tolerance_mm, mc.min_feature_mm
    FROM machine_capability mc
)
SELECT m.id, c.name, c.district, m.make||' '||m.model, pr.layman_label,
    CASE WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
      ROUND((6371*acos(LEAST(1, cos(radians(p_lat))*cos(radians(c.lat))
        *cos(radians(c.lng)-radians(p_lng)) + sin(radians(p_lat))*sin(radians(c.lat)))))::NUMERIC,1)
      ELSE NULL END AS distance_km,
    m.status, m.rate_per_hour,
    (mm.material_code IS NOT NULL) AS material_ok,
    COALESCE(mm.in_stock_g,0),
    ROUND(((o.d1/e.e1)*(o.d2/e.e2)*(o.d3/e.e3))::NUMERIC,3) AS fit_score,
    CONCAT_WS('; ',
      'fits '||ROUND(e.e1)||'×'||ROUND(e.e2)||'×'||ROUND(e.e3)||'mm',
      CASE WHEN e.tolerance_mm IS NOT NULL THEN 'holds ±'||e.tolerance_mm||'mm' END,
      CASE WHEN mm.in_stock_g>0 THEN ROUND(mm.in_stock_g)||'g in stock' END,
      CASE WHEN m.status<>'available' THEN 'currently '||m.status END) AS reason
FROM machine m
JOIN centre c   ON c.id=m.centre_id AND c.is_live
JOIN process pr ON pr.code=m.process_code
JOIN envelope e ON e.machine_id=m.id
CROSS JOIN oriented o
LEFT JOIN machine_material mm ON mm.machine_id=m.id AND (p_material IS NULL OR mm.material_code=p_material)
WHERE m.status<>'retired'
  AND o.d1<=e.e1 AND o.d2<=e.e2 AND o.d3<=e.e3
  AND (p_material IS NULL OR mm.material_code IS NOT NULL)
  AND (p_tolerance_mm IS NULL OR (e.tolerance_mm IS NOT NULL AND e.tolerance_mm<=p_tolerance_mm))
  AND (p_min_feature_mm IS NULL OR (e.min_feature_mm IS NOT NULL AND e.min_feature_mm<=p_min_feature_mm))
  AND (p_material IS NULL OR mm.in_stock_g IS NULL OR mm.in_stock_g>0)
ORDER BY (m.status='available') DESC, distance_km ASC NULLS LAST, fit_score DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- Free-slot finder: open hours minus existing bookings, never past close.
CREATE OR REPLACE FUNCTION free_slots(
    p_machine_id BIGINT, p_from DATE, p_days INT DEFAULT 7, p_slot_minutes INT DEFAULT 60
)
RETURNS TABLE (slot_start TIMESTAMPTZ, slot_end TIMESTAMPTZ) AS $$
BEGIN
RETURN QUERY
WITH cfg AS (
    SELECT c.opens_at, c.closes_at, c.working_days
    FROM machine m JOIN centre c ON c.id=m.centre_id WHERE m.id=p_machine_id
),
days AS (
    SELECT d::DATE AS day FROM generate_series(p_from, p_from+(p_days-1), '1 day') d
    CROSS JOIN cfg WHERE EXTRACT(ISODOW FROM d)::INT = ANY (cfg.working_days)
),
candidates AS (
    SELECT (d.day+cfg.opens_at)::TIMESTAMPTZ + (n*(p_slot_minutes||' minutes')::INTERVAL) AS s
    FROM days d CROSS JOIN cfg
    CROSS JOIN generate_series(0,(EXTRACT(EPOCH FROM (cfg.closes_at-cfg.opens_at))/60/p_slot_minutes)::INT-1) n
)
SELECT c.s, c.s+(p_slot_minutes||' minutes')::INTERVAL
FROM candidates c CROSS JOIN cfg
WHERE c.s>now()
  AND (c.s+(p_slot_minutes||' minutes')::INTERVAL)::TIME <= cfg.closes_at
  AND NOT EXISTS (SELECT 1 FROM booking b WHERE b.machine_id=p_machine_id
      AND b.status IN ('requested','confirmed')
      AND b.slot && tstzrange(c.s, c.s+(p_slot_minutes||' minutes')::INTERVAL))
ORDER BY c.s;
END;
$$ LANGUAGE plpgsql STABLE;

-- Standalone distance for a detail page that already knows the machine.
CREATE OR REPLACE FUNCTION machine_distance_km(p_machine BIGINT, p_lat NUMERIC, p_lng NUMERIC)
RETURNS NUMERIC AS $$
    SELECT ROUND((6371*acos(LEAST(1,
        cos(radians(p_lat))*cos(radians(c.lat))*cos(radians(c.lng)-radians(p_lng))
        + sin(radians(p_lat))*sin(radians(c.lat)))))::NUMERIC,1)
    FROM machine m JOIN centre c ON c.id=m.centre_id WHERE m.id=p_machine;
$$ LANGUAGE sql STABLE;

-- ============================================================
-- PERMISSIONS, AUDIT, NOTIFICATIONS (helpers)
-- ============================================================

-- Defence-in-depth: staff-only guard inside sensitive functions.
CREATE OR REPLACE FUNCTION assert_staff(p_actor BIGINT) RETURNS VOID AS $$
DECLARE v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM app_user WHERE id=p_actor;
    IF v_role IS NULL THEN RAISE EXCEPTION 'unknown actor %', p_actor; END IF;
    IF v_role NOT IN ('centre_staff','centre_manager','apis_admin') THEN
        RAISE EXCEPTION 'permission denied: role % cannot perform staff operations', v_role;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit(
    p_actor BIGINT, p_action TEXT, p_object_type TEXT, p_object_id BIGINT,
    p_detail JSONB DEFAULT NULL, p_ip INET DEFAULT NULL, p_ok BOOLEAN DEFAULT TRUE, p_error TEXT DEFAULT NULL
) RETURNS VOID AS $$
    INSERT INTO audit_log (actor_id, actor_role, action, object_type, object_id, detail, ip, ok, error)
    SELECT p_actor, (SELECT role FROM app_user WHERE id=p_actor),
           p_action, p_object_type, p_object_id, p_detail, p_ip, p_ok, p_error;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION enqueue_notification(
    p_user BIGINT, p_template TEXT, p_payload JSONB, p_job BIGINT DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE v_channel TEXT; v_id BIGINT;
BEGIN
    SELECT channel INTO v_channel FROM notification_template WHERE key=p_template;
    IF v_channel IS NULL THEN RAISE EXCEPTION 'unknown notification template %', p_template; END IF;
    INSERT INTO notification (user_id, channel, template, payload, related_job)
    VALUES (p_user, v_channel, p_template, p_payload, p_job) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- QUOTING  (hardened: role guard + input caps)
-- ============================================================
CREATE OR REPLACE FUNCTION issue_quote(
    p_job_id BIGINT, p_actor BIGINT, p_minutes INT,
    p_grams NUMERIC DEFAULT NULL, p_note TEXT DEFAULT NULL
) RETURNS NUMERIC AS $$
DECLARE
    v_machine RECORD; v_matcost NUMERIC:=0; v_disc NUMERIC:=0;
    v_machcost NUMERIC; v_total NUMERIC; v_ver INT;
    CAP CONSTANT NUMERIC := 9999999.99;
BEGIN
    PERFORM assert_staff(p_actor);
    IF p_minutes IS NULL OR p_minutes<0 THEN p_minutes:=0; END IF;
    IF p_grams IS NOT NULL AND p_grams<0 THEN p_grams:=0; END IF;
    IF p_minutes>525600 OR COALESCE(p_grams,0)>1000000 THEN
        RAISE EXCEPTION 'quote inputs out of range (minutes=%, grams=%)', p_minutes, p_grams;
    END IF;

    SELECT m.rate_per_hour, m.setup_fee, m.min_charge, m.student_discount_pct,
           j.material_code, au.affiliation, j.status
    INTO v_machine
    FROM job j JOIN machine m ON m.id=j.machine_id JOIN app_user au ON au.id=j.user_id
    WHERE j.id=p_job_id FOR UPDATE OF j;
    IF v_machine IS NULL THEN RAISE EXCEPTION 'job % not found', p_job_id; END IF;

    v_machcost := ROUND(v_machine.rate_per_hour*p_minutes/60.0,2);
    IF p_grams IS NOT NULL AND v_machine.material_code IS NOT NULL THEN
        SELECT COALESCE(mm.cost_per_gram,0)*p_grams INTO v_matcost
        FROM machine_material mm JOIN job j ON j.machine_id=mm.machine_id
        WHERE j.id=p_job_id AND mm.material_code=v_machine.material_code;
    END IF;
    IF v_machine.affiliation='student' THEN
        v_disc := ROUND(v_machcost*v_machine.student_discount_pct/100.0,2);
    END IF;
    v_total := GREATEST(v_machcost+COALESCE(v_matcost,0)+v_machine.setup_fee-v_disc, v_machine.min_charge);
    v_total := LEAST(v_total, CAP);

    SELECT COALESCE(MAX(version),0)+1 INTO v_ver FROM quote WHERE job_id=p_job_id;
    INSERT INTO quote (job_id,version,est_minutes,machine_cost,material_grams,material_cost,
                       setup_cost,discount,total,source,prepared_by,valid_until)
    VALUES (p_job_id,v_ver,p_minutes,v_machcost,p_grams,COALESCE(v_matcost,0),
            v_machine.setup_fee,v_disc,v_total,'manual',p_actor,now()+INTERVAL '7 days');
    UPDATE job SET status='quote_sent' WHERE id=p_job_id;
    INSERT INTO job_event (job_id,from_status,to_status,note,actor_id)
    VALUES (p_job_id,'quote_pending','quote_sent',COALESCE(p_note,'Quote v'||v_ver||': Rs '||v_total),p_actor);
    RETURN v_total;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- JOB LIFECYCLE  (hardened: role guard + stock guard)
-- ============================================================
CREATE OR REPLACE FUNCTION advance_job(
    p_job_id BIGINT, p_to TEXT, p_actor BIGINT,
    p_note TEXT DEFAULT NULL, p_grams NUMERIC DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE v_from TEXT; v_machine BIGINT; v_material TEXT; v_allowed BOOLEAN; v_have NUMERIC;
BEGIN
    PERFORM assert_staff(p_actor);
    SELECT status, machine_id, material_code INTO v_from, v_machine, v_material
    FROM job WHERE id=p_job_id FOR UPDATE;
    IF v_from IS NULL THEN RAISE EXCEPTION 'job % not found', p_job_id; END IF;

    v_allowed := CASE
        WHEN v_from='quote_accepted' AND p_to='queued'   THEN TRUE
        WHEN v_from='queued'         AND p_to='setup'     THEN TRUE
        WHEN v_from='setup'          AND p_to='running'   THEN TRUE
        WHEN v_from='running'        AND p_to='qc'        THEN TRUE
        WHEN v_from='qc'             AND p_to='ready'     THEN TRUE
        WHEN v_from='qc'             AND p_to='running'   THEN TRUE
        WHEN v_from='ready'          AND p_to='collected' THEN TRUE
        WHEN p_to='failed'    AND v_from IN ('queued','setup','running','qc') THEN TRUE
        WHEN p_to='cancelled' AND v_from IN ('quote_accepted','queued','setup') THEN TRUE
        ELSE FALSE END;
    IF NOT v_allowed THEN RAISE EXCEPTION 'illegal transition: % -> %', v_from, p_to; END IF;

    IF p_grams IS NOT NULL AND p_grams>0 AND v_material IS NOT NULL AND p_to IN ('running','ready') THEN
        SELECT in_stock_g INTO v_have FROM machine_material
        WHERE machine_id=v_machine AND material_code=v_material;
        IF v_have IS NULL OR v_have<p_grams THEN
            RAISE EXCEPTION 'insufficient stock: need %g of %, only %g on hand', p_grams, v_material, COALESCE(v_have,0);
        END IF;
        INSERT INTO stock_movement (machine_id,material_code,delta_g,reason,job_id,actor_id)
        VALUES (v_machine,v_material,-p_grams,'job_consume',p_job_id,p_actor);
    END IF;

    UPDATE job SET status=p_to WHERE id=p_job_id;
    INSERT INTO job_event (job_id,from_status,to_status,note,actor_id)
    VALUES (p_job_id,v_from,p_to,p_note,p_actor);
    RETURN p_to;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- MARKETPLACE  (list, earn)
-- ============================================================
CREATE OR REPLACE FUNCTION accrue_earning(p_job_id BIGINT, p_actor BIGINT DEFAULT NULL) RETURNS NUMERIC AS $$
DECLARE v_centre BIGINT; v_owner BIGINT; v_fee_pct NUMERIC; v_total NUMERIC;
        v_fee NUMERIC; v_net NUMERIC; v_role TEXT;
BEGIN
    IF p_actor IS NOT NULL THEN
        SELECT role INTO v_role FROM app_user WHERE id=p_actor;
        IF v_role NOT IN ('centre_staff','centre_manager','apis_admin') THEN
            RAISE EXCEPTION 'permission denied: role % cannot accrue earnings', v_role;
        END IF;
    END IF;
    SELECT c.id, c.owner_user_id, c.platform_fee_pct,
           (SELECT total FROM quote WHERE job_id=p_job_id ORDER BY version DESC LIMIT 1)
    INTO v_centre, v_owner, v_fee_pct, v_total
    FROM job j JOIN machine m ON m.id=j.machine_id JOIN centre c ON c.id=m.centre_id
    WHERE j.id=p_job_id;
    IF v_total IS NULL THEN RETURN 0; END IF;
    IF EXISTS (SELECT 1 FROM earning WHERE job_id=p_job_id AND status<>'reversed') THEN
        RAISE EXCEPTION 'earning already accrued for job %', p_job_id;
    END IF;
    v_fee := ROUND(v_total*v_fee_pct/100.0,2);
    v_net := v_total-v_fee;
    INSERT INTO earning (centre_id,owner_user_id,job_id,gross_amount,platform_fee,net_to_owner)
    VALUES (v_centre,v_owner,p_job_id,v_total,v_fee,v_net);
    RETURN v_net;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION list_private_machine(
    p_owner BIGINT, p_centre_name TEXT, p_district TEXT, p_address TEXT, p_lat NUMERIC, p_lng NUMERIC,
    p_process TEXT, p_make TEXT, p_model TEXT, p_rate NUMERIC,
    p_max_x NUMERIC, p_max_y NUMERIC, p_max_z NUMERIC,
    p_material TEXT DEFAULT 'pla', p_platform_fee_pct NUMERIC DEFAULT 15
) RETURNS BIGINT AS $$
DECLARE v_centre BIGINT; v_machine BIGINT; v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM app_user WHERE id=p_owner;
    IF v_role IS NULL OR v_role NOT IN ('equipment_owner','apis_admin') THEN
        RAISE EXCEPTION 'only equipment owners can list private machines (role=%)', v_role;
    END IF;
    SELECT id INTO v_centre FROM centre WHERE owner_user_id=p_owner AND name=p_centre_name LIMIT 1;
    IF v_centre IS NULL THEN
        INSERT INTO centre (name,district,address,lat,lng,is_live,owner_type,owner_user_id,platform_fee_pct,verification,operator)
        VALUES (p_centre_name,p_district,p_address,p_lat,p_lng,TRUE,'private',p_owner,p_platform_fee_pct,'pending','Private')
        RETURNING id INTO v_centre;
    END IF;
    INSERT INTO machine (centre_id,process_code,make,model,status,rate_per_hour,setup_fee,min_charge,student_discount_pct)
    VALUES (v_centre,p_process,p_make,p_model,'available',p_rate,0,p_rate,0) RETURNING id INTO v_machine;
    INSERT INTO machine_capability (machine_id,max_x_mm,max_y_mm,max_z_mm,tolerance_mm,min_feature_mm)
    VALUES (v_machine,p_max_x,p_max_y,p_max_z,
            CASE p_process WHEN 'cnc_mill' THEN 0.02 WHEN 'sla' THEN 0.10 ELSE 0.20 END,
            CASE p_process WHEN 'cnc_mill' THEN 0.20 ELSE 0.80 END);
    INSERT INTO machine_material (machine_id,material_code,cost_per_gram,in_stock_g,reorder_at_g)
    VALUES (v_machine,p_material,2.50,2000,300);
    RETURN v_machine;
END;
$$ LANGUAGE plpgsql;
