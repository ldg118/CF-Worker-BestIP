// Cloudflare Worker 优选IP可视化面板 - 双池智能优化版
// 版本: v4.5.0 - 优化界面显示，修复语法错误
// 项目地址: https://github.com/ldg118/CF-Worker-BestIP

const VERSION = 'v4.5.0';
const GITHUB_URL = 'https://github.com/ldg118/CF-Worker-BestIP';

const CONFIG = {
  defaultSources: [
    'https://raw.githubusercontent.com/ldg118/CF-Worker-BestIP/refs/heads/main/cfv4'
  ],
  kvKeys: {
    dnsConfig: 'dns_config',
    sessions: 'sessions',
    uiConfig: 'ui_config',
    advancedConfig: 'advanced_config',
    dataSources: 'data_sources',
    ipList: 'ip_list',
    lastUpdate: 'last_update',
    customIPs: 'custom_ips',
    logConfig: 'log_config'
  },
  batchConfig: {
    maxBatchSize: 20,
    flushInterval: 5000,
    cacheTTL: 30000
  },
  rateLimit: {
    bandwidthTestsPerMinute: 10,
    minTestInterval: 60000,
    batchDelay: 2000,
    ipDelay: 500
  }
};



const BANDWIDTH_LEVELS = {
  EXCELLENT: 50,
  GOOD: 20,
  FAIR: 10,
  POOR: 5
};

const COUNTRY_NAMES = {
  'CN': '中国', 'US': '美国', 'JP': '日本', 'SG': '新加坡',
  'KR': '韩国', 'DE': '德国', 'GB': '英国', 'FR': '法国',
  'CA': '加拿大', 'AU': '澳大利亚', 'IN': '印度',
  'TW': '台湾', 'HK': '香港', 'MO': '澳门', 'unknown': '未知'
};

const ASIA_REGIONS = ['CN', 'JP', 'KR', 'SG', 'HK', 'TW'];

const INIT_SQL = `
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
  level TEXT DEFAULT 'info',
  category TEXT DEFAULT 'system',
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

CREATE TABLE IF NOT EXISTS speed_strategy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_region TEXT DEFAULT 'CN',
  last_maintain_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  global_maintain_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  quality_mode TEXT DEFAULT 'bandwidth'
);

CREATE INDEX IF NOT EXISTS idx_high_quality_latency ON high_quality_ips(latency);
CREATE INDEX IF NOT EXISTS idx_high_quality_country ON high_quality_ips(country);
CREATE INDEX IF NOT EXISTS idx_high_quality_type ON high_quality_ips(quality_type);
CREATE INDEX IF NOT EXISTS idx_speed_results_country ON speed_results(country);
`;

class SimpleCache {
  constructor(ttl = 30000, maxSize = 100) {
    this.cache = new Map();
    this.ttl = ttl;
    this.maxSize = maxSize;
  }
  
  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }
  
  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }
  
  clear() { this.cache.clear(); }
}

const highQualityCache = new SimpleCache(CONFIG.batchConfig.cacheTTL, 50);
const geoCache = new SimpleCache(7 * 24 * 60 * 60 * 1000, 200);
const bandwidthCache = new SimpleCache(300000, 50);
const ipBandwidthTestCache = new Map();

// 定期清理ipBandwidthTestCache，防止内存泄漏
function cleanupIpBandwidthTestCache() {
  const now = Date.now();
  for (const [ip, timestamp] of ipBandwidthTestCache.entries()) {
    if (now - timestamp > 300000) { // 5分钟过期
      ipBandwidthTestCache.delete(ip);
    }
  }
}

let writeQueue = [];
let writeTimer = null;
let logQueue = [];
let logTimer = null;
let bandwidthTestCount = 0;
let lastBandwidthTestReset = Date.now();

const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

function isValidIPv4(ip) { return ipRegex.test(ip); }

function isValidCIDR(cidr) {
  const parts = cidr.split('/');
  if (parts.length !== 2) return false;
  const mask = parseInt(parts[1], 10);
  return isValidIPv4(parts[0]) && !isNaN(mask) && mask >= 16 && mask <= 30;
}

function expandCIDR(cidr) {
  try {
    const [ip, maskStr] = cidr.split('/');
    const mask = parseInt(maskStr, 10);
    if (mask < 16 || mask > 30) return [];
    
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4) return [];
    
    // 计算网络地址和主机地址范围
    const networkAddress = parts.slice();
    const hostBits = 32 - mask;
    const numHosts = Math.pow(2, hostBits) - 2; // 减去网络地址和广播地址
    
    // 计算网络地址
    let shift = 0;
    for (let i = 3; i >= 0; i--) {
      if (shift >= hostBits) break;
      const bitsToClear = Math.min(8, hostBits - shift);
      networkAddress[i] &= (0xFF << bitsToClear) & 0xFF;
      shift += bitsToClear;
    }
    
    const ips = [];
    // 生成所有可用的主机地址
    let current = [...networkAddress];
    for (let i = 0; i <= numHosts; i++) {
      // 跳过网络地址
      if (i === 0) {
        current = incrementIP(current);
        continue;
      }
      
      ips.push(current.join('.'));
      current = incrementIP(current);
      
      // 到达广播地址，停止
      if (i === numHosts - 1) break;
    }
    
    return ips;
  } catch (e) { return []; }
}

function incrementIP(ip) {
  const result = [...ip];
  let carry = 1;
  
  for (let i = 3; i >= 0 && carry > 0; i--) {
    const newValue = result[i] + carry;
    if (newValue > 255) {
      result[i] = 0;
      carry = 1;
    } else {
      result[i] = newValue;
      carry = 0;
    }
  }
  
  return result;
}

function compareIPs(a, b) {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
  }
  return 0;
}

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function escapeMarkdownV2(text) {
  if (!text) return '';
  return text.replace(/[\_\*\[\]\(\)\~\`\>\#\+\-\=\|\{\}\.\!]/g, '\\$&');
}

function getSourceText(source) {
  const sourceMap = {
    'manual': '手动操作',
    'auto_after_test': '测速后自动更新',
    'visitor_aware': '访客感知更新',
    'cron': '定时任务',
    'auto_after_local_test': '本地测试后自动更新'
  };
  return sourceMap[source] || source;
}

function getSessionId(request) {
  const cookie = request.headers.get('Cookie');
  if (cookie) {
    const match = cookie.match(/sessionId=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}



function calculateIPScore(latency, bandwidth) {
  let latencyScore = 0;
  if (latency <= 50) latencyScore = 100;
  else if (latency <= 100) latencyScore = 90;
  else if (latency <= 150) latencyScore = 80;
  else if (latency <= 200) latencyScore = 70;
  else if (latency <= 250) latencyScore = 60;
  else latencyScore = 50;
  
  let bandwidthScore = 0;
  if (!bandwidth || bandwidth === 0) bandwidthScore = 0;
  else if (bandwidth >= 1000) bandwidthScore = 100;
  else if (bandwidth >= 500) bandwidthScore = 95;
  else if (bandwidth >= 300) bandwidthScore = 90;
  else if (bandwidth >= 200) bandwidthScore = 85;
  else if (bandwidth >= 100) bandwidthScore = 80;
  else if (bandwidth >= 50) bandwidthScore = 60;
  else if (bandwidth >= 20) bandwidthScore = 40;
  else bandwidthScore = 20;
  
  return Math.round(bandwidthScore * 0.8 + latencyScore * 0.2);
}

function estimateBandwidthByLatency(latency) {
  if (latency <= 30) return Math.max(1, Math.round(150 + Math.random() * 100));
  if (latency <= 50) return Math.max(1, Math.round(100 + Math.random() * 80));
  if (latency <= 80) return Math.max(1, Math.round(60 + Math.random() * 60));
  if (latency <= 120) return Math.max(1, Math.round(30 + Math.random() * 40));
  if (latency <= 180) return Math.max(1, Math.round(15 + Math.random() * 20));
  return Math.max(1, Math.round(5 + Math.random() * 10));
}

function getBandwidthLevel(bandwidth) {
  if (!bandwidth) return { level: '未知', star: '❓', class: 'unknown' };
  if (bandwidth >= BANDWIDTH_LEVELS.EXCELLENT) return { level: '极速', star: '🚀', class: 'excellent' };
  if (bandwidth >= BANDWIDTH_LEVELS.GOOD) return { level: '高速', star: '⚡', class: 'good' };
  if (bandwidth >= BANDWIDTH_LEVELS.FAIR) return { level: '中等', star: '📶', class: 'fair' };
  if (bandwidth >= BANDWIDTH_LEVELS.POOR) return { level: '较慢', star: '🐌', class: 'poor' };
  return { level: '缓慢', star: '🐢', class: 'slow' };
}

async function batchWriteToD1(env) {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (writeQueue.length === 0) return;
  const queue = [...writeQueue];
  writeQueue = [];
  try {
    await env.DB.batch(queue);
  } catch (e) {
    if (queue.length <= 100) {
      writeQueue = [...queue, ...writeQueue];
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(() => batchWriteToD1(env), CONFIG.batchConfig.flushInterval);
    }
  }
}

function scheduleWrite(env) {
  if (writeTimer) return;
  writeTimer = setTimeout(() => batchWriteToD1(env), CONFIG.batchConfig.flushInterval);
}

function addToWriteQueue(env, stmt) {
  writeQueue.push(stmt);
  if (writeQueue.length >= CONFIG.batchConfig.maxBatchSize) {
    batchWriteToD1(env).catch(console.error);
  } else {
    scheduleWrite(env);
  }
}

async function sendTelegramNotification(env, { message, hideIP = true, type = 'info' }) {
  const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json') || {};
  
  if (!dnsConfig.telegramEnabled) {
    await addSystemLog(env, `Telegram通知未启用`, 'info', 'telegram');
    return;
  }
  
  const botToken = dnsConfig.telegramBotToken;
  const chatId = dnsConfig.telegramChatId;
  
  if (!botToken || !chatId) {
    await addSystemLog(env, `Telegram配置不完整`, 'warning', 'telegram');
    return;
  }
  
  try {
    // 根据消息类型选择图标和颜色
    const icons = {
      success: '✅',  // 成功
      warning: '⚠️',  // 警告
      error: '❌',    // 错误
      info: 'ℹ️'      // 信息
    };
    
    // 构建 HTML 格式消息
    let formattedMessage = `
<b>${icons[type]} ${type === 'success' ? 'DNS更新成功' : 
                       type === 'warning' ? '系统提醒' : 
                       type === 'error' ? '错误通知' : '系统通知'}</b>

<b>📅 时间：</b><code>${new Date().toLocaleString('zh-CN')}</code>
<b>📍 IP数量：</b><code>${message.ipCount || 0}个</code>
<b>🎯 来源：</b><code>${message.source || '系统'}</code>
<b>🔗 域名：</b><code>${message.domain || '未配置'}</code>

━━━━━━━━━━━━━━━
<b>✨ 优选IP列表</b>
`;

    // 格式化 IP 列表
    if (message.ips && message.ips.length) {
      message.ips.forEach((ip, idx) => {
        const ipDisplay = hideIP ? maskIP(ip.ip) : ip.ip;
        const latencyClass = getLatencyEmoji(ip.latency);
        const bandwidthEmoji = getBandwidthEmoji(ip.bandwidth);
        
        formattedMessage += `
${idx + 1}. <code>${ipDisplay}</code>
   ${latencyClass} <b>延迟：</b>${ip.latency}ms
   ${bandwidthEmoji} <b>带宽：</b>${ip.bandwidth}Mbps
   ⭐ <b>评分：</b>${ip.score || calculateIPScore(ip.latency, ip.bandwidth)}分`;
      });
    } else if (message.ipList) {
      // 兼容旧格式
      const ips = message.ipList.split('\n').filter(l => l.trim());
      ips.forEach((ipLine, idx) => {
        formattedMessage += `\n${idx + 1}. ${ipLine}`;
      });
    }
    
    // 添加统计信息
    if (message.stats) {
      formattedMessage += `
━━━━━━━━━━━━━━━
<b>📊 统计信息</b>
• 平均延迟：<b>${message.stats.avgLatency || 0}ms</b>
• 平均带宽：<b>${message.stats.avgBandwidth || 0}Mbps</b>
• 平均评分：<b>${message.stats.avgScore || 0}分</b>`;
    }
    
    // 添加版本信息
    formattedMessage += `
━━━━━━━━━━━━━━━
<code>CF优选IP ${VERSION}</code>
🔗 <a href="https://github.com/ldg118/CF-Worker-BestIP">GitHub项目地址</a>
    `;
    
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formattedMessage,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '未知错误');
      await addSystemLog(env, `Telegram通知发送失败: ${response.status} - ${errorText}`, 'error', 'telegram');
    } else {
      await addSystemLog(env, `Telegram通知发送成功`, 'info', 'telegram');
    }
    
    return await response.json();
  } catch (error) {
    await addSystemLog(env, `Telegram通知异常: ${error.message}`, 'error', 'telegram');
    console.error('Telegram发送失败:', error);
  }
}

// 辅助函数：根据延迟返回表情
function getLatencyEmoji(latency) {
  if (latency <= 30) return '🚀';
  if (latency <= 50) return '⚡';
  if (latency <= 80) return '👍';
  if (latency <= 120) return '📶';
  return '🐌';
}

// 辅助函数：根据带宽返回表情
function getBandwidthEmoji(bandwidth) {
  if (bandwidth >= 500) return '💎';
  if (bandwidth >= 200) return '🚀';
  if (bandwidth >= 100) return '⚡';
  if (bandwidth >= 50) return '📶';
  return '🐢';
}

// IP 隐私保护
function maskIP(ip) {
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.**.**`;
  }
  return ip;
}

async function addSystemLog(env, message, level = 'info', category = 'system') {
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  
  // 检查 env.DB 是否存在
  if (!env.DB) {
    console.error('数据库连接不存在，无法写入日志:', message);
    return;
  }
  
  // 只有测速相关的日志使用批处理，其他日志立即写入
  if (category === 'speed_test') {
    logQueue.push({ timeStr, level, category, message });
    if (logQueue.length >= 10) {
      try {
        await flushLogs(env);
      } catch (e) {
        console.error('批处理日志写入失败:', e);
      }
    } else if (!logTimer) {
      logTimer = setTimeout(async () => {
        try {
          await flushLogs(env);
        } catch (e) {
          console.error('定时器批处理日志写入失败:', e);
        }
      }, 2000);
    }
  } else {
    // 立即实时写入日志
    try {
      await env.DB.prepare('INSERT INTO system_logs (time_str, level, category, message) VALUES (?, ?, ?, ?)')
        .bind(timeStr, level, category, message)
        .run();
    } catch (e) {
      console.error('日志写入失败:', e);
    }
  }
}

async function flushLogs(env) {
  if (logTimer) { clearTimeout(logTimer); logTimer = null; }
  if (logQueue.length === 0) return;
  
  // 检查 env.DB 是否存在
  if (!env.DB) {
    console.error('数据库连接不存在，无法写入日志');
    logQueue = []; // 清空队列，避免重复尝试
    return;
  }
  
  const logs = [...logQueue];
  logQueue = [];
  try {
    const stmt = env.DB.prepare('INSERT INTO system_logs (time_str, level, category, message) VALUES (?, ?, ?, ?)');
    const operations = logs.map(log => stmt.bind(log.timeStr, log.level, log.category, log.message));
    if (operations.length > 0) await env.DB.batch(operations);
  } catch (e) {
    console.error('日志写入失败:', e);
  }
}



async function getSystemLogs(env, options = {}) {
  // 检查 env.DB 是否存在
  if (!env.DB) {
    console.error('数据库连接不存在，无法获取日志');
    return [];
  }
  
  try {
    const { startDate, endDate, keyword, level, category, limit = 100 } = options;
    let query = 'SELECT time_str, level, category, message FROM system_logs WHERE 1=1';
    const params = [];
    
    if (startDate) {
      query += ' AND datetime(substr(time_str, 1, 10) || " " || substr(time_str, 12), "localtime") >= datetime(?)';
      params.push(startDate);
    }
    
    if (endDate) {
      query += ' AND datetime(substr(time_str, 1, 10) || " " || substr(time_str, 12), "localtime") <= datetime(?)';
      params.push(endDate);
    }
    
    if (keyword) {
      query += ' AND message LIKE ?';
      params.push('%' + keyword + '%');
    }
    
    if (level && level !== '') {
      query += ' AND level = ?';
      params.push(level);
    }
    
    if (category && category !== '') {
      query += ' AND category = ?';
      params.push(category);
    }
    
    query += ' ORDER BY time_str DESC LIMIT ?';
    params.push(limit);
    
    const stmt = env.DB.prepare(query);
    const result = await stmt.bind(...params).all();
    return (result.results || []).map(row => ({
      timeStr: row.time_str,
      level: row.level,
      category: row.category,
      message: row.message
    }));
  } catch (e) {
    console.error('获取日志失败:', e);
    return [];
  }
}

async function initDatabase(env) {
  // 检查 env.DB 是否存在
  if (!env.DB) {
    console.error('数据库连接不存在，无法初始化数据库');
    return false;
  }
  
  try {
    const statements = INIT_SQL.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        try { await env.DB.prepare(stmt).run(); } catch (e) {}
      }
    }
    return true;
  } catch (e) { return false; }
}

async function runD1Migrations(env) {
  // 检查 env.DB 是否存在
  if (!env.DB) {
    console.error('数据库连接不存在，无法运行数据库迁移');
    return;
  }
  
  const steps = [
    `ALTER TABLE speed_strategy ADD COLUMN quality_mode TEXT DEFAULT 'bandwidth'`,
    `ALTER TABLE high_quality_ips ADD COLUMN quality_type TEXT DEFAULT 'bandwidth'`,
  ];
  for (const sql of steps) {
    try { await env.DB.prepare(sql).run(); } catch (_) {}
  }
}

async function getAdvancedConfig(env) {
  const savedConfig = await env.KV.get(CONFIG.kvKeys.advancedConfig, 'json') || {};
  const envConfig = getEnvConfig(env);
  return {
    maxHighQualityPoolSize: savedConfig.maxHighQualityPoolSize || envConfig.maxHighQualityPoolSize,
    failedIpCooldownDays: savedConfig.failedIpCooldownDays || envConfig.failedIpCooldownDays
  };
}

function getEnvConfig(env) {
    return {
      adminPassword: env.ADMIN_PASSWORD || '123',
      defaultIpCount: env.DEFAULT_IP_COUNT ? parseInt(env.DEFAULT_IP_COUNT) : 3,
      defaultTestCount: env.DEFAULT_TEST_COUNT ? parseInt(env.DEFAULT_TEST_COUNT) : 30,
      defaultThreadCount: env.DEFAULT_THREAD_COUNT ? parseInt(env.DEFAULT_THREAD_COUNT) : 10,
      defaultBandwidthFileSize: env.DEFAULT_BANDWIDTH_FILE_SIZE ? parseInt(env.DEFAULT_BANDWIDTH_FILE_SIZE) : 3,
      failedIpCooldownDays: env.FAILED_IP_COOLDOWN_DAYS ? parseInt(env.FAILED_IP_COOLDOWN_DAYS) : 15,
      maxHighQualityPoolSize: env.MAX_HIGH_QUALITY_POOL_SIZE ? parseInt(env.MAX_HIGH_QUALITY_POOL_SIZE) : 30
    };
  }

async function getIPGeo(env, ip) {
  const cached = geoCache.get(ip);
  if (cached) return cached;
  
  // 检查 env.DB 是否存在
  if (env.DB) {
    try {
      const dbCached = await env.DB.prepare('SELECT country, country_name, city FROM ip_geo_cache WHERE ip = ?').bind(ip).first();
      if (dbCached && dbCached.country) {
        const geo = { country: dbCached.country, countryName: dbCached.country_name, city: dbCached.city };
        geoCache.set(ip, geo);
        return geo;
      }
    } catch (e) {}
  }
  
  // 优先使用 ipapi.co（免费、准确）
  try {
    const resp = await fetch(`https://ipapi.co/${ip}/json/`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.country_code) {
        const geo = { 
          country: data.country_code, 
          countryName: data.country_name || data.country || '', 
          city: data.city || '' 
        };
        if (env.DB) {
          env.DB.prepare('INSERT OR REPLACE INTO ip_geo_cache (ip, country, country_name, city, cached_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)')
            .bind(ip, geo.country, geo.countryName, geo.city).run().catch(() => {});
        }
        geoCache.set(ip, geo);
        return geo;
      }
    }
  } catch (e) {}
  
  // 备用 1: ip-api.com
  try {
    const resp = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data.status === 'success' && data.countryCode) {
        const geo = { country: data.countryCode, countryName: data.country, city: data.city || '' };
        if (env.DB) {
          env.DB.prepare('INSERT OR REPLACE INTO ip_geo_cache (ip, country, country_name, city, cached_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)')
            .bind(ip, geo.country, geo.countryName, geo.city).run().catch(() => {});
        }
        geoCache.set(ip, geo);
        return geo;
      }
    }
  } catch (e) {}
  
  // 备用 2: ipwho.is（免费，无需 API key）
  try {
    const resp = await fetch(`https://ipwho.is/${ip}`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.country_code) {
        const geo = { 
          country: data.country_code, 
          countryName: data.country || '', 
          city: data.city || '' 
        };
        if (env.DB) {
          env.DB.prepare('INSERT OR REPLACE INTO ip_geo_cache (ip, country, country_name, city, cached_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)')
            .bind(ip, geo.country, geo.countryName, geo.city).run().catch(() => {});
        }
        geoCache.set(ip, geo);
        return geo;
      }
    }
  } catch (e) {}
  
  // 如果所有 API 都失败，根据 IP 段大致判断
  const ipParts = ip.split('.').map(Number);
  let guessedCountry = 'unknown';
  let guessedCountryName = '未知';
  
  // 根据常见 IP 段猜测（Cloudflare IP 范围）
  if (ipParts[0] === 104 || ipParts[0] === 172 || ipParts[0] === 162 || ipParts[0] === 173) {
    // Cloudflare IP  mostly US/Canada
    guessedCountry = 'US';
    guessedCountryName = '美国';
  } else if (ipParts[0] >= 1 && ipParts[0] <= 50) {
    guessedCountry = 'US';
    guessedCountryName = '美国';
  }
  
  const geo = { country: guessedCountry, countryName: guessedCountryName, city: '' };
  if (env.DB) {
    env.DB.prepare('INSERT OR REPLACE INTO ip_geo_cache (ip, country, country_name, city, cached_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)')
      .bind(ip, geo.country, geo.countryName, geo.city).run().catch(() => {});
  }
  geoCache.set(ip, geo);
  return geo;
}

async function addFailedIP(env, ip) {
  // 检查 env.DB 是否存在
  if (!env.DB) {
    console.error('数据库连接不存在，无法添加失败IP');
    return;
  }
  
  try {
    await env.DB.prepare('INSERT OR REPLACE INTO failed_ips (ip, failed_at) VALUES (?, CURRENT_TIMESTAMP)').bind(ip).run();
    await env.DB.prepare('DELETE FROM high_quality_ips WHERE ip = ?').bind(ip).run();
    highQualityCache.clear();
  } catch (e) {}
}

async function getFailedIPCount(env) {
  // 检查 env.DB 是否存在
  if (!env.DB) {
    console.error('数据库连接不存在，无法获取失败IP数量');
    return 0;
  }
  
  try {
    const result = await env.DB.prepare('SELECT COUNT(*) as count FROM failed_ips').first();
    return result ? result.count : 0;
  } catch (e) { return 0; }
}

async function cleanExpiredFailedIPs(env) {
  // 检查 env.DB 是否存在
  if (!env.DB) {
    console.error('数据库连接不存在，无法清理过期失败IP');
    return;
  }
  
  try {
    const advancedConfig = await getAdvancedConfig(env);
    await env.DB.prepare(`DELETE FROM failed_ips WHERE julianday('now') - julianday(failed_at) > ?`).bind(advancedConfig.failedIpCooldownDays).run();
  } catch (e) {}
}

async function cleanExpiredGeoCache(env) {
  // 检查 env.DB 是否存在
  if (!env.DB) {
    console.error('数据库连接不存在，无法清理过期地理位置缓存');
    return;
  }
  
  try {
    await env.DB.prepare(`DELETE FROM ip_geo_cache WHERE julianday('now') - julianday(cached_at) > 30`).run();
    geoCache.clear();
  } catch (e) {}
}

async function getLogConfig(env) {
  const savedConfig = await env.KV.get(CONFIG.kvKeys.logConfig, 'json') || {};
  return {
    autoClean: savedConfig.autoClean !== false,
    cleanDays: Math.min(7, Math.max(3, parseInt(savedConfig.cleanDays) || 7))
  };
}

async function cleanExpiredLogs(env) {
  // 检查 env.DB 是否存在
  if (!env.DB) {
    console.error('数据库连接不存在，无法清理过期日志');
    return;
  }
  
  try {
    const logConfig = await getLogConfig(env);
    if (logConfig.autoClean) {
      await env.DB.prepare(`DELETE FROM system_logs WHERE julianday('now') - julianday(datetime(substr(time_str, 1, 10) || ' ' || substr(time_str, 12), 'localtime')) > ?`).bind(logConfig.cleanDays).run();
    }
  } catch (e) {
    console.error('清理日志失败:', e);
  }
}

async function exportLogs(env, options = {}) {
  try {
    const logs = await getSystemLogs(env, { ...options, limit: 1000 });
    
    // 生成CSV内容
    let csvContent = '时间,级别,分类,消息\n';
    logs.forEach(log => {
      const timeStr = log.timeStr;
      const level = log.level;
      const category = log.category;
      const message = log.message.replace(/"/g, '""'); // 转义双引号
      csvContent += `"${timeStr}","${level}","${category}","${message}"\n`;
    });
    
    return csvContent;
  } catch (e) {
    console.error('导出日志失败:', e);
    return null;
  }
}

async function getBandwidthPoolIPs(env) {
  try {
    // 尝试从缓存获取
    const cached = highQualityCache.get('bandwidth_pool');
    if (cached) return cached;
    
    const advancedConfig = await getAdvancedConfig(env);
    const maxPoolSize = advancedConfig.maxHighQualityPoolSize;
    
    const result = await env.DB.prepare(`
      SELECT ip, latency, bandwidth, country 
      FROM high_quality_ips 
      ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC, latency ASC
      LIMIT ?
    `).bind(maxPoolSize).all();
    
    const ips = result.results || [];
    // 缓存结果
    highQualityCache.set('bandwidth_pool', ips);
    return ips;
  } catch (e) {
    await addSystemLog(env, `❌ getBandwidthPoolIPs 错误: ${e.message}`);
    return [];
  }
}

async function checkInBandwidthPool(env, ip) {
  try {
    const result = await env.DB.prepare('SELECT ip FROM high_quality_ips WHERE ip = ?').bind(ip).first();
    return !!result;
  } catch (e) { return false; }
}

async function checkInBackupPool(env, ip) {
  try {
    const result = await env.DB.prepare('SELECT ip FROM backup_quality_ips WHERE ip = ?').bind(ip).first();
    return !!result;
  } catch (e) { return false; }
}

async function addToBandwidthPool(env, ip, latency, bandwidth, geo, score) {
  try {
    const advancedConfig = await getAdvancedConfig(env);
    const maxPoolSize = advancedConfig.maxHighQualityPoolSize;
    
    // 带宽≥500Mbps直接加入带宽池
    if ((bandwidth || 0) >= 500) {
      const existingIP = await env.DB.prepare('SELECT ip FROM high_quality_ips WHERE ip = ?').bind(ip).first();
      if (existingIP) {
        await env.DB.prepare(`
          UPDATE high_quality_ips 
          SET latency = ?, bandwidth = ?, country = ?, city = ?, last_tested = CURRENT_TIMESTAMP, quality_type = 'bandwidth'
          WHERE ip = ?
        `).bind(latency, bandwidth || null, geo.country, geo.city, ip).run();
        await addSystemLog(env, `🔄 ${ip} 更新带宽池数据 (${latency}ms, ${bandwidth}Mbps, 评分${score})`);
        // 清除缓存
        highQualityCache.clear();
      } else {
        // 检查池大小，如果满了则替换带宽最低的IP
        const currentCount = await env.DB.prepare('SELECT COUNT(*) as count FROM high_quality_ips').first();
        if (currentCount.count >= maxPoolSize) {
          const worstIP = await env.DB.prepare(`
            SELECT ip, bandwidth 
            FROM high_quality_ips 
            ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) ASC 
            LIMIT 1
          `).first();
          if (worstIP) {
          await env.DB.prepare('DELETE FROM high_quality_ips WHERE ip = ?').bind(worstIP.ip).run();
          await addSystemLog(env, `🔄 替换带宽池IP: ${worstIP.ip}(带宽${worstIP.bandwidth || 0}Mbps) → ${ip}(带宽${bandwidth}Mbps)`);
        }
      }
      await env.DB.prepare(`
        INSERT INTO high_quality_ips 
        (ip, latency, bandwidth, country, city, last_tested, quality_type) 
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'bandwidth')
      `).bind(ip, latency, bandwidth || null, geo.country, geo.city).run();
      await addSystemLog(env, `✨ ${ip} (${geo.country}) - ${latency}ms, ${bandwidth}Mbps, 评分${score} 已加入带宽池 (优秀带宽直接加入)`);
      // 清除缓存
      highQualityCache.clear();
      }
      return;
    }
    
    // 带宽≥100Mbps的IP加入带宽池
    if ((bandwidth || 0) >= 100) {
      const existingIndex = await env.DB.prepare('SELECT ip FROM high_quality_ips WHERE ip = ?').bind(ip).first();
      if (existingIndex) {
        await env.DB.prepare(`
          UPDATE high_quality_ips 
          SET latency = ?, bandwidth = ?, country = ?, city = ?, last_tested = CURRENT_TIMESTAMP, quality_type = 'bandwidth'
          WHERE ip = ?
        `).bind(latency, bandwidth || null, geo.country, geo.city, ip).run();
        await addSystemLog(env, `🔄 ${ip} 更新带宽池数据 (${latency}ms, ${bandwidth || 0}Mbps, 评分${score})`);
        // 清除缓存
        highQualityCache.clear();
        return;
      }
      
      const currentIPs = await env.DB.prepare(`
        SELECT ip, bandwidth 
        FROM high_quality_ips 
        ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) ASC
      `).all();
      
      let currentIPList = currentIPs.results || [];
      
      // 检查是否有带宽更低的IP可以替换
      let canReplace = false;
      let replaceIP = null;
      
      for (const ipData of currentIPList) {
        if ((bandwidth || 0) > (ipData.bandwidth || 0)) {
          canReplace = true;
          replaceIP = ipData.ip;
          break;
        }
      }
      
      if (currentIPList.length < maxPoolSize || canReplace) {
        if (currentIPList.length >= maxPoolSize && replaceIP) {
          await env.DB.prepare('DELETE FROM high_quality_ips WHERE ip = ?').bind(replaceIP).run();
          await addSystemLog(env, `🔄 替换带宽池IP: ${replaceIP} → ${ip}(带宽${bandwidth || 0}Mbps > ${(currentIPList.find(item => item.ip === replaceIP)?.bandwidth || 0)}Mbps)`);
        }
        await env.DB.prepare(`
          INSERT INTO high_quality_ips 
          (ip, latency, bandwidth, country, city, last_tested, quality_type) 
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'bandwidth')
        `).bind(ip, latency, bandwidth || null, geo.country, geo.city).run();
        const newCount = await env.DB.prepare('SELECT COUNT(*) as count FROM high_quality_ips').first();
        await addSystemLog(env, `✨ ${ip} (${geo.country}) - ${latency}ms, ${bandwidth || 0}Mbps, 评分${score} 已加入带宽池 (${newCount.count}/${maxPoolSize})`);
        // 清除缓存
        highQualityCache.clear();
      } else {
        // 带宽优质池已满且当前IP带宽不高于池中所有IP，添加到备用池
        await addToBackupPool(env, ip, latency, bandwidth, geo, score);
      }
    } else {
      await addSystemLog(env, `⏭️ ${ip} - 带宽${bandwidth || 0}Mbps低于100Mbps，进入备用池`);
    }
  } catch (e) {
    await addSystemLog(env, `❌ 添加IP到带宽池失败 ${ip}: ${e.message}`);
  }
}

async function addToBackupPool(env, ip, latency, bandwidth, geo, score) {
  try {
    const maxBackupPoolSize = 50;
    
    const existingIP = await env.DB.prepare('SELECT ip FROM backup_quality_ips WHERE ip = ?').bind(ip).first();
    if (existingIP) {
      await env.DB.prepare(`
        UPDATE backup_quality_ips 
        SET latency = ?, bandwidth = ?, country = ?, city = ?, last_tested = CURRENT_TIMESTAMP
        WHERE ip = ?
      `).bind(latency, bandwidth || null, geo.country, geo.city, ip).run();
      await addSystemLog(env, `🔄 ${ip} 更新备用池数据 (${latency}ms, ${bandwidth || 0}Mbps, 评分${score})`);
      return;
    }
    
    const currentCount = await env.DB.prepare('SELECT COUNT(*) as count FROM backup_quality_ips').first();
    let currentPoolSize = currentCount ? currentCount.count : 0;
    
    if (currentPoolSize >= maxBackupPoolSize) {
      const worstIP = await env.DB.prepare(`
        SELECT ip, bandwidth 
        FROM backup_quality_ips 
        ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) ASC 
        LIMIT 1
      `).first();
      if (worstIP) {
        await env.DB.prepare('DELETE FROM backup_quality_ips WHERE ip = ?').bind(worstIP.ip).run();
        await addSystemLog(env, `🔄 替换备用池IP: ${worstIP.ip}(带宽${worstIP.bandwidth || 0}Mbps) → ${ip}(带宽${bandwidth || 0}Mbps)`);
      }
    }
    
    await env.DB.prepare(`
      INSERT INTO backup_quality_ips 
      (ip, latency, bandwidth, country, city, last_tested) 
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(ip, latency, bandwidth || null, geo.country, geo.city).run();
    
    const newCount = await env.DB.prepare('SELECT COUNT(*) as count FROM backup_quality_ips').first();
    await addSystemLog(env, `📌 ${ip} (${geo.country}) - ${latency}ms, ${bandwidth || 0}Mbps, 评分${score} 已加入备用池 (${newCount.count}/${maxBackupPoolSize})`);
  } catch (e) {
    await addSystemLog(env, `❌ 添加IP到备用池失败 ${ip}: ${e.message}`);
  }
}

async function cleanLatencyPool(env) {
  try {
    const countResult = await env.DB.prepare('SELECT COUNT(*) as count FROM latency_quality_ips').first();
    let currentCount = countResult ? countResult.count : 0;
    
    if (currentCount > 30) {
      const excess = currentCount - 30;
      const worstIPs = await env.DB.prepare('SELECT ip, latency FROM latency_quality_ips ORDER BY latency DESC LIMIT ?').bind(excess).all();
      
      if (worstIPs.results && worstIPs.results.length > 0) {
        for (const ipData of worstIPs.results) {
          await env.DB.prepare('DELETE FROM latency_quality_ips WHERE ip = ?').bind(ipData.ip).run();
        }
        await addSystemLog(env, `🧹 延迟池清理完成: 删除 ${excess} 个IP，当前 30/30`);
      }
    }
  } catch (e) {
    await addSystemLog(env, `❌ 延迟池清理失败: ${e.message}`);
  }
}

async function cleanHighQualityPool(env, force = false) {
  try {
    const advancedConfig = await getAdvancedConfig(env);
    const maxPoolSize = advancedConfig.maxHighQualityPoolSize;
    
    const allIPs = await env.DB.prepare(`
      SELECT ip, latency, bandwidth 
      FROM high_quality_ips 
      ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC, latency ASC
    `).all();
    
    const currentIPs = allIPs.results || [];
    const currentCount = currentIPs.length;
    
    if (currentCount > maxPoolSize) {
      const toDelete = currentIPs.slice(maxPoolSize);
      for (const ip of toDelete) {
        await env.DB.prepare('DELETE FROM high_quality_ips WHERE ip = ?').bind(ip.ip).run();
      }
      await addSystemLog(env, `🧹 带宽池清理: 删除 ${toDelete.length} 个IP，当前 ${maxPoolSize}/${maxPoolSize}`);
    } else if (force && currentCount > 0) {
      await env.DB.prepare('DELETE FROM high_quality_ips').run();
      await env.DB.prepare('DELETE FROM backup_quality_ips').run();
      await addSystemLog(env, `🧹 强制清理带宽池: 删除 ${currentCount} 个IP`);
    }
    
    return { success: true };
  } catch (e) {
    await addSystemLog(env, `❌ cleanHighQualityPool 错误: ${e.message}`);
    return { success: false };
  }
}

async function repairBandwidthPool(env) {
  try {
    await addSystemLog(env, `🔧 开始修复带宽池...`);
    
    await cleanHighQualityPool(env, true);
    
    const advancedConfig = await getAdvancedConfig(env);
    const maxPoolSize = advancedConfig.maxHighQualityPoolSize;
    
    const goodIPs = await env.DB.prepare(`
      SELECT ip, delay as latency, bandwidth, country, city 
      FROM speed_results 
      WHERE delay <= 150 AND (bandwidth > 30 OR bandwidth IS NOT NULL)
      ORDER BY bandwidth DESC, delay ASC
      LIMIT ?
    `).bind(maxPoolSize).all();
    
    await addSystemLog(env, `📊 找到 ${goodIPs.results?.length || 0} 个符合条件的IP`);
    
    let addedCount = 0;
    
    for (const ipData of goodIPs.results || []) {
      const geo = await getIPGeo(env, ipData.ip);
      const score = calculateIPScore(ipData.latency, ipData.bandwidth || 0);
      
      await env.DB.prepare(`
          INSERT INTO high_quality_ips 
          (ip, latency, bandwidth, country, city, last_tested, quality_type) 
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'bandwidth')
        `).bind(ipData.ip, ipData.latency, ipData.bandwidth, geo.country, geo.city).run();
      
      addedCount++;
    }
    
    await cleanHighQualityPool(env);
    
    const finalCount = await env.DB.prepare('SELECT COUNT(*) as count FROM high_quality_ips').first();
    await addSystemLog(env, `✅ 带宽池修复完成，当前总数: ${finalCount?.count || 0}/${maxPoolSize}，本次新增: ${addedCount}`);
    
    return { success: true, addedCount, totalCount: finalCount?.count || 0 };
  } catch (e) {
    await addSystemLog(env, `❌ 带宽池修复失败: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function debugBandwidthPool(env) {
  try {
    const allIPs = await env.DB.prepare(`
      SELECT ip, latency, bandwidth, country, quality_type, last_tested 
      FROM high_quality_ips 
      ORDER BY bandwidth DESC, latency ASC
      LIMIT 20
    `).all();
    
    const speedResults = await env.DB.prepare(`
      SELECT ip, delay, bandwidth 
      FROM speed_results 
      WHERE delay <= 150 AND bandwidth > 50
      ORDER BY bandwidth DESC
      LIMIT 10
    `).all();
    
    const stats = await env.DB.prepare(`
      SELECT 
        COUNT(*) as total,
        AVG(latency) as avg_latency,
        AVG(bandwidth) as avg_bandwidth
      FROM high_quality_ips
    `).first();
    
    return {
      success: true,
      stats,
      highQualityIPs: allIPs.results || [],
      speedResultsIPs: speedResults.results || []
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function shouldPerformBandwidthTest(ip, isRetest, latency = null) {
  const now = Date.now();
  
  const lastTestTime = ipBandwidthTestCache.get(ip);
  if (lastTestTime && now - lastTestTime < 300000) {
    return false;
  }
  
  if (now - lastBandwidthTestReset > 60000) {
    bandwidthTestCount = 0;
    lastBandwidthTestReset = now;
  }
  
  if (!isRetest && bandwidthTestCount < CONFIG.rateLimit.bandwidthTestsPerMinute) {
    bandwidthTestCount++;
    ipBandwidthTestCache.set(ip, now);
    return true;
  }
  
  if (isRetest && bandwidthTestCount < 3) {
    bandwidthTestCount++;
    ipBandwidthTestCache.set(ip, now);
    return true;
  }
  
  if (latency && latency <= 80 && bandwidthTestCount < CONFIG.rateLimit.bandwidthTestsPerMinute) {
    bandwidthTestCount++;
    ipBandwidthTestCache.set(ip, now);
    return true;
  }
  
  return false;
}

async function speedTestWithBandwidth(env, ip, geo = null, isRetest = false, ctx = null) {
  try {
    const cached = bandwidthCache.get(ip);
    if (cached) {
      await addSystemLog(env, `${ip} - 使用缓存带宽数据`, 'info', 'speed_test');
      return cached;
    }
    
    const savedConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
    const bandwidthFileSize = savedConfig.bandwidthFileSize || 3;
    const testBytes = bandwidthFileSize * 1000000;
    
    let totalLatency = 0, successCount = 0, latencyResults = [];
    
    for (let i = 0; i < 3; i++) {
      try {
        const startTime = Date.now();
        const response = await fetch('https://speed.cloudflare.com/__down?bytes=1000', {
          headers: { 'Host': 'speed.cloudflare.com' },
          cf: { resolveOverride: ip },
          signal: AbortSignal.timeout(5000)
        });
        if (response.ok) {
          await response.text();
          totalLatency += Date.now() - startTime;
          successCount++;
          latencyResults.push(Date.now() - startTime);
        } else {
          latencyResults.push(null);
        }
      } catch (e) {
        latencyResults.push(null);
      }
      if (i < 2) await new Promise(r => setTimeout(r, 100));
    }
    
    if (successCount === 0) {
      await addFailedIP(env, ip);
      await addSystemLog(env, `${ip} - 延迟测试失败`, 'error', 'speed_test');
      return { success: false, ip, latency: null, bandwidth: null };
    }
    
    const avgLatency = Math.round(totalLatency / successCount);
    const minLatency = Math.min(...latencyResults.filter(r => r !== null));
    
    let bandwidthMbps = null;
    let downloadSpeed = null;
    
    const shouldTest = await shouldPerformBandwidthTest(ip, isRetest, avgLatency);
    
    if (shouldTest) {
      try {
        const downloadStartTime = Date.now();
        const response = await fetch(`https://speed.cloudflare.com/__down?bytes=${testBytes}`, {
          headers: { 'Host': 'speed.cloudflare.com' },
          cf: { resolveOverride: ip },
          signal: AbortSignal.timeout(20000)
        });
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const downloadTime = (Date.now() - downloadStartTime) / 1000;
          bandwidthMbps = Math.round((arrayBuffer.byteLength * 8) / (downloadTime * 1000000) * 100) / 100;
          downloadSpeed = Math.round(arrayBuffer.byteLength / downloadTime / 1024);
          
          bandwidthCache.set(ip, {
            success: true, ip, latency: avgLatency, minLatency,
            maxLatency: Math.max(...latencyResults.filter(r => r !== null)),
            bandwidth: bandwidthMbps, downloadSpeed,
            bandwidthLevel: getBandwidthLevel(bandwidthMbps).level,
            score: calculateIPScore(avgLatency, bandwidthMbps || 0),
            country: geo.country, countryName
          });
        } else {
          await addSystemLog(env, `${ip} - 带宽测试返回 ${response.status}`, 'warning', 'speed_test');
          bandwidthMbps = estimateBandwidthByLatency(avgLatency);
        }
      } catch (e) {
        await addSystemLog(env, `${ip} - 带宽测试失败: ${e.message}`, 'warning', 'speed_test');
        bandwidthMbps = estimateBandwidthByLatency(avgLatency);
      }
    } else {
      bandwidthMbps = estimateBandwidthByLatency(avgLatency);
    }
    
    if (!geo) geo = await getIPGeo(env, ip);
    
    const bandwidthLevel = getBandwidthLevel(bandwidthMbps);
    const countryName = COUNTRY_NAMES[geo.country] || geo.country || '未知';
    const score = calculateIPScore(avgLatency, bandwidthMbps || 0);
    
    const writePromise = (async () => {
      try {
        await env.DB.prepare(`
          INSERT OR REPLACE INTO speed_results 
          (ip, delay, test_count, bandwidth, download_speed, country, city, last_tested) 
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(ip, avgLatency, successCount, bandwidthMbps || null, downloadSpeed || null, geo.country, geo.city).run();
      } catch (e) {
        addToWriteQueue(env, env.DB.prepare(`
          INSERT OR REPLACE INTO speed_results 
          (ip, delay, test_count, bandwidth, download_speed, country, city, last_tested) 
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(ip, avgLatency, successCount, bandwidthMbps || null, downloadSpeed || null, geo.country, geo.city));
      }
    })();
    
    if (ctx) {
      ctx.waitUntil(writePromise);
    } else {
      await writePromise;
    }
    
    const inBandwidthPool = await checkInBandwidthPool(env, ip);
    const inBackupPool = await checkInBackupPool(env, ip);
    
    const isHighQuality = (bandwidthMbps || 0) >= 100;
    const isExcellentBandwidth = (bandwidthMbps || 0) >= 500;
    
    if (isRetest && (inBandwidthPool || inBackupPool)) {
      if (isHighQuality || isExcellentBandwidth) {
        if (inBackupPool) {
          await env.DB.prepare('DELETE FROM backup_quality_ips WHERE ip = ?').bind(ip).run();
          await addToBandwidthPool(env, ip, avgLatency, bandwidthMbps, geo, score);
          await addSystemLog(env, `${ip} 带宽优秀，从备用池升级到带宽池`, 'info', 'pool_management');
        } else if (inBandwidthPool) {
          await env.DB.prepare(`
            UPDATE high_quality_ips 
            SET latency = ?, bandwidth = ?, country = ?, city = ?, last_tested = CURRENT_TIMESTAMP, quality_type = 'bandwidth'
            WHERE ip = ?
          `).bind(avgLatency, bandwidthMbps || null, geo.country, geo.city, ip).run();
          await addSystemLog(env, `${ip} 更新带宽池数据`, 'info', 'pool_management');
        }
      } else {
        if (inBandwidthPool) {
          await env.DB.prepare('DELETE FROM high_quality_ips WHERE ip = ?').bind(ip).run();
          await addSystemLog(env, `${ip} 带宽不足(评分${score})，从带宽池移除`, 'info', 'pool_management');
        }
        if (inBackupPool) {
          await env.DB.prepare('DELETE FROM backup_quality_ips WHERE ip = ?').bind(ip).run();
          await addSystemLog(env, `${ip} 带宽不足(评分${score})，从备用池移除`, 'info', 'pool_management');
        }
      }
    } else if (!inBandwidthPool && !inBackupPool) {
      if (isHighQuality || isExcellentBandwidth) {
        await addToBandwidthPool(env, ip, avgLatency, bandwidthMbps, geo, score);
      } else {
        await addSystemLog(env, `${ip} - 带宽不足(评分${score})，不加入任何池`, 'info', 'speed_test');
      }
    }
    
    const bandwidthInfo = bandwidthMbps ? ` | 带宽: ${bandwidthMbps} Mbps ${bandwidthLevel.star}` : ' | 带宽: 估算值';
    await addSystemLog(env, `${ip} (${countryName}) - 延迟:${avgLatency}ms ${bandwidthInfo} | 评分:${score}`, 'info', 'speed_test');
    
    return { 
      success: true, ip, latency: avgLatency, minLatency, maxLatency: Math.max(...latencyResults.filter(r => r !== null)),
      bandwidth: bandwidthMbps, downloadSpeed, bandwidthLevel: bandwidthLevel.level,
      score, country: geo.country, countryName
    };
  } catch (error) {
    await addSystemLog(env, `${ip} - 测速异常: ${error.message}`, 'error', 'speed_test');
    return { success: false, ip, error: error.message, latency: null, bandwidth: null };
  }
}

async function smartSpeedTest(env, options = {}, ctx = null) {
  const { maxConcurrent = 2, batchDelay = 2000, maxRetries = 1, timeout = 10000 } = options;
  
  bandwidthTestCount = 0;
  lastBandwidthTestReset = Date.now();
  
  // 清理过期的带宽测试缓存
  cleanupIpBandwidthTestCache();
  
  try {
    await cleanHighQualityPool(env);
    
    const uiConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
    const config = getEnvConfig(env);
    const advancedConfig = await getAdvancedConfig(env);
    const maxPoolSize = advancedConfig.maxHighQualityPoolSize;
    
    const bandwidthPoolIPs = await getBandwidthPoolIPs(env);
    const currentBandwidthCount = bandwidthPoolIPs.length;
    
    let finalTestCount = uiConfig.testCount || config.defaultTestCount;
    if (currentBandwidthCount >= maxPoolSize * 0.9) {
      finalTestCount = Math.min(finalTestCount, 30);
    } else if (currentBandwidthCount < maxPoolSize * 0.3) {
      finalTestCount = Math.min(finalTestCount * 1.5, 100);
    }
    
    const existingIPs = new Set([...bandwidthPoolIPs.map(ip => ip.ip)]);
    const allIPs = await getAllIPs(env);
    
    // 按优先级排序：历史高带宽IP > 带宽优质池 > 延迟池（备用池） > 总IP池 > 失败池
    const highBandwidthIPs = await env.DB.prepare(`
      SELECT ip, bandwidth 
      FROM speed_results 
      WHERE bandwidth >= 100 
      ORDER BY bandwidth DESC 
      LIMIT 50
    `).all();
    
    const highBandwidthIPList = (highBandwidthIPs.results || []).map(item => item.ip);
    const highBandwidthIPSet = new Set(highBandwidthIPList);
    
    // 分离IP池
    const bandwidthPoolIPSet = new Set(bandwidthPoolIPs.map(ip => ip.ip));
    const newIPs = allIPs.filter(ip => !existingIPs.has(ip));
    
    // 构建测试队列
    let ipsToTest = [];
    
    // 1. 历史高带宽IP（未在池中的）
    const highBandwidthNewIPs = highBandwidthIPList.filter(ip => !existingIPs.has(ip));
    ipsToTest.push(...highBandwidthNewIPs);
    
    // 2. 带宽优质池IP（需要重新测试的）
    const bandwidthPoolRetest = bandwidthPoolIPs
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
      .map(ip => ip.ip);
    ipsToTest.push(...bandwidthPoolRetest);
    
    // 3. 备用池IP
    const backupPoolIPs = await env.DB.prepare(`
      SELECT ip, bandwidth 
      FROM backup_quality_ips 
      ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC
    `).all();
    const backupPoolRetest = (backupPoolIPs.results || [])
      .map(ip => ip.ip);
    ipsToTest.push(...backupPoolRetest);
    
    // 4. 总IP池中的新IP
    ipsToTest.push(...newIPs);
    
    // 去重并限制数量
    ipsToTest = [...new Set(ipsToTest)].slice(0, finalTestCount);
    
    // 随机排序测试队列
    ipsToTest = ipsToTest.sort(() => 0.5 - Math.random());
    
    if (ipsToTest.length === 0) {
      await addSystemLog(env, '没有需要测试的IP', 'info', 'speed_test');
      return { success: true, message: '无需测试' };
    }
    
    await addSystemLog(env, `智能测速: 测试 ${ipsToTest.length} 个IP`, 'info', 'speed_test');
    
    const batchSize = Math.min(maxConcurrent, 2);
    const existingSet = new Set(existingIPs);
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < ipsToTest.length; i += batchSize) {
      const batch = ipsToTest.slice(i, i + batchSize);
      
      for (let j = 0; j < batch.length; j++) {
        const ip = batch[j];
        let lastError = null;
        let result = null;
        
        for (let retry = 0; retry <= maxRetries; retry++) {
          try {
            result = await Promise.race([
              speedTestWithBandwidth(env, ip, null, existingSet.has(ip), ctx),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
            ]);
            if (result.success) {
              successCount++;
              break;
            }
            lastError = result.error;
          } catch (e) {
            lastError = e.message;
            if (retry < maxRetries) {
              await new Promise(r => setTimeout(r, 500 * (retry + 1)));
            }
          }
        }
        
        if (!result || !result.success) {
          failCount++;
        }
        
        if (j < batch.length - 1) {
          await new Promise(resolve => setTimeout(resolve, CONFIG.rateLimit.ipDelay));
        }
      }
      
      if (i + batchSize < ipsToTest.length) {
        await new Promise(resolve => setTimeout(resolve, batchDelay));
      }
    }
    
    await batchWriteToD1(env);
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    highQualityCache.clear();
    geoCache.clear();
    await cleanHighQualityPool(env);
    await cleanLatencyPool(env);
    await updateRegionStats(env);
    await updateRegionQuality(env);
    
    const newBandwidthCount = (await getBandwidthPoolIPs(env)).length;
    await addSystemLog(env, `测速完成 | 成功: ${successCount}, 失败: ${failCount} | 带宽池: ${newBandwidthCount}/${maxPoolSize}`, 'info', 'speed_test');
    await sendTelegramNotification(env, {
      message: {
        ipCount: successCount,
        source: '测速任务',
        stats: {
          avgLatency: 0,
          avgBandwidth: 0,
          avgScore: 0
        }
      },
      type: 'success'
    });
    
    // 检查是否需要在测速完成后自动更新DNS
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    await addSystemLog(env, `检查自动更新DNS: autoUpdateAfterTest=${dnsConfig?.autoUpdateAfterTest}, DNS配置完整=${!!(dnsConfig?.apiToken && dnsConfig?.zoneId && dnsConfig?.recordName)}`, 'info', 'dns');
    if (dnsConfig?.autoUpdateAfterTest) {
      const config = getEnvConfig(env);
      const uiConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
      const ipCount = uiConfig.ipCount || config.defaultIpCount;
      // 先尝试获取中国IP，如果没有则获取全球IP
      let bestIPs = await getBestIPs(env, 'CN', ipCount);
      await addSystemLog(env, `自动更新DNS: 找到 ${bestIPs.length} 个中国最佳IP`, 'info', 'dns');
      if (bestIPs.length === 0) {
        await addSystemLog(env, `没有找到中国IP，尝试获取全球最佳IP`, 'info', 'dns');
        bestIPs = await getBestIPs(env, null, ipCount);
        await addSystemLog(env, `自动更新DNS: 找到 ${bestIPs.length} 个全球最佳IP`, 'info', 'dns');
      }
      if (bestIPs.length > 0) {
        await updateDNSBatch(env, bestIPs.map(item => item.ip), 'auto_after_test');
        await addSystemLog(env, `测速完成后自动更新DNS: ${bestIPs.length} 个IP`, 'info', 'dns');
      } else {
        await addSystemLog(env, `自动更新DNS失败: 没有找到最佳IP`, 'warning', 'dns');
      }
    }
    
    return { success: true, successCount, failCount, bandwidthCount: newBandwidthCount };
  } catch (e) {
    await addSystemLog(env, `测速失败: ${e.message}`, 'error', 'speed_test');
    return { success: false, error: e.message };
  }
}

async function updateRegionQuality(env) {
  try {
    const stats = await env.DB.prepare(`
      SELECT country, COUNT(*) as ip_count, AVG(latency) as avg_latency, AVG(bandwidth) as avg_bandwidth,
             MIN(latency) as min_latency, MAX(latency) as max_latency
      FROM high_quality_ips WHERE country != 'unknown' GROUP BY country
    `).all();
    
    const operations = [];
    for (const stat of stats.results || []) {
      operations.push(env.DB.prepare(`
        INSERT OR REPLACE INTO region_quality (country, ip_count, avg_latency, avg_bandwidth, min_latency, max_latency, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(stat.country, stat.ip_count, Math.round(stat.avg_latency), stat.avg_bandwidth ? Math.round(stat.avg_bandwidth * 10) / 10 : null, stat.min_latency, stat.max_latency));
    }
    if (operations.length > 0) await env.DB.batch(operations);
  } catch (e) {}
}

async function updateRegionStats(env) {
  try {
    const stats = await env.DB.prepare(`
      SELECT country, COUNT(*) as ip_count, AVG(latency) as avg_latency, AVG(bandwidth) as avg_bandwidth
      FROM high_quality_ips WHERE country != 'unknown' GROUP BY country
    `).all();
    
    const operations = [];
    for (const stat of stats.results || []) {
      operations.push(env.DB.prepare(`
        INSERT OR REPLACE INTO region_stats (country, ip_count, avg_latency, avg_bandwidth, last_updated)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(stat.country, stat.ip_count, Math.round(stat.avg_latency), stat.avg_bandwidth ? Math.round(stat.avg_bandwidth * 10) / 10 : null));
    }
    if (operations.length > 0) await env.DB.batch(operations);
  } catch (e) {}
}

async function getSpeedStrategy(env) {
  try {
    let strategy = await env.DB.prepare('SELECT last_region, last_maintain_time, global_maintain_count FROM speed_strategy WHERE id = 1').first();
    if (!strategy) {
      await env.DB.prepare(`INSERT INTO speed_strategy (id, last_region, last_maintain_time, global_maintain_count) VALUES (1, 'CN', CURRENT_TIMESTAMP, 0)`).run();
      strategy = { last_region: 'CN', last_maintain_time: new Date().toISOString(), global_maintain_count: 0 };
    }
    
    let regionStats;
    try {
      regionStats = await env.DB.prepare(`SELECT country, ip_count FROM region_quality WHERE country IN ('CN','JP','KR','SG','HK','TW')`).all();
    } catch (e) {
      regionStats = { results: [] };
    }
    
    const countMap = new Map();
    for (const stat of regionStats.results || []) countMap.set(stat.country, stat.ip_count);
    
    let minCountry = 'CN', minCount = 100;
    for (const region of ASIA_REGIONS) {
      const count = countMap.get(region) || 0;
      if (count < minCount) { minCount = count; minCountry = region; }
    }
    
    if (countMap.size === 0) {
      minCountry = 'CN';
      minCount = 0;
    }
    
    const now = new Date();
    const asiaHour = (now.getHours() + 8) % 24;
    const lastMaintain = new Date(strategy.last_maintain_time);
    const hoursSinceMaintain = (now - lastMaintain) / (1000 * 60 * 60);
    
    let globalCount = strategy.global_maintain_count || 0;
    
    if (minCount < 10) return { type: 'urgent', country: minCountry, count: minCount };
    if (hoursSinceMaintain > 24) return { type: 'maintain', country: minCountry, count: minCount };
    if (asiaHour >= 0 && asiaHour < 6 && new Date().getDay() === 0) {
      globalCount++;
      return { type: 'global', globalCount: globalCount };
    }
    if (asiaHour >= 0 && asiaHour < 6) return { type: 'global', globalCount: globalCount };
    
    const regionOrder = ['CN', 'JP', 'KR', 'SG', 'HK', 'TW'];
    let currentIndex = regionOrder.indexOf(strategy.last_region);
    let nextIndex = (currentIndex + 1) % regionOrder.length;
    let nextCountry = regionOrder[nextIndex];
    
    if ((countMap.get(nextCountry) || 0) > 30) {
      nextIndex = (nextIndex + 1) % regionOrder.length;
      nextCountry = regionOrder[nextIndex];
    }
    
    return { type: 'maintain', country: nextCountry, count: countMap.get(nextCountry) || 0 };
  } catch (e) {
    const now = new Date();
    const asiaHour = (now.getHours() + 8) % 24;
    if (asiaHour >= 0 && asiaHour < 6) {
      return { type: 'global', globalCount: 0 };
    }
    return { type: 'maintain', country: 'CN', count: 0 };
  }
}

async function updateSpeedStrategy(env, targetCountry) {
  try {
    const now = new Date();
    const asiaHour = (now.getHours() + 8) % 24;
    let globalInc = (!targetCountry && asiaHour >= 0 && asiaHour < 6) ? 1 : 0;
    
    const current = await env.DB.prepare('SELECT global_maintain_count FROM speed_strategy WHERE id = 1').first();
    const newCount = (current?.global_maintain_count || 0) + globalInc;
    
    await env.DB.prepare(`
      INSERT OR REPLACE INTO speed_strategy (id, last_region, last_maintain_time, global_maintain_count, updated_at)
      VALUES (1, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
    `).bind(targetCountry || 'CN', newCount).run();
  } catch (e) {}
}

async function getTotalIPCount(env) {
  try {
    const ips = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
    return ips.length;
  } catch (e) { return 0; }
}

async function getAllIPs(env) {
  try {
    // 尝试从缓存获取
    const cached = highQualityCache.get('all_ips');
    if (cached) return cached;
    
    const ips = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
    const customIPs = await env.KV.get(CONFIG.kvKeys.customIPs, 'json') || [];
    const result = [...new Set([...ips, ...customIPs])];
    
    // 缓存结果
    highQualityCache.set('all_ips', result);
    return result;
  } catch (e) { return []; }
}

async function updateIPs(env) {
  let allIPs = new Set();
  const sources = await getDataSources(env);
  
  for (const source of sources) {
    try {
      const resp = await fetch(source);
      const text = await resp.text();
      const ipPattern = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:\/[0-9]{1,2})?\b/g;
      const matches = text.match(ipPattern) || [];
      
      let expandedCount = 0;
      for (const item of matches) {
        if (item.includes('/')) {
          const expanded = expandCIDR(item);
          expanded.forEach(ip => allIPs.add(ip));
          expandedCount += expanded.length;
        } else if (isValidIPv4(item)) {
          allIPs.add(item);
        }
      }
      await addSystemLog(env, `📡 从 ${source} 获取到 ${matches.length} 个CIDR，展开后 ${expandedCount} 个IP`);
    } catch (e) {
      await addSystemLog(env, `❌ 从 ${source} 获取失败: ${e.message}`);
    }
  }

  const customIPs = await env.KV.get(CONFIG.kvKeys.customIPs, 'json') || [];
  for (const item of customIPs) {
    if (item.includes('/')) {
      expandCIDR(item).forEach(ip => allIPs.add(ip));
    } else {
      allIPs.add(item);
    }
  }

  const ipList = Array.from(allIPs).sort(compareIPs);
  await env.KV.put(CONFIG.kvKeys.ipList, JSON.stringify(ipList));
  await env.KV.put(CONFIG.kvKeys.lastUpdate, new Date().toLocaleString('zh-CN'));
  // 清除缓存
  highQualityCache.clear();
  await addSystemLog(env, `🔄 IP列表已更新: ${ipList.length} 个IP`);
  return ipList;
}

async function getBestIPs(env, visitorCountry, count) {
  let bestIPs = [];
  const filterCountry = visitorCountry && visitorCountry !== 'unknown';

  try {
    // 先从带宽池获取
    const bwSql = `
      SELECT ip, latency, bandwidth, country
      FROM high_quality_ips
      ${filterCountry ? 'WHERE country = ?' : ''}
      ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC, latency ASC
      LIMIT ?
    `;
    const bwStmt = env.DB.prepare(bwSql);
    const bandwidthIPs = filterCountry
      ? await bwStmt.bind(visitorCountry, count).all()
      : await bwStmt.bind(count).all();
    
    if (bandwidthIPs.results && bandwidthIPs.results.length > 0) {
      bestIPs.push(...bandwidthIPs.results);
    }

    // 如果带宽池不够，从备用池补充
    if (bestIPs.length < count) {
      const needed = count - bestIPs.length;
      const backupSql = `
        SELECT ip, latency, bandwidth, country
        FROM backup_quality_ips
        ${filterCountry ? 'WHERE country = ?' : ''}
        ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC, latency ASC
        LIMIT ?
      `;
      const backupStmt = env.DB.prepare(backupSql);
      const backupIPs = filterCountry
        ? await backupStmt.bind(visitorCountry, needed).all()
        : await backupStmt.bind(needed).all();
      
      if (backupIPs.results && backupIPs.results.length > 0) {
        bestIPs.push(...backupIPs.results);
      }
    }

  } catch (e) {
    await addSystemLog(env, `❌ getBestIPs 错误: ${e.message}`);
  }

  // 去重（按IP）
  const uniqueIPs = new Map();
  for (const ip of bestIPs) {
    if (!uniqueIPs.has(ip.ip)) {
      uniqueIPs.set(ip.ip, ip);
    }
  }
  
  const result = Array.from(uniqueIPs.values()).slice(0, count);
  await addSystemLog(env, `📊 获取最佳IP: ${result.length} 个 (请求: ${count}, 过滤: ${filterCountry ? visitorCountry : '全球'})`);
  
  return result.map(item => ({
    ip: item.ip, latency: item.latency, bandwidth: item.bandwidth, 
    country: item.country
  }));
}

async function getPoolStats(env, type = 'bandwidth') {
  try {
    if (type === 'bandwidth') {
      const advancedConfig = await getAdvancedConfig(env);
      const maxPoolSize = advancedConfig.maxHighQualityPoolSize;
      
      const allIPs = await env.DB.prepare(`
        SELECT ip, latency, bandwidth 
        FROM high_quality_ips 
        ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC, latency ASC
        LIMIT ?
      `).bind(maxPoolSize).all();
      
      const currentCount = allIPs.results?.length || 0;
      
      let totalScore = 0;
      for (const ip of allIPs.results || []) {
        totalScore += calculateIPScore(ip.latency, ip.bandwidth || 0);
      }
      
      const stats = await env.DB.prepare(`
        SELECT 
          AVG(latency) as avg_latency, 
          MIN(latency) as min_latency, 
          MAX(latency) as max_latency, 
          AVG(bandwidth) as avg_bandwidth, 
          MAX(bandwidth) as max_bandwidth 
        FROM high_quality_ips
      `).first();
      
      return {
        success: true, 
        currentCount, 
        maxPoolSize, 
        usage: (currentCount / maxPoolSize * 100).toFixed(1),
        stats: {
          avgLatency: Math.round(stats.avg_latency || 0), 
          minLatency: stats.min_latency || 0, 
          maxLatency: stats.max_latency || 0,
          avgBandwidth: stats.avg_bandwidth ? Math.round(stats.avg_bandwidth * 10) / 10 : 0, 
          maxBandwidth: stats.max_bandwidth ? Math.round(stats.max_bandwidth * 10) / 10 : 0,
          avgScore: Math.round(totalScore / (allIPs.results?.length || 1))
        }
      };
    } else if (type === 'backup') {
      const maxBackupPoolSize = 50;
      
      const allIPs = await env.DB.prepare(`
        SELECT ip, latency, bandwidth 
        FROM backup_quality_ips 
        ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC, latency ASC
      `).all();
      
      const currentCount = allIPs.results?.length || 0;
      
      let totalScore = 0;
      for (const ip of allIPs.results || []) {
        totalScore += calculateIPScore(ip.latency, ip.bandwidth || 0);
      }
      
      const stats = await env.DB.prepare(`
        SELECT 
          AVG(latency) as avg_latency, 
          MIN(latency) as min_latency, 
          MAX(latency) as max_latency, 
          AVG(bandwidth) as avg_bandwidth, 
          MAX(bandwidth) as max_bandwidth 
        FROM backup_quality_ips
      `).first();
      
      return {
        success: true, 
        currentCount, 
        maxPoolSize: maxBackupPoolSize, 
        usage: (currentCount / maxBackupPoolSize * 100).toFixed(1),
        stats: {
          avgLatency: Math.round(stats.avg_latency || 0), 
          minLatency: stats.min_latency || 0, 
          maxLatency: stats.max_latency || 0,
          avgBandwidth: stats.avg_bandwidth ? Math.round(stats.avg_bandwidth * 10) / 10 : 0, 
          maxBandwidth: stats.max_bandwidth ? Math.round(stats.max_bandwidth * 10) / 10 : 0,
          avgScore: Math.round(totalScore / (allIPs.results?.length || 1))
        }
      };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function updateDNSBatch(env, ips, triggerSource = 'manual') {
  try {
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    if (!dnsConfig || !dnsConfig.apiToken || !dnsConfig.zoneId || !dnsConfig.recordName) {
      return { success: false, error: 'DNS配置不完整，请先在设置页面配置DNS' };
    }
    
    if (!ips || ips.length === 0) {
      return { success: false, error: '没有可用的IP地址' };
    }
    
    const url = `https://api.cloudflare.com/client/v4/zones/${dnsConfig.zoneId}/dns_records`;
    const listResp = await fetch(`${url}?type=A&name=${dnsConfig.recordName}`, {
      headers: { 'Authorization': `Bearer ${dnsConfig.apiToken}` }
    });
    const listData = await listResp.json();
    
    if (listData.success && listData.result.length > 0) {
      for (const record of listData.result) {
        await fetch(`${url}/${record.id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${dnsConfig.apiToken}` } });
      }
    }
    
    let successCount = 0;
    for (const ip of ips) {
      const createResp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${dnsConfig.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'A', name: dnsConfig.recordName, content: ip, ttl: 120, proxied: dnsConfig.proxied || false })
      });
      const result = await createResp.json();
      if (result.success) successCount++;
    }
    
    if (successCount > 0) {
      await addSystemLog(env, `✅ DNS更新成功: ${successCount} 个IP (来源: ${triggerSource})`);
      
      // 获取IP的详细信息
      let ipDetails = [];
      for (const ip of ips) {
        try {
          const result = await env.DB.prepare('SELECT latency, bandwidth FROM high_quality_ips WHERE ip = ?').bind(ip).first();
          if (result) {
            ipDetails.push({
              ip: ip,
              latency: result.latency,
              bandwidth: result.bandwidth
            });
          }
        } catch (e) {
          // 忽略错误，继续处理其他IP
        }
      }
      
      // 构建IP列表消息
      let ipListMessage = '';
      ipDetails.forEach((ipDetail, index) => {
        // 根据配置决定是否隐藏IP
        let displayIP = ipDetail.ip;
        if (dnsConfig.telegramHideIP !== false) {
          // 隐藏IP后三位，只保留第一位
          displayIP = ipDetail.ip.split('.')[0] + '.*.*.*';
        }
        ipListMessage += (index + 1) + ". " + displayIP + " (延迟: " + ipDetail.latency + "ms, 带宽: " + (ipDetail.bandwidth || '未知') + "Mbps)\n";
      });
      
      // 构建完整通知消息
      const sourceText = getSourceText(triggerSource);
      const notificationMessage = "🌐 *DNS更新通知*\n\n" +
        "📅 *时间*: " + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + "\n" +
        "📍 *IP数量*: " + successCount + " 个\n" +
        "🎯 *来源*: " + sourceText + "\n" +
        "🔗 *域名*: " + dnsConfig.recordName + "\n\n" +
        "✨ *优选IP列表*\n" +
        (ipListMessage || '暂无详细信息');
      await sendTelegramNotification(env, {
        message: {
          ipCount: successCount,
          source: sourceText,
          domain: dnsConfig.recordName,
          ips: ipDetails.map(ipDetail => ({
            ip: ipDetail.ip,
            latency: ipDetail.latency,
            bandwidth: ipDetail.bandwidth
          }))
        },
        hideIP: dnsConfig.telegramHideIP !== false,
        type: 'success'
      });
      return { success: true, successCount };
    } else {
      const sourceText = getSourceText(triggerSource);
      await sendTelegramNotification(env, {
        message: {
          ipCount: 0,
          source: sourceText,
          domain: dnsConfig.recordName
        },
        type: 'error'
      });
      return { success: false, error: '没有成功更新任何DNS记录' };
    }
  } catch (e) {
    await addSystemLog(env, `❌ DNS更新失败: ${e.message}`);
    return { success: false, error: e.message, count: 0 };
  }
}

async function updateDNSWithVisitorAware(env, visitorCountry, count) {
  try {
    let bestIPs = await getBestIPs(env, visitorCountry, count);
    
    if (!bestIPs.length) {
      await addSystemLog(env, `⚠️ ${COUNTRY_NAMES[visitorCountry] || visitorCountry} 地区无可用IP，回退到全球优选池`);
      bestIPs = await getBestIPs(env, null, count);
    }
    
    if (!bestIPs.length) {
      await addSystemLog(env, `⚠️ 优选池为空，尝试从测速结果中获取IP`);
      const speedResults = await env.DB.prepare(`
        SELECT ip, delay, bandwidth 
        FROM speed_results 
        WHERE delay <= 200
        ORDER BY delay ASC, bandwidth DESC
        LIMIT ?
      `).bind(count).all();
      
      if (speedResults.results && speedResults.results.length > 0) {
        bestIPs = speedResults.results.map(r => ({
          ip: r.ip, latency: r.delay, bandwidth: r.bandwidth
        }));
      }
    }
    
    if (!bestIPs.length) {
      await addSystemLog(env, `❌ 没有可用的IP地址，请先进行测速`);
      return { success: false, error: '没有可用的IP地址，请先点击"开始测速"获取优质IP' };
    }
    
    await addSystemLog(env, `🌍 为 ${COUNTRY_NAMES[visitorCountry] || visitorCountry} 地区更新DNS，共 ${bestIPs.length} 个IP`);
    return await updateDNSBatch(env, bestIPs.map(item => item.ip), 'visitor_aware');
  } catch (e) {
    await addSystemLog(env, `❌ 访客感知DNS更新失败: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function getDataSources(env) {
  const userSources = await env.KV.get(CONFIG.kvKeys.dataSources, 'json') || [];
  return userSources.length === 0 ? CONFIG.defaultSources : userSources;
}

async function saveDataSources(env, sources) {
  const validSources = sources.filter(s => s.trim() && (s.startsWith('http://') || s.startsWith('https://')));
  if (validSources.length === 0) {
    await env.KV.delete(CONFIG.kvKeys.dataSources);
    return { success: true, sources: [] };
  }
  await env.KV.put(CONFIG.kvKeys.dataSources, JSON.stringify(validSources));
  return { success: true, sources: validSources };
}

async function handleVisitorInfo(request, env) {
  const clientIP = request.headers.get('CF-Connecting-IP') || '未知';
  const country = request.headers.get('CF-IPCountry') || 'unknown';
  const countryName = COUNTRY_NAMES[country] || country;
  
  const regionIPs = await getBestIPs(env, country, 10);
  const regionCount = regionIPs.length;
  const avgLatency = regionIPs.length > 0 ? Math.round(regionIPs.reduce((sum, ip) => sum + ip.latency, 0) / regionIPs.length) : 0;
  const avgBandwidth = regionIPs.length > 0 && regionIPs.some(ip => ip.bandwidth)
    ? Math.round(regionIPs.filter(ip => ip.bandwidth).reduce((sum, ip) => sum + (ip.bandwidth || 0), 0) / regionIPs.filter(ip => ip.bandwidth).length * 10) / 10 : 0;
  const recommendedIPs = await getBestIPs(env, country, 3);
  
  return new Response(JSON.stringify({ 
    clientIP, country, countryName,
    regionStats: { availableCount: regionCount, avgLatency, avgBandwidth, hasLocalIPs: regionCount > 0 },
    recommendedIPs: recommendedIPs.map(ip => ({ ip: ip.ip, latency: ip.latency, bandwidth: ip.bandwidth, country: ip.country }))
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleRegionStats(env) {
  try {
    const stats = await env.DB.prepare(`SELECT country, ip_count, avg_latency, avg_bandwidth, last_updated FROM region_stats ORDER BY avg_latency ASC LIMIT 20`).all();
    const topRegions = (stats.results || []).map(stat => ({
      country: stat.country, countryName: COUNTRY_NAMES[stat.country] || stat.country,
      ipCount: stat.ip_count, avgLatency: stat.avg_latency, avgBandwidth: stat.avg_bandwidth
    }));
    return { success: true, regions: topRegions };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function handleRegionQuality(env) {
  try {
    const quality = await env.DB.prepare(`SELECT country, ip_count, avg_latency, avg_bandwidth, min_latency, max_latency, last_updated FROM region_quality ORDER BY avg_latency ASC LIMIT 20`).all();
    const stats = await env.DB.prepare(`SELECT COUNT(*) as total_regions, SUM(ip_count) as total_ips, AVG(avg_latency) as global_avg_latency, AVG(avg_bandwidth) as global_avg_bandwidth FROM region_quality`).first();
    return {
      success: true,
      regions: (quality.results || []).map(r => ({
        country: r.country, countryName: COUNTRY_NAMES[r.country] || r.country,
        ipCount: r.ip_count, avgLatency: r.avg_latency, avgBandwidth: r.avg_bandwidth,
        minLatency: r.min_latency, maxLatency: r.max_latency, lastUpdated: r.last_updated
      })),
      summary: stats
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function handleSpeedStrategy(env) {
  try {
    const strategy = await getSpeedStrategy(env);
    const now = new Date();
    const asiaHour = (now.getHours() + 8) % 24;
    return { success: true, strategy, asiaHour, nextRun: strategy.type === 'urgent' ? '立即' : '下次定时任务' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function verifySession(sessionId, env) {
  if (!sessionId) return false;
  try {
    const sessions = await env.KV.get(CONFIG.kvKeys.sessions, 'json');
    return sessions && sessions[sessionId];
  } catch { return false; }
}

async function handleLogin(request, env) {
  try {
    const { password } = await request.json();
    const config = getEnvConfig(env);
    if (!config.adminPassword) {
      return new Response(JSON.stringify({ success: false, error: '管理员密码未配置' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    if (password === config.adminPassword) {
      const sessionId = generateSessionId();
      const sessions = await env.KV.get(CONFIG.kvKeys.sessions, 'json') || {};
      sessions[sessionId] = { createdAt: Date.now() };
      await env.KV.put(CONFIG.kvKeys.sessions, JSON.stringify(sessions));
      await addSystemLog(env, '🔐 管理员登录成功');
      return new Response(JSON.stringify({ success: true, sessionId }), { headers: { 'Content-Type': 'application/json' } });
    } else {
      return new Response(JSON.stringify({ success: false, error: '密码错误' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleLogout(request, env) {
  const sessionId = getSessionId(request);
  if (sessionId) {
    const sessions = await env.KV.get(CONFIG.kvKeys.sessions, 'json') || {};
    delete sessions[sessionId];
    await env.KV.put(CONFIG.kvKeys.sessions, JSON.stringify(sessions));
    await addSystemLog(env, '🔓 管理员登出');
  }
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleDBStatus(env) {
  try {
    await env.DB.prepare("SELECT 1").run();
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const counts = {};
    for (const table of ['speed_results', 'high_quality_ips', 'backup_quality_ips', 'failed_ips', 'system_logs', 'region_stats', 'ip_geo_cache', 'region_quality', 'speed_strategy']) {
      try {
        const result = await env.DB.prepare(`SELECT COUNT(*) as count FROM ${table}`).first();
        counts[table] = result ? result.count : 0;
      } catch (e) { counts[table] = 0; }
    }
    return { success: true, connected: true, tables: tables.results.map(t => t.name), counts };
  } catch (e) {
    return { success: false, connected: false, error: e.message };
  }
}

async function handleManualInit(env) {
  const success = await initDatabase(env);
  await runD1Migrations(env);
  const status = await handleDBStatus(env);
  await addSystemLog(env, '🗄️ 数据库手动初始化完成');
  return { success, ...status };
}

async function handleCleanPool(env) {
  await env.DB.prepare('DELETE FROM high_quality_ips').run();
  await env.DB.prepare('DELETE FROM backup_quality_ips').run();
  highQualityCache.clear();
  await addSystemLog(env, `🧹 手动清理带宽池完成，带宽池：0，备用池：0`);
  return { success: true, bandwidthCount: 0, backupCount: 0 };
}

async function getQualityMode(env) {
  const strategy = await env.DB.prepare('SELECT quality_mode FROM speed_strategy WHERE id = 1').first();
  if (!strategy) {
    await env.DB.prepare(`INSERT INTO speed_strategy (id, quality_mode) VALUES (1, 'bandwidth')`).run();
    return 'bandwidth';
  }
  return strategy.quality_mode || 'bandwidth';
}

async function checkBandwidthReliability(env) {
  try {
    const recentTests = await env.DB.prepare(`
      SELECT COUNT(*) as total,
             COUNT(CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 1 END) as zero_bandwidth,
             COUNT(CASE WHEN bandwidth IS NOT NULL AND bandwidth > 0 AND bandwidth < 5 THEN 1 END) as low_bandwidth
      FROM speed_results 
      WHERE last_tested > datetime('now', '-30 minutes')
    `).first();
    
    const total = recentTests.total || 0;
    if (total < 10) return { reliable: true, rate: 0 };
    const abnormalRate = ((recentTests.zero_bandwidth || 0) + (recentTests.low_bandwidth || 0)) / total * 100;
    return { reliable: abnormalRate < 80, rate: abnormalRate.toFixed(1) };
  } catch (e) { return { reliable: true, rate: 0 }; }
}

function getLoginHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CF优选IP · 登录</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-box {
      background: rgba(30, 41, 59, 0.95);
      backdrop-filter: blur(10px);
      padding: 40px;
      border-radius: 24px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
      border: 1px solid rgba(96, 165, 250, 0.3);
    }
    h1 {
      font-size: 28px;
      font-weight: 700;
      background: linear-gradient(135deg, #60a5fa, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 32px;
      text-align: center;
    }
    .subtitle {
      text-align: center;
      color: #94a3b8;
      font-size: 14px;
      margin-bottom: 24px;
    }
    .input-group { margin-bottom: 24px; }
    label {
      display: block;
      font-size: 14px;
      color: #94a3b8;
      margin-bottom: 8px;
      font-weight: 500;
    }
    input {
      width: 100%;
      padding: 12px 16px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 12px;
      color: #f1f5f9;
      font-size: 15px;
      transition: all 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #60a5fa;
      box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.2);
    }
    button {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      border: none;
      border-radius: 12px;
      color: white;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    button:hover { transform: translateY(-2px); box-shadow: 0 10px 20px -5px rgba(37, 99, 235, 0.4); }
    button:disabled { opacity: 0.6; transform: none; }
    .error {
      background: rgba(185, 28, 28, 0.2);
      border: 1px solid #b91c1c;
      color: #fecaca;
      padding: 12px;
      border-radius: 10px;
      margin-top: 20px;
      font-size: 13px;
      display: none;
      text-align: center;
    }
    .version {
      text-align: center;
      margin-top: 24px;
      font-size: 12px;
      color: #4b5563;
    }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>🌩️ CF优选IP</h1>
    <div class="subtitle">双池智能优选系统</div>
    <div class="input-group">
      <label>🔐 管理员密码</label>
      <input type="password" id="password" placeholder="请输入管理员密码" autofocus>
    </div>
    <button onclick="login()" id="loginBtn">登录系统</button>
    <div class="error" id="error"></div>
  </div>
  <script>
    async function login() {
      const password = document.getElementById('password').value;
      const btn = document.getElementById('loginBtn');
      if (!password) return showError('请输入管理员密码');
      btn.disabled = true;
      btn.textContent = '登录中...';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (data.success) {
          document.cookie = \`sessionId=\${data.sessionId}; path=/; max-age=86400; SameSite=Lax\`;
          window.location.href = '/';
        } else {
          showError(data.error || '登录失败，请检查密码');
        }
      } catch {
        showError('网络错误，请稍后重试');
      } finally {
        btn.disabled = false;
        btn.textContent = '登录系统';
      }
    }
    function showError(msg) {
      const el = document.getElementById('error');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 3000);
    }
    document.getElementById('password').addEventListener('keypress', (e) => { if (e.key === 'Enter') login(); });
  </script>
</body>
</html>`;
}

async function getMainHTML(env) {
  const config = getEnvConfig(env);
  const savedUIConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
  const savedAdvancedConfig = await env.KV.get(CONFIG.kvKeys.advancedConfig, 'json') || {};
  const countryNamesStr = JSON.stringify(COUNTRY_NAMES);
  
  const uiConfig = {
    ipCount: savedUIConfig.ipCount || config.defaultIpCount,
    testCount: savedUIConfig.testCount || config.defaultTestCount,
    threadCount: savedUIConfig.threadCount || config.defaultThreadCount,
    bandwidthFileSize: savedUIConfig.bandwidthFileSize || config.defaultBandwidthFileSize || 3,
    ipPrivacy: savedUIConfig.ipPrivacy !== false
  };
  
  const advancedConfig = {
    maxHighQualityPoolSize: savedAdvancedConfig.maxHighQualityPoolSize || config.maxHighQualityPoolSize,
    failedIpCooldownDays: savedAdvancedConfig.failedIpCooldownDays || config.failedIpCooldownDays
  };
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
  <title>CF优选IP · 双池智能优选 v${VERSION}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans SC', sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 20px;
    }
    .container { max-width: 1600px; margin: 0 auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 12px;
    }
    h1 {
      font-size: 26px;
      font-weight: 700;
      background: linear-gradient(135deg, #60a5fa, #a78bfa, #c084fc);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .version-badge {
      font-size: 12px;
      background: #1e293b;
      color: #94a3b8;
      padding: 2px 8px;
      border-radius: 20px;
      margin-left: 8px;
      -webkit-text-fill-color: #94a3b8;
    }
    .header-right { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .github-btn, .settings-btn {
      background: #1e293b;
      color: #94a3b8;
      text-decoration: none;
      padding: 8px 16px;
      border-radius: 40px;
      font-size: 13px;
      font-weight: 500;
      border: 1px solid #334155;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .github-btn:hover, .settings-btn:hover {
      color: #60a5fa;
      border-color: #60a5fa;
      background: #0f172a;
      transform: translateY(-1px);
    }
    .logout-btn {
      background: #4b5563;
      color: white;
      border: none;
      border-radius: 40px;
      padding: 8px 20px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .logout-btn:hover { background: #6b7280; transform: translateY(-1px); }
    
    .visitor-card {
      background: linear-gradient(135deg, #1e293b, #0f172a);
      border-radius: 20px;
      border: 1px solid #334155;
      margin-bottom: 24px;
      overflow: hidden;
    }
    .visitor-header {
      padding: 18px 24px;
      background: rgba(37, 99, 235, 0.15);
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .visitor-header h2 { font-size: 16px; font-weight: 600; color: #60a5fa; }
    .visitor-badge {
      background: #2563eb;
      padding: 4px 14px;
      border-radius: 40px;
      font-size: 12px;
      font-weight: 500;
    }
    .visitor-content {
      padding: 24px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 16px;
    }
    .visitor-info-item {
      background: #0f172a;
      padding: 14px;
      border-radius: 14px;
      text-align: center;
      transition: all 0.2s;
    }
    .visitor-info-item:hover { background: #1e293b; }
    .visitor-label { font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
    .visitor-value { font-size: 20px; font-weight: 700; color: #60a5fa; }
    
    .grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 20px; }
    @media (max-width: 1000px) { .grid { grid-template-columns: 1fr; } }
    
    .card {
      background: #1e293b;
      border-radius: 20px;
      border: 1px solid #334155;
      overflow: hidden;
      margin-bottom: 20px;
      transition: all 0.3s ease;
    }
    .card-header {
      padding: 18px 24px;
      border-bottom: 1px solid #334155;
      background: #0f172a;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }
    .card-header h2 { font-size: 17px; font-weight: 600; color: #f1f5f9; display: flex; align-items: center; gap: 8px; }
    .card-body { padding: 24px; }
    
    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: #0f172a;
      padding: 16px;
      border-radius: 14px;
      text-align: center;
      transition: all 0.2s;
    }
    .stat-card:hover { background: #1e293b; transform: translateY(-2px); }
    .stat-label { font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
    .stat-value { font-size: 28px; font-weight: 700; color: #60a5fa; }
    
    .pool-stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 20px;
    }
    .pool-card {
      background: #0f172a;
      padding: 16px;
      border-radius: 14px;
      text-align: center;
      border-left: 3px solid #60a5fa;
    }
    .pool-card h4 { font-size: 13px; color: #94a3b8; margin-bottom: 6px; }
    .pool-card .count { font-size: 28px; font-weight: bold; color: #60a5fa; }
    .pool-card .sub { font-size: 11px; color: #6b7280; margin-top: 6px; }
    
    .search-box {
      width: 100%;
      padding: 12px 16px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 12px;
      color: #f1f5f9;
      font-size: 14px;
      margin-bottom: 18px;
    }
    .search-box:focus { outline: none; border-color: #60a5fa; }
    .table-container {
      max-height: 450px;
      overflow-y: auto;
      border: 1px solid #334155;
      border-radius: 14px;
      margin-bottom: 20px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      background: #0f172a;
      padding: 12px 14px;
      text-align: left;
      font-weight: 600;
      color: #94a3b8;
      position: sticky;
      top: 0;
      font-size: 12px;
    }
    td { padding: 10px 14px; border-bottom: 1px solid #334155; }
    .ip-cell { font-family: monospace; color: #60a5fa; font-weight: 500; }
    .country-badge {
      background: #334155;
      padding: 3px 8px;
      border-radius: 20px;
      font-size: 11px;
      display: inline-block;
    }
    .latency-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 500;
    }
    .latency-excellent { background: rgba(74, 222, 128, 0.2); color: #4ade80; }
    .latency-good { background: rgba(96, 165, 250, 0.2); color: #60a5fa; }
    .latency-fair { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
    .latency-poor { background: rgba(248, 113, 113, 0.2); color: #f87171; }
    
    .btn {
      padding: 8px 18px;
      border: none;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-sm { padding: 5px 12px; font-size: 12px; }
    .btn-primary { background: #2563eb; color: white; }
    .btn-primary:hover { background: #1d4ed8; transform: translateY(-1px); }
    .btn-secondary { background: #4b5563; color: white; transition: all 0.2s; }
    .btn-secondary:hover { background: #6b7280; transform: translateY(-1px); }
    .btn-success { background: #059669; color: white; transition: all 0.2s; }
    .btn-success:hover { background: #047857; transform: translateY(-1px); }
    .btn-warning { background: #d97706; color: white; transition: all 0.2s; }
    .btn-warning:hover { background: #b45309; transform: translateY(-1px); }
    .btn-danger { background: #b91c1c; color: white; transition: all 0.2s; }
    .btn-danger:hover { background: #991b1b; transform: translateY(-1px); }
    .btn-info { background: #0891b2; color: white; transition: all 0.2s; }
    .btn-info:hover { background: #0e7490; }
    .button-group { display: flex; gap: 12px; margin: 16px 0; flex-wrap: wrap; }
    
    .log-panel {
      background: #0f172a;
      border-radius: 14px;
      padding: 14px;
      font-family: monospace;
      font-size: 11px;
      height: 220px;
      overflow-y: auto;
      border: 1px solid #334155;
    }
    .log-entry {
      color: #94a3b8;
      margin-bottom: 6px;
      border-bottom: 1px solid #1e293b;
      padding-bottom: 4px;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }
    .log-time { color: #60a5fa; margin-right: 10px; }
    
    .progress-bar {
      height: 4px;
      background: #334155;
      border-radius: 4px;
      margin: 16px 0;
      overflow: hidden;
      display: none;
    }
    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #60a5fa, #a78bfa);
      width: 0%;
      transition: width 0.3s ease;
    }
    .speed-status {
      text-align: center;
      font-size: 12px;
      color: #94a3b8;
      margin: 10px 0;
      display: none;
    }
    
    .params-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-bottom: 20px;
    }
    .param-item {
      display: flex;
      flex-direction: column;
      min-height: 70px;
    }
    .param-item label {
      display: block;
      font-size: 12px;
      color: #94a3b8;
      margin-bottom: 8px;
      flex: 1;
      display: flex;
      align-items: flex-start;
    }
    .param-input {
      width: 100%;
      padding: 10px 12px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 10px;
      color: #f1f5f9;
      font-size: 14px;
      align-self: flex-end;
    }
    .full-width { width: 100%; }
    
    .db-status-card {
      background: #0f172a;
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 20px;
      border-left: 4px solid #60a5fa;
    }
    .info-text { font-size: 11px; color: #6b7280; margin-top: 8px; text-align: center; }
    .score-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 20px;
      font-weight: 600;
      font-size: 11px;
    }
    .score-high { background: rgba(74, 222, 128, 0.2); color: #4ade80; }
    .score-medium { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
    .score-low { background: rgba(248, 113, 113, 0.2); color: #f87171; }
    
    @keyframes highlight {
      0% { background-color: rgba(96, 165, 250, 0.4); }
      100% { background-color: transparent; }
    }
    .speed-result-item.new { animation: highlight 0.8s ease; }
    .mode-switch {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .mode-btn {
      flex: 1;
      padding: 6px 12px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s;
    }
    .mode-btn.active {
      background: #2563eb;
      border-color: #60a5fa;
      color: white;
    }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🌩️ CF 优选 IP · 双池智能优选 <span class="version-badge">${VERSION}</span></h1>
    <div class="header-right">
      <a href="/settings" class="settings-btn">⚙️ 设置</a>
      <a href="${GITHUB_URL}" target="_blank" class="github-btn">⭐ GitHub</a>
      <button class="logout-btn" onclick="logout()">登出</button>
    </div>
  </div>

  <div class="visitor-card">
    <div class="visitor-header">
      <span>📍</span>
      <h2>访客位置感知 · 智能优选</h2>
      <span class="visitor-badge" id="visitorStatus">检测中...</span>
    </div>
    <div class="visitor-content">
      <div class="visitor-info-item"><div class="visitor-label">您的IP</div><div class="visitor-value" id="visitorIP">--</div></div>
      <div class="visitor-info-item"><div class="visitor-label">您的位置</div><div class="visitor-value" id="visitorCountry">--</div></div>
      <div class="visitor-info-item"><div class="visitor-label">本地优质IP</div><div class="visitor-value" id="localIPCount">--</div></div>
      <div class="visitor-info-item"><div class="visitor-label">本地平均延迟</div><div class="visitor-value" id="localAvgLatency">--</div></div>
      <div class="visitor-info-item"><div class="visitor-label">本地平均带宽</div><div class="visitor-value" id="localAvgBandwidth">--</div></div>
    </div>
    <div class="card-body" style="padding-top:0;">
      <div class="button-group">
        <button class="btn btn-info" style="flex:1;" onclick="startVisitorAwareSpeedTest()" id="visitorSpeedTestBtn">🚀 为您优选测速</button>
        <button class="btn btn-primary" style="flex:1;" onclick="updateDNSWithVisitorAware()">🌐 更新DNS（优先您的位置）</button>
      </div>
      <div id="recommendedIPs" style="margin-top: 12px;"></div>
    </div>
  </div>

  <div class="grid">
    <div>
      <div class="card">
        <div class="card-header">
          <h2>📋 带宽优质池 <span style="font-size:11px; color:#60a5fa;">(评分优先)</span></h2>
          <div>
            <button class="btn btn-sm btn-primary" onclick="manualUpdate()">🔄 刷新IP列表</button>
            <button class="btn btn-sm btn-warning" onclick="startSpeedTest()" id="speedTestBtn">▶ 开始测速</button>
          </div>
        </div>
        <div class="card-body">
          <div class="stats-row">
            <div class="stat-card"><div class="stat-label">总IP池</div><div class="stat-value" id="totalCount">0</div></div>
            <div class="stat-card"><div class="stat-label">带宽池</div><div class="stat-value" id="bandwidthCount">0</div></div>
            <div class="stat-card"><div class="stat-label">备用池</div><div class="stat-value" id="backupCount">0</div></div>
            <div class="stat-card"><div class="stat-label">失败池</div><div class="stat-value" id="failedCount">0</div></div>
          </div>
          
          <div id="poolStats" class="pool-stats"></div>
          
          <div class="mode-switch">
            <button class="mode-btn active" id="modeFull" onclick="setTestMode('full')">📊 完整测速</button>
            <button class="mode-btn" id="modeLite" onclick="setTestMode('lite')">⚡ 轻量测速(仅延迟)</button>
          </div>
          
          <div class="progress-bar" id="speedProgress"><div class="progress-bar-fill" id="speedProgressFill"></div></div>
          <div class="speed-status" id="speedStatus"></div>
          
          <input type="text" class="search-box" id="search" placeholder="🔍 搜索 IP 地址...">
        </div>
      </div>

      <div class="card">
        <div class="card-header" onclick="toggleIPTable()" style="cursor: pointer;">
          <h2>📋 优质 IP 列表 <span id="ipTableToggle">▶</span></h2>
        </div>
        <div class="card-body" id="ipTableContainer">
          <div class="table-container" style="max-height: 400px; overflow-y: auto;">
            <table>
              <thead>
                <tr><th>IP 地址</th><th>延迟</th><th>带宽</th><th>评分</th><th>地区</th><th>操作</th></tr>
              </thead>
              <tbody id="ipTable2">
                <tr><td colspan="7" style="text-align:center;padding:40px;">⏳ 暂无优质 IP，请点击"开始测速"或"修复带宽池"</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header" onclick="toggleSpeedResults()" style="cursor: pointer;">
          <h2>📊 实时测速结果 <span id="speedResultToggle">▶</span></h2>
          <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); clearSpeedResults()">清除记录</button>
        </div>
        <div class="card-body" id="speedResultContent" style="display:none;">
          <div class="stats-row" id="speedStatsSummary" style="display:none;">
            <div class="stat-card"><div class="stat-label">已测试</div><div class="stat-value" id="testedCount">0</div></div>
            <div class="stat-card"><div class="stat-label">成功</div><div class="stat-value" id="successCount" style="color:#4ade80;">0</div></div>
            <div class="stat-card"><div class="stat-label">失败</div><div class="stat-value" id="failCount" style="color:#f87171;">0</div></div>
            <div class="stat-card"><div class="stat-label">平均延迟</div><div class="stat-value" id="avgLatency">--</div></div>
          </div>
          <div class="table-container">
            <table>
              <thead><tr><th>IP</th><th>延迟</th><th>带宽</th><th>评分</th><th>地区</th><th>时间</th><th>状态</th></tr></thead>
              <tbody id="speedResultTable"><tr><td colspan="7" style="text-align:center;padding:40px;">暂无测速结果</td></tr></tbody>
            </table>
          </div>
          <div class="info-text">⚡ 延迟测试3次取平均 | 📊 带宽测试下载3-10MB文件(可配置) | 🎯 评分: 带宽80% + 延迟20%</div>
        </div>
      </div>
    </div>

    <div>
      <div class="card">
        <div class="card-header"><h2>⚡ 快速操作</h2></div>
        <div class="card-body">
          <div id="dbStatusCard" style="display:none;"></div>
          
          <div class="button-group">
            <button class="btn btn-warning" style="flex:1;" onclick="cleanPool()">🗑️ 清理带宽池</button>
            <button class="btn btn-info" style="flex:1;" onclick="startSmartSpeedTest()">🧠 智能测速</button>
          </div>
          <div class="button-group">
            <button class="btn btn-success" style="flex:1;" onclick="checkDBStatus()">💾 数据库状态</button>
            <button class="btn btn-primary" style="flex:1;" onclick="updateDNSWithBest()">🌐 更新 DNS</button>
          </div>
          <div class="button-group">
            <button class="btn btn-warning" style="flex:1;" onclick="repairBandwidthPool()">🔧 修复带宽池</button>
            <button class="btn btn-info" style="flex:1;" onclick="debugBandwidthPool()">🐛 调试带宽池</button>
          </div>
          <div class="button-group">
            <button class="btn btn-success" style="flex:1;" onclick="exportIPs()">📥 导出优质 IP</button>
          </div>
          
          <div style="background:#0f172a; border-radius:12px; padding:20px; margin:16px 0;">
            <h3 style="color:#60a5fa; font-size:14px; margin-bottom:16px;">⚙️ 运行参数</h3>
            <div class="params-row">
              <div class="param-item"><label>测速线程数 (1-10)</label><input type="number" class="param-input" id="threadCount" min="1" max="10" value="${uiConfig.threadCount}"></div>
              <div class="param-item"><label>测速数量 (10-100)</label><input type="number" class="param-input" id="testCount" min="10" max="100" value="${uiConfig.testCount}"></div>
              <div class="param-item"><label>DNS 自动添加 IP 数量 (1-10)</label><input type="number" class="param-input" id="ipCount" min="1" max="10" value="${uiConfig.ipCount}"></div>
            </div>
            <div class="params-row">
              <div class="param-item"><label>带宽优质池最大容量 (10-50)</label><input type="number" class="param-input" id="maxPoolSize" min="10" max="50" value="${advancedConfig.maxHighQualityPoolSize}"></div>
              <div class="param-item"><label>失败IP冷却天数 (1-30)</label><input type="number" class="param-input" id="failedCooldown" min="1" max="30" value="${advancedConfig.failedIpCooldownDays}"></div>
              <div class="param-item"><label>带宽测试文件大小值 (3-10MB)</label><input type="number" class="param-input" id="bandwidthFileSize" min="3" max="10" value="${uiConfig.bandwidthFileSize}"></div>
            </div>
            <div style="margin:16px 0; display:flex; align-items:center;">
              <input type="checkbox" id="clearFailedOnSave" style="margin-right:8px;"> <label style="color:#94a3b8; font-size:13px;">保存时清空失败IP黑名单</label>
            </div>
            <button class="btn btn-primary full-width" style="padding:12px;" onclick="saveAllSettings()">💾 保存所有设置</button>
          </div>
          
          <div class="info-text" style="text-align:center;">
            💡为避免限流，带宽测试每分钟最多10次，测试文件大小3-5MB，数值越大容易触发限流
          </div>
        </div>
      </div>
      
      <div class="card">
        <div class="card-header">
          <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
            <h2>📝 运行日志</h2>
            <div style="display: flex; gap: 8px; align-items: center;">
              <button class="btn btn-sm btn-primary" onclick="refreshLogs()">刷新</button>
              <button class="btn btn-sm btn-success" onclick="exportLogs()">导出</button>
              <button class="btn btn-sm btn-danger" onclick="clearLogs()">清除</button>
            </div>
          </div>
          <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-top: 12px; justify-content: space-between;">
            <div style="display: flex; gap: 12px; align-items: center; flex: 1;">
              <select id="logLevelFilter" style="background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 4px 8px; color: #e2e8f0; font-size: 12px; flex: 1; min-width: 100px;">
                <option value="">所有级别</option>
                <option value="info">信息</option>
                <option value="warning">警告</option>
                <option value="error">错误</option>
              </select>
              <select id="logCategoryFilter" style="background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 4px 8px; color: #e2e8f0; font-size: 12px; flex: 1; min-width: 120px;">
                <option value="">所有分类</option>
                <option value="system">系统</option>
                <option value="speed_test">测速</option>
                <option value="pool_management">池管理</option>
                <option value="dns">DNS</option>
                <option value="telegram">Telegram</option>
              </select>
            </div>
            <input type="text" id="logKeyword" placeholder="搜索关键词" style="background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 4px 8px; color: #e2e8f0; font-size: 12px; flex: 1.5; min-width: 150px;">
          </div>
        </div>
        <div class="card-body">
          <div class="log-panel" id="logPanel"></div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.style.position = 'fixed';
    toast.style.top = '20px';
    toast.style.right = '20px';
    toast.style.padding = '12px 20px';
    toast.style.borderRadius = '8px';
    toast.style.color = 'white';
    toast.style.fontSize = '14px';
    toast.style.fontWeight = '500';
    toast.style.zIndex = '9999';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    
    switch(type) {
      case 'success':
        toast.style.backgroundColor = '#10b981';
        break;
      case 'error':
        toast.style.backgroundColor = '#ef4444';
        break;
      case 'warning':
        toast.style.backgroundColor = '#f59e0b';
        break;
      default:
        toast.style.backgroundColor = '#3b82f6';
    }
    
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(0)';
    }, 10);
    
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => {
        document.body.removeChild(toast);
      }, 300);
    }, 3000);
  }
  
  function showConfirm(message, onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '9999';
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s ease';
    
    const dialog = document.createElement('div');
    dialog.style.background = '#1e293b';
    dialog.style.borderRadius = '12px';
    dialog.style.padding = '24px';
    dialog.style.minWidth = '300px';
    dialog.style.maxWidth = '400px';
    dialog.style.boxShadow = '0 25px 50px -12px rgba(0, 0, 0, 0.5)';
    dialog.style.border = '1px solid #334155';
    dialog.style.opacity = '0';
    dialog.style.transform = 'scale(0.9)';
    dialog.style.transition = 'all 0.3s ease';
    
    const messageElement = document.createElement('div');
    messageElement.style.color = '#e2e8f0';
    messageElement.style.fontSize = '14px';
    messageElement.style.marginBottom = '20px';
    messageElement.style.textAlign = 'center';
    messageElement.textContent = message;
    
    const buttonContainer = document.createElement('div');
    buttonContainer.style.display = 'flex';
    buttonContainer.style.gap = '10px';
    buttonContainer.style.justifyContent = 'center';
    
    const cancelButton = document.createElement('button');
    cancelButton.textContent = '取消';
    cancelButton.style.padding = '8px 20px';
    cancelButton.style.border = '1px solid #334155';
    cancelButton.style.borderRadius = '8px';
    cancelButton.style.background = '#0f172a';
    cancelButton.style.color = '#94a3b8';
    cancelButton.style.fontSize = '14px';
    cancelButton.style.cursor = 'pointer';
    cancelButton.style.transition = 'all 0.2s ease';
    
    cancelButton.addEventListener('mouseenter', () => {
      cancelButton.style.background = '#1e293b';
      cancelButton.style.color = '#e2e8f0';
    });
    
    cancelButton.addEventListener('mouseleave', () => {
      cancelButton.style.background = '#0f172a';
      cancelButton.style.color = '#94a3b8';
    });
    
    const confirmButton = document.createElement('button');
    confirmButton.textContent = '确定';
    confirmButton.style.padding = '8px 20px';
    confirmButton.style.border = 'none';
    confirmButton.style.borderRadius = '8px';
    confirmButton.style.background = '#2563eb';
    confirmButton.style.color = 'white';
    confirmButton.style.fontSize = '14px';
    confirmButton.style.cursor = 'pointer';
    confirmButton.style.transition = 'all 0.2s ease';
    
    confirmButton.addEventListener('mouseenter', () => {
      confirmButton.style.background = '#1d4ed8';
    });
    
    confirmButton.addEventListener('mouseleave', () => {
      confirmButton.style.background = '#2563eb';
    });
    
    cancelButton.addEventListener('click', () => {
      overlay.style.opacity = '0';
      dialog.style.opacity = '0';
      dialog.style.transform = 'scale(0.9)';
      setTimeout(() => {
        document.body.removeChild(overlay);
      }, 300);
      if (onCancel) onCancel();
    });
    
    confirmButton.addEventListener('click', () => {
      overlay.style.opacity = '0';
      dialog.style.opacity = '0';
      dialog.style.transform = 'scale(0.9)';
      setTimeout(() => {
        document.body.removeChild(overlay);
      }, 300);
      if (onConfirm) onConfirm();
    });
    
    buttonContainer.appendChild(cancelButton);
    buttonContainer.appendChild(confirmButton);
    dialog.appendChild(messageElement);
    dialog.appendChild(buttonContainer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    setTimeout(() => {
      overlay.style.opacity = '1';
      dialog.style.opacity = '1';
      dialog.style.transform = 'scale(1)';
    }, 10);
  }

  let bandwidthPoolIPs = [], allIPs = [], visitorInfo = null, speedTestResults = [];
  let uiConfig = { ipCount: ${uiConfig.ipCount}, testCount: ${uiConfig.testCount}, threadCount: ${uiConfig.threadCount}, bandwidthFileSize: ${uiConfig.bandwidthFileSize} };
  let isSpeedTesting = false, totalTested = 0, totalToTest = 0, testQueue = [], activeThreads = 0;
  let testMode = 'full';
  let lastSpeedTestTime = 0;
  const MIN_SPEED_TEST_INTERVAL = 60000;
  
  function getLatencyClass(l) { if(l<=50) return 'latency-excellent'; if(l<=100) return 'latency-good'; if(l<=150) return 'latency-fair'; return 'latency-poor'; }

  function calculateScore(l,b) { let ls=0; if(l<=50) ls=100; else if(l<=100) ls=90; else if(l<=150) ls=80; else if(l<=200) ls=70; else if(l<=250) ls=60; else ls=50; let bs=0; if(!b||b===0) bs=0; else if(b>=1000) bs=100; else if(b>=500) bs=95; else if(b>=300) bs=90; else if(b>=200) bs=85; else if(b>=100) bs=80; else if(b>=50) bs=60; else if(b>=20) bs=40; else bs=20; return Math.round(bs*0.8+ls*0.2); }
  function getScoreClass(s) { if(s>=80) return 'score-high'; if(s>=60) return 'score-medium'; return 'score-low'; }
  
  function setTestMode(mode) {
    testMode = mode;
    document.getElementById('modeFull').classList.toggle('active', mode === 'full');
    document.getElementById('modeLite').classList.toggle('active', mode === 'lite');
  }
  
  function toggleSpeedResults() {
    const content = document.getElementById('speedResultContent');
    const toggle = document.getElementById('speedResultToggle');
    if (content.style.display === 'none') {
      content.style.display = 'block';
      toggle.textContent = '▼';
    } else {
      content.style.display = 'none';
      toggle.textContent = '▶';
    }
  }
  
  function toggleIPTable() {
    const container = document.getElementById('ipTableContainer');
    const toggle = document.getElementById('ipTableToggle');
    if (container.style.display === 'none') {
      container.style.display = 'block';
      toggle.textContent = '▼';
    } else {
      container.style.display = 'none';
      toggle.textContent = '▶';
    }
    localStorage.setItem('ipTableCollapsed', container.style.display === 'none' ? 'true' : 'false');
  }
  
  // 恢复 IP 列表折叠状态
  function restoreIPTableState() {
    const collapsed = localStorage.getItem('ipTableCollapsed');
    if (collapsed === 'true') {
      const container = document.getElementById('ipTableContainer');
      const toggle = document.getElementById('ipTableToggle');
      container.style.display = 'none';
      toggle.textContent = '▶';
    }
  }
  
  async function repairBandwidthPool() {
    showConfirm('将根据测速结果修复带宽池，确定吗？', async () => {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = '修复中...';
      try {
        const res = await fetch('/api/repair-bandwidth-pool', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast(\`修复成功！新增 \${data.addedCount} 个IP到带宽池，当前总数: \${data.totalCount}\`, 'success');
          await loadIPs(true);
          await loadPoolStats();
        } else {
          showToast('修复失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch(e) {
        showToast('修复失败: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '🔧 修复带宽池';
      }
    });
  }
  
  async function debugBandwidthPool() {
    try {
      const res = await fetch('/api/debug-bandwidth-pool');
      const data = await res.json();
      if (data.success) {
        let msg = \`📊 带宽池统计:\\n\`;
        msg += \`总数: \${data.stats.total}\\n\`;
        msg += \`平均延迟: \${Math.round(data.stats.avg_latency || 0)}ms\\n\`;
        msg += \`平均带宽: \${Math.round(data.stats.avg_bandwidth || 0)}Mbps\\n\\n\`;
        
        msg += \`📋 带宽池中的IP (前10个):\\n\`;
        if (data.highQualityIPs && data.highQualityIPs.length) {
          data.highQualityIPs.slice(0, 10).forEach(ip => {
            msg += \`\${ip.ip} - \${ip.latency}ms, \${ip.bandwidth || 'N/A'}Mbps, 评分:\${calculateScore(ip.latency, ip.bandwidth)}分\\n\`;
          });
        } else {
          msg += \`无数据\\n\`;
        }
        
        msg += \`\\n📊 speed_results中的优质IP:\\n\`;
        if (data.speedResultsIPs && data.speedResultsIPs.length) {
          data.speedResultsIPs.forEach(ip => {
            msg += \`\${ip.ip} - \${ip.delay}ms, \${ip.bandwidth}Mbps\\n\`;
          });
        } else {
          msg += \`无数据\\n\`;
        }
        
        showToast(msg, 'info');
        await loadIPs(true);
        await loadPoolStats();
      } else {
        showToast('调试失败: ' + data.error, 'error');
      }
    } catch(e) {
      showToast('调试失败: ' + e.message, 'error');
    }
  }
  
  async function loadPoolStats() {
    try {
      const bwRes = await fetch('/api/get-pool-stats?type=bandwidth');
      const bwData = await bwRes.json();
      if (bwData.success) {
        document.getElementById('bandwidthCount').innerText = bwData.currentCount;
        // 获取备用池统计
        const backupRes = await fetch('/api/get-pool-stats?type=backup');
        const backupData = await backupRes.json();
        if (backupData.success) {
          document.getElementById('backupCount').innerText = backupData.currentCount;
        }
        
        document.getElementById('poolStats').innerHTML = \`
          <div class="pool-card"><h4>🚀 带宽优质池</h4><div class="count">\${bwData.currentCount}/\${bwData.maxPoolSize}</div><div class="sub">平均延迟: \${bwData.stats.avgLatency}ms | 平均带宽: \${bwData.stats.avgBandwidth} Mbps</div></div>
          <div class="pool-card"><h4>📋 备用池</h4><div class="count">\${backupData.success ? backupData.currentCount : 0}/50</div><div class="sub">平均延迟: \${backupData.success ? backupData.stats.avgLatency : 0}ms | 平均带宽: \${backupData.success ? backupData.stats.avgBandwidth : 0} Mbps</div></div>
        \`;
      }
    } catch(e) {}
  }
  
  async function loadVisitorInfo() {
    try {
      const res = await fetch('/api/visitor-info');
      const data = await res.json();
      visitorInfo = data;
      // 隐藏 IP 中间两段用于隐私保护
      const ipParts = data.clientIP.split('.');
      const maskedIP = ipParts.length === 4 ? (ipParts[0] + '.*.*.' + ipParts[3]) : data.clientIP;
      const visitorIPEl = document.getElementById('visitorIP');
      visitorIPEl.textContent = maskedIP;
      visitorIPEl.style.cursor = 'pointer';
      visitorIPEl.title = '点击显示完整 IP 并复制';
      visitorIPEl.onclick = function() {
        navigator.clipboard.writeText(data.clientIP);
        var originalText = visitorIPEl.textContent;
        visitorIPEl.textContent = data.clientIP + ' ✓';
        setTimeout(function() { visitorIPEl.textContent = maskedIP; }, 2000);
      };
      document.getElementById('visitorCountry').textContent = data.countryName;
      document.getElementById('localIPCount').textContent = data.regionStats?.availableCount || 0;
      document.getElementById('localAvgLatency').textContent = data.regionStats?.avgLatency ? data.regionStats.avgLatency + 'ms' : '待测速';
      document.getElementById('localAvgBandwidth').textContent = data.regionStats?.avgBandwidth ? data.regionStats.avgBandwidth + ' Mbps' : '待测速';
      const statusEl = document.getElementById('visitorStatus');
      if (data.regionStats?.hasLocalIPs) { statusEl.textContent = '✓ 已有本地IP'; statusEl.style.background = '#059669'; }
      else { statusEl.textContent = '⚡ 建议测速'; statusEl.style.background = '#d97706'; }
      if (data.recommendedIPs?.length) {
        const ipsHtml = '<div style="margin-top:8px;"><span style="color:#94a3b8;font-size:12px;">✨ 推荐IP：</span> ' + 
          data.recommendedIPs.map(ip => '<span style="background:#1e293b;padding:4px 10px;border-radius:20px;font-family:monospace;font-size:12px;margin-right:8px;">' + ip.ip + ' (' + ip.latency + 'ms)</span>').join('') + '</div>';
        document.getElementById('recommendedIPs').innerHTML = ipsHtml;
      }
    } catch(e) {}
  }
  
  async function startVisitorAwareSpeedTest() {
    if (!visitorInfo || visitorInfo.country === 'unknown') {
      showConfirm('无法识别您的位置，是否继续使用全球测速？', () => {
        startSpeedTest();
      });
      return;
    }
    const btn = document.getElementById('visitorSpeedTestBtn');
    btn.disabled = true; btn.textContent = '测速中...';
    try {
      const res = await fetch('/api/visitor-aware-speedtest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ country: visitorInfo.country }) });
      const data = await res.json();
      if (data.success) { showToast(data.message, 'success'); setTimeout(() => { loadLogs(); loadIPs(true); loadVisitorInfo(); loadPoolStats(); }, 3000); }
      else showToast('启动失败', 'error');
    } catch(e) { showToast('启动失败', 'error'); }
    finally { btn.disabled = false; btn.textContent = '🚀 为您优选测速'; }
  }
  
  async function updateDNSWithVisitorAware() {
    if (!visitorInfo || visitorInfo.country === 'unknown') { 
      showToast('无法识别您的位置，将使用全球最优IP', 'info'); 
      return updateDNSWithBest(); 
    }
    const count = parseInt(document.getElementById('ipCount').value) || 3;
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '更新中...';
    try {
      const res = await fetch('/api/visitor-aware-update-dns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ country: visitorInfo.country, count }) });
      const data = await res.json();
      if (data.success) {
        showToast('DNS更新成功！已为您优选 ' + (data.count || count) + ' 个IP', 'success');
      } else {
        showToast('DNS更新失败：' + (data.error || '请检查配置或先进行测速'), 'error');
      }
    } catch(e) { 
      showToast('更新失败：' + e.message, 'error'); 
    } finally {
      btn.disabled = false;
      btn.textContent = '🌐 更新DNS（优先您的位置）';
    }
  }
  
  async function startSmartSpeedTest() {
    showConfirm('智能测速将根据双池状态自动调整，可能需要几分钟。确定吗？', async () => {
      const btn = event.target;
      btn.disabled = true; btn.textContent = '测速中...';
      try {
        const res = await fetch('/api/smart-speedtest', { method: 'POST' });
        const data = await res.json();
        if (data.success) { showToast('智能测速已启动', 'success'); setTimeout(() => { loadLogs(); loadIPs(true); loadPoolStats(); }, 3000); }
        else showToast('启动失败', 'error');
      } catch(e) { showToast('启动失败', 'error'); }
      finally { btn.disabled = false; btn.textContent = '🧠 智能测速'; }
    });
  }
  
  async function checkAuth() {
    try {
      const res = await fetch('/api/check-auth');
      const data = await res.json();
      if (!data.authenticated) { window.location.href = '/login'; return false; }
      return true;
    } catch { window.location.href = '/login'; return false; }
  }
  
  async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    document.cookie = 'sessionId=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    window.location.href = '/login';
  }
  
  async function cleanPool() {
    showConfirm('确定要清理带宽优质池吗？', async () => {
      const res = await fetch('/api/clean-pool', { method: 'POST' });
      const data = await res.json();
      if (data.success) { showToast('清理成功！带宽池: ' + data.bandwidthCount + '个', 'success'); await loadIPs(true); await loadPoolStats(); }
      else showToast('清理失败', 'error');
    });
  }
  
  async function loadLogs() {
    try {
      const level = document.getElementById('logLevelFilter').value;
      const category = document.getElementById('logCategoryFilter').value;
      const keyword = document.getElementById('logKeyword').value;
      
      const params = new URLSearchParams();
      if (level) params.append('level', level);
      if (category) params.append('category', category);
      if (keyword) params.append('keyword', keyword);
      
      const url = '/api/get-logs?' + params.toString();
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('API请求失败: ' + res.status);
      }
      const data = await res.json();
      const panel = document.getElementById('logPanel');
      
      if (data.logs?.length) {
        panel.innerHTML = data.logs.map(l => {
          let levelClass = '';
          switch(l.level) {
            case 'error': levelClass = 'color: #f87171;'; break;
            case 'warning': levelClass = 'color: #fbbf24;'; break;
            case 'info': levelClass = 'color: #60a5fa;'; break;
          }
          return '<div class="log-entry"> ' +
            '<span class="log-time">[' + l.timeStr + ']</span> ' +
            '<span style="' + levelClass + ' margin-right: 8px; font-size: 10px;">[' + l.level + ']</span>' +
            '<span style="color: #94a3b8; margin-right: 8px; font-size: 10px;">[' + l.category + ']</span>' +
            escapeHtml(l.message) +
            '</div>';
        }).join('');
      } else {
        panel.innerHTML = '<div class="log-entry">暂无日志</div>';
      }
    } catch(e) {
      console.error('加载日志失败:', e);
      showToast('加载日志失败: ' + e.message, 'error');
    }
  }
  
  async function clearLogs() {
    showConfirm('清除所有日志？', async () => {
      try {
        const res = await fetch('/api/clear-logs', { method: 'POST' });
        if (!res.ok) {
          throw new Error('API请求失败: ' + res.status);
        }
        await loadLogs();
        showToast('日志清除成功', 'success');
      } catch(e) {
        console.error('清除日志失败:', e);
        showToast('清除日志失败: ' + e.message, 'error');
      }
    });
  }
  
  async function refreshLogs() { 
    try {
      await loadLogs();
    } catch(e) {
      console.error('刷新日志失败:', e);
    }
  }
  
  async function exportLogs() {
    try {
      const level = document.getElementById('logLevelFilter').value;
      const category = document.getElementById('logCategoryFilter').value;
      const keyword = document.getElementById('logKeyword').value;
      
      const params = new URLSearchParams();
      if (level) params.append('level', level);
      if (category) params.append('category', category);
      if (keyword) params.append('keyword', keyword);
      
      const url = '/api/export-logs?' + params.toString();
      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'CF_Logs_' + new Date().toISOString().split('T')[0] + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('日志导出成功', 'success');
      } else {
        throw new Error('API请求失败: ' + res.status);
      }
    } catch(e) {
      console.error('导出日志失败:', e);
      showToast('导出失败: ' + e.message, 'error');
    }
  }
  
  async function checkDBStatus() {
    try {
      const res = await fetch('/api/db-status');
      const data = await res.json();
      const card = document.getElementById('dbStatusCard');
      if (data.connected) {
        card.innerHTML = '<div style="background:#0f172a;padding:12px;border-radius:12px;margin-bottom:16px;border-left:3px solid #4ade80;">✅ 数据库正常 | 带宽池: ' + (data.counts?.high_quality_ips || 0) + '个</div>';
        card.style.display = 'block';
        setTimeout(() => { card.style.display = 'none'; }, 3000);
      } else { showToast('数据库连接失败', 'error'); }
    } catch(e) { showToast('检查失败', 'error'); }
  }
  
  async function loadIPs(forceRefresh = false) {
    try {
      const url = forceRefresh ? '/api/ips?t=' + Date.now() : '/api/ips';
      const res = await fetch(url);
      const data = await res.json();
      bandwidthPoolIPs = data.highQualityIPs || [];
      allIPs = data.allIPs || [];
      document.getElementById('totalCount').innerText = data.totalCount || 0;
      document.getElementById('failedCount').innerText = data.failedCount || 0;
      renderTable();
    } catch(e) {}
  }
  
  function renderTable() {
    const search = document.getElementById('search').value.toLowerCase();
    let ips = [...bandwidthPoolIPs].filter(item => item.ip.toLowerCase().includes(search));
    if (ips.length) {
      const html = ips.map(item => {
        const cn = window.countryNames?.[item.country] || item.country || '未知';
        const lc = getLatencyClass(item.latency);
        const score = calculateScore(item.latency, item.bandwidth);
        const scoreClass = getScoreClass(score);
        return \`<tr><td class="ip-cell">\${item.ip}</td><td><span class="latency-badge \${lc}">\${item.latency}ms</span></td><td>\${item.bandwidth ? item.bandwidth + ' Mbps' : '未测'}</td><td><span class="score-badge \${scoreClass}">\${score}分</span></td><td><span class="country-badge">\${cn}</span></td><td><button class="btn btn-sm btn-secondary" onclick="copyIP('\${item.ip}')">复制</button></td></tr>\`;
      }).join('');
      document.getElementById('ipTable2').innerHTML = html;
    } else {
      document.getElementById('ipTable2').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;">⏳ 暂无优质 IP，请点击"开始测速"或"修复带宽池"</td></tr>';
    }
  }
  
  function copyIP(ip) { navigator.clipboard.writeText(ip); showToast('IP 已复制', 'success'); }
  
  function exportIPs() {
    window.location.href = '/api/export-ips';
  }
  
  async function manualUpdate() {
    const btn = event.target;
    btn.disabled = true; btn.textContent = '更新中...';
    try {
      await fetch('/api/update', { method: 'POST' });
      setTimeout(async () => { await loadIPs(true); await loadLogs(); btn.disabled = false; btn.textContent = '🔄 刷新IP列表'; }, 3000);
    } catch(e) { btn.disabled = false; btn.textContent = '🔄 刷新IP列表'; }
  }
  
  async function updateDNSWithBest() {
    const count = parseInt(document.getElementById('ipCount').value) || 3;
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '更新中...';
    try {
      const res = await fetch('/api/update-dns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count }) });
      const data = await res.json();
      if (data.success) showToast('DNS更新成功！已更新 ' + data.count + ' 个IP', 'success');
      else showToast('DNS更新失败：' + (data.error || '请检查配置'), 'error');
    } catch(e) {
      showToast('更新失败', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🌐 更新DNS';
    }
  }
  
  function addSpeedResult(ip, result) {
    const score = result.success ? calculateScore(result.latency, result.bandwidth) : 0;
    speedTestResults.unshift({
      id: Date.now() + Math.random(), ip, latency: result.latency || null, bandwidth: result.bandwidth || null,
      success: result.success, score, country: result.country || 'unknown',
      countryName: window.countryNames?.[result.country] || result.country || '未知',
      timeStr: new Date().toLocaleTimeString('zh-CN')
    });
    if (speedTestResults.length > 100) speedTestResults = speedTestResults.slice(0, 100);
    updateSpeedResultDisplay();
    updateSpeedStats();
  }
  
  function updateSpeedStats() {
    const t = speedTestResults.length, s = speedTestResults.filter(r => r.success).length, f = t - s;
    const aL = s > 0 ? Math.round(speedTestResults.filter(r => r.success && r.latency).reduce((sum, r) => sum + r.latency, 0) / s) : 0;
    document.getElementById('testedCount').textContent = t;
    document.getElementById('successCount').textContent = s;
    document.getElementById('failCount').textContent = f;
    document.getElementById('avgLatency').textContent = aL ? aL + 'ms' : '--';
    if (t > 0) document.getElementById('speedStatsSummary').style.display = 'grid';
  }
  
  function updateSpeedResultDisplay() {
    const tb = document.getElementById('speedResultTable');
    if (speedTestResults.length === 0) { tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;">暂无测速结果</td></tr>'; return; }
    tb.innerHTML = speedTestResults.slice(0, 50).map(r => {
      const lc = r.latency ? getLatencyClass(r.latency) : '';
      const ld = r.success && r.latency ? '<span class="latency-badge ' + lc + '">' + r.latency + 'ms</span>' : '<span style="color:#f87171;">超时</span>';
      const scoreClass = getScoreClass(r.score);
      return '<tr class="speed-result-item"><td class="ip-cell">' + r.ip + '</td><td>' + ld + '</td><td>' + (r.bandwidth ? r.bandwidth + ' Mbps' : '-') + '</td><td><span class="score-badge ' + scoreClass + '">' + (r.success ? r.score + '分' : '-') + '</span></td><td><span class="country-badge">' + r.countryName + '</span></td><td style="font-size:11px;">' + r.timeStr + '</td><td class="' + (r.success ? 'speed-success' : 'speed-failed') + '">' + (r.success ? '✅ 成功' : '❌ 失败') + '</td></tr>';
    }).join('');
  }
  
  function clearSpeedResults() { showConfirm('清除所有测速记录？', () => { speedTestResults = []; updateSpeedResultDisplay(); updateSpeedStats(); }); }
  
  async function speedTestIP(ip) {
    try {
      const url = testMode === 'lite' ? '/api/speedtest-lite?ip=' + encodeURIComponent(ip) : '/api/speedtest?ip=' + encodeURIComponent(ip);
      const res = await fetch(url);
      const result = await res.json();
      if (result.success) addSpeedResult(ip, { success: true, latency: result.latency, bandwidth: result.bandwidth, country: result.country });
      else addSpeedResult(ip, { success: false });
      totalTested++;
      const pct = (totalTested / totalToTest * 100).toFixed(1);
      document.getElementById('speedProgressFill').style.width = pct + '%';
      document.getElementById('speedStatus').innerHTML = '已完成: ' + totalTested + '/' + totalToTest + ' (' + pct + '%) ' + (testMode === 'lite' ? '(轻量模式)' : '');
      if (testQueue.length) await speedTestIP(testQueue.shift());
      else if (--activeThreads === 0) {
        isSpeedTesting = false;
        document.getElementById('speedTestBtn').disabled = false;
        document.getElementById('speedTestBtn').textContent = '▶ 开始测速';
        document.getElementById('speedProgress').style.display = 'none';
        document.getElementById('speedStatus').style.display = 'none';
        await loadIPs(true);
        await loadPoolStats();
        
        // 检查是否启用了测速完成后自动更新DNS
        try {
          const dnsConfig = await fetch('/api/get-config').then(res => res.json());
          if (dnsConfig.autoUpdateAfterTest) {
            showToast('开始自动更新DNS...', 'info');
            const ipCount = parseInt(document.getElementById('ipCount').value) || 3;
            const res = await fetch('/api/update-dns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: ipCount, triggerSource: 'auto_after_local_test' }) });
            const result = await res.json();
            if (result.success) {
              showToast('DNS更新成功', 'success');
            } else {
              showToast('DNS更新失败: ' + (result.error || '未知错误'), 'error');
            }
          }
        } catch (e) {
          console.error('自动更新DNS失败:', e);
        }
      }
    } catch(e) {
      addSpeedResult(ip, { success: false });
      totalTested++;
      if (testQueue.length) await speedTestIP(testQueue.shift());
      else if (--activeThreads === 0) {
        isSpeedTesting = false;
        document.getElementById('speedTestBtn').disabled = false;
        document.getElementById('speedTestBtn').textContent = '▶ 开始测速';
        document.getElementById('speedProgress').style.display = 'none';
        document.getElementById('speedStatus').style.display = 'none';
      }
    }
  }
  
  async function startSpeedTest() {
    const now = Date.now();
    if (now - lastSpeedTestTime < MIN_SPEED_TEST_INTERVAL) {
      const waitTime = Math.ceil((MIN_SPEED_TEST_INTERVAL - (now - lastSpeedTestTime)) / 1000);
      showConfirm(\`距离上次测速不足1分钟，建议等待\${waitTime}秒后再测速，否则可能无法获取带宽数据。是否继续？\`, () => {
        startSpeedTestAfterConfirm();
      });
      return;
    }
    startSpeedTestAfterConfirm();
  }
  
  async function startSpeedTestAfterConfirm() {
    lastSpeedTestTime = Date.now();
    
    if (isSpeedTesting || !allIPs.length) {
      if (!allIPs.length) showToast('没有可测速的IP，请先点击"刷新IP列表"', 'warning');
      return;
    }
    const testCount = parseInt(document.getElementById('testCount').value) || 50;
    const threadCount = parseInt(document.getElementById('threadCount').value) || 10;
    const shuffled = [...allIPs].sort(() => 0.5 - Math.random());
    const queue = shuffled.slice(0, Math.min(testCount, allIPs.length));
    isSpeedTesting = true;
    activeThreads = Math.min(threadCount, 3);
    totalTested = 0;
    totalToTest = queue.length;
    testQueue = [...queue];
    speedTestResults = [];
    updateSpeedResultDisplay();
    updateSpeedStats();
    document.getElementById('speedTestBtn').disabled = true;
    document.getElementById('speedTestBtn').textContent = '测速中...';
    document.getElementById('speedProgress').style.display = 'block';
    document.getElementById('speedStatus').style.display = 'block';
    document.getElementById('speedProgressFill').style.width = '0%';
    document.getElementById('speedStatus').innerHTML = testMode === 'lite' ? '⚡ 轻量模式：仅测试延迟' : '📊 完整模式：测试延迟+带宽';
    for (let i = 0; i < activeThreads && testQueue.length; i++) { speedTestIP(testQueue.shift()); }
  }
  
  function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
  
  async function saveAdvancedSettings() {
    const maxPoolSizeElement = document.getElementById('maxPoolSize');
    const failedCooldownElement = document.getElementById('failedCooldown');
    const clearFailedElement = document.getElementById('clearFailedOnSave');
    
    if (!maxPoolSizeElement || !failedCooldownElement || !clearFailedElement) {
      showToast('设置项元素未找到', 'error');
      return false;
    }
    
    const maxPoolSize = parseInt(maxPoolSizeElement.value) || 50;
    const failedCooldown = parseInt(failedCooldownElement.value) || 15;
    const clearFailed = clearFailedElement.checked;
    
    if (maxPoolSize < 10 || maxPoolSize > 100) { showToast('带宽池容量必须在10-100之间', 'error'); return false; }
    if (failedCooldown < 1 || failedCooldown > 30) { showToast('冷却天数必须在1-30之间', 'error'); return false; }
    
    try {
      const res = await fetch('/api/save-advanced-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxHighQualityPoolSize: maxPoolSize, failedIpCooldownDays: failedCooldown, clearFailedIPs: clearFailed }) });
      if (!res.ok) {
        throw new Error('网络请求失败');
      }
      const data = await res.json();
      if (data.success) { if (clearFailed) showToast('失败IP黑名单已清空', 'success'); await loadAdvancedConfig(); return true; }
      else { showToast('高级设置保存失败', 'error'); return false; }
    } catch(e) { showToast('高级设置保存失败: ' + e.message, 'error'); return false; }
  }

  async function loadAdvancedConfig() {
    try {
      const res = await fetch('/api/get-advanced-config');
      if (!res.ok) {
        throw new Error('网络请求失败');
      }
      const data = await res.json();
      const maxPoolSize = document.getElementById('maxPoolSize');
      const failedCooldown = document.getElementById('failedCooldown');
      if (maxPoolSize) maxPoolSize.value = data.maxHighQualityPoolSize || 30;
      if (failedCooldown) failedCooldown.value = data.failedIpCooldownDays || 15;
    } catch(e) {
      const maxPoolSize = document.getElementById('maxPoolSize');
      const failedCooldown = document.getElementById('failedCooldown');
      if (maxPoolSize) maxPoolSize.value = 30;
      if (failedCooldown) failedCooldown.value = 15;
    }
  }

  async function saveUIConfig() {
    const ipCount = parseInt(document.getElementById('ipCount').value) || 3;
    const testCount = parseInt(document.getElementById('testCount').value) || 50;
    const threadCount = parseInt(document.getElementById('threadCount').value) || 10;
    const bandwidthFileSize = parseInt(document.getElementById('bandwidthFileSize').value) || 3;
    try {
      const res = await fetch('/api/save-ui-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ipCount, testCount, threadCount, bandwidthFileSize }) });
      if (!res.ok) {
        throw new Error('网络请求失败');
      }
      const data = await res.json();
      return data;
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async function saveAllSettings() {
    const btn = event.target;
    btn.disabled = true; btn.textContent = '保存中...';
    try {
      const uiData = await saveUIConfig();
      
      if (!uiData.success) {
        showToast('运行参数保存失败: ' + (uiData.error || '未知错误'), 'error');
        return;
      }
      
      const advancedSuccess = await saveAdvancedSettings();
      
      if (advancedSuccess) {
        await loadPoolStats();
        showToast('所有设置保存成功！', 'success');
      } else {
        showToast('高级设置保存失败', 'error');
      }
    } catch(e) {
      showToast('保存失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '💾 保存所有设置';
    }
  }

  async function loadUIConfig() {
    try {
      const res = await fetch('/api/get-ui-config');
      if (!res.ok) {
        throw new Error('网络请求失败');
      }
      const data = await res.json();
      const ipCount = document.getElementById('ipCount');
      const testCount = document.getElementById('testCount');
      const threadCount = document.getElementById('threadCount');
      const bandwidthFileSize = document.getElementById('bandwidthFileSize');
      if (ipCount) ipCount.value = data.ipCount || 3;
      if (testCount) testCount.value = data.testCount || 50;
      if (threadCount) threadCount.value = data.threadCount || 10;
      if (bandwidthFileSize) bandwidthFileSize.value = data.bandwidthFileSize || 3;
    } catch(e) {
      const ipCount = document.getElementById('ipCount');
      const testCount = document.getElementById('testCount');
      const threadCount = document.getElementById('threadCount');
      const bandwidthFileSize = document.getElementById('bandwidthFileSize');
      if (ipCount) ipCount.value = 3;
      if (testCount) testCount.value = 50;
      if (threadCount) threadCount.value = 10;
      if (bandwidthFileSize) bandwidthFileSize.value = 3;
    }
  }
  
  document.getElementById('search').addEventListener('input', () => renderTable());
  
  window.onload = async () => {
    restoreIPTableState();
    if (await checkAuth()) {
      await Promise.all([loadVisitorInfo(), loadIPs(true), loadLogs(), loadPoolStats(), loadUIConfig(), loadAdvancedConfig()]);
      setInterval(() => loadLogs(), 5000);
    }
  };
  
  window.countryNames = ${countryNamesStr};
</script>
</body>
</html>`;
}

function getSettingsHTML(env) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CF优选IP · 系统设置</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 20px;
    }
    .container { max-width: 900px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; flex-wrap: wrap; gap: 12px; }
    h1 { font-size: 26px; font-weight: 700; background: linear-gradient(135deg, #60a5fa, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .back-btn {
      background: #1e293b; color: #94a3b8; text-decoration: none; padding: 8px 20px; border-radius: 40px;
      border: 1px solid #334155; transition: 0.2s; display: inline-flex; align-items: center; gap: 6px;
    }
    .back-btn:hover { color: #60a5fa; border-color: #60a5fa; background: #0f172a; }
    .card { background: #1e293b; border-radius: 20px; border: 1px solid #334155; margin-bottom: 24px; overflow: hidden; }
    .card-header { padding: 18px 24px; border-bottom: 1px solid #334155; background: #0f172a; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: all 0.2s ease; }
    .card-header:hover { background: #1e293b; }
    .card-header h2 { font-size: 18px; font-weight: 600; display: flex; align-items: center; gap: 8px; margin: 0; }
    .card-body { padding: 24px; max-height: 800px; overflow-y: auto; transition: all 0.3s ease; }
    .card-body.collapsed { max-height: 0; padding: 0; overflow: hidden; border-top: none; }
    .toggle-icon { transition: transform 0.3s ease; color: #60a5fa; font-size: 16px; }
    .toggle-icon.collapsed { transform: rotate(-90deg); }
    .form-group { margin-bottom: 24px; }
    .form-group label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 8px; font-weight: 500; }
    .form-group input, .form-group select {
      width: 100%; padding: 12px 16px; background: #0f172a; border: 1px solid #334155;
      border-radius: 12px; color: #f1f5f9; font-size: 14px; transition: all 0.2s;
    }
    .form-group input:focus, .form-group select:focus { outline: none; border-color: #60a5fa; box-shadow: 0 0 0 3px rgba(96,165,250,0.2); }
    .checkbox { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .checkbox input { width: 18px; height: 18px; cursor: pointer; }
    .checkbox label { color: #e2e8f0; font-size: 14px; cursor: pointer; }
    .btn {
      padding: 12px 24px; border: none; border-radius: 12px; font-size: 14px; font-weight: 600;
      cursor: pointer; transition: all 0.2s;
    }
    .btn-primary { background: #2563eb; color: white; }
    .btn-primary:hover { background: #1d4ed8; transform: translateY(-1px); }
    .btn-success { background: #059669; color: white; }
    .btn-success:hover { background: #047857; }
    .btn-secondary { background: #4b5563; color: white; }
    .btn-secondary:hover { background: #6b7280; }
    .btn-danger { background: #b91c1c; color: white; }
    .full-width { width: 100%; }
    .action-bar { display: flex; gap: 12px; margin-top: 20px; }
    .info-text { font-size: 12px; color: #6b7280; margin-top: 8px; }
    .sources-list { margin-bottom: 16px; max-height: 280px; overflow-y: auto; }
    .source-item { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; background: #0f172a; padding: 10px 14px; border-radius: 12px; }
    .source-url { flex: 1; font-family: monospace; font-size: 12px; word-break: break-all; color: #60a5fa; }
    .pool-info { background: #0f172a; border-radius: 12px; padding: 14px; margin-top: 12px; }
    hr { border: none; border-top: 1px solid #334155; margin: 20px 0; }
    .strategy-info { background: #0f172a; border-radius: 12px; padding: 14px; margin-bottom: 16px; border-left: 3px solid #60a5fa; }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>⚙️ 系统设置</h1>
    <a href="/" class="back-btn">← 返回主页</a>
  </div>

  <div class="card">
    <div class="card-header" onclick="toggleCard(this)">
      <h2>📡 IP数据源管理</h2>
      <span class="toggle-icon">▶</span>
    </div>
    <div class="card-body collapsed">
      <div class="info-text" style="margin-bottom: 16px;">💡 支持导入IP列表或CIDR网段，每行一个，支持HTTP/HTTPS协议</div>
      <div class="form-group">
        <label>数据源列表</label>
        <div id="sourcesList" class="sources-list"></div>
        <div style="display: flex; gap: 10px;">
          <input type="text" id="newSourceUrl" placeholder="https://example.com/ips.txt" style="flex: 1;">
          <button class="btn btn-primary" onclick="addDataSource()">添加</button>
        </div>
      </div>
      <div class="form-group">
        <label>数据源测试</label>
        <div style="display: flex; gap: 10px;">
          <input type="text" id="testUrl" placeholder="输入URL测试" style="flex: 1;">
          <button class="btn btn-secondary" onclick="testDataSource()">测试</button>
        </div>
        <div id="testResult" style="margin-top: 10px; font-size: 12px; display: none;"></div>
      </div>
      <div class="action-bar">
        <button class="btn btn-primary full-width" onclick="saveDataSources()">💾 保存数据源</button>
        <button class="btn btn-secondary full-width" onclick="resetDataSources()">🔄 恢复默认</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header" onclick="toggleCard(this)">
      <h2>📌 自定义IP导入</h2>
      <span class="toggle-icon">▶</span>
    </div>
    <div class="card-body collapsed">
      <div class="info-text" style="margin-bottom: 16px;">💡 支持导入单个IP或CIDR网段，每行一个</div>
      <div class="form-group">
        <label>自定义IP列表</label>
        <textarea id="customIPs" rows="6" placeholder="输入IP或CIDR，每行一个
例如:
1.1.1.1
8.8.8.8/24" style="width: 100%; padding: 12px 16px; background: #0f172a; border: 1px solid #334155; border-radius: 12px; color: #f1f5f9; font-size: 14px; font-family: monospace; resize: vertical;"></textarea>
      </div>
      <div id="customIPsStatus" style="margin-bottom: 16px; font-size: 12px; color: #94a3b8;">当前无自定义IP</div>
      <div class="action-bar">
        <button class="btn btn-primary full-width" onclick="importCustomIPs()">📥 导入IP</button>
        <button class="btn btn-danger full-width" onclick="clearCustomIPs()">🗑️ 清除所有</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header" onclick="toggleCard(this)">
      <h2>📌 DNS 配置</h2>
      <span class="toggle-icon">▶</span>
    </div>
    <div class="card-body collapsed">
      <div class="form-group">
        <label>Cloudflare API Token</label>
        <input type="password" id="apiToken" placeholder="输入你的API Token">
        <div class="info-text">需要具备 DNS 编辑权限的 API Token</div>
      </div>
      <div class="form-group">
        <label>Zone ID</label>
        <input type="password" id="zoneId" placeholder="输入域名所在的Zone ID">
      </div>
      <div class="form-group">
        <label>域名记录</label>
        <input type="text" id="recordName" placeholder="例如: cf.yourdomain.com">
      </div>
      <div class="form-group">
        <label>代理状态</label>
        <select id="proxied">
          <option value="false">仅DNS (灰色云 - 直接解析)</option>
          <option value="true">开启代理 (橙色云 - 隐藏源IP)</option>
        </select>
      </div>
      <div class="checkbox">
        <input type="checkbox" id="autoUpdate"> <label>每小时自动更新DNS (定时任务)</label>
      </div>
      <div class="checkbox">
        <input type="checkbox" id="autoUpdateAfterTest"> <label>测速完成后自动更新DNS</label>
      </div>
      <div class="action-bar">
        <button class="btn btn-primary full-width" onclick="saveAllConfig()">💾 保存DNS配置</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header" onclick="toggleCard(this)">
      <h2>📱 Telegram 通知</h2>
      <span class="toggle-icon">▶</span>
    </div>
    <div class="card-body collapsed">
      <div class="checkbox">
        <input type="checkbox" id="telegramEnabled"> <label>启用Telegram通知</label>
      </div>
      <div id="telegramConfig" style="margin-top: 16px;">
        <div class="form-group">
          <label>Bot Token</label>
          <input type="password" id="telegramBotToken" placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz">
        </div>
        <div class="form-group">
          <label>Chat ID</label>
          <input type="password" id="telegramChatId" placeholder="123456789">
        </div>
        <div class="checkbox">
          <input type="checkbox" id="telegramHideIP" checked> <label>隐藏IP后两位 (显示为 ***.***)</label>
        </div>
      </div>
      <div class="action-bar">
        <button class="btn btn-primary" style="flex:1;" onclick="testTelegram()">📨 测试通知</button>
        <button class="btn btn-success" style="flex:1;" onclick="saveAllConfig()">💾 保存所有配置</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header" onclick="toggleCard(this)">
      <h2>📝 日志管理</h2>
      <span class="toggle-icon">▶</span>
    </div>
    <div class="card-body collapsed">
      <div class="form-group">
        <label>自动清理过期日志</label>
        <div class="checkbox">
          <input type="checkbox" id="logAutoClean" checked> <label>启用自动清理</label>
        </div>
      </div>
      <div class="form-group">
        <label>清理周期 (3-7天)</label>
        <input type="number" id="logCleanDays" min="3" max="7" value="7">
        <div class="info-text">设置日志保留的天数，超过此天数的日志将被自动清理</div>
      </div>
      <div class="action-bar">
        <button class="btn btn-primary full-width" onclick="saveLogConfig()">💾 保存日志配置</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header" onclick="toggleCard(this)">
      <h2>🚀 带宽优先算法说明</h2>
      <span class="toggle-icon">▶</span>
    </div>
    <div class="card-body collapsed">
      <div class="strategy-info">
        <h3>📊 评分公式</h3>
        <p>带宽分数 × 80% + 延迟分数 × 20%</p>
        
        <h3>🎯 带宽池准入标准</h3>
        <p>带宽 ≥ 100Mbps，小于100Mbps进入备用池</p>
        
        <h3>✨ 优秀带宽</h3>
        <p>≥500Mbps 直接加入带宽池</p>
        
        <h3>🔄 池内替换规则</h3>
        <p>只有带宽更高的IP才能替换池中成员</p>
        
        <h3>⚡ 测试优先级</h3>
        <p>优先测试历史高带宽IP，带宽优质池大于备用池大于总IP池大于失败池</p>
        
        <h3>✅ 确保优选池中都是高带宽IP，保障传输速度</h3>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header" onclick="toggleCard(this)">
      <h2>🤖 测速策略</h2>
      <span class="toggle-icon">▶</span>
    </div>
    <div class="card-body collapsed">
      <div class="strategy-info">
        <div style="margin-bottom: 12px;">📅 Cron定时任务会根据地区IP数量智能选择测速地区</div>
        <div style="margin-bottom: 12px;">🎯 优先维护IP不足的亚洲地区</div>
        <div style="margin-bottom: 12px;">🌍 亚洲时间0-6点会进行全球维护</div>
        <div style="color: #94a3b8; font-size: 12px;">系统会自动管理测速策略，无需手动配置</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header" onclick="toggleCard(this)">
      <h2>ℹ️ 关于</h2>
      <span class="toggle-icon">▶</span>
    </div>
    <div class="card-body collapsed">
      <p style="margin-bottom: 8px;">CF优选IP可视化面板 - 双池智能优选版</p>
      <p style="font-size: 13px; color: #94a3b8;">版本: ${VERSION}</p>
      <p style="font-size: 13px; color: #94a3b8; margin-top: 12px;"><a href="${GITHUB_URL}" target="_blank" style="color: #60a5fa;">GitHub仓库</a></p>
    </div>
  </div>
</div>

<script>
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.style.position = 'fixed';
    toast.style.top = '20px';
    toast.style.right = '20px';
    toast.style.padding = '12px 20px';
    toast.style.borderRadius = '8px';
    toast.style.color = 'white';
    toast.style.fontSize = '14px';
    toast.style.fontWeight = '500';
    toast.style.zIndex = '9999';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    
    switch(type) {
      case 'success':
        toast.style.backgroundColor = '#10b981';
        break;
      case 'error':
        toast.style.backgroundColor = '#ef4444';
        break;
      case 'warning':
        toast.style.backgroundColor = '#f59e0b';
        break;
      default:
        toast.style.backgroundColor = '#3b82f6';
    }
    
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(0)';
    }, 10);
    
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => {
        document.body.removeChild(toast);
      }, 300);
    }, 3000);
  }
  
  function showConfirm(message, onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '9999';
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s ease';
    
    const dialog = document.createElement('div');
    dialog.style.background = '#1e293b';
    dialog.style.borderRadius = '12px';
    dialog.style.padding = '24px';
    dialog.style.minWidth = '300px';
    dialog.style.maxWidth = '400px';
    dialog.style.boxShadow = '0 25px 50px -12px rgba(0, 0, 0, 0.5)';
    dialog.style.border = '1px solid #334155';
    dialog.style.opacity = '0';
    dialog.style.transform = 'scale(0.9)';
    dialog.style.transition = 'all 0.3s ease';
    
    const messageElement = document.createElement('div');
    messageElement.style.color = '#e2e8f0';
    messageElement.style.fontSize = '14px';
    messageElement.style.marginBottom = '20px';
    messageElement.style.textAlign = 'center';
    messageElement.textContent = message;
    
    const buttonContainer = document.createElement('div');
    buttonContainer.style.display = 'flex';
    buttonContainer.style.gap = '10px';
    buttonContainer.style.justifyContent = 'center';
    
    const cancelButton = document.createElement('button');
    cancelButton.textContent = '取消';
    cancelButton.style.padding = '8px 20px';
    cancelButton.style.border = '1px solid #334155';
    cancelButton.style.borderRadius = '8px';
    cancelButton.style.background = '#0f172a';
    cancelButton.style.color = '#94a3b8';
    cancelButton.style.fontSize = '14px';
    cancelButton.style.cursor = 'pointer';
    cancelButton.style.transition = 'all 0.2s ease';
    
    cancelButton.addEventListener('mouseenter', () => {
      cancelButton.style.background = '#1e293b';
      cancelButton.style.color = '#e2e8f0';
    });
    
    cancelButton.addEventListener('mouseleave', () => {
      cancelButton.style.background = '#0f172a';
      cancelButton.style.color = '#94a3b8';
    });
    
    const confirmButton = document.createElement('button');
    confirmButton.textContent = '确定';
    confirmButton.style.padding = '8px 20px';
    confirmButton.style.border = 'none';
    confirmButton.style.borderRadius = '8px';
    confirmButton.style.background = '#2563eb';
    confirmButton.style.color = 'white';
    confirmButton.style.fontSize = '14px';
    confirmButton.style.cursor = 'pointer';
    confirmButton.style.transition = 'all 0.2s ease';
    
    confirmButton.addEventListener('mouseenter', () => {
      confirmButton.style.background = '#1d4ed8';
    });
    
    confirmButton.addEventListener('mouseleave', () => {
      confirmButton.style.background = '#2563eb';
    });
    
    cancelButton.addEventListener('click', () => {
      overlay.style.opacity = '0';
      dialog.style.opacity = '0';
      dialog.style.transform = 'scale(0.9)';
      setTimeout(() => {
        document.body.removeChild(overlay);
      }, 300);
      if (onCancel) onCancel();
    });
    
    confirmButton.addEventListener('click', () => {
      overlay.style.opacity = '0';
      dialog.style.opacity = '0';
      dialog.style.transform = 'scale(0.9)';
      setTimeout(() => {
        document.body.removeChild(overlay);
      }, 300);
      if (onConfirm) onConfirm();
    });
    
    buttonContainer.appendChild(cancelButton);
    buttonContainer.appendChild(confirmButton);
    dialog.appendChild(messageElement);
    dialog.appendChild(buttonContainer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    setTimeout(() => {
      overlay.style.opacity = '1';
      dialog.style.opacity = '1';
      dialog.style.transform = 'scale(1)';
    }, 10);
  }
  
  function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
  
  async function loadDataSources() {
    const container = document.getElementById('sourcesList');
    if (!container) return;
    
    container.innerHTML = '<div style="color:#60a5fa;text-align:center;padding:20px;">⏳ 加载中...</div>';
    
    try {
      const res = await fetch('/api/get-data-sources');
      if (!res.ok) {
        container.innerHTML = '<div style="color:#f87171;text-align:center;padding:20px;">❌ 加载失败：网络错误 (' + res.status + ')</div>';
        return;
      }
      
      const data = await res.json();
      if (!data || typeof data !== 'object') {
        container.innerHTML = '<div style="color:#f87171;text-align:center;padding:20px;">❌ 加载失败：数据格式错误</div>';
        return;
      }
      
      if (!data.success) {
        container.innerHTML = '<div style="color:#f87171;text-align:center;padding:20px;">❌ 加载失败：' + (data.error || '未知错误') + '</div>';
        return;
      }
      
      if (data.sources && data.sources.length) {
        container.innerHTML = data.sources.map((source, idx) => '<div class="source-item"><span class="source-url">' + escapeHtml(source) + '</span><button class="btn btn-sm btn-danger" onclick="removeDataSource(' + idx + ')">删除</button></div>').join('');
      } else {
        container.innerHTML = '<div style="color:#6b7280;text-align:center;padding:20px;">使用默认数据源</div>';
      }
    } catch(e) {
      container.innerHTML = '<div style="color:#f87171;text-align:center;padding:20px;">❌ 加载失败：' + (e.message || '网络错误') + '</div>';
    }
  }

  async function loadCustomIPs() {
    try {
      const res = await fetch('/api/ips');
      const data = await res.json();
      const status = document.getElementById('customIPsStatus');
      if (data.customIPs && data.customIPs.length) {
        status.innerHTML = '当前已导入 ' + data.customIPs.length + ' 个自定义IP/CIDR';
        document.getElementById('customIPs').value = data.customIPs.join('\\n');
      } else {
        status.innerHTML = '当前无自定义IP';
        document.getElementById('customIPs').value = '';
      }
    } catch(e) {}
  }

  async function importCustomIPs() {
    const textarea = document.getElementById('customIPs');
    const ips = textarea.value.trim().split('\\n').filter(line => line.trim());
    
    if (ips.length === 0) {
      showToast('请输入IP或CIDR', 'error');
      return;
    }
    
    try {
      const res = await fetch('/api/save-custom-ips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ips })
      });
      const data = await res.json();
      if (data.success) { showToast('成功导入 ' + data.validCount + ' 个IP/CIDR，展开为 ' + data.expandedCount + ' 个IP', 'success');
        await loadCustomIPs();
      } else {
        showToast('导入失败: ' + (data.error || '未知错误'), 'error');
      }
    } catch(e) {
      showToast('导入失败: ' + e.message, 'error');
    }
  }

  async function clearCustomIPs() {
    showConfirm('确定要清除所有自定义IP吗？', async () => {
      try {
        const res = await fetch('/api/clear-custom-ips', {
          method: 'POST'
        });
        const data = await res.json();
        if (data.success) {
          showToast('已清除所有自定义IP', 'success');
          await loadCustomIPs();
        } else {
          showToast('清除失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch(e) {
        showToast('清除失败: ' + e.message, 'error');
      }
    });
  }
  
  function addDataSource() {
    const url = document.getElementById('newSourceUrl').value.trim();
    if (!url) { 
      showToast('请输入URL', 'error');
      return; 
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) { 
      showToast('URL必须以http://或https://开头', 'error');
      return; 
    }
    const container = document.getElementById('sourcesList');
    const newItem = document.createElement('div');
    newItem.className = 'source-item';
    newItem.innerHTML = '<span class="source-url">' + escapeHtml(url) + '</span><button class="btn btn-sm btn-danger" onclick="this.parentElement.remove()">删除</button>';
    newItem.style.opacity = '0';
    newItem.style.transform = 'translateY(-10px)';
    newItem.style.transition = 'all 0.3s ease';
    container.appendChild(newItem);
    setTimeout(() => {
      newItem.style.opacity = '1';
      newItem.style.transform = 'translateY(0)';
    }, 10);
    document.getElementById('newSourceUrl').value = '';
    showToast('数据源添加成功', 'success');
  }
  
  function removeDataSource(index) {
    const items = document.querySelectorAll('#sourcesList .source-item');
    if (items[index]) items[index].remove();
  }
  
  async function saveDataSources() {
    const items = document.querySelectorAll('#sourcesList .source-url');
    const sources = Array.from(items).map(span => span.textContent.trim());
    if (sources.length === 0) {
      showConfirm('数据源列表为空，将恢复默认数据源。确定吗？', async () => {
        saveDataSourcesWithSources(sources);
      });
      return;
    }
    saveDataSourcesWithSources(sources);
  }
  
  async function saveDataSourcesWithSources(sources) {
    const btn = event.target;
    const originalText = btn.textContent;
    btn.disabled = true; btn.textContent = '保存中...';
    try {
      const res = await fetch('/api/save-data-sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources }) });
      if (!res.ok) {
        throw new Error('网络请求失败 (' + res.status + ')');
      }
      const data = await res.json();
      if (data.success) { 
        showToast('数据源保存成功！共 ' + data.sources.length + ' 个源', 'success'); 
        setTimeout(() => location.reload(), 1500); 
      } else {
        showToast('保存失败: ' + (data.error || '未知错误'), 'error');
      }
    } catch(e) { 
      showToast('保存失败: ' + e.message, 'error'); 
    } finally { 
      btn.disabled = false; 
      btn.textContent = originalText; 
    }
  }
  
  async function resetDataSources() {
    showConfirm('恢复默认数据源？当前自定义数据源将被清除', async () => {
      const btn = event.target;
      btn.disabled = true; btn.textContent = '恢复中...';
      try {
        const res = await fetch('/api/save-data-sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: [] }) });
        if (!res.ok) {
          throw new Error('网络请求失败 (' + res.status + ')');
        }
        const data = await res.json();
        if (data.success) { 
          showToast('已恢复默认数据源', 'success'); 
          await loadDataSources(); 
          setTimeout(() => location.reload(), 1500); 
        } else {
          showToast('恢复失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch(e) { 
        showToast('恢复失败: ' + e.message, 'error'); 
      } finally { 
        btn.disabled = false; 
        btn.textContent = '🔄 恢复默认'; 
      }
    });
  }
  
  async function testDataSource() {
    const url = document.getElementById('testUrl').value.trim();
    if (!url) { 
      showToast('请输入URL', 'error'); 
      return; 
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) { 
      showToast('URL必须以http://或https://开头', 'error'); 
      return; 
    }
    const resultDiv = document.getElementById('testResult');
    resultDiv.style.display = 'block'; 
    resultDiv.innerHTML = '⏳ 测试中...'; 
    resultDiv.style.color = '#60a5fa';
    try {
      const res = await fetch('/api/test-data-source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      if (!res.ok) {
        throw new Error('网络请求失败 (' + res.status + ')');
      }
      const data = await res.json();
      if (data.success) {
        resultDiv.innerHTML = '✅ 测试成功<br>📊 状态码: ' + data.status + '<br>📝 CIDR数量: ' + data.cidrCount + '<br>🌐 IP数量: ' + data.ipCount + '<br>🔍 预览: ' + (data.preview || []).join(', ') + (data.ipCount > 5 ? '...' : '');
        resultDiv.style.color = '#4ade80';
      } else { 
        resultDiv.innerHTML = '❌ 测试失败: ' + data.error; 
        resultDiv.style.color = '#f87171'; 
      }
    } catch(e) { 
      resultDiv.innerHTML = '❌ 测试异常: ' + e.message; 
      resultDiv.style.color = '#f87171'; 
    }
  }
  
  async function loadConfig() {
    try {
      const res = await fetch('/api/get-config');
      if (!res.ok) {
        throw new Error('网络请求失败 (' + res.status + ')');
      }
      const data = await res.json();
      if (!data || typeof data !== 'object') {
        throw new Error('数据格式错误');
      }
      document.getElementById('apiToken').value = data.apiToken || '';
      document.getElementById('zoneId').value = data.zoneId || '';
      document.getElementById('recordName').value = data.recordName || '';
      document.getElementById('proxied').value = data.proxied !== undefined ? (data.proxied ? 'true' : 'false') : 'false';
      document.getElementById('autoUpdate').checked = data.autoUpdate || false;
      document.getElementById('autoUpdateAfterTest').checked = data.autoUpdateAfterTest || false;
      document.getElementById('telegramEnabled').checked = data.telegramEnabled || false;
      document.getElementById('telegramBotToken').value = data.telegramBotToken || '';
      document.getElementById('telegramChatId').value = data.telegramChatId || '';
      document.getElementById('telegramHideIP').checked = data.telegramHideIP !== false;
      toggleTelegramConfig();
    } catch(e) { 
      showToast('加载配置失败: ' + e.message, 'error'); 
    }
  }
  
  async function loadLogConfig() {
    try {
      const res = await fetch('/api/get-log-config');
      if (!res.ok) {
        throw new Error('网络请求失败 (' + res.status + ')');
      }
      const data = await res.json();
      if (!data || typeof data !== 'object') {
        throw new Error('数据格式错误');
      }
      document.getElementById('logAutoClean').checked = data.autoClean !== false;
      document.getElementById('logCleanDays').value = data.cleanDays || 7;
    } catch(e) {
      document.getElementById('logAutoClean').checked = true;
      document.getElementById('logCleanDays').value = 7;
    }
  }
  
  async function saveLogConfig() {
    const config = {
      autoClean: document.getElementById('logAutoClean').checked,
      cleanDays: parseInt(document.getElementById('logCleanDays').value) || 7
    };
    if (config.cleanDays < 3 || config.cleanDays > 7) {
      showToast('清理周期必须在3-7天之间', 'error');
      return;
    }
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '保存中...';
    try {
      const res = await fetch('/api/save-log-config', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(config) 
      });
      if (!res.ok) {
        throw new Error('网络请求失败 (' + res.status + ')');
      }
      const data = await res.json();
      if (data.success) {
        showToast('日志配置保存成功！', 'success');
      } else {
        showToast('保存失败: ' + (data.error || '未知错误'), 'error');
      }
    } catch(e) {
      showToast('保存失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '💾 保存日志配置';
    }
  }
  

  function toggleTelegramConfig() {
    const enabled = document.getElementById('telegramEnabled').checked;
    const configDiv = document.getElementById('telegramConfig');
    const inputs = configDiv.querySelectorAll('input');
    inputs.forEach(input => { input.disabled = !enabled; });
  }
  
  async function saveAllConfig() {
    const config = {
      apiToken: document.getElementById('apiToken').value.trim(),
      zoneId: document.getElementById('zoneId').value.trim(),
      recordName: document.getElementById('recordName').value.trim(),
      proxied: document.getElementById('proxied').value === 'true',
      autoUpdate: document.getElementById('autoUpdate').checked,
      autoUpdateAfterTest: document.getElementById('autoUpdateAfterTest').checked,
      telegramEnabled: document.getElementById('telegramEnabled').checked,
      telegramBotToken: document.getElementById('telegramBotToken').value.trim(),
      telegramChatId: document.getElementById('telegramChatId').value.trim(),
      telegramHideIP: document.getElementById('telegramHideIP').checked
    };
    if (config.telegramEnabled && (!config.telegramBotToken || !config.telegramChatId)) {
      showToast('启用 Telegram 通知时，Bot Token 和 Chat ID 不能为空', 'error'); 
      return;
    }
    const btn = event.target;
    btn.disabled = true; 
    btn.textContent = '保存中...';
    try {
      const res = await fetch('/api/save-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      if (!res.ok) {
        throw new Error('网络请求失败 (' + res.status + ')');
      }
      const data = await res.json();
      if (data.success) {
        showToast('所有配置保存成功！', 'success');
      } else {
        showToast('保存失败: ' + (data.error || '未知错误'), 'error');
      }
    } catch(e) { 
      showToast('保存失败: ' + e.message, 'error'); 
    } finally { 
      btn.disabled = false; 
      btn.textContent = '💾 保存所有配置'; 
    }
  }
  
  async function testTelegram() {
    const enabled = document.getElementById('telegramEnabled').checked;
    if (!enabled) { showToast('请先启用 Telegram 通知', 'error'); return; }
    const botToken = document.getElementById('telegramBotToken').value.trim();
    const chatId = document.getElementById('telegramChatId').value.trim();
    if (!botToken || !chatId) { showToast('请先填写 Bot Token 和 Chat ID', 'error'); return; }
    const btn = event.target;
    btn.disabled = true; btn.textContent = '发送中...';
    try {
      const res = await fetch('/api/test-telegram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botToken, chatId }) });
      const data = await res.json();
      if (data.success) showToast('✅ 测试消息发送成功！请检查 Telegram', 'success');
      else showToast('❌ 发送失败: ' + (data.error || '请检查 Token 和 Chat ID'), 'error');
    } catch(e) { showToast('发送失败: ' + e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = '📨 测试通知'; }
  }
  

  
  document.getElementById('telegramEnabled').addEventListener('change', toggleTelegramConfig);
  
  function toggleCard(header) {
    const cardBody = header.nextElementSibling;
    const toggleIcon = header.querySelector('.toggle-icon');
    
    if (cardBody.classList.contains('collapsed')) {
      cardBody.classList.remove('collapsed');
      toggleIcon.classList.remove('collapsed');
    } else {
      cardBody.classList.add('collapsed');
      toggleIcon.classList.add('collapsed');
    }
  }
  
  window.countryNames = ${JSON.stringify(COUNTRY_NAMES)};

</script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const config = getEnvConfig(env);

    // 同步初始化数据库，确保表结构存在
    try {
      await initDatabase(env);
      await runD1Migrations(env);
    } catch (e) {
      console.error('数据库初始化失败:', e);
    }

    ctx.waitUntil(cleanExpiredFailedIPs(env).catch(() => {}));
    ctx.waitUntil(cleanExpiredGeoCache(env).catch(() => {}));
    ctx.waitUntil(cleanExpiredLogs(env).catch(() => {}));

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
      });
    }

    if (path === '/login') {
      return new Response(getLoginHTML(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (path === '/api/login' && request.method === 'POST') return handleLogin(request, env);
    if (path === '/api/check-auth') {
      const sessionId = getSessionId(request);
      const isValid = await verifySession(sessionId, env);
      return new Response(JSON.stringify({ authenticated: isValid, hasAdminPassword: !!config.adminPassword }), { headers: { 'Content-Type': 'application/json' } });
    }

    const sessionId = getSessionId(request);
    if (!await verifySession(sessionId, env)) {
      if (path.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      return Response.redirect(`${url.origin}/login`, 302);
    }

    if (path === '/') {
      const html = await getMainHTML(env);
      return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (path === '/settings') {
      return new Response(getSettingsHTML(env), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    // API 路由
    if (path === '/api/repair-bandwidth-pool' && request.method === 'POST') {
      const result = await repairBandwidthPool(env);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    
    if (path === '/api/debug-bandwidth-pool') {
      const result = await debugBandwidthPool(env);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    
    if (path === '/api/get-pool-stats') {
      const type = url.searchParams.get('type') || 'bandwidth';
      const stats = await getPoolStats(env, type);
      return new Response(JSON.stringify(stats), { headers: { 'Content-Type': 'application/json' } });
    }
    
    if (path === '/api/speedtest-lite' && request.method === 'GET') {
      const ip = url.searchParams.get('ip');
      if (!ip) return new Response(JSON.stringify({ error: '缺少IP参数' }), { status: 400 });
      
      try {
        let totalLatency = 0, successCount = 0;
        for (let i = 0; i < 3; i++) {
          try {
            const startTime = Date.now();
            const response = await fetch('https://speed.cloudflare.com/__down?bytes=1000', {
              headers: { 'Host': 'speed.cloudflare.com' },
              cf: { resolveOverride: ip },
              signal: AbortSignal.timeout(5000)
            });
            if (response.ok) {
              await response.text();
              totalLatency += Date.now() - startTime;
              successCount++;
            }
          } catch (e) {}
          if (i < 2) await new Promise(r => setTimeout(r, 100));
        }
        
        if (successCount === 0) {
          return new Response(JSON.stringify({ success: false, ip, error: '延迟测试失败' }), { headers: { 'Content-Type': 'application/json' } });
        }
        
        const avgLatency = Math.round(totalLatency / successCount);
        const geo = await getIPGeo(env, ip);
        const bandwidthEstimate = estimateBandwidthByLatency(avgLatency);
        
        return new Response(JSON.stringify({
          success: true, ip, latency: avgLatency, bandwidth: bandwidthEstimate,
          country: geo.country, countryName: COUNTRY_NAMES[geo.country] || geo.country
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, ip, error: error.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }
    
    if (path === '/api/get-quality-mode') {
      const mode = await getQualityMode(env);
      const reliability = await checkBandwidthReliability(env);
      return new Response(JSON.stringify({ success: true, mode, bandwidthReliable: reliability.reliable, abnormalRate: reliability.rate }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/force-clean-pool' && request.method === 'POST') {
      const result = await cleanHighQualityPool(env, true);
      highQualityCache.clear();
      await addSystemLog(env, `🔧 手动强制清理带宽池完成`);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/visitor-info') return handleVisitorInfo(request, env);
    if (path === '/api/region-stats') {
      const stats = await handleRegionStats(env);
      return new Response(JSON.stringify(stats), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/region-quality') {
      const quality = await handleRegionQuality(env);
      return new Response(JSON.stringify(quality), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/speed-strategy') {
      const strategy = await handleSpeedStrategy(env);
      return new Response(JSON.stringify(strategy), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/visitor-aware-speedtest' && request.method === 'POST') {
      const { country } = await request.json();
      await addSystemLog(env, `🌍 访客感知测速: 为 ${COUNTRY_NAMES[country] || country} 地区启动智能测速`);
      ctx.waitUntil(smartSpeedTest(env, { maxConcurrent: 2, batchDelay: 2000 }, ctx));
      return new Response(JSON.stringify({ success: true, message: `访客感知测速已启动` }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/visitor-aware-update-dns' && request.method === 'POST') {
      const { country, count } = await request.json();
      const result = await updateDNSWithVisitorAware(env, country, count || 3);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/clean-pool' && request.method === 'POST') {
      const result = await handleCleanPool(env);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/logout' && request.method === 'POST') return handleLogout(request, env);
    if (path === '/api/init-db' && request.method === 'POST') {
      const result = await handleManualInit(env);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/get-logs') {
      const { startDate, endDate, keyword, level, category, limit } = url.searchParams;
      const logs = await getSystemLogs(env, {
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        keyword: keyword || undefined,
        level: level || undefined,
        category: category || undefined,
        limit: limit ? parseInt(limit) : 100
      });
      return new Response(JSON.stringify({ logs }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/clear-logs' && request.method === 'POST') {
      await env.DB.exec('DELETE FROM system_logs');
      await addSystemLog(env, '日志已被手动清除', 'info', 'system');
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/export-logs') {
      const { startDate, endDate, keyword, level, category } = url.searchParams;
      const csvContent = await exportLogs(env, {
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        keyword: keyword || undefined,
        level: level || undefined,
        category: category || undefined
      });
      if (csvContent) {
        return new Response(csvContent, {
          headers: {
            'Content-Type': 'text/csv;charset=utf-8',
            'Content-Disposition': 'attachment; filename="CF_Logs_' + new Date().toISOString().split('T')[0] + '.csv"'
          }
        });
      } else {
        return new Response(JSON.stringify({ success: false, error: '导出失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
    if (path === '/api/smart-speedtest' && request.method === 'POST') {
      await addSystemLog(env, '🔧 手动触发智能测速');
      ctx.waitUntil(smartSpeedTest(env, { maxConcurrent: 2, batchDelay: 2000 }, ctx));
      return new Response(JSON.stringify({ success: true, message: '智能测速已启动' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/get-data-sources') {
      try {
        const sources = await getDataSources(env);
        return new Response(JSON.stringify({ success: true, sources }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        await addSystemLog(env, `❌ 获取数据源失败: ${e.message}`);
        return new Response(JSON.stringify({ success: false, error: '获取数据源失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
    if (path === '/api/save-data-sources' && request.method === 'POST') {
      try {
        const { sources } = await request.json();
        if (!Array.isArray(sources)) {
          return new Response(JSON.stringify({ success: false, error: '数据源必须是数组格式' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        const result = await saveDataSources(env, sources);
        if (result.success) {
          await addSystemLog(env, `📝 数据源已更新: ${result.sources.length} 个源`);
          ctx.waitUntil(updateIPs(env));
        }
        return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        await addSystemLog(env, `❌ 保存数据源失败: ${e.message}`);
        return new Response(JSON.stringify({ success: false, error: '保存数据源失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
    if (path === '/api/test-data-source' && request.method === 'POST') {
      try {
        const { url: testUrl } = await request.json();
        if (!testUrl) {
          return new Response(JSON.stringify({ success: false, error: 'URL不能为空' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        if (!testUrl.startsWith('http://') && !testUrl.startsWith('https://')) {
          return new Response(JSON.stringify({ success: false, error: 'URL必须以http://或https://开头' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        const resp = await fetch(testUrl, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const text = await resp.text();
        const ipPattern = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:\/[0-9]{1,2})?\b/g;
        const matches = text.match(ipPattern) || [];
        let ipCount = 0, cidrCount = 0;
        for (const item of matches) {
          if (item.includes('/')) {
            cidrCount++;
            ipCount += expandCIDR(item).length;
          } else if (isValidIPv4(item)) {
            ipCount++;
          }
        }
        return new Response(JSON.stringify({ success: true, url: testUrl, status: resp.status, cidrCount, ipCount, preview: matches.slice(0, 5) }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        await addSystemLog(env, `❌ 测试数据源失败: ${e.message}`);
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
    if (path === '/api/ips') {
      const [totalCount, highQualityIPs, lastUpdate, failedCount, customIPs, allIPs] = await Promise.all([
        getTotalIPCount(env), getBandwidthPoolIPs(env), env.KV.get(CONFIG.kvKeys.lastUpdate),
        getFailedIPCount(env), env.KV.get(CONFIG.kvKeys.customIPs, 'json'), getAllIPs(env)
      ]);
      return new Response(JSON.stringify({ totalCount, highQualityIPs, lastUpdate, failedCount, customIPs, allIPs }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/export-ips') {
      const highQualityIPs = await getBandwidthPoolIPs(env);
      const countryNames = {
        'CN': '中国', 'US': '美国', 'JP': '日本', 'SG': '新加坡',
        'KR': '韩国', 'DE': '德国', 'GB': '英国', 'FR': '法国',
        'CA': '加拿大', 'AU': '澳大利亚', 'IN': '印度',
        'TW': '台湾', 'HK': '香港', 'MO': '澳门', 'unknown': '未知'
      };
      const calculateScore = function(l, b) {
        var ls = 0;
        if (l <= 50) ls = 100;
        else if (l <= 100) ls = 90;
        else if (l <= 150) ls = 80;
        else if (l <= 200) ls = 70;
        else if (l <= 250) ls = 60;
        else ls = 50;
        var bs = 0;
        if (!b || b === 0) bs = 0;
        else if (b >= 1000) bs = 100;
        else if (b >= 500) bs = 95;
        else if (b >= 300) bs = 90;
        else if (b >= 200) bs = 85;
        else if (b >= 100) bs = 80;
        else if (b >= 50) bs = 60;
        else if (b >= 20) bs = 40;
        else bs = 20;
        return Math.round(bs * 0.8 + ls * 0.2);
      };
      var headers = ['IP 地址', '延迟 (ms)', '带宽 (Mbps)', '评分', '地区'];
      var rows = highQualityIPs.map(function(item) {
        var cn = countryNames[item.country] || item.country || '未知';
        var score = calculateScore(item.latency, item.bandwidth);
        return [
          item.ip,
          item.latency,
          item.bandwidth || '未测',
          score,
          cn
        ];
      });
      var csvContent = '\uFEFF' + [headers.join(',')].concat(rows.map(function(row) { return row.join(','); })).join('\n');
      return new Response(csvContent, {
        headers: {
          'Content-Type': 'text/csv;charset=utf-8',
          'Content-Disposition': 'attachment; filename="CF_BestIP_' + new Date().toISOString().split('T')[0] + '.csv"'
        }
      });
    }
    if (path === '/api/get-ui-config') {
      const savedConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
      return new Response(JSON.stringify({ 
        ipCount: savedConfig.ipCount || config.defaultIpCount, 
        testCount: savedConfig.testCount || config.defaultTestCount, 
        threadCount: savedConfig.threadCount || config.defaultThreadCount,
        bandwidthFileSize: savedConfig.bandwidthFileSize || 3
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/save-ui-config' && request.method === 'POST') {
      const { ipCount, testCount, threadCount, bandwidthFileSize } = await request.json();
      const uiConfig = {
        ipCount: Math.min(10, Math.max(1, parseInt(ipCount) || config.defaultIpCount)),
        testCount: Math.min(100, Math.max(10, parseInt(testCount) || config.defaultTestCount)),
        threadCount: Math.min(10, Math.max(1, parseInt(threadCount) || config.defaultThreadCount)),
        bandwidthFileSize: Math.min(10, Math.max(3, parseInt(bandwidthFileSize) || 3))
      };
      await env.KV.put(CONFIG.kvKeys.uiConfig, JSON.stringify(uiConfig));
      await addSystemLog(env, `⚙️ 参数已保存`);
      return new Response(JSON.stringify({ success: true, config: uiConfig }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/get-advanced-config') {
      const advancedConfig = await getAdvancedConfig(env);
      return new Response(JSON.stringify(advancedConfig), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/save-advanced-config' && request.method === 'POST') {
      const { maxHighQualityPoolSize, failedIpCooldownDays, clearFailedIPs } = await request.json();
      const advancedConfig = {
        maxHighQualityPoolSize: Math.min(100, Math.max(10, parseInt(maxHighQualityPoolSize) || 50)),
        failedIpCooldownDays: Math.min(30, Math.max(1, parseInt(failedIpCooldownDays) || 15))
      };
      await env.KV.put(CONFIG.kvKeys.advancedConfig, JSON.stringify(advancedConfig));
      if (clearFailedIPs) {
        await env.DB.prepare('DELETE FROM failed_ips').run();
        await addSystemLog(env, '🗑️ 失败IP黑名单已手动清空');
      }
      const cleanResult = await cleanHighQualityPool(env, false);
      await addSystemLog(env, `⚙️ 高级设置已保存`);
      return new Response(JSON.stringify({ success: true, config: advancedConfig, cleanResult }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/get-config') {
      const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json') || {};
      return new Response(JSON.stringify(dnsConfig), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/save-config' && request.method === 'POST') {
      const dnsConfig = await request.json();
      await env.KV.put(CONFIG.kvKeys.dnsConfig, JSON.stringify(dnsConfig));
      await addSystemLog(env, '🔐 DNS配置已保存');
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/test-telegram' && request.method === 'POST') {
      const { botToken, chatId } = await request.json();
      if (!botToken || !chatId) {
        return new Response(JSON.stringify({ success: false, error: 'Bot Token 和 Chat ID 不能为空' }), { status: 400 });
      }
      try {
        // 直接调用 Telegram API 发送测试通知
        const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        
        // 构建 HTML 格式消息
        let formattedMessage = `
<b>✅ 测试消息</b>

• 如果您看到这条消息，说明 Telegram 通知配置成功！

━━━━━━━━━━━━━━━
<code>CF优选IP ${VERSION}</code>
🔗 <a href="https://github.com/ldg118/CF-Worker-BestIP">GitHub项目地址</a>
        `;
        
        const response = await fetch(telegramUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: formattedMessage,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          })
        });
        
        const result = await response.json();
        if (result.ok) {
          return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        } else {
          return new Response(JSON.stringify({ success: false, error: result.description || '发送失败' }), { status: 400 });
        }
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
      }
    }
    if (path === '/api/save-custom-ips' && request.method === 'POST') {
      const { ips } = await request.json();
      const validIPs = [], expandedIPs = [];
      for (const item of ips) {
        if (isValidIPv4(item)) {
          validIPs.push(item);
          expandedIPs.push(item);
        } else if (isValidCIDR(item)) {
          const cidrIPs = expandCIDR(item);
          if (cidrIPs.length > 0) {
            expandedIPs.push(...cidrIPs);
            validIPs.push(item);
          }
        }
      }
      if (expandedIPs.length > 0) {
        await env.KV.put(CONFIG.kvKeys.customIPs, JSON.stringify(validIPs));
        const allIPs = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
        const newIPs = [...new Set([...allIPs, ...expandedIPs])];
        await env.KV.put(CONFIG.kvKeys.ipList, JSON.stringify(newIPs.sort(compareIPs)));
        await addSystemLog(env, `📥 自定义IP已保存: ${validIPs.length} 个CIDR`);
      }
      return new Response(JSON.stringify({ success: true, expandedCount: expandedIPs.length, validCount: validIPs.length }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/clear-custom-ips' && request.method === 'POST') {
      try {
        await env.KV.put(CONFIG.kvKeys.customIPs, JSON.stringify([]));
        ctx.waitUntil(updateIPs(env));
        await addSystemLog(env, '🗑️ 所有自定义IP已清除');
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        await addSystemLog(env, `❌ 清除自定义IP失败: ${e.message}`);
        return new Response(JSON.stringify({ success: false, error: '清除自定义IP失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
    if (path === '/api/get-log-config') {
      const logConfig = await getLogConfig(env);
      return new Response(JSON.stringify(logConfig), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/save-log-config' && request.method === 'POST') {
      const { autoClean, cleanDays } = await request.json();
      const logConfig = {
        autoClean: autoClean !== false,
        cleanDays: Math.min(7, Math.max(3, parseInt(cleanDays) || 7))
      };
      await env.KV.put(CONFIG.kvKeys.logConfig, JSON.stringify(logConfig));
      await addSystemLog(env, `⚙️ 日志配置已保存: 自动清理=${logConfig.autoClean}, 清理周期=${logConfig.cleanDays}天`);
      return new Response(JSON.stringify({ success: true, config: logConfig }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/update') {
      ctx.waitUntil(updateIPs(env));
      await addSystemLog(env, '🔄 手动触发IP列表更新');
      return new Response(JSON.stringify({ status: '更新任务已启动' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/speedtest' && request.method === 'GET') {
      const ip = url.searchParams.get('ip');
      if (!ip) return new Response(JSON.stringify({ error: '缺少IP参数' }), { status: 400 });
      const result = await speedTestWithBandwidth(env, ip, null, false, ctx);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/update-dns' && request.method === 'POST') {
      const { ips, count, triggerSource } = await request.json();
      let targetIPs = ips;
      if (!targetIPs) {
        const config = getEnvConfig(env);
        const ipCount = count || (await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {}).ipCount || config.defaultIpCount;
        const bestIPs = await getBestIPs(env, null, ipCount);
        targetIPs = bestIPs.map(item => item.ip);
      }
      if (!targetIPs || targetIPs.length === 0) return new Response(JSON.stringify({ error: '无可用IP' }), { status: 400 });
      const result = await updateDNSBatch(env, targetIPs, triggerSource || 'manual');
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/db-status') {
      const status = await handleDBStatus(env);
      return new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    await addSystemLog(env, `⏰ Cron定时任务启动`);
    try {
      await initDatabase(env);
      await runD1Migrations(env);
      await cleanExpiredFailedIPs(env);
      await cleanHighQualityPool(env);
      await cleanExpiredGeoCache(env);
      await cleanExpiredLogs(env);
      await flushLogs(env);
      await updateRegionQuality(env);
      
      // 更新IP列表
      await addSystemLog(env, `🔄 开始更新IP列表`);
      await updateIPs(env);
      await addSystemLog(env, `✅ IP列表更新完成`);
      
      const strategy = await getSpeedStrategy(env);
      let targetCountry = null;
      let logMessage = '';
      
      switch (strategy.type) {
        case 'urgent':
          targetCountry = strategy.country;
          logMessage = `🚨 紧急补充: ${COUNTRY_NAMES[targetCountry]} 地区 (仅${strategy.count}个IP)`;
          break;
        case 'maintain':
          targetCountry = strategy.country;
          logMessage = `🔄 常规维护: ${COUNTRY_NAMES[targetCountry]} 地区 (当前${strategy.count}个IP)`;
          break;
        case 'global':
          targetCountry = null;
          logMessage = `🌍 全球维护测速 (第${strategy.globalCount}次)`;
          break;
        default:
          targetCountry = 'CN';
          logMessage = `🎯 默认测速: 中国地区`;
      }
      
      await addSystemLog(env, logMessage);
      await smartSpeedTest(env, { maxConcurrent: 2, batchDelay: 2000 }, ctx);
      await updateSpeedStrategy(env, targetCountry);
      await updateRegionStats(env);
      await updateRegionQuality(env);
      
      const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
      await addSystemLog(env, `🔍 检查自动更新DNS: autoUpdate=${dnsConfig?.autoUpdate}, DNS配置完整=${!!(dnsConfig?.apiToken && dnsConfig?.zoneId && dnsConfig?.recordName)}`);
      if (dnsConfig?.autoUpdate) {
        if (!dnsConfig.apiToken || !dnsConfig.zoneId || !dnsConfig.recordName) {
          await addSystemLog(env, `⚠️ 自动更新DNS失败: DNS配置不完整`);
        } else {
          const config = getEnvConfig(env);
          const uiConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
          const ipCount = uiConfig.ipCount || config.defaultIpCount;
          const bestIPs = await getBestIPs(env, 'CN', ipCount);
          await addSystemLog(env, `🔍 自动更新DNS: 找到 ${bestIPs.length} 个最佳IP`);
          if (bestIPs.length > 0) {
            const result = await updateDNSBatch(env, bestIPs.map(item => item.ip), 'cron');
            if (result.success) {
              await addSystemLog(env, `✅ 定时任务自动更新DNS成功: ${result.successCount || bestIPs.length} 个IP`);
            } else {
              await addSystemLog(env, `❌ 定时任务自动更新DNS失败: ${result.error || '未知错误'}`);
            }
          } else {
            await addSystemLog(env, `⚠️ 自动更新DNS失败: 没有找到最佳IP`);
          }
        }
      }
      
      await addSystemLog(env, `✅ Cron定时任务完成`);
      await sendTelegramNotification(env, {
        message: {
          source: '定时任务',
          ipCount: 0
        },
        type: 'info'
      });
    } catch (error) {
      await addSystemLog(env, `❌ Cron定时任务异常: ${error.message}`);
    }
  }
};

