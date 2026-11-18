-- Contoh data aman untuk Pistachio DB Browser.
-- Jalankan pada database yang dipilih lewat DB_NAME.
-- Semua tabel memakai prefix pistachio_demo_; skrip ini tidak menghapus data.

CREATE TABLE IF NOT EXISTS pistachio_demo_devices (
  device_id VARCHAR(36) NOT NULL,
  device_name VARCHAR(80) NOT NULL,
  location VARCHAR(120) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'online',
  installed_at DATETIME NOT NULL,
  PRIMARY KEY (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pistachio_demo_schemes (
  scheme_id INT UNSIGNED NOT NULL,
  device_id VARCHAR(36) NOT NULL,
  scheme_name VARCHAR(80) NOT NULL,
  unit VARCHAR(16) NOT NULL DEFAULT '',
  value_type VARCHAR(16) NOT NULL DEFAULT 'number',
  min_value DECIMAL(12,3) NULL,
  max_value DECIMAL(12,3) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (scheme_id),
  KEY idx_pistachio_demo_schemes_device (device_id),
  CONSTRAINT fk_pistachio_demo_schemes_device
    FOREIGN KEY (device_id)
    REFERENCES pistachio_demo_devices (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pistachio_demo_readings (
  reading_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scheme_id INT UNSIGNED NOT NULL,
  recorded_at DATETIME NOT NULL,
  value_decimal DECIMAL(12,3) NOT NULL,
  quality VARCHAR(16) NOT NULL DEFAULT 'good',
  PRIMARY KEY (reading_id),
  KEY idx_pistachio_demo_readings_scheme_time (scheme_id, recorded_at),
  CONSTRAINT fk_pistachio_demo_readings_scheme
    FOREIGN KEY (scheme_id)
    REFERENCES pistachio_demo_schemes (scheme_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO pistachio_demo_devices
  (device_id, device_name, location, status, installed_at)
VALUES
  ('p-demo-home-001', 'Weather Station', 'Rumah - ruang keluarga', 'online', '2026-10-01 08:00:00'),
  ('p-demo-green-001', 'Greenhouse Monitor', 'Kebun - rumah kaca', 'online', '2026-10-05 09:30:00'),
  ('p-demo-work-001', 'Workshop Monitor', 'Workshop - area mesin', 'maintenance', '2026-10-12 13:15:00');

INSERT IGNORE INTO pistachio_demo_schemes
  (scheme_id, device_id, scheme_name, unit, value_type, min_value, max_value, is_active)
VALUES
  (1001, 'p-demo-home-001', 'Room Temperature', '°C', 'number', -10, 60, 1),
  (1002, 'p-demo-home-001', 'Room Humidity', '%', 'number', 0, 100, 1),
  (1003, 'p-demo-home-001', 'Barometric Pressure', 'hPa', 'number', 800, 1200, 1),
  (1004, 'p-demo-home-001', 'Light Intensity', 'lux', 'number', 0, 100000, 1),
  (2001, 'p-demo-green-001', 'Air Temperature', '°C', 'number', -10, 60, 1),
  (2002, 'p-demo-green-001', 'Soil Moisture', '%', 'number', 0, 100, 1),
  (3001, 'p-demo-work-001', 'Machine Vibration', 'mm/s', 'number', 0, 50, 1);

INSERT IGNORE INTO pistachio_demo_readings
  (reading_id, scheme_id, recorded_at, value_decimal, quality)
VALUES
  (1, 1001, '2026-11-18 07:00:00', 26.400, 'good'),
  (2, 1001, '2026-11-18 07:05:00', 26.700, 'good'),
  (3, 1001, '2026-11-18 07:10:00', 27.100, 'good'),
  (4, 1001, '2026-11-18 07:15:00', 27.300, 'good'),
  (5, 1002, '2026-11-18 07:00:00', 68.200, 'good'),
  (6, 1002, '2026-11-18 07:05:00', 67.900, 'good'),
  (7, 1002, '2026-11-18 07:10:00', 67.100, 'good'),
  (8, 1002, '2026-11-18 07:15:00', 66.800, 'good'),
  (9, 1003, '2026-11-18 07:00:00', 1008.400, 'good'),
  (10, 1003, '2026-11-18 07:05:00', 1008.100, 'good'),
  (11, 1003, '2026-11-18 07:10:00', 1007.900, 'good'),
  (12, 1003, '2026-11-18 07:15:00', 1007.600, 'good'),
  (13, 1004, '2026-11-18 07:00:00', 12.000, 'good'),
  (14, 1004, '2026-11-18 07:05:00', 18.500, 'good'),
  (15, 1004, '2026-11-18 07:10:00', 24.000, 'good'),
  (16, 1004, '2026-11-18 07:15:00', 31.500, 'good'),
  (17, 2001, '2026-11-18 07:00:00', 29.200, 'good'),
  (18, 2001, '2026-11-18 07:05:00', 29.500, 'good'),
  (19, 2002, '2026-11-18 07:00:00', 42.000, 'warning'),
  (20, 2002, '2026-11-18 07:05:00', 40.500, 'warning'),
  (21, 3001, '2026-11-18 07:00:00', 2.150, 'good'),
  (22, 3001, '2026-11-18 07:05:00', 2.480, 'good');
