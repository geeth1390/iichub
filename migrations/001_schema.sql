-- ============================================================
-- PROTOHUB — 01_schema.sql
-- Every table in final form. No ALTERs, no later patches.
-- Read this one file to understand the entire data model.
--
-- Load order:  01_schema → 02_functions → 03_views_triggers → 04_seed
-- Requires:    CREATE EXTENSION btree_gist;
-- ============================================================

-- ============================================================
-- STATES & CENTRES
-- ============================================================

-- A state and its innovation agency. First-class so the platform is
-- national from day one; adding a 7th state is one INSERT.
CREATE TABLE state (
    code            TEXT PRIMARY KEY,           -- 'AP','TS','KA','TN','MH','GJ'
    name            TEXT NOT NULL,
    agency          TEXT NOT NULL,              -- 'APIS · RTIH', 'TSIC · T-Works'
    policy_anchor   TEXT,                       -- real, citable policy line
    colour          TEXT,                       -- dashboard accent, hex
    is_live         BOOLEAN NOT NULL DEFAULT TRUE
);

-- A centre is ANY facility with machines — government or private.
-- That generality is deliberate: the matcher, booking and billing all
-- treat a private workshop and a government APIC identically.
CREATE TABLE centre (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    district        TEXT NOT NULL,
    address         TEXT NOT NULL,
    lat             NUMERIC(9,6) NOT NULL,
    lng             NUMERIC(9,6) NOT NULL,
    phone           TEXT,
    -- operating hours drive the free-slot finder
    opens_at        TIME NOT NULL DEFAULT '09:00',
    closes_at       TIME NOT NULL DEFAULT '17:30',
    working_days    INT[] NOT NULL DEFAULT '{1,2,3,4,5,6}',   -- ISO dow
    is_live         BOOLEAN NOT NULL DEFAULT FALSE,            -- planned vs operational
    -- location in the national network
    state_code      TEXT REFERENCES state(code),
    zone            TEXT,                        -- region within a state
    operator        TEXT,                        -- 'T-Works', 'StartupTN', 'RTIH', 'Private'
    -- ownership & marketplace (government centres: owner_type='government')
    owner_type      TEXT NOT NULL DEFAULT 'government'
                      CHECK (owner_type IN ('government','private','institution','partner')),
    owner_user_id   BIGINT,                      -- FK added after app_user exists (see below)
    platform_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 0
                      CHECK (platform_fee_pct BETWEEN 0 AND 100),
    verification    TEXT NOT NULL DEFAULT 'verified'
                      CHECK (verification IN ('pending','verified','rejected','suspended')),
    payout_account  TEXT,                        -- bank/UPI ref for payouts
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX centre_state_idx ON centre (state_code, zone);

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE app_user (
    id              BIGSERIAL PRIMARY KEY,
    phone           TEXT UNIQUE NOT NULL,        -- OTP is the realistic auth
    name            TEXT NOT NULL,
    email           TEXT,
    role            TEXT NOT NULL CHECK (role IN
                        ('innovator','centre_staff','centre_manager','apis_admin','equipment_owner')),
    centre_id       BIGINT REFERENCES centre(id),
    affiliation     TEXT CHECK (affiliation IN
                        ('student','startup','industry','individual','institution')),
    institution     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- innovators, admins and equipment owners don't belong to a centre;
    -- staff and managers must.
    CONSTRAINT staff_needs_centre CHECK (
        role IN ('innovator','apis_admin','equipment_owner') OR centre_id IS NOT NULL
    )
);

-- now that app_user exists, complete the centre→owner FK
ALTER TABLE centre
    ADD CONSTRAINT centre_owner_fk FOREIGN KEY (owner_user_id) REFERENCES app_user(id);

-- ============================================================
-- MACHINES, CAPABILITY & MATERIALS  (the core)
-- ============================================================

-- What a machine DOES. Users think in outcomes, not brand names.
CREATE TABLE process (
    code            TEXT PRIMARY KEY,            -- 'fdm','sla','cnc_mill','laser_cut','pcb'
    family          TEXT NOT NULL,               -- 'additive','subtractive','electronics'
    label           TEXT NOT NULL,
    layman_label    TEXT NOT NULL
);

CREATE TABLE material (
    code            TEXT PRIMARY KEY,
    label           TEXT NOT NULL,
    class           TEXT NOT NULL CHECK (class IN
                        ('thermoplastic','resin','metal','composite','wood','other')),
    density_g_cm3   NUMERIC(6,3)
);

CREATE TABLE machine (
    id              BIGSERIAL PRIMARY KEY,
    centre_id       BIGINT NOT NULL REFERENCES centre(id),
    process_code    TEXT NOT NULL REFERENCES process(code),
    make            TEXT NOT NULL,
    model           TEXT NOT NULL,
    asset_tag       TEXT,
    status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN
                        ('available','in_use','maintenance','broken','retired','offline')),
    -- pricing (with CHECK guards from the pentest, folded in)
    rate_per_hour   NUMERIC(10,2) NOT NULL CHECK (rate_per_hour >= 0),
    setup_fee       NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (setup_fee >= 0),
    min_charge      NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (min_charge >= 0),
    student_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0
                      CHECK (student_discount_pct BETWEEN 0 AND 100),
    commissioned_on DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (centre_id, asset_tag)
);

-- THE capability record. Answers "can this machine make my part?"
CREATE TABLE machine_capability (
    machine_id      BIGINT PRIMARY KEY REFERENCES machine(id) ON DELETE CASCADE,
    max_x_mm        NUMERIC(8,2) NOT NULL,
    max_y_mm        NUMERIC(8,2) NOT NULL,
    max_z_mm        NUMERIC(8,2) NOT NULL,
    tolerance_mm    NUMERIC(6,3),
    min_feature_mm  NUMERIC(6,3),
    layer_min_mm    NUMERIC(6,3),
    surface_finish  TEXT CHECK (surface_finish IN ('rough','standard','fine','mirror')),
    notes           TEXT
);

-- Material stock per machine (what a job consumes).
CREATE TABLE machine_material (
    machine_id      BIGINT NOT NULL REFERENCES machine(id) ON DELETE CASCADE,
    material_code   TEXT NOT NULL REFERENCES material(code),
    cost_per_gram   NUMERIC(8,3),
    in_stock_g      NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (in_stock_g >= 0),
    reorder_at_g    NUMERIC(10,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (machine_id, material_code)
);

-- ============================================================
-- SCHEDULING
-- ============================================================
-- The EXCLUDE constraint makes double-booking structurally impossible,
-- even under simultaneous requests — the platform's core guarantee.
CREATE TABLE booking (
    id              BIGSERIAL PRIMARY KEY,
    machine_id      BIGINT NOT NULL REFERENCES machine(id),
    user_id         BIGINT NOT NULL REFERENCES app_user(id),
    slot            TSTZRANGE NOT NULL,
    status          TEXT NOT NULL DEFAULT 'requested' CHECK (status IN
                        ('requested','confirmed','cancelled','no_show','completed')),
    is_block        BOOLEAN NOT NULL DEFAULT FALSE,     -- maintenance blocks use this table
    block_reason    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    EXCLUDE USING gist (
        machine_id WITH =,
        slot WITH &&
    ) WHERE (status IN ('requested','confirmed'))
);
CREATE INDEX booking_slot_idx ON booking USING gist (slot);
CREATE INDEX booking_user_idx ON booking (user_id, created_at DESC);

-- ============================================================
-- JOBS, QUOTES & EVENTS
-- ============================================================
CREATE TABLE job (
    id              BIGSERIAL PRIMARY KEY,
    booking_id      BIGINT UNIQUE REFERENCES booking(id),
    user_id         BIGINT NOT NULL REFERENCES app_user(id),
    machine_id      BIGINT NOT NULL REFERENCES machine(id),
    material_code   TEXT REFERENCES material(code),
    title           TEXT NOT NULL,
    description     TEXT,
    req_x_mm        NUMERIC(8,2),
    req_y_mm        NUMERIC(8,2),
    req_z_mm        NUMERIC(8,2),
    req_tolerance_mm NUMERIC(6,3),
    quantity        INT NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                        ('draft','quote_pending','quote_sent','quote_accepted',
                         'queued','setup','running','qc','ready','collected',
                         'failed','cancelled')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_file (
    id              BIGSERIAL PRIMARY KEY,
    job_id          BIGINT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,
    storage_key     TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('model','drawing','gerber','photo','other')),
    bytes           BIGINT,
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quote (
    id              BIGSERIAL PRIMARY KEY,
    job_id          BIGINT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
    version         INT NOT NULL DEFAULT 1,
    est_minutes     INT NOT NULL,
    machine_cost    NUMERIC(10,2) NOT NULL,
    material_grams  NUMERIC(10,2),
    material_cost   NUMERIC(10,2) NOT NULL DEFAULT 0,
    setup_cost      NUMERIC(10,2) NOT NULL DEFAULT 0,
    discount        NUMERIC(10,2) NOT NULL DEFAULT 0,
    total           NUMERIC(10,2) NOT NULL,
    source          TEXT NOT NULL CHECK (source IN ('auto','manual')),
    prepared_by     BIGINT REFERENCES app_user(id),
    valid_until     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, version)
);

-- Append-only job history. Also the utilisation dataset.
CREATE TABLE job_event (
    id              BIGSERIAL PRIMARY KEY,
    job_id          BIGINT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
    from_status     TEXT,
    to_status       TEXT NOT NULL,
    note            TEXT,
    actor_id        BIGINT REFERENCES app_user(id),
    at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_event_job_idx ON job_event (job_id, at);

-- ============================================================
-- STOCK LEDGER
-- ============================================================
-- Stock as a ledger, not a mutable number: every movement is a row,
-- so "why did we run out?" is always answerable.
CREATE TABLE stock_movement (
    id              BIGSERIAL PRIMARY KEY,
    machine_id      BIGINT NOT NULL REFERENCES machine(id),
    material_code   TEXT NOT NULL REFERENCES material(code),
    delta_g         NUMERIC(10,2) NOT NULL,       -- +restock, -consume
    reason          TEXT NOT NULL CHECK (reason IN
                        ('restock','job_consume','adjustment','waste','stocktake')),
    job_id          BIGINT REFERENCES job(id),
    actor_id        BIGINT REFERENCES app_user(id),
    note            TEXT,
    at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (machine_id, material_code)
        REFERENCES machine_material(machine_id, material_code)
);
CREATE INDEX stock_mv_idx ON stock_movement (machine_id, material_code, at);

-- ============================================================
-- AUDIT & NOTIFICATIONS
-- ============================================================
-- Security/ops forensics: every sensitive action, append-only.
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id    BIGINT REFERENCES app_user(id),
    actor_role  TEXT,
    action      TEXT NOT NULL,
    object_type TEXT,
    object_id   BIGINT,
    detail      JSONB,
    ip          INET,
    ok          BOOLEAN NOT NULL DEFAULT TRUE,
    error       TEXT
);
CREATE INDEX audit_actor_idx  ON audit_log (actor_id, at DESC);
CREATE INDEX audit_action_idx ON audit_log (action, at DESC);
CREATE INDEX audit_object_idx ON audit_log (object_type, object_id, at DESC);

-- The database queues notifications; a worker sends them.
CREATE TABLE notification (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES app_user(id),
    channel     TEXT NOT NULL CHECK (channel IN ('email','sms','inapp')),
    template    TEXT NOT NULL,
    payload     JSONB NOT NULL,
    subject     TEXT,
    body        TEXT,
    status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
    attempts    INT NOT NULL DEFAULT 0,
    last_error  TEXT,
    related_job BIGINT REFERENCES job(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at     TIMESTAMPTZ
);
CREATE INDEX notif_queue_idx ON notification (status, created_at) WHERE status='queued';
CREATE INDEX notif_user_idx  ON notification (user_id, created_at DESC);

-- Editable message templates (non-devs can change copy without a deploy).
CREATE TABLE notification_template (
    key         TEXT PRIMARY KEY,
    channel     TEXT NOT NULL,
    subject     TEXT,
    body        TEXT NOT NULL,
    description TEXT
);

-- ============================================================
-- MARKETPLACE  (private equipment earnings)
-- ============================================================
CREATE TABLE earning (
    id              BIGSERIAL PRIMARY KEY,
    centre_id       BIGINT NOT NULL REFERENCES centre(id),
    owner_user_id   BIGINT REFERENCES app_user(id),
    job_id          BIGINT REFERENCES job(id),
    gross_amount    NUMERIC(12,2) NOT NULL,
    platform_fee    NUMERIC(12,2) NOT NULL,
    net_to_owner    NUMERIC(12,2) NOT NULL,
    status          TEXT NOT NULL DEFAULT 'accrued'
                      CHECK (status IN ('accrued','paid_out','reversed')),
    at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_out_at     TIMESTAMPTZ
);
CREATE INDEX earning_owner_idx  ON earning (owner_user_id, status, at DESC);
CREATE INDEX earning_centre_idx ON earning (centre_id, at DESC);

-- ============================================================
-- MACHINE OPERATIONS  (operators, guides, maintenance, faults)
-- ============================================================

-- The person who runs a machine — operator or helper, with their shift.
CREATE TABLE machine_operator (
    id              BIGSERIAL PRIMARY KEY,
    machine_id      BIGINT NOT NULL REFERENCES machine(id) ON DELETE CASCADE,
    user_id         BIGINT REFERENCES app_user(id),
    name            TEXT NOT NULL,
    phone           TEXT,
    role            TEXT NOT NULL DEFAULT 'operator'
                      CHECK (role IN ('operator','helper','supervisor','on_call')),
    shift_start     TIME,
    shift_end       TIME,
    is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
    skills          TEXT[],
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX operator_machine_idx ON machine_operator (machine_id, is_primary DESC);

-- How to use the machine + safety/certification rules.
CREATE TABLE machine_guide (
    machine_id      BIGINT PRIMARY KEY REFERENCES machine(id) ON DELETE CASCADE,
    how_to_use      TEXT,
    file_formats    TEXT[],
    prep_notes      TEXT,
    safety_notes    TEXT,
    requires_cert   BOOLEAN NOT NULL DEFAULT FALSE,
    requires_operator BOOLEAN NOT NULL DEFAULT FALSE,
    typical_lead_hrs NUMERIC(6,1),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Current/scheduled maintenance: WHY and UNTIL WHEN (not just "down").
CREATE TABLE maintenance_window (
    id              BIGSERIAL PRIMARY KEY,
    machine_id      BIGINT NOT NULL REFERENCES machine(id) ON DELETE CASCADE,
    reason          TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'repair'
                      CHECK (kind IN ('repair','service','calibration','upgrade','cleaning')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expected_back   TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    logged_by       BIGINT REFERENCES app_user(id)
);
CREATE INDEX maint_machine_idx ON maintenance_window (machine_id, resolved_at);

-- The machine's medical history: past problems and fixes.
CREATE TABLE machine_fault (
    id              BIGSERIAL PRIMARY KEY,
    machine_id      BIGINT NOT NULL REFERENCES machine(id) ON DELETE CASCADE,
    reported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    reported_by     BIGINT REFERENCES app_user(id),
    severity        TEXT NOT NULL DEFAULT 'minor'
                      CHECK (severity IN ('minor','major','critical')),
    symptom         TEXT NOT NULL,
    cause           TEXT,
    fix             TEXT,
    job_id          BIGINT REFERENCES job(id),
    downtime_hours  NUMERIC(8,1),
    resolved_at     TIMESTAMPTZ
);
CREATE INDEX fault_machine_idx ON machine_fault (machine_id, reported_at DESC);

-- Wear parts that stop a machine (nozzles, end mills, build sheets).
CREATE TABLE machine_consumable (
    id              BIGSERIAL PRIMARY KEY,
    machine_id      BIGINT NOT NULL REFERENCES machine(id) ON DELETE CASCADE,
    item            TEXT NOT NULL,
    on_hand         INT NOT NULL DEFAULT 0,
    reorder_at      INT NOT NULL DEFAULT 1,
    life_hours      NUMERIC(8,1),
    hours_used      NUMERIC(8,1) NOT NULL DEFAULT 0
);
CREATE INDEX consumable_machine_idx ON machine_consumable (machine_id);

-- Photos of the machine and its sample output (trust signal).
CREATE TABLE machine_photo (
    id              BIGSERIAL PRIMARY KEY,
    machine_id      BIGINT NOT NULL REFERENCES machine(id) ON DELETE CASCADE,
    storage_key     TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'machine'
                      CHECK (kind IN ('machine','sample_output','location')),
    caption         TEXT,
    sort            INT NOT NULL DEFAULT 0
);
