-- Store coordinates, so route fulfillment can ship from the store nearest the customer.
ALTER TABLE locations ADD COLUMN latitude REAL;
ALTER TABLE locations ADD COLUMN longitude REAL;

UPDATE locations SET latitude = 40.7233, longitude = -74.0030 WHERE id = 'loc_soho';
UPDATE locations SET latitude = 37.7599, longitude = -122.4148, ships = 1 WHERE id = 'loc_mission';
