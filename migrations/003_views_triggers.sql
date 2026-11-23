-- ============================================================
-- PROTOHUB — 03_views_triggers.sql
-- All views and all triggers, defined once.
-- ============================================================

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Stock balance = running sum of movements (keeps the matcher fast).
CREATE OR REPLACE FUNCTION apply_stock_movement() RETURNS TRIGGER AS $$
BEGIN
    UPDATE machine_material
    SET in_stock_g = in_stock_g + NEW.delta_g
    WHERE machine_id = NEW.machine_id
      AND material_code = NEW.material_code;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_movement ON stock_movement;

CREATE TRIGGER trg_stock_movement
AFTER INSERT ON stock_movement
FOR EACH ROW
EXECUTE FUNCTION apply_stock_movement();


-- New bookings can't start in the past (maintenance blocks exempt).
CREATE OR REPLACE FUNCTION guard_booking_future() RETURNS TRIGGER AS $$
BEGIN
    IF NOT NEW.is_block
       AND NEW.status IN ('requested', 'confirmed')
       AND lower(NEW.slot) < now() THEN

        RAISE EXCEPTION
            'cannot book a slot in the past (slot starts %)',
            lower(NEW.slot);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_booking_future ON booking;

CREATE TRIGGER trg_booking_future
BEFORE INSERT ON booking
FOR EACH ROW
EXECUTE FUNCTION guard_booking_future();


-- Job events drive notifications + audit.
CREATE OR REPLACE FUNCTION on_job_event() RETURNS TRIGGER AS $$
DECLARE
    v_job RECORD;
BEGIN
    SELECT
        j.id,
        j.title,
        j.user_id,
        u.name,
        m.make || ' ' || m.model AS machine,
        c.name AS centre,
        s.agency,
        s.name AS state
    INTO v_job
    FROM job j
    JOIN machine m ON m.id = j.machine_id
    JOIN centre c ON c.id = m.centre_id
    LEFT JOIN state s ON s.code = c.state_code
    JOIN app_user u ON u.id = j.user_id
    WHERE j.id = NEW.job_id;

    IF NEW.to_status = 'quote_sent' THEN
        PERFORM enqueue_notification(
            v_job.user_id,
            'quote_sent',
            jsonb_build_object(
                'name', v_job.name,
                'job_title', v_job.title,
                'job_id', v_job.id,
                'centre', v_job.centre,
                'machine', v_job.machine,
                'agency', COALESCE(v_job.agency, 'ProtoHub')
            ),
            v_job.id
        );

    ELSIF NEW.to_status = 'running' THEN
        PERFORM enqueue_notification(
            v_job.user_id,
            'job_running',
            jsonb_build_object(
                'job_title', v_job.title,
                'centre', v_job.centre
            ),
            v_job.id
        );

    ELSIF NEW.to_status = 'ready' THEN
        PERFORM enqueue_notification(
            v_job.user_id,
            'job_ready',
            jsonb_build_object(
                'name', v_job.name,
                'job_title', v_job.title,
                'job_id', v_job.id,
                'centre', v_job.centre,
                'agency', COALESCE(v_job.agency, 'ProtoHub')
            ),
            v_job.id
        );
    END IF;

    PERFORM audit(
        NEW.actor_id,
        'job.advance',
        'job',
        NEW.job_id,
        jsonb_build_object(
            'from', NEW.from_status,
            'to', NEW.to_status
        ),
        NULL,
        TRUE,
        NULL
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_on_job_event ON job_event;

CREATE TRIGGER trg_on_job_event
AFTER INSERT ON job_event
FOR EACH ROW
EXECUTE FUNCTION on_job_event();


-- Low stock → alert the centre manager.
CREATE OR REPLACE FUNCTION on_stock_low() RETURNS TRIGGER AS $$
DECLARE
    v_mgr BIGINT;
    v_info RECORD;
BEGIN
    IF NEW.in_stock_g <= NEW.reorder_at_g
       AND OLD.in_stock_g > OLD.reorder_at_g THEN

        SELECT
            c.name AS centre,
            m.make || ' ' || m.model AS machine,
            mat.label AS material
        INTO v_info
        FROM machine m
        JOIN centre c ON c.id = m.centre_id
        JOIN material mat ON mat.code = NEW.material_code
        WHERE m.id = NEW.machine_id;

        SELECT id
        INTO v_mgr
        FROM app_user
        WHERE centre_id = (
            SELECT centre_id
            FROM machine
            WHERE id = NEW.machine_id
        )
        AND role IN ('centre_manager', 'centre_staff')
        LIMIT 1;

        IF v_mgr IS NOT NULL THEN
            PERFORM enqueue_notification(
                v_mgr,
                'low_stock',
                jsonb_build_object(
                    'centre', v_info.centre,
                    'machine', v_info.machine,
                    'material', v_info.material,
                    'in_stock', NEW.in_stock_g,
                    'reorder', NEW.reorder_at_g
                )
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_on_stock_low ON machine_material;

CREATE TRIGGER trg_on_stock_low
AFTER UPDATE OF in_stock_g ON machine_material
FOR EACH ROW
EXECUTE FUNCTION on_stock_low();


-- Maintenance window auto-syncs machine.status.
CREATE OR REPLACE FUNCTION sync_maintenance_status() RETURNS TRIGGER AS $$
DECLARE
    v_open INT;
BEGIN
    SELECT count(*)
    INTO v_open
    FROM maintenance_window
    WHERE machine_id = COALESCE(NEW.machine_id, OLD.machine_id)
      AND resolved_at IS NULL;

    UPDATE machine
    SET status = CASE
        WHEN v_open > 0 THEN 'maintenance'
        WHEN status = 'maintenance' THEN 'available'
        ELSE status
    END
    WHERE id = COALESCE(NEW.machine_id, OLD.machine_id);

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_maint_sync ON maintenance_window;

CREATE TRIGGER trg_maint_sync
AFTER INSERT OR UPDATE OR DELETE ON maintenance_window
FOR EACH ROW
EXECUTE FUNCTION sync_maintenance_status();


-- ============================================================
-- VIEWS — manager / ops
-- ============================================================

-- Machine utilisation (booked hours per machine per week).
CREATE OR REPLACE VIEW v_machine_utilization AS
SELECT
    m.id AS machine_id,
    m.centre_id,
    c.name AS centre_name,
    m.make || ' ' || m.model AS machine,
    date_trunc('week', lower(b.slot)) AS week,
    SUM(
        EXTRACT(EPOCH FROM (upper(b.slot) - lower(b.slot))) / 3600.0
    ) AS booked_hours,
    COUNT(*) FILTER (WHERE b.status = 'no_show') AS no_shows
FROM machine m
JOIN centre c ON c.id = m.centre_id
LEFT JOIN booking b
    ON b.machine_id = m.id
    AND b.status IN ('confirmed', 'completed', 'no_show')
    AND NOT b.is_block
GROUP BY
    m.id,
    m.centre_id,
    c.name,
    m.make,
    m.model,
    date_trunc('week', lower(b.slot));


-- Low-stock alerts.
CREATE OR REPLACE VIEW v_material_alerts AS
SELECT
    c.name AS centre_name,
    m.make || ' ' || m.model AS machine,
    mat.label AS material,
    mm.in_stock_g,
    mm.reorder_at_g
FROM machine_material mm
JOIN machine m ON m.id = mm.machine_id
JOIN centre c ON c.id = m.centre_id
JOIN material mat ON mat.code = mm.material_code
WHERE mm.in_stock_g <= mm.reorder_at_g;


-- The manager's queue: jobs needing attention, most urgent first.
CREATE OR REPLACE VIEW v_manager_queue AS
SELECT
    j.id AS job_id,
    j.title,
    j.status,
    m.centre_id,
    c.name AS centre_name,
    m.make || ' ' || m.model AS machine,
    u.name AS innovator,
    u.affiliation,
    u.phone,
    j.material_code,
    j.quantity,
    b.slot,
    lower(b.slot) AS slot_start,
    q.total AS current_quote,

    CASE j.status
        WHEN 'quote_pending' THEN 'Price this job'
        WHEN 'quote_sent' THEN 'Awaiting innovator'
        WHEN 'quote_accepted' THEN 'Add to queue'
        WHEN 'queued' THEN 'Start setup'
        WHEN 'setup' THEN 'Begin run'
        WHEN 'running' THEN 'Move to QC when done'
        WHEN 'qc' THEN 'Pass or rework'
        WHEN 'ready' THEN 'Awaiting collection'
    END AS next_action,

    CASE
        WHEN j.status = 'quote_pending' THEN 0
        WHEN lower(b.slot)::date = CURRENT_DATE THEN 1
        WHEN j.status IN ('setup', 'running', 'qc') THEN 2
        ELSE 3
    END AS priority,

    j.created_at

FROM job j
JOIN machine m ON m.id = j.machine_id
JOIN centre c ON c.id = m.centre_id
JOIN app_user u ON u.id = j.user_id
LEFT JOIN booking b ON b.id = j.booking_id

LEFT JOIN LATERAL (
    SELECT total
    FROM quote
    WHERE job_id = j.id
    ORDER BY version DESC
    LIMIT 1
) q ON TRUE

WHERE j.status NOT IN (
    'draft',
    'collected',
    'cancelled',
    'failed'
)
ORDER BY priority, slot_start NULLS LAST, j.created_at;


-- Centre health at a glance.
CREATE OR REPLACE VIEW v_centre_today AS
SELECT
    c.id AS centre_id,
    c.name AS centre_name,

    COUNT(*) FILTER (
        WHERE j.status = 'quote_pending'
    ) AS awaiting_quote,

    COUNT(*) FILTER (
        WHERE j.status IN ('queued', 'setup', 'running', 'qc')
    ) AS active_jobs,

    COUNT(*) FILTER (
        WHERE j.status = 'ready'
    ) AS ready_pickup,

    COUNT(*) FILTER (
        WHERE lower(b.slot)::date = CURRENT_DATE
    ) AS todays_bookings,

    (
        SELECT COUNT(*)
        FROM machine mm
        WHERE mm.centre_id = c.id
          AND mm.status = 'available'
    ) AS machines_up,

    (
        SELECT COUNT(*)
        FROM machine mm
        WHERE mm.centre_id = c.id
          AND mm.status IN ('maintenance', 'broken')
    ) AS machines_down,

    (
        SELECT COUNT(*)
        FROM v_material_alerts va
        WHERE va.centre_name = c.name
    ) AS low_stock_items

FROM centre c
LEFT JOIN machine m ON m.centre_id = c.id
LEFT JOIN job j ON j.machine_id = m.id
LEFT JOIN booking b ON b.id = j.booking_id
WHERE c.is_live
GROUP BY c.id, c.name;


-- ============================================================
-- VIEWS — multi-state / idle cost
-- ============================================================

CREATE OR REPLACE VIEW v_machine_idle AS
WITH open_hours AS (
    SELECT
        c.id AS centre_id,
        EXTRACT(EPOCH FROM (c.closes_at - c.opens_at)) / 3600.0
            * COALESCE(array_length(c.working_days, 1), 6) AS hrs_per_week
    FROM centre c
),

booked AS (
    SELECT
        b.machine_id,
        COALESCE(
            SUM(
                EXTRACT(EPOCH FROM (upper(b.slot) - lower(b.slot))) / 3600.0
            ) FILTER (
                WHERE lower(b.slot) >= now() - INTERVAL '7 days'
            ),
            0
        ) AS hrs_booked_7d
    FROM booking b
    WHERE b.status IN ('confirmed', 'completed')
      AND NOT b.is_block
    GROUP BY b.machine_id
)

SELECT
    m.id AS machine_id,
    s.code AS state_code,
    s.name AS state_name,
    c.zone,
    c.district,
    c.name AS centre_name,
    m.make || ' ' || m.model AS machine,
    m.rate_per_hour,
    m.status,
    oh.hrs_per_week,
    COALESCE(bk.hrs_booked_7d, 0) AS hrs_used,

    GREATEST(
        oh.hrs_per_week - COALESCE(bk.hrs_booked_7d, 0),
        0
    ) AS hrs_idle,

    CASE
        WHEN oh.hrs_per_week > 0
        THEN LEAST(
            COALESCE(bk.hrs_booked_7d, 0) / oh.hrs_per_week,
            1
        )
        ELSE 0
    END AS utilisation,

    ROUND(
        GREATEST(
            oh.hrs_per_week - COALESCE(bk.hrs_booked_7d, 0),
            0
        ) * 50 * m.rate_per_hour
    ) AS idle_cost_year,

    ROUND(
        COALESCE(bk.hrs_booked_7d, 0) * 50 * m.rate_per_hour
    ) AS earned_year

FROM machine m
JOIN centre c ON c.id = m.centre_id
JOIN state s ON s.code = c.state_code
JOIN open_hours oh ON oh.centre_id = c.id
LEFT JOIN booked bk ON bk.machine_id = m.id
WHERE m.status <> 'retired';


CREATE OR REPLACE VIEW v_state_utilisation AS
SELECT
    state_code,
    state_name,
    COUNT(*) AS machines,
    COUNT(*) FILTER (WHERE utilisation = 0) AS idle_machines,
    ROUND(AVG(utilisation)::NUMERIC, 3) AS avg_utilisation,
    SUM(idle_cost_year) AS idle_cost_year,
    SUM(earned_year) AS earned_year
FROM v_machine_idle
GROUP BY state_code, state_name
ORDER BY idle_cost_year DESC;


CREATE OR REPLACE VIEW v_zone_utilisation AS
SELECT
    state_code,
    state_name,
    zone,
    COUNT(*) AS machines,
    COUNT(*) FILTER (WHERE utilisation = 0) AS idle_machines,
    ROUND(AVG(utilisation)::NUMERIC, 3) AS avg_utilisation,
    SUM(idle_cost_year) AS idle_cost_year,
    SUM(earned_year) AS earned_year
FROM v_machine_idle
GROUP BY state_code, state_name, zone
ORDER BY idle_cost_year DESC;


CREATE OR REPLACE VIEW v_national AS
SELECT
    COUNT(DISTINCT state_code) AS states,
    COUNT(*) AS machines,
    COUNT(*) FILTER (WHERE utilisation = 0) AS idle_machines,
    ROUND(AVG(utilisation)::NUMERIC, 3) AS avg_utilisation,
    SUM(idle_cost_year) AS idle_cost_year,
    SUM(earned_year) AS earned_year
FROM v_machine_idle;


-- ============================================================
-- VIEWS — marketplace / notifications / machine ops
-- ============================================================

CREATE OR REPLACE VIEW v_listable_centre AS
SELECT *
FROM centre
WHERE is_live
  AND (
      owner_type = 'government'
      OR verification = 'verified'
  );


CREATE OR REPLACE VIEW v_owner_dashboard AS
SELECT
    c.owner_user_id,
    c.id AS centre_id,
    c.name AS centre_name,
    c.verification,
    COUNT(DISTINCT m.id) AS machines,
    COALESCE(
        SUM(e.net_to_owner) FILTER (WHERE e.status = 'accrued'),
        0
    ) AS pending_payout,
    COALESCE(
        SUM(e.net_to_owner) FILTER (WHERE e.status = 'paid_out'),
        0
    ) AS paid_to_date,
    COALESCE(SUM(e.gross_amount), 0) AS gross_booked
FROM centre c
LEFT JOIN machine m ON m.centre_id = c.id
LEFT JOIN earning e ON e.centre_id = c.id
WHERE c.owner_type = 'private'
GROUP BY
    c.owner_user_id,
    c.id,
    c.name,
    c.verification;


CREATE OR REPLACE VIEW v_notification_outbox AS
SELECT
    n.id,
    n.channel,
    n.template,
    n.payload,
    n.related_job,
    u.name,
    u.email,
    u.phone,
    t.subject AS subject_tpl,
    t.body AS body_tpl
FROM notification n
JOIN app_user u ON u.id = n.user_id
JOIN notification_template t ON t.key = n.template
WHERE n.status = 'queued'
ORDER BY n.created_at
LIMIT 100;


CREATE OR REPLACE VIEW v_machine_reliability AS
SELECT
    m.id AS machine_id,
    m.make || ' ' || m.model AS machine,

    COUNT(j.id) FILTER (
        WHERE j.status = 'collected'
    ) AS jobs_done,

    COUNT(j.id) FILTER (
        WHERE j.status = 'failed'
    ) AS jobs_failed,

    CASE
        WHEN COUNT(j.id) FILTER (
            WHERE j.status IN ('collected', 'failed')
        ) > 0
        THEN ROUND(
            100.0 * COUNT(j.id) FILTER (WHERE j.status = 'collected')
            / COUNT(j.id) FILTER (WHERE j.status IN ('collected', 'failed')),
            1
        )
        ELSE NULL
    END AS success_rate_pct,

    COUNT(DISTINCT f.id) AS faults_logged,

    COUNT(DISTINCT f.id) FILTER (
        WHERE f.severity = 'critical'
    ) AS critical_faults,

    COALESCE(SUM(f.downtime_hours), 0) AS total_downtime_hrs,
    MAX(f.reported_at) AS last_fault_at

FROM machine m
LEFT JOIN job j ON j.machine_id = m.id
LEFT JOIN machine_fault f ON f.machine_id = m.id
GROUP BY m.id, m.make, m.model;


-- The full machine profile: everything a booker needs before booking.
CREATE OR REPLACE VIEW v_machine_profile AS
SELECT
    m.id AS machine_id,
    m.make || ' ' || m.model AS machine,
    pr.layman_label AS does_what,
    m.status,
    m.rate_per_hour,
    m.setup_fee,
    m.min_charge,
    m.student_discount_pct,

    c.name AS centre_name,
    c.district,
    c.zone,
    s.name AS state,
    c.lat,
    c.lng,
    c.address,
    c.opens_at,
    c.closes_at,
    c.working_days,

    cap.max_x_mm,
    cap.max_y_mm,
    cap.max_z_mm,
    cap.tolerance_mm,
    cap.min_feature_mm,
    cap.surface_finish,

    op.name AS operator_name,
    op.phone AS operator_phone,
    op.shift_start,
    op.shift_end,

    g.how_to_use,
    g.file_formats,
    g.safety_notes,
    g.requires_cert,
    g.requires_operator,
    g.typical_lead_hrs,

    (
        SELECT upper(b.slot)
        FROM booking b
        WHERE b.machine_id = m.id
          AND b.status IN ('confirmed', 'requested')
          AND now() <@ b.slot
        ORDER BY upper(b.slot) DESC
        LIMIT 1
    ) AS busy_until,

    (
        SELECT mw.reason
        FROM maintenance_window mw
        WHERE mw.machine_id = m.id
          AND mw.resolved_at IS NULL
        ORDER BY mw.started_at DESC
        LIMIT 1
    ) AS maint_reason,

    (
        SELECT mw.expected_back
        FROM maintenance_window mw
        WHERE mw.machine_id = m.id
          AND mw.resolved_at IS NULL
        ORDER BY mw.started_at DESC
        LIMIT 1
    ) AS maint_expected_back,

    rel.success_rate_pct,
    rel.jobs_done,
    rel.faults_logged,
    rel.last_fault_at

FROM machine m
JOIN centre c ON c.id = m.centre_id
LEFT JOIN state s ON s.code = c.state_code
JOIN process pr ON pr.code = m.process_code
LEFT JOIN machine_capability cap ON cap.machine_id = m.id

LEFT JOIN LATERAL (
    SELECT *
    FROM machine_operator mo
    WHERE mo.machine_id = m.id
    ORDER BY mo.is_primary DESC, mo.id
    LIMIT 1
) op ON TRUE

LEFT JOIN machine_guide g ON g.machine_id = m.id
LEFT JOIN v_machine_reliability rel ON rel.machine_id = m.id;