-- ============================================================
-- 005_security.sql — production hardening
--  * email + password accounts, lockout, token revocation
--  * super_admin role
--  * staff can act only on their own centre (checked in the DB too)
--  * unverified private listings hidden from search
--  * quotes only before acceptance; booking sanity checks
--  * India time zone for opening hours and "today"
-- ============================================================

-- ---- accounts ----------------------------------------------------------
ALTER TABLE app_user ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE app_user
    ADD COLUMN password_hash        TEXT,
    ADD COLUMN is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN token_version        INT NOT NULL DEFAULT 0,
    ADD COLUMN failed_logins        INT NOT NULL DEFAULT 0,
    ADD COLUMN locked_until         TIMESTAMPTZ,
    ADD COLUMN last_login_at        TIMESTAMPTZ,
    ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN email_verified_at    TIMESTAMPTZ,
    ADD COLUMN created_by           BIGINT REFERENCES app_user(id);

UPDATE app_user SET email = lower(trim(email)) WHERE email IS NOT NULL;
UPDATE app_user SET email = 'user' || id || '@legacy.invalid', is_active = FALSE WHERE email IS NULL;
ALTER TABLE app_user ALTER COLUMN email SET NOT NULL;
ALTER TABLE app_user ADD CONSTRAINT app_user_email_lower CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254);
CREATE UNIQUE INDEX app_user_email_uq ON app_user (email);

ALTER TABLE app_user DROP CONSTRAINT app_user_role_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_role_check CHECK (role IN
    ('innovator','centre_staff','centre_manager','apis_admin','super_admin','equipment_owner'));
ALTER TABLE app_user DROP CONSTRAINT staff_needs_centre;
ALTER TABLE app_user ADD CONSTRAINT staff_needs_centre CHECK (
    role IN ('innovator','apis_admin','super_admin','equipment_owner') OR centre_id IS NOT NULL);

-- one-time links (password reset, email verification); only hashes stored
CREATE TABLE auth_token (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    purpose     TEXT NOT NULL CHECK (purpose IN ('reset','verify')),
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_token_user_idx ON auth_token (user_id, purpose);

-- ---- permission guards ----------------------------------------------------
CREATE OR REPLACE FUNCTION assert_staff(p_actor BIGINT) RETURNS VOID AS $$
DECLARE v_role TEXT; v_active BOOLEAN;
BEGIN
    SELECT role, is_active INTO v_role, v_active FROM app_user WHERE id=p_actor;
    IF v_role IS NULL THEN RAISE EXCEPTION 'unknown actor %', p_actor; END IF;
    IF NOT v_active THEN RAISE EXCEPTION 'permission denied: account disabled'; END IF;
    IF v_role NOT IN ('centre_staff','centre_manager','apis_admin','super_admin') THEN
        RAISE EXCEPTION 'permission denied: role % cannot perform staff operations', v_role;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Staff and managers may only act on machines of their own centre.
CREATE OR REPLACE FUNCTION assert_staff_for_machine(p_actor BIGINT, p_machine BIGINT) RETURNS VOID AS $$
DECLARE v_role TEXT; v_centre BIGINT; v_mc BIGINT;
BEGIN
    PERFORM assert_staff(p_actor);
    SELECT role, centre_id INTO v_role, v_centre FROM app_user WHERE id=p_actor;
    IF v_role IN ('apis_admin','super_admin') THEN RETURN; END IF;
    SELECT centre_id INTO v_mc FROM machine WHERE id=p_machine;
    IF v_mc IS NULL THEN RAISE EXCEPTION 'machine % not found', p_machine; END IF;
    IF v_mc IS DISTINCT FROM v_centre THEN
        RAISE EXCEPTION 'permission denied: that machine belongs to another centre';
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assert_staff_for_job(p_actor BIGINT, p_job BIGINT) RETURNS VOID AS $$
DECLARE v_machine BIGINT;
BEGIN
    SELECT machine_id INTO v_machine FROM job WHERE id=p_job;
    IF v_machine IS NULL THEN RAISE EXCEPTION 'job % not found', p_job; END IF;
    PERFORM assert_staff_for_machine(p_actor, v_machine);
END;
$$ LANGUAGE plpgsql;

-- ---- functions re-defined with the scoped guards ---------------------------
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
                 AND (c.owner_type='government' OR c.verification='verified')
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

CREATE OR REPLACE FUNCTION issue_quote(
    p_job_id BIGINT, p_actor BIGINT, p_minutes INT,
    p_grams NUMERIC DEFAULT NULL, p_note TEXT DEFAULT NULL
) RETURNS NUMERIC AS $$
DECLARE
    v_machine RECORD; v_matcost NUMERIC:=0; v_disc NUMERIC:=0;
    v_machcost NUMERIC; v_total NUMERIC; v_ver INT;
    CAP CONSTANT NUMERIC := 9999999.99;
BEGIN
    PERFORM assert_staff_for_job(p_actor, p_job_id);
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
    IF v_machine.status NOT IN ('quote_pending','quote_sent') THEN
        RAISE EXCEPTION 'job is %, it can only be priced before the quote is accepted', v_machine.status;
    END IF;

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
    VALUES (p_job_id,v_machine.status,'quote_sent',COALESCE(p_note,'Quote v'||v_ver||': Rs '||v_total),p_actor);
    RETURN v_total;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION advance_job(
    p_job_id BIGINT, p_to TEXT, p_actor BIGINT,
    p_note TEXT DEFAULT NULL, p_grams NUMERIC DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE v_from TEXT; v_machine BIGINT; v_material TEXT; v_allowed BOOLEAN; v_have NUMERIC;
BEGIN
    PERFORM assert_staff_for_job(p_actor, p_job_id);
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

CREATE OR REPLACE FUNCTION accrue_earning(p_job_id BIGINT, p_actor BIGINT DEFAULT NULL) RETURNS NUMERIC AS $$
DECLARE v_centre BIGINT; v_owner BIGINT; v_fee_pct NUMERIC; v_total NUMERIC;
        v_fee NUMERIC; v_net NUMERIC; v_role TEXT;
BEGIN
    IF p_actor IS NOT NULL THEN
        SELECT role INTO v_role FROM app_user WHERE id=p_actor;
        IF v_role NOT IN ('centre_staff','centre_manager','apis_admin','super_admin') THEN
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
    p_platform_fee_pct := 15;  -- set by admins on approval, never by the owner
    SELECT role INTO v_role FROM app_user WHERE id=p_owner;
    IF v_role IS NULL OR v_role NOT IN ('equipment_owner','apis_admin','super_admin') THEN
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

-- ---- booking sanity (on top of the no-overlap and no-past rules) ------------
CREATE OR REPLACE FUNCTION guard_booking_valid() RETURNS TRIGGER AS $$
DECLARE v_status TEXT; v_live BOOLEAN; v_listable BOOLEAN;
BEGIN
    IF NEW.is_block OR NEW.status NOT IN ('requested','confirmed') THEN RETURN NEW; END IF;
    IF upper(NEW.slot) <= lower(NEW.slot) THEN RAISE EXCEPTION 'booking must end after it starts'; END IF;
    IF upper(NEW.slot) - lower(NEW.slot) > INTERVAL '12 hours' THEN
        RAISE EXCEPTION 'a single booking can be at most 12 hours';
    END IF;
    IF lower(NEW.slot) > now() + INTERVAL '120 days' THEN
        RAISE EXCEPTION 'bookings can be made up to 120 days ahead';
    END IF;
    SELECT m.status, c.is_live, (c.owner_type='government' OR c.verification='verified')
      INTO v_status, v_live, v_listable
      FROM machine m JOIN centre c ON c.id=m.centre_id WHERE m.id=NEW.machine_id;
    IF v_status IS NULL THEN RAISE EXCEPTION 'machine not found'; END IF;
    IF NOT v_live OR NOT v_listable THEN RAISE EXCEPTION 'this centre is not taking bookings yet'; END IF;
    IF v_status IN ('retired','broken','offline') THEN
        RAISE EXCEPTION 'this machine is % and cannot be booked', v_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_booking_valid ON booking;
CREATE TRIGGER trg_booking_valid BEFORE INSERT ON booking
FOR EACH ROW EXECUTE FUNCTION guard_booking_valid();

-- ---- time zone: centre hours and "today" are Indian time --------------------
DO $$ BEGIN
    EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Asia/Kolkata');
END $$;
