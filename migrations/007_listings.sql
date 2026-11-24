-- ============================================================
-- 007_listings.sql — private equipment listings done properly
--  * listing life-cycle: draft → pending → verified
--                        (or changes_requested / rejected / suspended)
--  * photos and SOP documents stored in the database (backed up with it)
--  * PIN code and the reviewer's note on each listing
-- ============================================================

ALTER TABLE centre DROP CONSTRAINT IF EXISTS centre_verification_check;
ALTER TABLE centre ADD CONSTRAINT centre_verification_check CHECK (verification IN
    ('draft','pending','changes_requested','verified','rejected','suspended'));
ALTER TABLE centre
    ADD COLUMN pincode      TEXT CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$'),
    ADD COLUMN review_note  TEXT,
    ADD COLUMN submitted_at TIMESTAMPTZ,
    ADD COLUMN reviewed_at  TIMESTAMPTZ,
    ADD COLUMN reviewed_by  BIGINT REFERENCES app_user(id);

-- Photos: the bytes live here, already re-encoded and stripped of metadata.
ALTER TABLE machine_photo ALTER COLUMN storage_key DROP NOT NULL;
ALTER TABLE machine_photo
    ADD COLUMN data        BYTEA,
    ADD COLUMN mime        TEXT CHECK (mime IS NULL OR mime IN ('image/webp','image/jpeg','image/png')),
    ADD COLUMN size_bytes  INT,
    ADD COLUMN width       INT,
    ADD COLUMN height      INT,
    ADD COLUMN uploaded_by BIGINT REFERENCES app_user(id),
    ADD COLUMN created_at  TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS machine_photo_machine_idx ON machine_photo (machine_id, sort, id);

-- One operating-procedure document (PDF) per machine.
CREATE TABLE machine_doc (
    machine_id  BIGINT PRIMARY KEY REFERENCES machine(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    mime        TEXT NOT NULL CHECK (mime = 'application/pdf'),
    data        BYTEA NOT NULL,
    size_bytes  INT NOT NULL,
    uploaded_by BIGINT REFERENCES app_user(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unverified listings stay out of search, slots and booking (already true
-- for 'pending'; the new states are covered by the same rule, which only
-- lets through government centres or verified ones).

-- Private owners declare which materials they offer but don't keep a gram
-- ledger, so a material they list counts as available.
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
  AND (p_material IS NULL OR mm.in_stock_g IS NULL OR mm.in_stock_g>0 OR c.owner_type='private')
ORDER BY (m.status='available') DESC, distance_km ASC NULLS LAST, fit_score DESC;
END;
$$ LANGUAGE plpgsql STABLE;
