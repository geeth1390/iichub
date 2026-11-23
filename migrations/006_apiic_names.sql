-- Sample Andhra Pradesh centres are APIIC centres, not "APIC".
UPDATE centre SET name = 'APIIC ' || substr(name, 6) WHERE name LIKE 'APIC %';
