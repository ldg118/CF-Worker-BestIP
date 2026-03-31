CREATE TABLE IF NOT EXISTS speed_results (
  ip TEXT PRIMARY KEY,
  delay INTEGER NOT NULL,
  test_count INTEGER DEFAULT 1,
  bandwidth REAL,
  download_speed INTEGER,
  country TEXT DEFAULT 'unknown',
  city TEXT DEFAULT 'unknown',
  last_tested TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS high_quality_ips (
  ip TEXT PRIMARY KEY,
  latency INTEGER NOT NULL,
  bandwidth REAL,
  country TEXT DEFAULT 'unknown',
  city TEXT DEFAULT 'unknown',
  last_tested TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  quality_type TEXT DEFAULT 'bandwidth'
);

CREATE TABLE IF NOT EXISTS backup_quality_ips (
  ip TEXT PRIMARY KEY,
  latency INTEGER NOT NULL,
  bandwidth REAL,
  country TEXT DEFAULT 'unknown',
  city TEXT DEFAULT 'unknown',
  last_tested TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS failed_ips (
  ip TEXT PRIMARY KEY,
  failed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_str TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS region_stats (
  country TEXT PRIMARY KEY,
  ip_count INTEGER DEFAULT 0,
  avg_latency INTEGER DEFAULT 0,
  avg_bandwidth REAL,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ip_geo_cache (
  ip TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  country_name TEXT,
  city TEXT,
  lat REAL,
  lon REAL,
  isp TEXT,
  cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS region_quality (
  country TEXT PRIMARY KEY,
  ip_count INTEGER DEFAULT 0,
  avg_latency INTEGER DEFAULT 0,
  avg_bandwidth REAL,
  min_latency INTEGER DEFAULT 0,
  max_latency INTEGER DEFAULT 0,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_high_quality_latency ON high_quality_ips(latency);
CREATE INDEX IF NOT EXISTS idx_high_quality_country ON high_quality_ips(country);
CREATE INDEX IF NOT EXISTS idx_high_quality_type ON high_quality_ips(quality_type);
CREATE INDEX IF NOT EXISTS idx_speed_results_country ON speed_results(country);