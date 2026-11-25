-- 009: 60 days of SAMPLE usage history so the utilisation report has data to show.
--
-- Only runs where the sample catalogue is installed (SEED_DEMO). Real installs
-- without sample data are untouched. Every row belongs to the disabled system
-- account sample-history@system.invalid, so it is easy to find and remove:
--   SELECT remove_sample_usage_history();
--
-- Each machine gets a stable "personality" (busy / average / quiet) from its id,
-- with no-shows, cancellations, quotes that run over or under, and the odd
-- repair, so the report shows realistic patterns rather than uniform numbers.

CREATE OR REPLACE FUNCTION remove_sample_usage_history() RETURNS INT AS $$
DECLARE v_user BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_user FROM app_user WHERE email = 'sample-history@system.invalid';
    IF v_user IS NULL THEN RETURN 0; END IF;
    DELETE FROM job_event WHERE job_id IN (SELECT id FROM job WHERE user_id = v_user);
    DELETE FROM quote WHERE job_id IN (SELECT id FROM job WHERE user_id = v_user);
    DELETE FROM job WHERE user_id = v_user;
    DELETE FROM booking WHERE user_id = v_user;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    DELETE FROM maintenance_window WHERE reason LIKE 'Sample:%';
    RETURN v_n;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_sample_usage_history(p_days INT DEFAULT 60) RETURNS INT AS $$
DECLARE
    v_user   BIGINT;
    m        RECORD;
    v_day    DATE;
    v_busy   INT;     -- % chance a working day has any bookings
    v_blocks INT;
    v_k      INT;
    v_len    INT;     -- booked minutes
    v_start  TIMESTAMPTZ;
    v_end    TIMESTAMPTZ;
    v_r      INT;
    v_status TEXT;
    v_bid    BIGINT;
    v_jid    BIGINT;
    v_created TIMESTAMPTZ;
    v_setup  INT;
    v_run    INT;
    v_t      TIMESTAMPTZ;
    v_n      INT := 0;
BEGIN
    SELECT id INTO v_user FROM app_user WHERE email = 'sample-history@system.invalid';
    IF v_user IS NULL THEN RETURN 0; END IF;

    PERFORM remove_sample_usage_history();
    -- sample events must not send emails
    ALTER TABLE job_event DISABLE TRIGGER trg_on_job_event;

    FOR m IN
        SELECT mac.id, mac.rate_per_hour, mac.process_code, c.opens_at, c.closes_at, c.working_days, c.operator
          FROM machine mac JOIN centre c ON c.id = mac.centre_id
         WHERE c.is_live AND mac.status IN ('available','in_use')
           AND c.owner_type = 'government'
    LOOP
        -- personality: flagship operators busier, remote centres quieter
        v_busy := CASE
            WHEN m.operator IN ('T-Works','iCreate','IITM','IIT-B','KITS','RTIH') THEN 55 + (m.id % 5) * 8
            WHEN m.operator IN ('StartupTN','CEPT','IIITB','NITT','Makers Asylum') THEN 35 + (m.id % 5) * 6
            ELSE 10 + (m.id % 6) * 5 END;

        FOR v_day IN SELECT d::date FROM generate_series(CURRENT_DATE - p_days, CURRENT_DATE - 1, interval '1 day') d LOOP
            CONTINUE WHEN NOT (EXTRACT(ISODOW FROM v_day)::int = ANY (m.working_days));
            v_r := abs(hashtext(m.id || ':' || v_day)) % 100;
            CONTINUE WHEN v_r >= v_busy;
            v_blocks := 1 + (v_r % 3);
            FOR v_k IN 0 .. v_blocks - 1 LOOP
                v_len := 60 + (abs(hashtext(m.id || ':' || v_day || ':' || v_k)) % 3) * 60;   -- 1-3 h
                v_start := (v_day + m.opens_at)::timestamptz + make_interval(hours => v_k * 3);
                v_end := v_start + make_interval(mins => v_len);
                EXIT WHEN v_end::time > m.closes_at OR v_end::date <> v_day;

                v_r := abs(hashtext('s' || m.id || ':' || v_day || ':' || v_k)) % 100;
                -- machine id decides how leaky it is: a few machines have poor show-up
                v_status := CASE
                    WHEN v_r < CASE WHEN m.id % 7 = 0 THEN 22 ELSE 5 END THEN 'no_show'
                    WHEN v_r < CASE WHEN m.id % 7 = 0 THEN 32 ELSE 12 END THEN 'cancelled'
                    ELSE 'completed' END;
                v_created := v_start - make_interval(hours => 6 + (v_r % 7) * 12);

                INSERT INTO booking (machine_id, user_id, slot, status, created_at)
                VALUES (m.id, v_user, tstzrange(v_start, v_end), v_status, v_created)
                RETURNING id INTO v_bid;
                v_n := v_n + 1;
                CONTINUE WHEN v_status <> 'completed';

                -- the job that ran in this slot
                INSERT INTO job (booking_id, user_id, machine_id, title, quantity, status, created_at)
                VALUES (v_bid, v_user, m.id, 'Sample job', 1 + (v_r % 4), 'collected', v_created - interval '2 hours')
                RETURNING id INTO v_jid;

                -- quote: estimate = booked time; some machines' quotes run consistently long or short
                INSERT INTO quote (job_id, est_minutes, machine_cost, setup_cost, total, source, created_at)
                VALUES (v_jid, v_len, round(m.rate_per_hour * v_len / 60.0, 2), 150,
                        round(m.rate_per_hour * v_len / 60.0, 2) + 150, 'manual', v_created);

                v_setup := 10 + (v_r % 3) * 5;
                v_run := round(v_len * (CASE WHEN m.id % 5 = 0 THEN 1.25 WHEN m.id % 5 = 1 THEN 0.72 ELSE 0.85 END
                                        + ((v_r % 21) - 10) / 100.0))::int - v_setup;
                v_run := GREATEST(v_run, 10);

                v_t := v_created - interval '2 hours';
                INSERT INTO job_event (job_id, from_status, to_status, at) VALUES
                    (v_jid, 'draft', 'quote_pending', v_t),
                    (v_jid, 'quote_pending', 'quote_sent', v_t + make_interval(hours => 1 + (v_r % 30))),
                    (v_jid, 'quote_sent', 'quote_accepted', v_t + make_interval(hours => 2 + (v_r % 30))),
                    (v_jid, 'quote_accepted', 'queued', v_start - interval '30 minutes'),
                    (v_jid, 'queued', 'setup', v_start),
                    (v_jid, 'setup', 'running', v_start + make_interval(mins => v_setup)),
                    (v_jid, 'running', 'qc', v_start + make_interval(mins => v_setup + v_run)),
                    (v_jid, 'qc', 'ready', v_start + make_interval(mins => v_setup + v_run + 30)),
                    (v_jid, 'ready', 'collected', v_start + make_interval(mins => v_setup + v_run + 30) + interval '1 day');
            END LOOP;
        END LOOP;

        -- an occasional past repair
        IF m.id % 9 = 0 THEN
            INSERT INTO maintenance_window (machine_id, reason, kind, started_at, expected_back, resolved_at)
            VALUES (m.id, 'Sample: spindle bearing replaced', 'repair',
                    (CURRENT_DATE - 20 + m.opens_at)::timestamptz, (CURRENT_DATE - 17 + m.opens_at)::timestamptz,
                    (CURRENT_DATE - 17 + m.opens_at)::timestamptz);
        END IF;
    END LOOP;

    ALTER TABLE job_event ENABLE TRIGGER trg_on_job_event;
    RETURN v_n;
END;
$$ LANGUAGE plpgsql;

-- Existing installs that already have the sample catalogue get the history now.
-- Fresh installs get it from seeds/demo.sql, which runs after migrations.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'seed:demo') THEN
        PERFORM generate_sample_usage_history(60);
    END IF;
END $$;
