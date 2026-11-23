-- Reference data needed in every install: message templates, processes,
-- materials and states. Safe to re-run.

-- notification templates (required before job events fire)
INSERT INTO notification_template (key, channel, subject, body, description) VALUES
('quote_sent','email',
 'Your ProtoHub quote for {job_title} is ready — Rs {total}',
 E'Hi {name},\n\nYour quote for "{job_title}" at {centre} is ready.\n\n'
  'Machine: {machine}\nEstimated total: Rs {total}\nValid until: {valid_until}\n\n'
  'Review and accept it here: {link}\n\n— ProtoHub, {agency}',
 'Sent when staff issue a quote'),
('job_running','sms', NULL,
 'ProtoHub: your part "{job_title}" is now being made at {centre}. Track: {link}',
 'Sent when a job enters running'),
('job_ready','email',
 'Your prototype "{job_title}" is ready for pickup',
 E'Hi {name},\n\nGood news — "{job_title}" is finished and ready to collect at {centre}.\n\n'
  'Please bring your job number {job_id}.\n\n— ProtoHub, {agency}',
 'Sent when a job is marked ready'),
('booking_confirmed','sms', NULL,
 'ProtoHub: booking confirmed for {machine} at {centre} on {slot}. See you there!',
 'Sent on booking confirmation'),
('low_stock','email',
 '[ProtoHub Ops] Low stock: {material} on {machine} at {centre}',
 E'Stock alert for {centre}.\n\n{material} on {machine} is down to {in_stock}g '
  '(reorder at {reorder}g). Please restock to avoid job failures.\n\n— ProtoHub Ops',
 'Sent to centre staff when material dips below reorder level')
ON CONFLICT (key) DO NOTHING;

-- ==== core process/material/centre/machine seed (AP) ====
-- Seed data. Machine specs are realistic for the actual models named.

INSERT INTO process (code, family, label, layman_label) VALUES
('fdm',      'additive',    'FDM 3D Printing',        'Plastic 3D printing'),
('sla',      'additive',    'SLA/Resin 3D Printing',  'Resin 3D printing (fine detail)'),
('sls',      'additive',    'SLS Nylon Printing',     'Nylon 3D printing (strong parts)'),
('cnc_mill', 'subtractive', '3-Axis CNC Milling',     'Metal/plastic machining'),
('laser_cut','subtractive', 'CO2 Laser Cutting',      'Sheet cutting & engraving'),
('pcb',      'electronics', 'PCB Prototyping',        'Circuit board making')
ON CONFLICT (code) DO NOTHING;

INSERT INTO material (code, label, class, density_g_cm3) VALUES
('pla',       'PLA',             'thermoplastic', 1.240),
('abs',       'ABS',             'thermoplastic', 1.040),
('petg',      'PETG',            'thermoplastic', 1.270),
('nylon_pa12','Nylon PA12',      'thermoplastic', 1.010),
('resin_std', 'Standard Resin',  'resin',         1.100),
('al_6061',   'Aluminium 6061',  'metal',         2.700),
('acrylic',   'Acrylic Sheet',   'other',         1.180),
('mdf',       'MDF Board',       'wood',          0.750),
('fr4',       'FR4 Copper-Clad', 'composite',     1.850)
ON CONFLICT (code) DO NOTHING;

INSERT INTO state (code, name, agency, policy_anchor, colour, is_live) VALUES
('AP','Andhra Pradesh','APIS · RTIH','AP Startup Policy 4.0 — 1 lakh jobs by 2029','f5c518',TRUE),
('TS','Telangana','TSIC · T-Works','T-Works — India''s largest prototyping centre, 250+ machines','e8822e',TRUE),
('KA','Karnataka','Startup Karnataka · KITS','266 incubators · 50 NAIN centres · ELEVATE','1c7c6c',TRUE),
('TN','Tamil Nadu','StartupTN · TANSIM','317 incubators · 208 incubation centres','c1440e',TRUE),
('MH','Maharashtra','MSInS · Maharashtra','Maharashtra State Innovation Society network','3b7dd8',TRUE),
('GJ','Gujarat','iCreate · GUSEC','iCreate Ahmedabad · FabLab CEPT','8e5bd0',TRUE)
ON CONFLICT (code) DO NOTHING;
