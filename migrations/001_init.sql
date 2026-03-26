-- 系统日志表
CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_str TEXT,
  level TEXT,
  category TEXT,
  message TEXT
);

-- 测速结果表
CREATE TABLE IF NOT EXISTS speed_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT UNIQUE,
  latency REAL,
  bandwidth REAL,
  country TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 带宽优质池
CREATE TABLE IF NOT EXISTS high_quality_ips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT UNIQUE,
  latency REAL,
  bandwidth REAL,
  country TEXT,
  city TEXT,
  star_level INTEGER,
  last_tested TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  quality_type TEXT
);

-- 备用池
CREATE TABLE IF NOT EXISTS backup_quality_ips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT UNIQUE,
  latency REAL,
  bandwidth REAL,
  country TEXT,
  last_tested TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 失败 IP 表
CREATE TABLE IF NOT EXISTS failed_ips (
  ip TEXT PRIMARY KEY,
  failed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- IP 地理位置缓存
CREATE TABLE IF NOT EXISTS ip_geo_cache (
  ip TEXT PRIMARY KEY,
  country TEXT,
  country_name TEXT,
  city TEXT,
  cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 区域质量统计
CREATE TABLE IF NOT EXISTS region_quality (
  country TEXT PRIMARY KEY,
  avg_latency REAL,
  avg_bandwidth REAL,
  ip_count INTEGER,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 测速策略
CREATE TABLE IF NOT EXISTS speed_strategy (
  id INTEGER PRIMARY KEY,
  quality_mode TEXT DEFAULT 'bandwidth',
  last_region TEXT,
  last_maintain_time TIMESTAMP,
  global_maintain_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_high_quality_latency ON high_quality_ips(latency);
CREATE INDEX IF NOT EXISTS idx_high_quality_country ON high_quality_ips(country);
CREATE INDEX IF NOT EXISTS idx_high_quality_type ON high_quality_ips(quality_type);
CREATE INDEX IF NOT EXISTS idx_speed_results_country ON speed_results(country);
CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);
CREATE INDEX IF NOT EXISTS idx_system_logs_category ON system_logs(category);
CREATE INDEX IF NOT EXISTS idx_system_logs_time ON system_logs(time_str);
