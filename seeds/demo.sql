-- ============================================================
-- SAMPLE CATALOGUE (optional, SEED_DEMO=true)
-- Centres, machines, capabilities, stock and a week of usage history
-- so search and dashboards have something to show. Rates are modelled
-- estimates. No real or fake login accounts are created.
-- Derived from schema/04_seed.sql.
-- ============================================================

INSERT INTO centre (name, district, address, lat, lng, phone, is_live) VALUES
('APIIC Visakhapatnam',  'Visakhapatnam', 'AU Engineering College Campus, Visakhapatnam', 17.730000, 83.319000, '0891-2844000', TRUE),
('APIIC Vijayawada',     'NTR',           'Siddhartha Engineering College, Vijayawada',   16.506100, 80.648000, '0866-2582333', TRUE),
('APIIC Tirupati',       'Tirupati',      'SVU Campus, Tirupati',                          13.628700, 79.419200, '0877-2289000', TRUE),
('APIIC Kakinada',       'Kakinada',      'JNTU-K Campus, Kakinada',                       16.989400, 82.247500, '0884-2300900', TRUE),
('APIIC Anantapur',      'Anantapur',     'JNTU-A Campus, Anantapur',                      14.681500, 77.600400, '08554-272000', FALSE); -- not commissioned yet

-- One locked system account owns the sample usage history.
-- It has no password and is disabled, so nobody can sign in as it.
INSERT INTO app_user (email, name, role, is_active) VALUES
('sample-history@system.invalid', 'Sample usage history', 'innovator', FALSE);

-- ---- Visakhapatnam (well equipped) ----
INSERT INTO machine (centre_id, process_code, make, model, asset_tag, status, rate_per_hour, setup_fee, min_charge, student_discount_pct) VALUES
(1, 'fdm',      'Ultimaker',  'S5',            'VZG-3DP-001', 'available',   350.00, 100.00, 200.00, 50),
(1, 'sla',      'Formlabs',   'Form 3L',       'VZG-SLA-001', 'available',   600.00, 150.00, 400.00, 40),
(1, 'cnc_mill', 'Haas',       'Mini Mill',     'VZG-CNC-001', 'available',  1200.00, 500.00, 1000.00, 30),
(1, 'laser_cut','Trotec',     'Speedy 400',    'VZG-LSR-001', 'maintenance', 450.00, 100.00, 250.00, 40);

-- ---- Vijayawada ----
INSERT INTO machine (centre_id, process_code, make, model, asset_tag, status, rate_per_hour, setup_fee, min_charge, student_discount_pct) VALUES
(2, 'fdm',      'Creality',   'K1 Max',        'VJA-3DP-001', 'available',   250.00,  50.00, 150.00, 50),
(2, 'fdm',      'Prusa',      'MK4',           'VJA-3DP-002', 'available',   200.00,  50.00, 150.00, 50),
(2, 'pcb',      'LPKF',       'ProtoMat S104', 'VJA-PCB-001', 'available',   800.00, 200.00, 500.00, 40);

-- ---- Tirupati (has the big SLS) ----
INSERT INTO machine (centre_id, process_code, make, model, asset_tag, status, rate_per_hour, setup_fee, min_charge, student_discount_pct) VALUES
(3, 'sls',      'EOS',        'P 396',         'TPT-SLS-001', 'available',  2500.00, 800.00, 2000.00, 25),
(3, 'fdm',      'Ultimaker',  'S3',            'TPT-3DP-001', 'available',   300.00, 100.00, 200.00, 50);

-- ---- Kakinada (modest) ----
INSERT INTO machine (centre_id, process_code, make, model, asset_tag, status, rate_per_hour, setup_fee, min_charge, student_discount_pct) VALUES
(4, 'fdm',      'Creality',   'Ender-3 V3',    'KKD-3DP-001', 'available',   150.00,  50.00, 100.00, 50),
(4, 'laser_cut','GCC',        'LaserPro C180', 'KKD-LSR-001', 'available',   350.00, 100.00, 200.00, 40);

-- ---- Anantapur (centre not live, machines shouldn't appear in search) ----
INSERT INTO machine (centre_id, process_code, make, model, asset_tag, status, rate_per_hour, setup_fee, min_charge, student_discount_pct) VALUES
(5, 'fdm',      'Bambu Lab',  'X1 Carbon',     'ATP-3DP-001', 'available',   300.00, 100.00, 200.00, 50);

-- Capabilities (real specs for these models)
INSERT INTO machine_capability (machine_id, max_x_mm, max_y_mm, max_z_mm, tolerance_mm, min_feature_mm, layer_min_mm, surface_finish) VALUES
(1,  330, 240, 300, 0.200, 0.800, 0.020, 'standard'),  -- Ultimaker S5
(2,  335, 200, 300, 0.100, 0.300, 0.025, 'fine'),      -- Form 3L
(3,  406, 305, 254, 0.013, 0.200, NULL,  'mirror'),    -- Haas Mini Mill
(4,  1000, 610, 305, 0.100, 0.100, NULL, 'standard'),  -- Trotec Speedy 400
(5,  300, 300, 300, 0.200, 0.800, 0.050, 'standard'),  -- Creality K1 Max
(6,  250, 210, 220, 0.150, 0.400, 0.050, 'fine'),      -- Prusa MK4
(7,  229, 305, 100, 0.050, 0.150, NULL,  'fine'),      -- LPKF S104
(8,  340, 340, 600, 0.150, 0.500, 0.060, 'standard'),  -- EOS P 396
(9,  230, 190, 200, 0.200, 0.800, 0.020, 'standard'),  -- Ultimaker S3
(10, 220, 220, 250, 0.300, 1.000, 0.100, 'rough'),     -- Ender-3 V3
(11, 300, 200,  50, 0.100, 0.100, NULL,  'standard'),  -- GCC C180
(12, 256, 256, 256, 0.150, 0.400, 0.020, 'fine');      -- Bambu X1C (Anantapur)

INSERT INTO machine_material (machine_id, material_code, cost_per_gram, in_stock_g, reorder_at_g) VALUES
(1, 'pla', 2.50, 4000, 500), (1, 'abs', 3.00, 2000, 500), (1, 'petg', 3.20, 1500, 500),
(2, 'resin_std', 8.00, 3000, 500),
(3, 'al_6061', 1.20, 25000, 5000),
(4, 'acrylic', 0.90, 12000, 2000), (4, 'mdf', 0.40, 20000, 3000),
(5, 'pla', 2.20, 3000, 500), (5, 'petg', 3.00, 800, 500),
(6, 'pla', 2.20, 250, 500),          -- low stock, should trigger alert
(7, 'fr4', 4.50, 2200, 500);

INSERT INTO machine_material (machine_id, material_code, cost_per_gram, in_stock_g, reorder_at_g) VALUES
(8, 'nylon_pa12', 6.50, 15000, 3000),
(9, 'pla', 2.50, 1800, 500),
(10, 'pla', 2.00, 600, 400),
(11, 'acrylic', 0.90, 5000, 1000), (11, 'mdf', 0.40, 8000, 2000),
(12, 'pla', 2.20, 2000, 500);


-- ==== multi-state centres & machines ====
-- ============================================================
-- MULTI-STATE SEED  — real centres, real equipment where known.
--
-- SOURCING NOTE (honest): centre names, cities and equipment MODELS
-- below are drawn from public sources (each state's innovation agency,
-- T-Works' own equipment pages, FabLab CEPT, iCreate, etc.). What is
-- NOT public anywhere is each machine's hourly RATE and live
-- utilisation — those are modelled estimates, realistic for the model.
-- That gap is the point: the data does not exist in one place, which
-- is exactly why ProtoHub must be built.
-- ============================================================

-- ---- STATES ----

-- backfill AP centres already seeded in seed.sql with state/zone
UPDATE centre SET state_code='AP',
  zone = CASE district
           WHEN 'Visakhapatnam' THEN 'Coastal'
           WHEN 'NTR'           THEN 'Central'
           WHEN 'Kakinada'      THEN 'Coastal'
           WHEN 'Tirupati'      THEN 'Rayalaseema'
           WHEN 'Anantapur'     THEN 'Rayalaseema'
           ELSE 'Central' END,
  operator = 'RTIH'
WHERE state_code IS NULL;

-- =====================================================================
-- TELANGANA — T-Works (real equipment from tworks.telangana.gov.in)
-- =====================================================================
INSERT INTO centre (name, district, address, lat, lng, phone, is_live, state_code, zone, operator) VALUES
('T-Works Hyderabad','Hyderabad','Raidurg, near T-Hub, Hyderabad', 17.434000, 78.381000, '040-67015100', TRUE, 'TS','Hyderabad','T-Works'),
('RICH Hyderabad','Hyderabad','Research & Innovation Circle, Hyderabad', 17.414500, 78.447000, NULL, TRUE, 'TS','Hyderabad','RICH'),
('Warangal TBI','Warangal','NIT Warangal campus', 17.982000, 79.531000, NULL, TRUE, 'TS','Warangal','NITW'),
('Khammam IIC','Khammam','Innovation & Incubation Centre, Khammam', 17.247000, 80.151000, NULL, FALSE, 'TS','Khammam','TSIC');

-- T-Works machines — these models are REAL (per T-Works equipment pages)
INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id, p, mk, md, st, rt, sf, mc, dc FROM centre, (VALUES
  ('fdm','Bambu Lab','X1E',        'available', 300,100,200,40),
  ('sla','Formlabs','Form 3L',     'available', 650,150,400,40),
  ('sla','Formlabs','Form 3+',     'available', 550,150,350,40),
  ('cnc_mill','Haas','5-Axis Mill','in_use',   2200,800,1800,25),
  ('laser_cut','CO2','120W 900x1200','available',500,100,300,35),
  ('laser_cut','CO2','80W 900x1200','available', 400,100,250,35)
) AS m(p,mk,md,st,rt,sf,mc,dc)
WHERE centre.name='T-Works Hyderabad';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Ultimaker','S7','available',400,100,250,45 FROM centre WHERE name='RICH Hyderabad'
UNION ALL SELECT id,'cnc_mill','Pocket NC','V2-50','available',700,200,500,35 FROM centre WHERE name='RICH Hyderabad';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Creality','K1','available',250,50,150,50 FROM centre WHERE name='Warangal TBI'
UNION ALL SELECT id,'cnc_mill','Roland','MDX-50','available',700,150,500,40 FROM centre WHERE name='Warangal TBI';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Creality','Ender-3 V3','available',150,50,100,50 FROM centre WHERE name='Khammam IIC'
UNION ALL SELECT id,'pcb','LPKF','ProtoMat','available',800,200,500,40 FROM centre WHERE name='Khammam IIC';

-- =====================================================================
-- KARNATAKA — CoE Bengaluru, IIITB, NAIN centres (Startup Karnataka)
-- =====================================================================
INSERT INTO centre (name, district, address, lat, lng, phone, is_live, state_code, zone, operator) VALUES
('CoE Bengaluru','Bengaluru','Centre of Excellence, Bengaluru', 12.971600, 77.594600, NULL, TRUE, 'KA','Bengaluru','KITS'),
('IIITB Innovation Centre','Bengaluru','IIIT-Bangalore, Electronic City', 12.844300, 77.663800, NULL, TRUE, 'KA','Bengaluru','IIITB'),
('NAIN Mysuru','Mysuru','New Age Innovation Network, Mysuru', 12.295800, 76.639400, NULL, TRUE, 'KA','Mysuru','NAIN'),
('NAIN Hubballi','Dharwad','NAIN Centre, Hubballi', 15.364700, 75.123900, NULL, TRUE, 'KA','Hubballi','NAIN'),
('NAIN Mangaluru','Dakshina Kannada','NAIN Centre, Mangaluru', 12.914200, 74.856000, NULL, FALSE, 'KA','Mangaluru','NAIN');

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id, p, mk, md, st, rt, sf, mc, dc FROM centre, (VALUES
  ('fdm','Stratasys','F370',     'available',2800,800,2000,25),
  ('cnc_mill','DMG Mori','CMX 50','available',3200,1000,2500,20),
  ('sla','Formlabs','Form 4',    'available', 700,150,400,40)
) AS m(p,mk,md,st,rt,sf,mc,dc)
WHERE centre.name='CoE Bengaluru';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Ultimaker','S7','available',400,100,250,45 FROM centre WHERE name='IIITB Innovation Centre'
UNION ALL SELECT id,'laser_cut','Trotec','Speedy 360','available',450,100,250,40 FROM centre WHERE name='IIITB Innovation Centre';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Creality','K1 Max','available',250,50,150,50 FROM centre WHERE name='NAIN Mysuru'
UNION ALL SELECT id,'fdm','Prusa','MK4','available',200,50,150,50 FROM centre WHERE name='NAIN Mysuru';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Creality','Ender-3 V3','available',150,50,100,50 FROM centre WHERE name='NAIN Hubballi'
UNION ALL SELECT id,'cnc_mill','Roland','SRM-20','available',600,150,400,45 FROM centre WHERE name='NAIN Hubballi';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Bambu Lab','X1 Carbon','available',300,100,200,50 FROM centre WHERE name='NAIN Mangaluru'
UNION ALL SELECT id,'pcb','LPKF','ProtoMat S104','available',800,200,500,40 FROM centre WHERE name='NAIN Mangaluru';

-- =====================================================================
-- TAMIL NADU — StartupTN, IIT-M, Coimbatore (real cities/hubs)
-- =====================================================================
INSERT INTO centre (name, district, address, lat, lng, phone, is_live, state_code, zone, operator) VALUES
('StartupTN Chennai','Chennai','CMRL Building, Nandanam, Chennai', 13.032000, 80.236000, NULL, TRUE, 'TN','Chennai','StartupTN'),
('IIT-M Incubator','Chennai','IIT Madras Research Park, Chennai', 12.991000, 80.234000, NULL, TRUE, 'TN','Chennai','IITM'),
('Coimbatore Hub','Coimbatore','StartupTN Coimbatore cluster', 11.016800, 76.955800, NULL, TRUE, 'TN','Coimbatore','StartupTN'),
('Trichy TBI','Tiruchirappalli','NIT Trichy incubation', 10.759100, 78.814600, NULL, TRUE, 'TN','Trichy','NITT'),
('Madurai IIC','Madurai','Innovation & Incubation Centre, Madurai', 9.925200, 78.119800, NULL, FALSE, 'TN','Madurai','StartupTN');

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id, p, mk, md, st, rt, sf, mc, dc FROM centre, (VALUES
  ('fdm','Markforged','Mark Two','available',1600,500,1200,30),
  ('cnc_mill','Haas','Mini Mill','available',1200,500,1000,30),
  ('sla','Formlabs','Form 3',   'available', 600,150,400,40)
) AS m(p,mk,md,st,rt,sf,mc,dc)
WHERE centre.name='StartupTN Chennai';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Stratasys','J55','available',2400,800,1800,25 FROM centre WHERE name='IIT-M Incubator'
UNION ALL SELECT id,'laser_cut','Trumpf','Fiber','available',900,200,600,30 FROM centre WHERE name='IIT-M Incubator';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id, p, mk, md, st, rt, sf, mc, dc FROM centre, (VALUES
  ('cnc_mill','DMG Mori','CLX 350','available',3200,1000,2500,20),
  ('fdm','Ultimaker','S5',        'available', 350,100,200,45),
  ('fdm','Creality','K1',         'available', 250,50,150,50)
) AS m(p,mk,md,st,rt,sf,mc,dc)
WHERE centre.name='Coimbatore Hub';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Prusa','MK4','available',200,50,150,50 FROM centre WHERE name='Trichy TBI'
UNION ALL SELECT id,'cnc_mill','Roland','MDX-40','available',700,150,500,45 FROM centre WHERE name='Trichy TBI';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Creality','Ender-3 V3','available',150,50,100,50 FROM centre WHERE name='Madurai IIC'
UNION ALL SELECT id,'pcb','LPKF','ProtoMat','available',800,200,500,40 FROM centre WHERE name='Madurai IIC';

-- =====================================================================
-- MAHARASHTRA — Maker's Asylum, BETiC/IIT-B, AIC-ADT Baramati (real)
-- =====================================================================
INSERT INTO centre (name, district, address, lat, lng, phone, is_live, state_code, zone, operator) VALUES
('Makers Asylum Mumbai','Mumbai','Andheri, Mumbai', 19.119700, 72.846500, NULL, TRUE, 'MH','Mumbai','Makers Asylum'),
('BETiC IIT-Bombay','Mumbai','IIT Bombay, Powai, Mumbai', 19.133400, 72.915100, NULL, TRUE, 'MH','Mumbai','IIT-B'),
('AIC-ADT Baramati','Pune','Sharadanagar, Baramati, Pune', 18.151700, 74.577900, '02112-255518', TRUE, 'MH','Pune','AIC-ADT'),
('Nagpur IIC','Nagpur','Innovation Centre, Nagpur', 21.145800, 79.088200, NULL, FALSE, 'MH','Vidarbha','MSInS');

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id, p, mk, md, st, rt, sf, mc, dc FROM centre, (VALUES
  ('fdm','Ultimaker','S5',    'available',350,100,200,45),
  ('laser_cut','Trotec','Speedy 400','available',450,100,250,40),
  ('cnc_mill','Roland','SRM-20','available',600,150,400,45)
) AS m(p,mk,md,st,rt,sf,mc,dc)
WHERE centre.name='Makers Asylum Mumbai';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'cnc_mill','Precision','CNC Mill','available',1400,500,1000,25 FROM centre WHERE name='BETiC IIT-Bombay'
UNION ALL SELECT id,'sla','Formlabs','Form 3B','available',650,150,400,35 FROM centre WHERE name='BETiC IIT-Bombay';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Large Format','FDM','available',300,100,200,50 FROM centre WHERE name='AIC-ADT Baramati'
UNION ALL SELECT id,'laser_cut','CO2','Laser Cutter','available',350,100,200,45 FROM centre WHERE name='AIC-ADT Baramati'
UNION ALL SELECT id,'cnc_mill','CNC','Router','available',650,150,450,45 FROM centre WHERE name='AIC-ADT Baramati';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Creality','Ender-3 V3','available',150,50,100,50 FROM centre WHERE name='Nagpur IIC';

-- =====================================================================
-- GUJARAT — iCreate Ahmedabad, FabLab CEPT (real equipment)
-- =====================================================================
INSERT INTO centre (name, district, address, lat, lng, phone, is_live, state_code, zone, operator) VALUES
('iCreate Ahmedabad','Ahmedabad','Deo Dholera, Bavla-Rajkot Highway, Ahmedabad', 22.188000, 72.185000, NULL, TRUE, 'GJ','Ahmedabad','iCreate'),
('FabLab CEPT','Ahmedabad','CEPT University, Navrangpura, Ahmedabad', 23.037400, 72.550700, NULL, TRUE, 'GJ','Ahmedabad','CEPT'),
('GUSEC','Ahmedabad','Gujarat University Startup & Entrepreneurship Council', 23.038200, 72.546400, NULL, TRUE, 'GJ','Ahmedabad','GUSEC'),
('Surat IIC','Surat','Innovation Centre, Surat', 21.170200, 72.831100, NULL, FALSE, 'GJ','Surat','GUSEC');

-- iCreate — real machines: CNC Lathe HQ400-3A, plasma CNC Intecut 5
INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id, p, mk, md, st, rt, sf, mc, dc FROM centre, (VALUES
  ('cnc_mill','CNC Lathe','HQ400-3A','available',900,300,600,30),
  ('laser_cut','Intecut','5 Plasma','available',700,200,500,35),
  ('fdm','Ultimaker','S5','available',350,100,200,45)
) AS m(p,mk,md,st,rt,sf,mc,dc)
WHERE centre.name='iCreate Ahmedabad';

-- FabLab CEPT — real machines: Shopbot, Roland MDX-20, Ultimaker 2
INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id, p, mk, md, st, rt, sf, mc, dc FROM centre, (VALUES
  ('cnc_mill','ShopBot','Gantry','available',800,200,600,40),
  ('cnc_mill','Roland','MDX-20','available',500,150,350,45),
  ('fdm','Ultimaker','2+','available',300,100,200,50),
  ('laser_cut','GCC','Laser','available',400,100,250,40)
) AS m(p,mk,md,st,rt,sf,mc,dc)
WHERE centre.name='FabLab CEPT';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Creality','K1','available',250,50,150,50 FROM centre WHERE name='GUSEC'
UNION ALL SELECT id,'pcb','LPKF','ProtoMat','available',800,200,500,40 FROM centre WHERE name='GUSEC';

INSERT INTO machine (centre_id, process_code, make, model, status, rate_per_hour, setup_fee, min_charge, student_discount_pct)
SELECT id,'fdm','Creality','Ender-3 V3','available',150,50,100,50 FROM centre WHERE name='Surat IIC';

-- =====================================================================
-- capabilities + materials for every new machine (sensible defaults by process)
-- so the matcher works nationwide. Envelope/tolerance keyed to process type.
-- =====================================================================
INSERT INTO machine_capability (machine_id, max_x_mm, max_y_mm, max_z_mm, tolerance_mm, min_feature_mm, layer_min_mm, surface_finish)
SELECT m.id,
  CASE m.process_code WHEN 'fdm' THEN 300 WHEN 'sla' THEN 335 WHEN 'cnc_mill' THEN 400 WHEN 'laser_cut' THEN 900 WHEN 'pcb' THEN 229 ELSE 250 END,
  CASE m.process_code WHEN 'fdm' THEN 300 WHEN 'sla' THEN 200 WHEN 'cnc_mill' THEN 300 WHEN 'laser_cut' THEN 1200 WHEN 'pcb' THEN 305 ELSE 250 END,
  CASE m.process_code WHEN 'fdm' THEN 300 WHEN 'sla' THEN 300 WHEN 'cnc_mill' THEN 250 WHEN 'laser_cut' THEN 12 WHEN 'pcb' THEN 50 ELSE 200 END,
  CASE m.process_code WHEN 'cnc_mill' THEN 0.02 WHEN 'sla' THEN 0.10 WHEN 'pcb' THEN 0.05 WHEN 'laser_cut' THEN 0.10 ELSE 0.20 END,
  CASE m.process_code WHEN 'cnc_mill' THEN 0.20 WHEN 'sla' THEN 0.30 WHEN 'pcb' THEN 0.15 WHEN 'laser_cut' THEN 0.10 ELSE 0.80 END,
  CASE m.process_code WHEN 'fdm' THEN 0.05 WHEN 'sla' THEN 0.025 ELSE NULL END,
  CASE m.process_code WHEN 'cnc_mill' THEN 'fine' WHEN 'sla' THEN 'fine' WHEN 'laser_cut' THEN 'standard' ELSE 'standard' END
FROM machine m
LEFT JOIN machine_capability mc ON mc.machine_id = m.id
WHERE mc.machine_id IS NULL;

-- materials by process (realistic stock)
INSERT INTO machine_material (machine_id, material_code, cost_per_gram, in_stock_g, reorder_at_g)
SELECT m.id, mat, cost, stock, reorder FROM machine m
CROSS JOIN LATERAL (
  SELECT * FROM (VALUES
    ('fdm','pla',2.20,2500,500),
    ('sla','resin_std',8.00,2000,400),
    ('cnc_mill','al_6061',1.20,18000,4000),
    ('laser_cut','acrylic',0.90,9000,2000),
    ('pcb','fr4',4.50,2000,500)
  ) AS d(proc,mat,cost,stock,reorder)
  WHERE d.proc = m.process_code
) matrow(proc,mat,cost,stock,reorder)
LEFT JOIN machine_material mm ON mm.machine_id = m.id AND mm.material_code = matrow.mat
WHERE mm.machine_id IS NULL;

-- give FDM machines a second material (ABS) for variety
INSERT INTO machine_material (machine_id, material_code, cost_per_gram, in_stock_g, reorder_at_g)
SELECT m.id, 'abs', 3.00, 1500, 400 FROM machine m
LEFT JOIN machine_material mm ON mm.machine_id=m.id AND mm.material_code='abs'
WHERE m.process_code='fdm' AND mm.machine_id IS NULL;

-- ==== historical bookings (utilisation) ====
-- ============================================================
-- DEMO UTILISATION  — seeds bookings in the last 7 days so the
-- idle-cost views show a realistic SPREAD, not "everything idle".
--
-- Strategy: give each machine a target utilisation (deterministic
-- from its id, so it's stable), then insert that many hours of
-- confirmed bookings in the past week. Flagship-centre machines
-- run busier; remote ones run cold — the real-world pattern.
-- ============================================================

-- Need an innovator to attribute bookings to. Use any existing one.
DO $$
DECLARE
    m           RECORD;
    v_user      BIGINT;
    v_target    NUMERIC;
    v_hours     INT;
    v_i         INT;
    v_open      TIME;
    v_close     TIME;
    v_day       DATE;
    v_start     TIMESTAMPTZ;
BEGIN
    SELECT id INTO v_user FROM app_user WHERE role='innovator' LIMIT 1;

    FOR m IN
        SELECT mac.id, mac.centre_id, c.opens_at, c.closes_at, c.operator, c.is_live AS centre_live, mac.status
        FROM machine mac JOIN centre c ON c.id = mac.centre_id
    LOOP
        -- target utilisation: flagship operators busier, offline/maintenance = 0
        v_target := CASE
            WHEN m.status IN ('maintenance','broken','offline') OR NOT m.centre_live THEN 0
            WHEN m.operator IN ('T-Works','iCreate','IITM','IIT-B','KITS','RTIH') THEN 0.30 + (m.id % 20)/100.0
            WHEN m.operator IN ('StartupTN','CEPT','IIITB','NITT','Makers Asylum') THEN 0.20 + (m.id % 15)/100.0
            ELSE 0.08 + (m.id % 12)/100.0   -- NAIN / remote / district centres run cold
        END;

        -- hours to book this week = target × weekly open hours (cap sensible)
        v_hours := GREATEST(0, ROUND(v_target *
            EXTRACT(EPOCH FROM (m.closes_at - m.opens_at))/3600.0 * 6)::INT);

        -- lay them down across the past 6 days, 1-2 hr blocks, avoiding overlap
        v_i := 0;
        WHILE v_hours > 0 AND v_i < 30 LOOP
            v_day := CURRENT_DATE - ((v_i % 6) + 1);
            v_start := v_day + m.opens_at + ((v_i / 6)::INT * INTERVAL '2 hours');
            -- keep inside closing time
            IF (v_start + INTERVAL '1 hour')::TIME <= m.closes_at THEN
                BEGIN
                    -- historical usage: these slots are in the past week, so they
                    -- are COMPLETED jobs (already happened), not future commitments.
                    -- completed bookings are exempt from the future-slot guard and
                    -- still count toward utilisation in v_machine_idle.
                    INSERT INTO booking (machine_id, user_id, slot, status, is_block)
                    VALUES (m.id, v_user,
                            tstzrange(v_start, v_start + INTERVAL '1 hour'),
                            'completed', FALSE);
                    v_hours := v_hours - 1;
                EXCEPTION WHEN exclusion_violation THEN
                    -- slot taken, skip
                    NULL;
                END;
            END IF;
            v_i := v_i + 1;
        END LOOP;
    END LOOP;
END $$;

-- ==== machine ops detail (operators, guides, faults) ====
-- ============================================================
-- SEED OPS DETAIL  — gives a sample of machines realistic operational
-- data (operators, guides, consumables, a fault, a maintenance window)
-- so the profile view and detail pages have something to show.
-- Apply after machine_ops.sql and the other seeds.
-- ============================================================

-- Operators / helpers for the first machine at a few flagship centres.
-- (machine ids are stable from the seed order.)
INSERT INTO machine_operator (machine_id, name, phone, role, shift_start, shift_end, is_primary, skills)
SELECT m.id, v.nm, v.ph, v.rl, v.ss, v.se, v.pri, v.sk
FROM (VALUES
  -- Visakhapatnam Ultimaker S5 (machine 1)
  (1, 'Suresh Kumar',    NULL, 'operator', TIME '09:00', TIME '17:00', TRUE,  ARRAY['fdm','slicing']),
  (1, 'Lakshmi Devi',    NULL, 'helper',   TIME '13:00', TIME '21:00', FALSE, ARRAY['fdm']),
  -- Vizag Haas CNC (machine 3) — needs a skilled operator
  (3, 'Ramesh Rao',      NULL, 'operator', TIME '09:00', TIME '17:00', TRUE,  ARRAY['cnc','cam','metrology']),
  -- Vijayawada Creality (machine 5)
  (5, 'Anil Varma',      NULL, 'operator', TIME '10:00', TIME '18:00', TRUE,  ARRAY['fdm'])
) AS v(mid, nm, ph, rl, ss, se, pri, sk)
JOIN machine m ON m.id = v.mid
ON CONFLICT DO NOTHING;

-- Usage guides. CNC & laser require a certified operator; FDM does not.
INSERT INTO machine_guide (machine_id, how_to_use, file_formats, prep_notes, safety_notes, requires_cert, requires_operator, typical_lead_hrs)
SELECT m.id, v.howto, v.ff, v.prep, v.safety, v.cert, v.op, v.lead
FROM (VALUES
  (1, 'Submit STL/3MF. Operator slices and previews. Confirm material and infill. Collect when you are told it is ready.',
      ARRAY['stl','3mf','obj'], 'Orient flat faces down; walls >= 1mm; overhangs under 60 deg print best.',
      'Hot nozzle (200C+). Do not open the lid mid-print. Operator checks the first layer.',
      FALSE, FALSE, 6.0),
  (3, 'Submit STEP/IGES with a dimensioned drawing. CAM is done by the operator. Material billet supplied or BYO.',
      ARRAY['step','iges','dxf'], 'Leave 1mm machining stock; mark the datum face; note critical tolerances.',
      'Certified operator only. Eye protection mandatory in the machining bay. No loose clothing.',
      TRUE, TRUE, 24.0),
  (5, 'Upload STL. Choose material and quality. The machine runs unattended; collect from the output rack.',
      ARRAY['stl','3mf'], 'Keep max dimension under 300mm; add a brim for tall parts.',
      'Standard FDM safety. Supervised first layer for new users.',
      FALSE, FALSE, 5.0)
) AS v(mid, howto, ff, prep, safety, cert, op, lead)
JOIN machine m ON m.id = v.mid
ON CONFLICT (machine_id) DO NOTHING;

-- Consumables / wear parts
INSERT INTO machine_consumable (machine_id, item, on_hand, reorder_at, life_hours, hours_used)
SELECT m.id, v.item, v.oh, v.ro, v.life, v.used
FROM (VALUES
  (1, '0.4mm brass nozzle',  3, 1, 250, 180),
  (1, 'PEI build sheet',     1, 1, 500, 420),   -- near end of life
  (3, 'Carbide end mill 6mm', 5, 2, 120,  40),
  (3, 'Collet ER32',         2, 1, 2000, 300),
  (5, '0.4mm nozzle',        4, 1, 250,  60)
) AS v(mid, item, oh, ro, life, used)
JOIN machine m ON m.id = v.mid
ON CONFLICT DO NOTHING;

-- Fault history (resolved — the machine's "medical record")
INSERT INTO machine_fault (machine_id, reported_by, severity, symptom, cause, fix, downtime_hours, resolved_at)
SELECT m.id, NULL::bigint, v.sev, v.sym, v.cause, v.fix, v.dt, now() - (v.days_ago || ' days')::INTERVAL
FROM (VALUES
  (1, 'minor', 'Layer shifting on tall prints', 'Loose X-axis belt', 'Re-tensioned belt, recalibrated', 2.5, 20),
  (3, 'major', 'Chatter on finishing pass',      'Worn tool holder',  'Replaced holder, reduced feed', 6.0, 45),
  (5, 'minor', 'First layer not adhering',       'Un-level bed',      'Auto-levelled, cleaned sheet', 1.0, 12)
) AS v(mid, sev, sym, cause, fix, dt, days_ago)
JOIN machine m ON m.id = v.mid
ON CONFLICT DO NOTHING;

-- One machine currently under maintenance, with reason + expected back.
-- (Trotec laser at Vizag = machine 4, which seed.sql already set to 'maintenance'.)
INSERT INTO maintenance_window (machine_id, reason, kind, expected_back, logged_by)
SELECT 4, 'Laser tube replacement and mirror re-alignment', 'repair', now() + INTERVAL '3 days', NULL
WHERE EXISTS (SELECT 1 FROM machine WHERE id=4)
  AND NOT EXISTS (SELECT 1 FROM maintenance_window WHERE machine_id=4 AND resolved_at IS NULL);


-- 60 days of sample usage history for the utilisation report (see migration 009).
SELECT generate_sample_usage_history(60);
