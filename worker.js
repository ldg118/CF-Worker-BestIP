// CF优选IP v4.6.2 | github.com/ldg118/CF-Worker-BestIP
// 区域1: 全局常量与配置

const VERSION = 'v4.6.2';
const GITHUB_URL = 'https://github.com/ldg118/CF-Worker-BestIP';

// 核心配置
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
`;

// 区域3: 缓存管理

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

// 区域2: IP处理工具函数

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

// 辅助函数：随机打乱数组
function shuffleArray(array) {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

// IP工具命名空间
const IPUtils = {
  isValid: isValidIPv4,
  isValidCIDR,
  expandCIDR,
  increment: incrementIP,
  compare: compareIPs
};

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
    'visitor_aware': '访客感知',
    'cron': '定时任务',
    'auto_after_local_test': '本地测试'
  };
  return sourceMap[source] || source;
}

// 通用工具命名空间
const Utils = {
  emoji: {
    latency: getLatencyEmoji,
    bandwidth: getBandwidthEmoji
  },
  format: {
    maskIP,
    sourceText: getSourceText,
    escapeMarkdown: escapeMarkdownV2
  },
  text: {
    escapeMarkdown: escapeMarkdownV2
  }
};

// 会话管理模块
const SessionManager = {
  // 从请求中提取会话ID
  extractId(request) {
    const cookie = request.headers.get('Cookie');
    if (cookie) {
      const match = cookie.match(/sessionId=([^;]+)/);
      if (match) return match[1];
    }
    return null;
  },
  
  // 验证会话是否有效
  async verify(sessionId, env) {
    if (!sessionId) return false;
    try {
      const sessions = await env.KV.get(CONFIG.kvKeys.sessions, 'json');
      return sessions && sessions[sessionId];
    } catch { return false; }
  },
  
  // 处理登录
  async login(request, env) {
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
  },
  
  // 处理登出
  async logout(request, env) {
    const sessionId = this.extractId(request);
    if (sessionId) {
      const sessions = await env.KV.get(CONFIG.kvKeys.sessions, 'json') || {};
      delete sessions[sessionId];
      await env.KV.put(CONFIG.kvKeys.sessions, JSON.stringify(sessions));
      await addSystemLog(env, '🔓 管理员登出');
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  }
};

// 兼容性别名
function getSessionId(request) {
  return SessionManager.extractId(request);
}

async function verifySession(sessionId, env) {
  return SessionManager.verify(sessionId, env);
}

async function handleLogin(request, env) {
  return SessionManager.login(request, env);
}

async function handleLogout(request, env) {
  return SessionManager.logout(request, env);
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

async function sendTelegramNotification(env, { message, hideIP = true, type = 'info', dnsConfig = null }) {
  // 如果未传入dnsConfig，则从KV读取（消耗1个子请求）
  const config = dnsConfig || await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json') || {};

  if (!config.telegramEnabled) {
    await addSystemLog(env, `ℹ️ Telegram通知未启用`);
    return;
  }

  const botToken = config.telegramBotToken;
  const chatId = config.telegramChatId;

  if (!botToken || !chatId) {
    await addSystemLog(env, `ℹ️ Telegram配置不完整`);
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

<b>📅 时间：</b><code>${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</code>
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
      await addSystemLog(env, `❌ Telegram通知发送失败: ${response.status} - ${errorText}`);
    } else {
      await addSystemLog(env, `✅ Telegram通知发送成功`);
    }
    
    return await response.json();
  } catch (error) {
    await addSystemLog(env, `❌ Telegram通知异常: ${error.message}`);
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

// 日志管理模块
const LogManager = {
  queue: [],
  timer: null,
  
  // 添加系统日志
  async add(env, message) {
    const now = new Date();
    const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    this.queue.push({ timeStr, message });
    if (this.queue.length >= 20) {
      await this.flush(env);
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(env), 5000);
    }
  },
  
  // 刷新日志到数据库
  async flush(env) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.queue.length === 0) return;
    const logs = [...this.queue];
    this.queue = [];
    try {
      const stmt = env.DB.prepare('INSERT INTO system_logs (time_str, message) VALUES (?, ?)');
      const operations = logs.map(log => stmt.bind(log.timeStr, log.message));
      if (operations.length > 0) await env.DB.batch(operations);
    } catch (e) {}
  },
  
  // 获取系统日志
  async get(env, limit = 100) {
    try {
      const result = await env.DB.prepare('SELECT time_str, message FROM system_logs ORDER BY id DESC LIMIT ?').bind(limit).all();
      return (result.results || []).map(row => ({ timeStr: row.time_str, message: row.message }));
    } catch (e) { return []; }
  }
};

// 兼容性别名
async function addSystemLog(env, message) {
  return LogManager.add(env, message);
}

async function flushLogs(env) {
  return LogManager.flush(env);
}

async function getSystemLogs(env) {
  return LogManager.get(env);
}

// 区域4: 数据库操作

async function initDatabase(env) {
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

// 通用配置获取函数
async function getConfig(env, type) {
  switch (type) {
    case 'advanced': {
      const savedConfig = await env.KV.get(CONFIG.kvKeys.advancedConfig, 'json') || {};
      const envConfig = getEnvConfig(env);
      return {
        maxHighQualityPoolSize: savedConfig.maxHighQualityPoolSize || envConfig.maxHighQualityPoolSize,
        failedIpCooldownDays: savedConfig.failedIpCooldownDays || envConfig.failedIpCooldownDays,
        maxBackupPoolSize: savedConfig.maxBackupPoolSize || 50
      };
    }
    
    case 'log': {
      const savedConfig = await env.KV.get(CONFIG.kvKeys.logConfig, 'json') || {};
      return {
        autoClean: savedConfig.autoClean !== false,
        cleanDays: Math.min(7, Math.max(3, parseInt(savedConfig.cleanDays) || 7))
      };
    }
    
    default:
      throw new Error(`Unknown config type: ${type}`);
  }
}

// 兼容性别名
async function getAdvancedConfig(env) {
  return getConfig(env, 'advanced');
}

async function getLogConfig(env) {
  return getConfig(env, 'log');
}

function getEnvConfig(env) {
    return {
      adminPassword: env.ADMIN_PASSWORD || '123',
      defaultIpCount: env.DEFAULT_IP_COUNT ? parseInt(env.DEFAULT_IP_COUNT) : 3,
      defaultTestCount: env.DEFAULT_TEST_COUNT ? parseInt(env.DEFAULT_TEST_COUNT) : 30,
      defaultThreadCount: env.DEFAULT_THREAD_COUNT ? parseInt(env.DEFAULT_THREAD_COUNT) : 10,
      defaultBandwidthFileSize: env.DEFAULT_BANDWIDTH_FILE_SIZE ? parseInt(env.DEFAULT_BANDWIDTH_FILE_SIZE) : 3,
      failedIpCooldownDays: env.FAILED_IP_COOLDOWN_DAYS ? parseInt(env.FAILED_IP_COOLDOWN_DAYS) : 15,
      maxHighQualityPoolSize: env.MAX_HIGH_QUALITY_POOL_SIZE ? parseInt(env.MAX_HIGH_QUALITY_POOL_SIZE) : 20
    };
  }

async function getIPGeo(env, ip) {
  const cached = geoCache.get(ip);
  if (cached) return cached;
  
  try {
    const dbCached = await env.DB.prepare('SELECT country, country_name, city FROM ip_geo_cache WHERE ip = ?').bind(ip).first();
    if (dbCached && dbCached.country) {
      const geo = { country: dbCached.country, countryName: dbCached.country_name, city: dbCached.city };
      geoCache.set(ip, geo);
      return geo;
    }
  } catch (e) {}
  
  // 首选: ipwho.is（免费，无需 API key）
  try {
    const resp = await fetch(`https://ipwho.is/${ip}`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.country_code) {
        const geo = { 
          country: data.country_code, 
          countryName: COUNTRY_NAMES[data.country_code] || data.country || '', 
          city: data.city || '' 
        };
        env.DB.prepare('INSERT OR REPLACE INTO ip_geo_cache (ip, country, country_name, city, cached_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)')
          .bind(ip, geo.country, geo.countryName, geo.city).run().catch(() => {});
        geoCache.set(ip, geo);
        return geo;
      }
    }
  } catch (e) {}
  
  // 备用: ip-api.com
  try {
    const resp = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data.status === 'success' && data.countryCode) {
        const geo = { 
          country: data.countryCode, 
          countryName: COUNTRY_NAMES[data.countryCode] || data.country || '', 
          city: data.city || '' 
        };
        env.DB.prepare('INSERT OR REPLACE INTO ip_geo_cache (ip, country, country_name, city, cached_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)')
          .bind(ip, geo.country, geo.countryName, geo.city).run().catch(() => {});
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
  env.DB.prepare('INSERT OR REPLACE INTO ip_geo_cache (ip, country, country_name, city, cached_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)')
    .bind(ip, geo.country, geo.countryName, geo.city).run().catch(() => {});
  geoCache.set(ip, geo);
  return geo;
}

async function addFailedIP(env, ip) {
  try {
    await env.DB.prepare('INSERT OR REPLACE INTO failed_ips (ip, failed_at) VALUES (?, CURRENT_TIMESTAMP)').bind(ip).run();
    await env.DB.prepare('DELETE FROM high_quality_ips WHERE ip = ?').bind(ip).run();
    highQualityCache.clear();
  } catch (e) {}
}

async function getFailedIPCount(env) {
  try {
    const result = await env.DB.prepare('SELECT COUNT(*) as count FROM failed_ips').first();
    return result ? result.count : 0;
  } catch (e) { return 0; }
}

// 通用清理函数
async function cleanPool(env, config) {
  const { table, timeField, days, condition, afterClean } = config;
  try {
    if (condition && !condition()) return;
    
    let sql;
    if (table === 'system_logs') {
      // 日志表使用特殊的日期处理
      sql = `DELETE FROM ${table} WHERE julianday('now') - julianday(datetime(substr(${timeField}, 1, 10) || ' ' || substr(${timeField}, 12), 'localtime')) > ?`;
    } else {
      sql = `DELETE FROM ${table} WHERE julianday('now') - julianday(${timeField}) > ?`;
    }
    
    await env.DB.prepare(sql).bind(days).run();
    
    if (afterClean) await afterClean();
  } catch (e) {}
}

// 兼容性别名函数
async function cleanExpiredFailedIPs(env) {
  const advancedConfig = await getAdvancedConfig(env);
  return cleanPool(env, {
    table: 'failed_ips',
    timeField: 'failed_at',
    days: advancedConfig.failedIpCooldownDays
  });
}

async function cleanExpiredGeoCache(env) {
  return cleanPool(env, {
    table: 'ip_geo_cache',
    timeField: 'cached_at',
    days: 30,
    afterClean: () => geoCache.clear()
  });
}

async function cleanExpiredLogs(env) {
  const logConfig = await getLogConfig(env);
  return cleanPool(env, {
    table: 'system_logs',
    timeField: 'time_str',
    days: logConfig.cleanDays,
    condition: () => logConfig.autoClean
  });
}

// 区域5: IP池管理

async function getBandwidthPoolIPs(env) {
  try {
    const advancedConfig = await getAdvancedConfig(env);
    const maxPoolSize = advancedConfig.maxHighQualityPoolSize;

    const result = await env.DB.prepare(`
      SELECT ip, latency, bandwidth, country, city, last_tested
      FROM high_quality_ips
      ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC, latency ASC
      LIMIT ?
    `).bind(maxPoolSize).all();

    return result.results || [];
  } catch (e) {
    await addSystemLog(env, `❌ getBandwidthPoolIPs 错误: ${e.message}`);
    return [];
  }
}

async function checkInPool(env, ip, poolType = 'bandwidth') {
  const tableName = poolType === 'bandwidth' ? 'high_quality_ips' : 'backup_quality_ips';
  try {
    const result = await env.DB.prepare(`SELECT ip FROM ${tableName} WHERE ip = ?`).bind(ip).first();
    return !!result;
  } catch (e) { return false; }
}

// 兼容性别名
async function checkInBandwidthPool(env, ip) {
  return checkInPool(env, ip, 'bandwidth');
}

async function checkInBackupPool(env, ip) {
  return checkInPool(env, ip, 'backup');
}

async function addToPool(env, ip, latency, bandwidth, geo, score, poolType = 'bandwidth') {
  // 如果是备用池，调用专用的addToBackupPool函数
  if (poolType === 'backup') {
    return addToBackupPool(env, ip, latency, bandwidth, geo, score);
  }
  
  try {
    const isBandwidthPool = poolType === 'bandwidth';
    const tableName = isBandwidthPool ? 'high_quality_ips' : 'backup_quality_ips';
    const maxPoolSize = isBandwidthPool ? (await getAdvancedConfig(env)).maxHighQualityPoolSize : 20;
    const qualityType = isBandwidthPool ? 'bandwidth' : null;
    
    // 检查IP是否已存在
    const existingIP = await env.DB.prepare(`SELECT ip FROM ${tableName} WHERE ip = ?`).bind(ip).first();
    if (existingIP) {
      const updateSql = isBandwidthPool 
        ? `UPDATE ${tableName} SET latency = ?, bandwidth = ?, country = ?, city = ?, last_tested = CURRENT_TIMESTAMP, quality_type = ? WHERE ip = ?`
        : `UPDATE ${tableName} SET latency = ?, bandwidth = ?, country = ?, city = ?, last_tested = CURRENT_TIMESTAMP WHERE ip = ?`;
      
      if (isBandwidthPool) {
        await env.DB.prepare(updateSql).bind(latency, bandwidth || null, geo.country, geo.city, qualityType, ip).run();
        await addSystemLog(env, `🔄 ${ip} 更新带宽池数据 (${latency}ms, ${bandwidth || 0}Mbps, 评分${score})`);
      } else {
        await env.DB.prepare(updateSql).bind(latency, bandwidth || null, geo.country, geo.city, ip).run();
        await addSystemLog(env, `🔄 ${ip} 更新备用池数据 (${latency}ms, ${bandwidth || 0}Mbps, 评分${score})`);
      }
      return;
    }
    
    // 检查池大小
    const currentCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).first();
    const currentPoolSize = currentCount ? currentCount.count : 0;
    
    if (currentPoolSize >= maxPoolSize) {
      const worstIP = await env.DB.prepare(`
        SELECT ip, bandwidth FROM ${tableName} 
        ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) ASC 
        LIMIT 1
      `).first();
      if (worstIP) {
        await env.DB.prepare(`DELETE FROM ${tableName} WHERE ip = ?`).bind(worstIP.ip).run();
        const poolName = isBandwidthPool ? '带宽池' : '备用池';
        await addSystemLog(env, `🔄 替换${poolName}IP: ${worstIP.ip}(带宽${worstIP.bandwidth || 0}Mbps) → ${ip}(带宽${bandwidth || 0}Mbps)`);
      }
    }
    
    // 插入新IP
    const insertSql = isBandwidthPool
      ? `INSERT INTO ${tableName} (ip, latency, bandwidth, country, city, last_tested, quality_type) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`
      : `INSERT INTO ${tableName} (ip, latency, bandwidth, country, city, last_tested) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
    
    if (isBandwidthPool) {
      await env.DB.prepare(insertSql).bind(ip, latency, bandwidth || null, geo.country, geo.city, qualityType).run();
      const newCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).first();
      await addSystemLog(env, `✨ ${ip} (${geo.country}) - ${latency}ms, ${bandwidth || 0}Mbps, 评分${score} 已加入带宽池 (${newCount.count}/${maxPoolSize})`);
    } else {
      await env.DB.prepare(insertSql).bind(ip, latency, bandwidth || null, geo.country, geo.city).run();
      const newCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).first();
      await addSystemLog(env, `📌 ${ip} (${geo.country}) - ${latency}ms, ${bandwidth || 0}Mbps, 评分${score} 已加入备用池 (${newCount.count}/${maxPoolSize})`);
    }
  } catch (e) {
    const poolName = poolType === 'bandwidth' ? '带宽池' : '备用池';
    await addSystemLog(env, `❌ 添加IP到${poolName}失败 ${ip}: ${e.message}`);
  }
}

// 带宽池专用函数（带智能逻辑）
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
      } else {
        // 带宽优质池已满且当前IP带宽不高于池中所有IP，添加到备用池
        await addToPool(env, ip, latency, bandwidth, geo, score, 'backup');
      }
    } else {
      await addSystemLog(env, `⏭️ ${ip} - 带宽${bandwidth || 0}Mbps低于100Mbps，进入备用池`);
    }
  } catch (e) {
    await addSystemLog(env, `❌ 添加IP到带宽池失败 ${ip}: ${e.message}`);
  }
}

// 备用池专用函数（带宽≥100Mbps，最大容量可配置）
async function addToBackupPool(env, ip, latency, bandwidth, geo, score) {
  // 只存储带宽≥100Mbps的优质IP
  if ((bandwidth || 0) < 100) {
    await addSystemLog(env, `⏭️ ${ip} - 带宽${bandwidth || 0}Mbps低于100Mbps，不加入备用池`);
    return { success: false, reason: 'bandwidth_too_low' };
  }
  
  const advancedConfig = await getAdvancedConfig(env);
  const maxBackupPoolSize = advancedConfig.maxBackupPoolSize || 50;
  
  try {
    // 检查IP是否已存在
    const existingIP = await env.DB.prepare('SELECT ip FROM backup_quality_ips WHERE ip = ?').bind(ip).first();
    if (existingIP) {
      await env.DB.prepare(`
        UPDATE backup_quality_ips 
        SET latency = ?, bandwidth = ?, country = ?, city = ?, last_tested = CURRENT_TIMESTAMP
        WHERE ip = ?
      `).bind(latency, bandwidth || null, geo.country, geo.city, ip).run();
      await addSystemLog(env, `🔄 ${ip} 更新备用池数据 (${latency}ms, ${bandwidth || 0}Mbps, 评分${score})`);
      return { success: true, action: 'updated' };
    }
    
    // 检查池大小
    const currentCount = await env.DB.prepare('SELECT COUNT(*) as count FROM backup_quality_ips').first();
    const currentPoolSize = currentCount ? currentCount.count : 0;
    
    if (currentPoolSize >= maxBackupPoolSize) {
      // 找到带宽最低的IP进行替换
      const worstIP = await env.DB.prepare(`
        SELECT ip, bandwidth FROM backup_quality_ips 
        ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) ASC 
        LIMIT 1
      `).first();
      
      if (worstIP && (bandwidth || 0) > (worstIP.bandwidth || 0)) {
        await env.DB.prepare('DELETE FROM backup_quality_ips WHERE ip = ?').bind(worstIP.ip).run();
        await addSystemLog(env, `🔄 替换备用池IP: ${worstIP.ip}(带宽${worstIP.bandwidth || 0}Mbps) → ${ip}(带宽${bandwidth || 0}Mbps)`);
      } else {
        await addSystemLog(env, `⏭️ ${ip} - 备用池已满(${maxBackupPoolSize})且带宽不高于池中最低带宽，跳过`);
        return { success: false, reason: 'pool_full_and_low_bandwidth' };
      }
    }
    
    // 插入新IP
    await env.DB.prepare(`
      INSERT INTO backup_quality_ips (ip, latency, bandwidth, country, city, last_tested) 
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(ip, latency, bandwidth || null, geo.country, geo.city).run();
    
    const newCount = await env.DB.prepare('SELECT COUNT(*) as count FROM backup_quality_ips').first();
    await addSystemLog(env, `📌 ${ip} (${geo.country}) - ${latency}ms, ${bandwidth || 0}Mbps, 评分${score} 已加入备用池 (${newCount.count}/${maxBackupPoolSize})`);
    
    return { success: true, action: 'added' };
  } catch (e) {
    await addSystemLog(env, `❌ 添加IP到备用池失败 ${ip}: ${e.message}`);
    return { success: false, reason: 'error', error: e.message };
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

async function speedTestWithBandwidth(env, ip, geo = null, isInPool = false, ctx = null, isRetry = false) {
  try {
    const cached = bandwidthCache.get(ip);
    if (cached) {
      await addSystemLog(env, `💾 ${ip} - 使用缓存带宽数据`);
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
      // 只在非重试模式下记录日志，避免重复
      if (!isRetry) {
        await addSystemLog(env, `❌ ${ip} - 延迟测试失败 (3次尝试均失败)`);
      }
      return { success: false, ip, latency: null, bandwidth: null };
    }
    
    const avgLatency = Math.round(totalLatency / successCount);
    const minLatency = Math.min(...latencyResults.filter(r => r !== null));
    
    let bandwidthMbps = null;
    let downloadSpeed = null;
    
    // 确保 geo 和 countryName 已定义
    if (!geo) geo = await getIPGeo(env, ip);
    const countryName = COUNTRY_NAMES[geo.country] || geo.country || '未知';

    const shouldTest = await shouldPerformBandwidthTest(ip, isInPool, avgLatency);
    
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
          await addSystemLog(env, `⚠️ ${ip} - 带宽测试返回 ${response.status}`);
          bandwidthMbps = estimateBandwidthByLatency(avgLatency);
        }
      } catch (e) {
        await addSystemLog(env, `⚠️ ${ip} - 带宽测试失败: ${e.message}`);
        bandwidthMbps = estimateBandwidthByLatency(avgLatency);
      }
    } else {
      bandwidthMbps = estimateBandwidthByLatency(avgLatency);
    }
    
    const bandwidthLevel = getBandwidthLevel(bandwidthMbps);
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

    if (isInPool && (inBandwidthPool || inBackupPool)) {
      if (isHighQuality || isExcellentBandwidth) {
        if (inBackupPool) {
          await env.DB.prepare('DELETE FROM backup_quality_ips WHERE ip = ?').bind(ip).run();
          await addToBandwidthPool(env, ip, avgLatency, bandwidthMbps, geo, score);
          await addSystemLog(env, `⬆️ ${ip} 带宽优秀，从备用池升级到带宽池`);
        } else if (inBandwidthPool) {
          await env.DB.prepare(`
            UPDATE high_quality_ips
            SET latency = ?, bandwidth = ?, country = ?, city = ?, last_tested = CURRENT_TIMESTAMP, quality_type = 'bandwidth'
            WHERE ip = ?
          `).bind(avgLatency, bandwidthMbps || null, geo.country, geo.city, ip).run();
          await addSystemLog(env, `🔄 ${ip} 更新带宽池数据`);
        }
      } else {
        if (inBandwidthPool) {
          await env.DB.prepare('DELETE FROM high_quality_ips WHERE ip = ?').bind(ip).run();
          await addSystemLog(env, `🗑️ ${ip} 带宽不足(评分${score})，从带宽池移除`);
        }
        if (inBackupPool) {
          await env.DB.prepare('DELETE FROM backup_quality_ips WHERE ip = ?').bind(ip).run();
          await addSystemLog(env, `🗑️ ${ip} 带宽不足(评分${score})，从备用池移除`);
        }
      }
    } else if (!inBandwidthPool && !inBackupPool) {
      if (isHighQuality || isExcellentBandwidth) {
        await addToBandwidthPool(env, ip, avgLatency, bandwidthMbps, geo, score);
      } else {
        await addSystemLog(env, `📝 ${ip} - 带宽不足(评分${score})，不加入任何池`);
      }
    }
    
    const bandwidthInfo = bandwidthMbps ? ` | 带宽: ${bandwidthMbps} Mbps ${bandwidthLevel.star}` : ' | 带宽: 估算值';
    // 只在非重试模式下记录成功日志，避免重复
    if (!isRetry) {
      await addSystemLog(env, `✅ ${ip} (${countryName}) - 延迟:${avgLatency}ms ${bandwidthInfo} | 评分:${score}`);
    }

    return { 
      success: true, ip, latency: avgLatency, minLatency, maxLatency: Math.max(...latencyResults.filter(r => r !== null)),
      bandwidth: bandwidthMbps, downloadSpeed, bandwidthLevel: bandwidthLevel.level,
      score, country: geo.country, countryName
    };
  } catch (error) {
    await addSystemLog(env, `❌ ${ip} - 测速异常: ${error.message}`);
    return { success: false, ip, error: error.message, latency: null, bandwidth: null };
  }
}

async function smartSpeedTest(env, options = {}, ctx = null) {
  const { maxConcurrent = 1, batchDelay = 3000, maxRetries = 1, timeout = 10000 } = options;
  
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
    const userSetCount = uiConfig.testCount || config.defaultTestCount;
    
    if (currentBandwidthCount >= maxPoolSize * 0.9) {
      finalTestCount = Math.min(finalTestCount, 30);
    } else if (currentBandwidthCount < maxPoolSize * 0.3) {
      // 当池较空时，增加测试数量以快速补充池子
      finalTestCount = Math.min(finalTestCount * 1.5, 100);
    }
    
    // 始终限制最大测试数量
    finalTestCount = Math.min(finalTestCount, 100);
    
    const existingIPs = new Set([...bandwidthPoolIPs.map(ip => ip.ip)]);
    const allIPs = await getAllIPs(env);
    
    // 按优先级排序：历史高带宽IP > 带宽优质池 > 延迟池（备用池） > 总IP池 > 失败池
    // IP质量衰减机制：根据最后测试时间降低优先级（7天衰减50%）
    const highBandwidthIPs = await env.DB.prepare(`
      SELECT ip, bandwidth, 
             (bandwidth * (1.0 - MIN((julianday('now') - julianday(last_tested)) / 14.0, 0.5))) as decayed_bandwidth
      FROM speed_results 
      WHERE bandwidth >= 100 
        AND julianday('now') - julianday(last_tested) < 30  -- 30天内的测试结果
      ORDER BY decayed_bandwidth DESC 
      LIMIT 50
    `).all();
    
    const highBandwidthIPList = (highBandwidthIPs.results || []).map(item => item.ip);
    const highBandwidthIPSet = new Set(highBandwidthIPList);
    
    // 1. 获取历史高带宽IP
    const highBandwidthNewIPs = highBandwidthIPList.filter(ip => !existingIPs.has(ip));
    
    // 2. 获取备用池IP
    const backupPoolIPs = await env.DB.prepare(`
      SELECT ip, bandwidth 
      FROM backup_quality_ips 
      ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC
    `).all();
    const backupPoolIPList = (backupPoolIPs.results || []).map(ip => ip.ip);
    
    // 3. 获取新IP（不在任何池中的）
    const newIPs = allIPs.filter(ip => !existingIPs.has(ip) && !new Set(backupPoolIPList).has(ip));
    
    // 4. 获取失败池恢复IP
    const recoverableFailedIPs = await env.DB.prepare(`
      SELECT f.ip 
      FROM failed_ips f
      LEFT JOIN high_quality_ips h ON f.ip = h.ip
      LEFT JOIN backup_quality_ips b ON f.ip = b.ip
      WHERE julianday('now') - julianday(f.failed_at) > ?
      AND h.ip IS NULL AND b.ip IS NULL
      ORDER BY f.failed_at ASC
      LIMIT 20
    `).bind(advancedConfig.failedIpCooldownDays).all();
    const recoverableIPs = (recoverableFailedIPs.results || []).map(item => item.ip);
    
    // 智能抽样：按优先级分配测试名额
    const testSlots = {
      newIPs: Math.floor(finalTestCount * 0.5),  // 新IP 50%
      highBandwidthNewIPs: Math.floor(finalTestCount * 0.2),  // 历史高带宽新IP 20%
      bandwidthPoolIPs: Math.floor(finalTestCount * 0.15),  // 带宽池IP 15%
      recoverableIPs: Math.floor(finalTestCount * 0.05),  // 失败池恢复 5%
      backupPoolIPs: Math.floor(finalTestCount * 0.1)  // 备用池IP 10%
    };
    
    // 构建测试队列
    let ipsToTest = [];
    
    // 1. 新IP（优先级最高）
    if (newIPs.length > 0) {
      const sampledNewIPs = shuffleArray(newIPs).slice(0, testSlots.newIPs);
      ipsToTest.push(...sampledNewIPs);
    }
    
    // 2. 历史高带宽新IP
    if (highBandwidthNewIPs.length > 0) {
      const sampledHighBandwidthIPs = shuffleArray(highBandwidthNewIPs).slice(0, testSlots.highBandwidthNewIPs);
      ipsToTest.push(...sampledHighBandwidthIPs);
    }
    
    // 3. 带宽池IP（需要重新测试的）
    if (bandwidthPoolIPs.length > 0) {
      const sampledBandwidthPoolIPs = shuffleArray(bandwidthPoolIPs.map(ip => ip.ip)).slice(0, testSlots.bandwidthPoolIPs);
      ipsToTest.push(...sampledBandwidthPoolIPs);
    }
    
    // 4. 备用池IP
    if (backupPoolIPList.length > 0) {
      const sampledBackupIPs = shuffleArray(backupPoolIPList).slice(0, testSlots.backupPoolIPs);
      ipsToTest.push(...sampledBackupIPs);
    }
    
    // 5. 失败池恢复IP
    if (recoverableIPs.length > 0) {
      const sampledRecoverableIPs = shuffleArray(recoverableIPs).slice(0, testSlots.recoverableIPs);
      ipsToTest.push(...sampledRecoverableIPs);
      if (sampledRecoverableIPs.length > 0) {
        await addSystemLog(env, `🔄 失败池自动恢复: ${sampledRecoverableIPs.length} 个IP冷却期已过，重新加入测速队列`);
      }
    }
    
    // 去重并限制数量
    ipsToTest = [...new Set(ipsToTest)].slice(0, finalTestCount);
    
    // 再次随机排序，确保测试分布均匀
    ipsToTest = shuffleArray(ipsToTest);
    
    if (ipsToTest.length === 0) {
      await addSystemLog(env, 'ℹ️ 没有需要测试的IP');
      return { success: true, message: '无需测试' };
    }
    
    await addSystemLog(env, `📊 智能测速: 测试 ${ipsToTest.length} 个IP (设置数量: ${uiConfig.testCount || config.defaultTestCount}, 实际计算: ${finalTestCount})`);

    const batchSize = Math.min(maxConcurrent, 2);
    const existingSet = new Set(existingIPs);

    let successCount = 0;
    let failCount = 0;
    let totalTestAttempts = 0; // 总测试次数（包括重试）
    
    for (let i = 0; i < ipsToTest.length; i += batchSize) {
      const batch = ipsToTest.slice(i, i + batchSize);

      for (let j = 0; j < batch.length; j++) {
        const ip = batch[j];
        let lastError = null;
        let result = null;

        let testSuccess = false;
        let retryCount = 0;
        for (let retry = 0; retry <= maxRetries; retry++) {
          retryCount++;
          totalTestAttempts++;
          try {
            // isInPool: IP是否已在带宽池中
            // isRetry: 是否是重试调用(retry > 0)
            const isInPool = existingSet.has(ip);
            const isRetry = retry > 0;
            result = await Promise.race([
              speedTestWithBandwidth(env, ip, null, isInPool, ctx, isRetry),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
            ]);
            if (result.success) {
              successCount++;
              testSuccess = true;
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

        if (!testSuccess) {
          failCount++;
        }
        // 记录每个IP的测试次数
        if (retryCount > 1) {
          await addSystemLog(env, `🔄 ${ip} 测试了 ${retryCount} 次才结束`);
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
    
    // 备用池主动升级策略：当带宽池较空时，主动将备用池的优质IP升级到带宽池
    const finalBandwidthCount = (await getBandwidthPoolIPs(env)).length;
    if (finalBandwidthCount < maxPoolSize * 0.5) {
      const neededSlots = Math.floor(maxPoolSize * 0.5) - finalBandwidthCount;
      const bestBackupIPs = await env.DB.prepare(`
        SELECT ip, latency, bandwidth, country, city
        FROM backup_quality_ips
        ORDER BY bandwidth DESC, latency ASC
        LIMIT ?
      `).bind(Math.min(neededSlots, 5)).all();  // 每次最多升级5个
      
      if (bestBackupIPs.results && bestBackupIPs.results.length > 0) {
        for (const ipData of bestBackupIPs.results) {
          const score = calculateIPScore(ipData.latency, ipData.bandwidth || 0);
          const geo = { country: ipData.country, city: ipData.city };
          await addToBandwidthPool(env, ipData.ip, ipData.latency, ipData.bandwidth, geo, score);
          // 从备用池删除
          await env.DB.prepare('DELETE FROM backup_quality_ips WHERE ip = ?').bind(ipData.ip).run();
        }
        await addSystemLog(env, `⬆️ 备用池主动升级: ${bestBackupIPs.results.length} 个优质IP升级到带宽池`);
      }
    }
    
    await updateRegionStats(env);
    await updateRegionQuality(env);
    
    const newBandwidthCount = (await getBandwidthPoolIPs(env)).length;
    await addSystemLog(env, `✅ 测速完成 | 成功: ${successCount}, 失败: ${failCount} | 总测试次数: ${totalTestAttempts} | 带宽池: ${newBandwidthCount}/${maxPoolSize}`);
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
    const countryDomains = dnsConfig?.countryDomains || {};
    const hasCountryDomains = Object.keys(countryDomains).length > 0;
    await addSystemLog(env, `🔍 检查自动更新DNS: autoUpdateAfterTest=${dnsConfig?.autoUpdateAfterTest}, DNS配置完整=${!!(dnsConfig?.apiToken && dnsConfig?.zoneId && (dnsConfig?.recordName || hasCountryDomains))}`);
    if (dnsConfig?.autoUpdateAfterTest) {
      const config = getEnvConfig(env);
      const uiConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
      const ipCount = uiConfig.ipCount || config.defaultIpCount;
      // 获取排序方式，默认为综合评分
      const sortBy = dnsConfig?.autoUpdateSortBy || 'score';
      await addSystemLog(env, `🔍 自动更新DNS排序方式: ${sortBy}`);
      
      // 确定要更新的国家和域名
      let targetCountry = 'CN';
      let targetDomain = dnsConfig?.recordName;
      
      // 如果有国家域名映射，优先使用国家域名
      if (hasCountryDomains) {
        // 优先尝试中国域名
        if (countryDomains['CN']) {
          targetCountry = 'CN';
          targetDomain = countryDomains['CN'];
        } else {
          // 如果没有中国域名，使用第一个国家
          const firstCountry = Object.keys(countryDomains)[0];
          targetCountry = firstCountry;
          targetDomain = countryDomains[firstCountry];
        }
      }
      
      // 先尝试获取目标国家IP，如果没有则获取全球IP
      let bestIPs = await getBestIPs(env, targetCountry, ipCount, sortBy);
      await addSystemLog(env, `🔍 自动更新DNS: 找到 ${bestIPs.length} 个${targetCountry}最佳IP`);
      if (bestIPs.length === 0) {
        await addSystemLog(env, `🔍 没有找到${targetCountry} IP，尝试获取全球最佳IP`);
        bestIPs = await getBestIPs(env, null, ipCount, sortBy);
        await addSystemLog(env, `🔍 自动更新DNS: 找到 ${bestIPs.length} 个全球最佳IP`);
      }
      if (bestIPs.length > 0) {
        // 使用 ctx.waitUntil 让DNS更新在后台执行，避免占用子请求配额
        if (ctx) {
          ctx.waitUntil(updateDNSBatch(env, bestIPs.map(item => item.ip), 'auto_after_test', targetDomain));
        } else {
          await updateDNSBatch(env, bestIPs.map(item => item.ip), 'auto_after_test', targetDomain);
        }
        await addSystemLog(env, `🌍 测速完成后自动更新DNS: ${bestIPs.length} 个IP (域名: ${targetDomain || '默认'})`);
      } else {
        await addSystemLog(env, `⚠️ 自动更新DNS失败: 没有找到最佳IP`);
      }
    }
    
    return { success: true, successCount, failCount, bandwidthCount: newBandwidthCount };
  } catch (e) {
    await addSystemLog(env, `❌ 测速失败: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// 通用区域数据更新函数
async function updateRegionData(env, type = 'quality') {
  try {
    const isQuality = type === 'quality';
    const tableName = isQuality ? 'region_quality' : 'region_stats';
    
    // 构建查询SQL
    const selectFields = isQuality 
      ? 'country, COUNT(*) as ip_count, AVG(latency) as avg_latency, AVG(bandwidth) as avg_bandwidth, MIN(latency) as min_latency, MAX(latency) as max_latency'
      : 'country, COUNT(*) as ip_count, AVG(latency) as avg_latency, AVG(bandwidth) as avg_bandwidth';
    
    const stats = await env.DB.prepare(`
      SELECT ${selectFields}
      FROM high_quality_ips WHERE country != 'unknown' GROUP BY country
    `).all();
    
    await addSystemLog(env, `🌍 更新区域数据: 从 high_quality_ips 获取到 ${stats.results?.length || 0} 个地区`);
    
    const operations = [];
    for (const stat of stats.results || []) {
      if (isQuality) {
        operations.push(env.DB.prepare(`
          INSERT OR REPLACE INTO ${tableName} (country, ip_count, avg_latency, avg_bandwidth, min_latency, max_latency, last_updated)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(stat.country, stat.ip_count, Math.round(stat.avg_latency), stat.avg_bandwidth ? Math.round(stat.avg_bandwidth * 10) / 10 : null, stat.min_latency, stat.max_latency));
      } else {
        operations.push(env.DB.prepare(`
          INSERT OR REPLACE INTO ${tableName} (country, ip_count, avg_latency, avg_bandwidth, last_updated)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(stat.country, stat.ip_count, Math.round(stat.avg_latency), stat.avg_bandwidth ? Math.round(stat.avg_bandwidth * 10) / 10 : null));
      }
    }
    if (operations.length > 0) {
      await env.DB.batch(operations);
      await addSystemLog(env, `✅ 已更新 ${operations.length} 个地区数据到 ${tableName}`);
    } else {
      await addSystemLog(env, `⚠️ 没有地区数据需要更新到 ${tableName}`);
    }
  } catch (e) {
    await addSystemLog(env, `❌ 更新区域数据失败: ${e.message}`);
  }
}

// 兼容性别名
async function updateRegionQuality(env) {
  return updateRegionData(env, 'quality');
}

async function updateRegionStats(env) {
  return updateRegionData(env, 'stats');
}

async function getTotalIPCount(env) {
  try {
    const ips = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
    return ips.length;
  } catch (e) { return 0; }
}

async function getAllIPs(env) {
  try {
    const ips = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
    const customIPs = await env.KV.get(CONFIG.kvKeys.customIPs, 'json') || [];
    return [...new Set([...ips, ...customIPs])];
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
  await env.KV.put(CONFIG.kvKeys.lastUpdate, new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
  await addSystemLog(env, `🔄 IP列表已更新: ${ipList.length} 个IP`);
  return ipList;
}

async function getBestIPs(env, visitorCountry, count, sortBy = 'score') {
  let bestIPs = [];
  const filterCountry = visitorCountry && visitorCountry !== 'unknown';

  // 根据排序方式构建ORDER BY子句
  let orderByClause;
  switch (sortBy) {
    case 'bandwidth':
      // 带宽优先：按带宽降序，延迟升序
      orderByClause = '(CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC, latency ASC';
      break;
    case 'latency':
      // 延迟优先：按延迟升序，带宽降序
      orderByClause = 'latency ASC, (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC';
      break;
    case 'score':
    default:
      // 综合评分优先：按评分降序（带宽80% + 延迟20%）
      orderByClause = `(CASE 
        WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 
        ELSE (bandwidth * 0.8 + (100 - CASE WHEN latency > 100 THEN 0 ELSE 100 - latency END) * 0.2) 
      END) DESC, latency ASC`;
      break;
  }

  try {
    // 先从带宽池获取
    const bwSql = `
      SELECT ip, latency, bandwidth, country
      FROM high_quality_ips
      ${filterCountry ? 'WHERE country = ?' : ''}
      ORDER BY ${orderByClause}
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
        ORDER BY ${orderByClause}
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
  await addSystemLog(env, `📊 获取最佳IP: ${result.length} 个 (请求: ${count}, 排序: ${sortBy}, 过滤: ${filterCountry ? visitorCountry : '全球'})`);
  
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
      const advancedConfig = await getAdvancedConfig(env);
      const maxBackupPoolSize = advancedConfig.maxBackupPoolSize || 50;
      
      await addSystemLog(env, `🔍 获取备用池统计: maxBackupPoolSize=${maxBackupPoolSize}`);
      
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

async function updateDNSBatch(env, ips, triggerSource = 'manual', recordName = null) {
  try {
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    if (!dnsConfig || !dnsConfig.apiToken || !dnsConfig.zoneId) {
      return { success: false, error: 'DNS配置不完整，请先在设置页面配置DNS' };
    }

    if (!ips || ips.length === 0) {
      return { success: false, error: '没有可用的IP地址' };
    }

    // 使用传入的记录名或默认记录名
    const targetRecordName = recordName || dnsConfig.recordName;
    if (!targetRecordName) {
      return { success: false, error: '域名未配置，请在设置页面配置域名记录或国家域名映射' };
    }

    // 限制IP数量，减少子请求
    const MAX_DNS_IPS = 3; // 最多3个IP，减少子请求
    const limitedIPs = ips.slice(0, MAX_DNS_IPS);

    const url = `https://api.cloudflare.com/client/v4/zones/${dnsConfig.zoneId}/dns_records`;

    // 获取现有DNS记录列表
    const listResp = await fetch(`${url}?type=A&name=${targetRecordName}`, {
      headers: { 'Authorization': `Bearer ${dnsConfig.apiToken}` }
    });
    const listData = await listResp.json();

    // 串行删除现有记录（减少并发子请求）
    if (listData.success && listData.result.length > 0) {
      for (const record of listData.result) {
        try {
          await fetch(`${url}/${record.id}`, { 
            method: 'DELETE', 
            headers: { 'Authorization': `Bearer ${dnsConfig.apiToken}` } 
          });
          await new Promise(r => setTimeout(r, 100)); // 延迟避免过快
        } catch (e) {
          // 忽略删除错误
        }
      }
    }

    // 串行创建新记录（减少并发子请求）
    let successCount = 0;
    for (const ip of limitedIPs) {
      try {
        const createResp = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${dnsConfig.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'A', name: targetRecordName, content: ip, ttl: 120, proxied: dnsConfig.proxied || false })
        });
        const result = await createResp.json();
        if (result.success) successCount++;
        await new Promise(r => setTimeout(r, 100)); // 延迟避免过快
      } catch (e) {
        // 忽略创建错误
      }
    }

    if (successCount > 0) {
      await addSystemLog(env, `✅ DNS更新成功: ${successCount} 个IP (域名: ${targetRecordName}, 来源: ${triggerSource})`);

      // 获取IP的详细信息
      let ipDetails = [];
      const placeholders = limitedIPs.map(() => '?').join(',');
      try {
        const results = await env.DB.prepare(
          `SELECT ip, latency, bandwidth FROM high_quality_ips WHERE ip IN (${placeholders})`
        ).bind(...limitedIPs).all();

        if (results.results) {
          ipDetails = results.results.map(result => ({
            ip: result.ip,
            latency: result.latency,
            bandwidth: result.bandwidth
          }));
        }
      } catch (e) {
        // 忽略错误，继续处理
      }
      
      await sendTelegramNotification(env, {
        message: {
          ipCount: successCount,
          source: getSourceText(triggerSource),
          domain: targetRecordName,
          ips: ipDetails.map(ipDetail => ({
            ip: ipDetail.ip,
            latency: ipDetail.latency,
            bandwidth: ipDetail.bandwidth
          }))
        },
        hideIP: dnsConfig.telegramHideIP !== false,
        type: 'success'
      });
    } else {
      await sendTelegramNotification(env, {
        message: {
          ipCount: 0,
          source: getSourceText(triggerSource),
          domain: targetRecordName
        },
        type: 'error'
      });
    }
    return { success: successCount > 0, count: successCount, domain: targetRecordName };
  } catch (e) {
    await addSystemLog(env, `❌ DNS更新失败: ${e.message}`);
    return { success: false, error: e.message, count: 0 };
  }
}

async function updateDNSByCountry(env, country, ips, triggerSource = 'manual') {
  try {
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    if (!dnsConfig || !dnsConfig.apiToken || !dnsConfig.zoneId) {
      return { success: false, error: 'DNS配置不完整' };
    }

    // 检查是否有对应国家的域名配置
    const countryDomains = dnsConfig.countryDomains || {};
    const countryDomain = countryDomains[country];

    if (!countryDomain) {
      return { success: false, error: `未配置 ${country} 国家的域名` };
    }

    return await updateDNSBatch(env, ips, triggerSource, countryDomain);
  } catch (e) {
    await addSystemLog(env, `❌ 按国家更新DNS失败: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function updateDNSForAllCountries(env, triggerSource = 'manual') {
  try {
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    if (!dnsConfig || !dnsConfig.apiToken || !dnsConfig.zoneId) {
      return { success: false, error: 'DNS配置不完整' };
    }

    const countryDomains = dnsConfig.countryDomains || {};
    const countryCodes = Object.keys(countryDomains);

    if (countryCodes.length === 0) {
      return { success: false, error: '未配置国家域名映射' };
    }

    const results = [];
    const config = getEnvConfig(env);
    const ipCount = config.defaultIpCount;

    for (const country of countryCodes) {
      const bestIPs = await getBestIPs(env, country, ipCount);
      if (bestIPs.length > 0) {
        const result = await updateDNSByCountry(env, country, bestIPs.map(item => item.ip), triggerSource);
        results.push({ country, ...result });
        // 延迟一下，避免API限流
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        await addSystemLog(env, `⚠️ 国家 ${country} 没有可用的IP`);
        results.push({ country, success: false, error: '没有可用的IP' });
      }
    }

    const successCount = results.filter(r => r.success).length;
    await addSystemLog(env, `🌍 按国家更新DNS完成: 成功 ${successCount}/${results.length} 个国家`);

    return { success: successCount > 0, results, successCount, totalCount: results.length };
  } catch (e) {
    await addSystemLog(env, `❌ 批量按国家更新DNS失败: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function updateDNSSmartRouting(env, triggerSource = 'manual') {
  try {
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    if (!dnsConfig || !dnsConfig.apiToken || !dnsConfig.zoneId) {
      return { success: false, error: 'DNS配置不完整' };
    }

    const countryDomains = dnsConfig.countryDomains || {};
    const countryCodes = Object.keys(countryDomains);

    if (countryCodes.length === 0) {
      return { success: false, error: '未配置国家域名映射' };
    }

    const config = getEnvConfig(env);
    const ipCount = config.defaultIpCount;
    const results = [];
    const updatedCountries = [];

    // 获取所有优质IP并按国家分组
    const allIPs = await env.DB.prepare(`
      SELECT ip, latency, bandwidth, country 
      FROM high_quality_ips 
      ORDER BY bandwidth DESC, latency ASC
    `).all();

    if (!allIPs.results || allIPs.results.length === 0) {
      return { success: false, error: '没有可用的IP地址' };
    }

    // 按国家分组IP
    const ipsByCountry = {};
    for (const ip of allIPs.results) {
      const country = ip.country || 'unknown';
      if (!ipsByCountry[country]) {
        ipsByCountry[country] = [];
      }
      ipsByCountry[country].push(ip);
    }

    await addSystemLog(env, `🧠 智能分流DNS更新: 找到 ${allIPs.results.length} 个IP，分布在 ${Object.keys(ipsByCountry).length} 个国家/地区`);

    // 为每个配置的国家域名更新DNS
    for (const country of countryCodes) {
      let countryIPs = ipsByCountry[country] || [];
      
      // 如果该国家没有足够的IP，从其他国家补充
      if (countryIPs.length < ipCount) {
        const needed = ipCount - countryIPs.length;
        const otherIPs = allIPs.results
          .filter(ip => ip.country !== country)
          .slice(0, needed);
        countryIPs = countryIPs.concat(otherIPs);
      }

      // 取前N个最优IP
      const bestIPs = countryIPs.slice(0, ipCount);

      if (bestIPs.length > 0) {
        const result = await updateDNSByCountry(env, country, bestIPs.map(item => item.ip), triggerSource);
        results.push({ country, domain: countryDomains[country], ...result });
        if (result.success) {
          updatedCountries.push(country);
          await addSystemLog(env, `✅ ${COUNTRY_NAMES[country] || country} DNS更新成功: ${bestIPs.length} 个IP (${countryDomains[country]})`);
        } else {
          await addSystemLog(env, `❌ ${COUNTRY_NAMES[country] || country} DNS更新失败: ${result.error}`);
        }
        // 延迟一下，避免API限流
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        await addSystemLog(env, `⚠️ ${COUNTRY_NAMES[country] || country} 没有可用的IP`);
        results.push({ country, domain: countryDomains[country], success: false, error: '没有可用的IP' });
      }
    }

    const successCount = results.filter(r => r.success).length;
    await addSystemLog(env, `🧠 智能分流DNS更新完成: 成功 ${successCount}/${results.length} 个国家`);

    return { 
      success: successCount > 0, 
      results, 
      successCount, 
      totalCount: results.length,
      updatedCountries,
      totalIPs: allIPs.results.length
    };
  } catch (e) {
    await addSystemLog(env, `❌ 智能分流DNS更新失败: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function updateDNSWithVisitorAware(env, visitorCountry, count) {
  try {
    // 首先获取最佳 IP 列表
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
    
    // 检查是否有该国家的域名配置
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    const countryDomains = dnsConfig?.countryDomains || {};
    
    // 如果有该国家的域名配置，使用按国家更新
    if (countryDomains[visitorCountry]) {
      await addSystemLog(env, `🌍 为 ${COUNTRY_NAMES[visitorCountry] || visitorCountry} 地区更新DNS (使用国家域名: ${countryDomains[visitorCountry]})，共 ${bestIPs.length} 个IP`);
      return await updateDNSByCountry(env, visitorCountry, bestIPs.map(item => item.ip), 'visitor_aware');
    }
    
    // 如果没有该国家的域名配置，但有其他国家域名映射，使用第一个国家域名作为默认
    const countryCodes = Object.keys(countryDomains);
    if (countryCodes.length > 0) {
      const defaultCountryDomain = countryDomains[countryCodes[0]];
      await addSystemLog(env, `🌍 为 ${COUNTRY_NAMES[visitorCountry] || visitorCountry} 地区更新DNS (回退到国家域名: ${defaultCountryDomain})，共 ${bestIPs.length} 个IP`);
      return await updateDNSBatch(env, bestIPs.map(item => item.ip), 'visitor_aware', defaultCountryDomain);
    }
    
    // 如果没有国家域名映射，使用默认的 recordName
    await addSystemLog(env, `🌍 为 ${COUNTRY_NAMES[visitorCountry] || visitorCountry} 地区更新DNS (使用默认域名)，共 ${bestIPs.length} 个IP`);
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

// 通用数据处理函数
async function handleDataQuery(env, type) {
  try {
    switch (type) {
      case 'region-stats': {
        const stats = await env.DB.prepare(`SELECT country, ip_count, avg_latency, avg_bandwidth, last_updated FROM region_stats ORDER BY avg_latency ASC LIMIT 20`).all();
        const topRegions = (stats.results || []).map(stat => ({
          country: stat.country, countryName: COUNTRY_NAMES[stat.country] || stat.country,
          ipCount: stat.ip_count, avgLatency: stat.avg_latency, avgBandwidth: stat.avg_bandwidth
        }));
        return { success: true, regions: topRegions };
      }
      
      case 'region-quality': {
        const quality = await env.DB.prepare(`SELECT country, ip_count, avg_latency, avg_bandwidth, min_latency, max_latency, last_updated FROM region_quality ORDER BY avg_latency ASC LIMIT 20`).all();
        const stats = await env.DB.prepare(`SELECT COUNT(*) as total_regions, SUM(ip_count) as total_ips, AVG(avg_latency) as global_avg_latency, AVG(avg_bandwidth) as global_avg_bandwidth FROM region_quality`).first();
        await addSystemLog(env, `🔍 区域质量查询: ${quality.results?.length || 0} 个地区, 总IP: ${stats?.total_ips || 0}`);
        return {
          success: true,
          regions: (quality.results || []).map(r => ({
            country: r.country, countryName: COUNTRY_NAMES[r.country] || r.country,
            ipCount: r.ip_count, avgLatency: r.avg_latency, avgBandwidth: r.avg_bandwidth,
            minLatency: r.min_latency, maxLatency: r.max_latency, lastUpdated: r.last_updated
          })),
          summary: stats
        };
      }
      
      default:
        return { success: false, error: 'Unknown query type' };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 兼容性别名
async function handleRegionStats(env) {
  return handleDataQuery(env, 'region-stats');
}

async function handleRegionQuality(env) {
  return handleDataQuery(env, 'region-quality');
}

async function handleDBStatus(env) {
  try {
    await env.DB.prepare("SELECT 1").run();
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const counts = {};
    for (const table of ['speed_results', 'high_quality_ips', 'backup_quality_ips', 'failed_ips', 'system_logs', 'region_stats', 'ip_geo_cache', 'region_quality']) {
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

// 区域10: 前端界面

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
    failedIpCooldownDays: savedAdvancedConfig.failedIpCooldownDays || config.failedIpCooldownDays,
    maxBackupPoolSize: savedAdvancedConfig.maxBackupPoolSize || 50
  };
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
  <title>CF优选IP · 双池智能优选</title>
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
      background: #0b1120;
      padding: 16px;
      border-radius: 14px;
      text-align: center;
      transition: all 0.2s;
      border: 1px solid #1e293b;
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
      transition: all 0.3s ease;
      cursor: pointer;
    }
    .pool-card:hover {
      background: #1e293b;
      transform: translateY(-4px);
      box-shadow: 0 8px 25px rgba(96, 165, 250, 0.2);
      border-left: 3px solid #3b82f6;
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
        <button class="btn btn-primary" style="flex:1;" onclick="updateDNSWithVisitorAware()" id="visitorUpdateDNSBtn">🌍 更新DNS（优先您的位置）</button>
      </div>
      <div id="recommendedIPs" style="margin-top: 12px;"></div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>🎯 IP池管理与快速操作</h2>
    </div>
    <div class="card-body">
      <div style="display: grid; grid-template-columns: 1.6fr 1fr; gap: 20px; align-items: stretch;">
        <!-- 左侧：带宽优质池 -->
        <div style="background: #0f172a; border-radius: 12px; padding: 16px; border: 1px solid #334155;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <h3 style="color: #60a5fa; font-size: 14px; margin: 0;">📋 带宽优质池 <span style="font-size:11px; color:#94a3b8;">(评分优先)</span></h3>
            <div>
              <button class="btn btn-sm btn-primary" onclick="manualUpdate()">🔄 刷新IP列表</button>
              <button class="btn btn-sm btn-warning" onclick="startSpeedTest()" id="speedTestBtn">▶ 开始测速</button>
            </div>
          </div>
          
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
        </div>
        
        <!-- 右侧：快速操作 -->
        <div style="background: #0f172a; border-radius: 12px; padding: 16px; border: 1px solid #334155;">
          <h3 style="color: #60a5fa; font-size: 14px; margin: 0 0 16px 0;">⚡ 快速操作</h3>
          
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
            <button class="btn btn-warning" style="flex:1;" onclick="updateDNSForAllCountries()">🌍 更新所有国家DNS</button>
            <button class="btn btn-info" style="flex:1;" onclick="updateDNSWithSmartRouting()">🧠 智能分流更新</button>
          </div>
          <div class="button-group">
            <button class="btn btn-warning" style="flex:1;" onclick="repairBandwidthPool()">🔧 修复带宽池</button>
            <button class="btn btn-info" style="flex:1;" onclick="debugBandwidthPool()">🐛 调试带宽池</button>
          </div>
          <div class="button-group">
            <button class="btn btn-success" style="flex:1;" onclick="exportIPs()">📥 导出优质 IP</button>
            <button class="btn btn-info" style="flex:1;" onclick="exportBackupIPs()">📥 导出备用池 IP</button>
          </div>
          <div class="button-group">
            <button class="btn btn-danger" style="flex:1;" onclick="clearFailedIPs()">🗑️ 清空失败IP黑名单</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div style="display: grid; grid-template-columns: 1.6fr 1fr; gap: 20px; align-items: start;">
    <!-- 左侧大卡片：实时测速结果 + 区域分析 -->
    <div class="card">
      <div class="card-header">
        <h2>📊 数据分析</h2>
      </div>
      <div class="card-body">
        <!-- 实时测速结果 -->
        <div style="background: #0f172a; border-radius: 12px; padding: 16px; border: 1px solid #334155; margin-bottom: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; cursor: pointer;" onclick="toggleSpeedResults()">
            <h3 style="color: #60a5fa; font-size: 14px; margin: 0;">📊 实时测速结果 <span id="speedResultToggle">▶</span></h3>
            <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); clearSpeedResults()">清除记录</button>
          </div>
          <div id="speedResultContent" style="display:none;">
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
        
        <!-- 区域分析 -->
        <div style="background: #0f172a; border-radius: 12px; padding: 16px; border: 1px solid #334155;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; cursor: pointer;" onclick="toggleRegionStats()">
            <h3 style="color: #60a5fa; font-size: 14px; margin: 0;">🌍 区域分析 <span id="regionStatsToggle">▶</span></h3>
            <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); loadRegionStats()">刷新数据</button>
          </div>
          <div id="regionStatsContent" style="display:none;">
            <div class="stats-row" id="regionStatsSummary" style="display:none;">
              <div class="stat-card"><div class="stat-label">全球平均延迟</div><div class="stat-value" id="globalAvgLatency">--</div></div>
              <div class="stat-card"><div class="stat-label">全球平均带宽</div><div class="stat-value" id="globalAvgBandwidth">--</div></div>
              <div class="stat-card"><div class="stat-label">总地区数</div><div class="stat-value" id="totalRegions">--</div></div>
              <div class="stat-card"><div class="stat-label">总IP数</div><div class="stat-value" id="totalRegionIPs">--</div></div>
            </div>
            <div class="table-container">
              <table>
                <thead><tr><th>地区</th><th>IP数量</th><th>平均延迟</th><th>平均带宽</th><th>最佳延迟</th><th>最差延迟</th><th>更新时间</th></tr></thead>
                <tbody id="regionStatsTable"><tr><td colspan="7" style="text-align:center;padding:40px;">暂无区域数据</td></tr></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <!-- 右侧大卡片：运行参数 + 运行日志 -->
    <div class="card">
      <div class="card-header">
        <h2>⚙️ 配置与日志</h2>
      </div>
      <div class="card-body">
        <!-- 运行参数 -->
        <div style="background: #0f172a; border-radius: 12px; padding: 16px; border: 1px solid #334155; margin-bottom: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; cursor: pointer;" onclick="toggleParamsCard()">
            <h3 style="color: #60a5fa; font-size: 14px; margin: 0;">⚙️ 运行参数</h3>
            <span id="paramsToggleIcon" style="font-size:18px; color:#94a3b8;">▼</span>
          </div>
          <div id="paramsCardBody" style="display:none;">
            <div style="margin-bottom:12px;">
              <h4 style="color:#60a5fa; font-size:12px; margin:0 0 8px 0; font-weight:500;">📊 测速设置</h4>
              <div class="params-row">
                <div class="param-item"><label style="font-size:11px;">测速线程数 (1-10)</label><input type="number" class="param-input" id="threadCount" min="1" max="10" value="${uiConfig.threadCount}"></div>
                <div class="param-item"><label style="font-size:11px;">测速数量 (10-100)</label><input type="number" class="param-input" id="testCount" min="10" max="100" value="${uiConfig.testCount}"></div>
                <div class="param-item"><label style="font-size:11px;">带宽测试文件 (3-10MB)</label><input type="number" class="param-input" id="bandwidthFileSize" min="3" max="10" value="${uiConfig.bandwidthFileSize}"></div>
              </div>
            </div>
            
            <div style="margin-bottom:12px;">
              <h4 style="color:#60a5fa; font-size:12px; margin:0 0 8px 0; font-weight:500;">🌐 DNS 设置</h4>
              <div class="params-row">
                <div class="param-item"><label style="font-size:11px;">DNS 自动添加 IP 数量 (1-10)</label><input type="number" class="param-input" id="ipCount" min="1" max="10" value="${uiConfig.ipCount}"></div>
                <div class="param-item"><label style="font-size:11px;">失败IP冷却天数 (1-30)</label><input type="number" class="param-input" id="failedCooldown" min="1" max="30" value="${advancedConfig.failedIpCooldownDays}"></div>
                <div class="param-item"></div>
              </div>
            </div>
            
            <div style="margin-bottom:12px;">
              <h4 style="color:#60a5fa; font-size:12px; margin:0 0 8px 0; font-weight:500;">💾 池容量设置</h4>
              <div class="params-row">
                <div class="param-item"><label style="font-size:11px;">带宽优质池最大容量 (10-50)</label><input type="number" class="param-input" id="maxPoolSize" min="10" max="50" value="${advancedConfig.maxHighQualityPoolSize}"></div>
                <div class="param-item"><label style="font-size:11px;">备用池最大容量 (50-500)</label><input type="number" class="param-input" id="maxBackupPoolSize" min="50" max="500" value="${advancedConfig.maxBackupPoolSize}"></div>
                <div class="param-item"></div>
              </div>
            </div>
            
            <button class="btn btn-primary full-width" style="padding:10px; margin-top:8px;" onclick="saveAllSettings()">💾 保存所有设置</button>
            
            <div class="info-text" style="text-align:center; margin-top:10px; font-size:11px;">
              💡为避免限流，带宽测试每分钟最多10次，测试文件大小3-5MB，数值越大容易触发限流
            </div>
          </div>
        </div>
        
        <!-- 运行日志 -->
        <div style="background: #0f172a; border-radius: 12px; padding: 16px; border: 1px solid #334155;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; cursor: pointer;" onclick="toggleLogsCard()">
            <h3 style="color: #60a5fa; font-size: 14px; margin: 0;">📝 运行日志</h3>
            <div style="display: flex; gap: 8px; align-items: center; height: 32px;">
              <button class="btn btn-sm btn-danger" style="height: 28px; line-height: 1;" onclick="event.stopPropagation(); clearLogs();">清除</button>
              <button class="btn btn-sm btn-primary" style="height: 28px; line-height: 1;" onclick="event.stopPropagation(); refreshLogs();">刷新</button>
              <span id="logsToggleIcon" style="font-size:18px; color:#94a3b8; line-height: 1;">▼</span>
            </div>
          </div>
          <div id="logsCardBody" style="display:none;">
            <div class="log-panel" id="logPanel"></div>
          </div>
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
  
  function toggleRegionStats() {
    const content = document.getElementById('regionStatsContent');
    const toggle = document.getElementById('regionStatsToggle');
    if (content.style.display === 'none') {
      content.style.display = 'block';
      toggle.textContent = '▼';
      loadRegionStats();
    } else {
      content.style.display = 'none';
      toggle.textContent = '▶';
    }
  }

  async function loadRegionStats() {
    try {
      const res = await fetch('/api/region-quality');
      const data = await res.json();
      
      if (data.success) {
        const regions = data.regions || [];
        const stats = data.summary || {};
        
        // Update summary
        document.getElementById('globalAvgLatency').textContent = stats.global_avg_latency ? parseFloat(stats.global_avg_latency).toFixed(1) + 'ms' : '--';
        document.getElementById('globalAvgBandwidth').textContent = stats.global_avg_bandwidth ? parseFloat(stats.global_avg_bandwidth).toFixed(1) + 'Mbps' : '--';
        document.getElementById('totalRegions').textContent = stats.total_regions || 0;
        document.getElementById('totalRegionIPs').textContent = stats.total_ips || 0;
        document.getElementById('regionStatsSummary').style.display = 'grid';
        
        // Update table
        const tableBody = document.getElementById('regionStatsTable');
        if (regions.length > 0) {
          tableBody.innerHTML = regions.map(r => '<tr><td><span class="country-badge">' + (r.countryName || r.country) + '</span></td><td>' + r.ipCount + '</td><td><span class="latency-badge ' + getLatencyClass(r.avgLatency) + '">' + Math.round(r.avgLatency) + 'ms</span></td><td>' + (r.avgBandwidth ? parseFloat(r.avgBandwidth).toFixed(1) + 'Mbps' : '0Mbps') + '</td><td>' + (r.minLatency || '--') + 'ms</td><td>' + (r.maxLatency || '--') + 'ms</td><td>' + (r.lastUpdated || '--') + '</td></tr>').join('');
        } else {
          tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;">暂无区域数据，请先进行测速或更新IP列表</td></tr>';
        }
      } else {
        showToast('获取区域数据失败: ' + (data.error || '未知错误'), 'error');
      }
    } catch (error) {
      showToast('加载区域数据失败: ' + error.message, 'error');
    }
  }

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
      // 获取带宽池统计
      const bwRes = await fetch('/api/get-pool-stats?type=bandwidth');
      const bwData = await bwRes.json();
      
      // 获取备用池统计
      const backupRes = await fetch('/api/get-pool-stats?type=backup');
      const backupData = await backupRes.json();
      
      if (bwData.success) {
        document.getElementById('bandwidthCount').innerText = bwData.currentCount;
      }
      
      if (backupData.success) {
        document.getElementById('backupCount').innerText = backupData.currentCount;
      }
      
      // 更新池统计卡片显示
      if (bwData.success || backupData.success) {
        document.getElementById('poolStats').innerHTML = \`
          <div class="pool-card" onclick="showBandwidthPoolModal()" style="cursor: pointer;" title="点击查看带宽优质池IP列表"><h4>🚀 带宽优质池</h4><div class="count">\${bwData.success ? bwData.currentCount : 0}/\${bwData.success ? bwData.maxPoolSize : 30}</div><div class="sub">平均延迟: \${bwData.success ? bwData.stats.avgLatency : 0}ms | 平均带宽: \${bwData.success ? bwData.stats.avgBandwidth : 0} Mbps</div></div>
          <div class="pool-card" onclick="showBackupPoolModal()" style="cursor: pointer;" title="点击查看备用池IP列表"><h4>📋 备用池</h4><div class="count">\${backupData.success ? backupData.currentCount : 0}/\${backupData.success ? backupData.maxPoolSize : 50}</div><div class="sub">平均延迟: \${backupData.success ? backupData.stats.avgLatency : 0}ms | 平均带宽: \${backupData.success ? backupData.stats.avgBandwidth : 0} Mbps</div></div>
        \`;
      }
    } catch(e) { /* 忽略错误 */ }
  }

  // 备用池弹窗相关变量
  let backupPoolIPs = [];
  let backupPoolCountries = [];

  async function showBackupPoolModal() {
    const modal = document.createElement('div');
    modal.id = 'backupPoolModal';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; display: flex; align-items: center; justify-content: center;';
    modal.innerHTML = \`
      <div style="background: #1e293b; border-radius: 12px; width: 90%; max-width: 1000px; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column;">
        <div style="padding: 20px; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center;">
          <h2 style="margin: 0; color: #e2e8f0;">📋 备用池 IP 列表</h2>
          <button onclick="closeBackupPoolModal()" style="background: none; border: none; color: #94a3b8; font-size: 24px; cursor: pointer;">×</button>
        </div>
        <div style="padding: 20px; overflow-y: auto; flex: 1;">
          <!-- 筛选区域 -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; padding: 16px; background: #0f172a; border-radius: 8px;">
            <div>
              <label style="color: #94a3b8; font-size: 12px;">国家/地区</label>
              <select id="backupFilterCountry" onchange="loadBackupPoolIPs()" style="width: 100%; padding: 8px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0;">
                <option value="all">全部</option>
              </select>
            </div>
            <div>
              <label style="color: #94a3b8; font-size: 12px;">最小带宽 (Mbps)</label>
              <input type="number" id="backupFilterMinBandwidth" value="0" min="0" onchange="loadBackupPoolIPs()" style="width: 100%; padding: 8px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0;">
            </div>
            <div>
              <label style="color: #94a3b8; font-size: 12px;">最大延迟 (ms)</label>
              <input type="number" id="backupFilterMaxLatency" value="9999" min="0" onchange="loadBackupPoolIPs()" style="width: 100%; padding: 8px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0;">
            </div>
            <div>
              <label style="color: #94a3b8; font-size: 12px;">排序方式</label>
              <select id="backupFilterSortBy" onchange="loadBackupPoolIPs()" style="width: 100%; padding: 8px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0;">
                <option value="bandwidth">带宽优先</option>
                <option value="latency">延迟优先</option>
                <option value="country">国家优先</option>
              </select>
            </div>
          </div>
          
          <!-- 统计信息 -->
          <div style="margin-bottom: 16px; color: #94a3b8; font-size: 14px;">
            共找到 <span id="backupPoolTotal" style="color: #60a5fa; font-weight: bold;">0</span> 个 IP
          </div>
          
          <!-- IP 列表表格 -->
          <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr style="border-bottom: 2px solid #334155;">
                  <th style="text-align: left; padding: 12px; color: #94a3b8;">IP 地址</th>
                  <th style="text-align: left; padding: 12px; color: #94a3b8;">延迟</th>
                  <th style="text-align: left; padding: 12px; color: #94a3b8;">带宽</th>
                  <th style="text-align: left; padding: 12px; color: #94a3b8;">国家/地区</th>
                  <th style="text-align: left; padding: 12px; color: #94a3b8;">城市</th>
                  <th style="text-align: left; padding: 12px; color: #94a3b8;">最后测试</th>
                </tr>
              </thead>
              <tbody id="backupPoolTableBody">
                <tr><td colspan="6" style="text-align: center; padding: 40px; color: #64748b;">加载中...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    \`;
    document.body.appendChild(modal);
    await loadBackupPoolIPs();
  }

  function closeBackupPoolModal() {
    const modal = document.getElementById('backupPoolModal');
    if (modal) modal.remove();
  }

  async function loadBackupPoolIPs() {
    try {
      const country = document.getElementById('backupFilterCountry')?.value || 'all';
      const minBandwidth = document.getElementById('backupFilterMinBandwidth')?.value || 0;
      const maxLatency = document.getElementById('backupFilterMaxLatency')?.value || 9999;
      const sortBy = document.getElementById('backupFilterSortBy')?.value || 'bandwidth';
      
      const url = \`/api/backup-pool-ips?country=\${country}&minBandwidth=\${minBandwidth}&maxLatency=\${maxLatency}&sortBy=\${sortBy}&limit=200\`;
      const res = await fetch(url);
      const data = await res.json();
      
      if (data.success) {
        backupPoolIPs = data.ips;
        backupPoolCountries = data.countries;
        
        // 更新国家筛选下拉框
        const countrySelect = document.getElementById('backupFilterCountry');
        if (countrySelect && countrySelect.options.length <= 1) {
          backupPoolCountries.forEach(c => {
            const option = document.createElement('option');
            option.value = c;
            option.textContent = window.countryNames?.[c] || c;
            countrySelect.appendChild(option);
          });
        }
        
        // 更新统计
        document.getElementById('backupPoolTotal').textContent = data.total;
        
        // 更新表格
        const tbody = document.getElementById('backupPoolTableBody');
        if (backupPoolIPs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: #64748b;">暂无数据</td></tr>';
        } else {
          tbody.innerHTML = backupPoolIPs.map(ip => {
            const countryName = window.countryNames?.[ip.country] || ip.country || '未知';
            const latencyClass = ip.latency <= 50 ? 'color: #10b981;' : ip.latency <= 100 ? 'color: #f59e0b;' : 'color: #ef4444;';
            const bandwidthClass = ip.bandwidth >= 500 ? 'color: #10b981; font-weight: bold;' : ip.bandwidth >= 200 ? 'color: #60a5fa;' : 'color: #e2e8f0;';
            // 处理 last_tested 时间，确保正确转换为上海时区
            let lastTested = '-';
            if (ip.last_tested) {
              try {
                const date = new Date(ip.last_tested);
                if (!isNaN(date.getTime())) {
                  // 手动添加 8 小时来转换为上海时区
                  const shanghaiDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
                  lastTested = shanghaiDate.toLocaleString('zh-CN', { hour12: false });
                }
              } catch (e) {
                /* 忽略日期解析错误 */
              }
            }
            return '<tr style="border-bottom: 1px solid #334155;">' +
              '<td style="padding: 12px; color: #e2e8f0; font-family: monospace; cursor: pointer;" onclick="copyIPToClipboard(this)" title="点击复制 IP" data-ip="' + ip.ip + '">' + ip.ip + ' 📋</td>' +
              '<td style="padding: 12px; ' + latencyClass + '">' + ip.latency + 'ms</td>' +
              '<td style="padding: 12px; ' + bandwidthClass + '">' + (ip.bandwidth || 0) + ' Mbps</td>' +
              '<td style="padding: 12px; color: #e2e8f0;">' + countryName + '</td>' +
              '<td style="padding: 12px; color: #94a3b8;">' + (ip.city || '-') + '</td>' +
              '<td style="padding: 12px; color: #94a3b8; font-size: 12px;">' + lastTested + '</td>' +
            '</tr>';
          }).join('');
        }
      }
    } catch (error) {
      document.getElementById('backupPoolTableBody').innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: #ef4444;">加载失败: ' + error.message + '</td></tr>';
    }
  }

  // 带宽优质池弹窗功能
  let bandwidthPoolCountries = [];

  async function showBandwidthPoolModal() {
    const modal = document.createElement('div');
    modal.id = 'bandwidthPoolModal';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; display: flex; align-items: center; justify-content: center;';
    modal.innerHTML = '<div style="background: #1e293b; border-radius: 12px; width: 90%; max-width: 1000px; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column;">' +
      '<div style="padding: 20px; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center;">' +
        '<h2 style="margin: 0; color: #e2e8f0;">🚀 带宽优质池 IP 列表</h2>' +
        '<button onclick="closeBandwidthPoolModal()" style="background: none; border: none; color: #94a3b8; font-size: 24px; cursor: pointer;">×</button>' +
      '</div>' +
      '<div style="padding: 20px; overflow-y: auto; flex: 1;">' +
        '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; padding: 16px; background: #0f172a; border-radius: 8px;">' +
          '<div>' +
            '<label style="color: #94a3b8; font-size: 12px;">国家/地区</label>' +
            '<select id="bandwidthFilterCountry" onchange="loadBandwidthPoolIPs()" style="width: 100%; padding: 8px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0;">' +
              '<option value="all">全部</option>' +
            '</select>' +
          '</div>' +
          '<div>' +
            '<label style="color: #94a3b8; font-size: 12px;">最小带宽 (Mbps)</label>' +
            '<input type="number" id="bandwidthFilterMinBandwidth" value="0" min="0" onchange="loadBandwidthPoolIPs()" style="width: 100%; padding: 8px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0;">' +
          '</div>' +
          '<div>' +
            '<label style="color: #94a3b8; font-size: 12px;">最大延迟 (ms)</label>' +
            '<input type="number" id="bandwidthFilterMaxLatency" value="9999" min="0" onchange="loadBandwidthPoolIPs()" style="width: 100%; padding: 8px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0;">' +
          '</div>' +
          '<div>' +
            '<label style="color: #94a3b8; font-size: 12px;">排序方式</label>' +
            '<select id="bandwidthFilterSortBy" onchange="loadBandwidthPoolIPs()" style="width: 100%; padding: 8px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0;">' +
              '<option value="bandwidth">带宽优先</option>' +
              '<option value="latency">延迟优先</option>' +
              '<option value="country">国家优先</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div style="margin-bottom: 16px; color: #94a3b8; font-size: 14px;">' +
          '共找到 <span id="bandwidthPoolTotal" style="color: #60a5fa; font-weight: bold;">0</span> 个 IP' +
        '</div>' +
        '<div style="overflow-x: auto;">' +
          '<table style="width: 100%; border-collapse: collapse;">' +
            '<thead>' +
              '<tr style="border-bottom: 2px solid #334155;">' +
                '<th style="text-align: left; padding: 12px; color: #94a3b8;">IP 地址</th>' +
                '<th style="text-align: left; padding: 12px; color: #94a3b8;">延迟</th>' +
                '<th style="text-align: left; padding: 12px; color: #94a3b8;">带宽</th>' +
                '<th style="text-align: left; padding: 12px; color: #94a3b8;">国家/地区</th>' +
                '<th style="text-align: left; padding: 12px; color: #94a3b8;">城市</th>' +
                '<th style="text-align: left; padding: 12px; color: #94a3b8;">最后测试</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody id="bandwidthPoolTableBody">' +
              '<tr><td colspan="6" style="text-align: center; padding: 40px; color: #64748b;">加载中...</td></tr>' +
            '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>' +
    '</div>';
    document.body.appendChild(modal);
    await loadBandwidthPoolIPs();
  }

  function closeBandwidthPoolModal() {
    const modal = document.getElementById('bandwidthPoolModal');
    if (modal) modal.remove();
  }

  async function loadBandwidthPoolIPs() {
    try {
      const country = document.getElementById('bandwidthFilterCountry')?.value || 'all';
      const minBandwidth = document.getElementById('bandwidthFilterMinBandwidth')?.value || 0;
      const maxLatency = document.getElementById('bandwidthFilterMaxLatency')?.value || 9999;
      const sortBy = document.getElementById('bandwidthFilterSortBy')?.value || 'bandwidth';
      
      const url = '/api/bandwidth-pool-ips?country=' + country + '&minBandwidth=' + minBandwidth + '&maxLatency=' + maxLatency + '&sortBy=' + sortBy + '&limit=200';
      const res = await fetch(url);
      const data = await res.json();
      
      if (data.success) {
        bandwidthPoolIPs = data.ips;
        bandwidthPoolCountries = data.countries;
        
        const countrySelect = document.getElementById('bandwidthFilterCountry');
        if (countrySelect && countrySelect.options.length <= 1) {
          bandwidthPoolCountries.forEach(function(c) {
            const option = document.createElement('option');
            option.value = c;
            option.textContent = window.countryNames?.[c] || c;
            countrySelect.appendChild(option);
          });
        }
        
        document.getElementById('bandwidthPoolTotal').textContent = data.total;
        
        const tbody = document.getElementById('bandwidthPoolTableBody');
        if (bandwidthPoolIPs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: #64748b;">暂无数据</td></tr>';
        } else {
          tbody.innerHTML = bandwidthPoolIPs.map(function(ip) {
            const countryName = window.countryNames?.[ip.country] || ip.country || '未知';
            const latencyClass = ip.latency <= 50 ? 'color: #10b981;' : ip.latency <= 100 ? 'color: #f59e0b;' : 'color: #ef4444;';
            const bandwidthClass = ip.bandwidth >= 500 ? 'color: #10b981; font-weight: bold;' : ip.bandwidth >= 200 ? 'color: #60a5fa;' : 'color: #e2e8f0;';
            // 处理 last_tested 时间，确保正确转换为上海时区
            let lastTested = '-';
            if (ip.last_tested) {
              try {
                const date = new Date(ip.last_tested);
                if (!isNaN(date.getTime())) {
                  // 手动添加 8 小时来转换为上海时区 (UTC+8)
                  const shanghaiDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
                  lastTested = shanghaiDate.toLocaleString('zh-CN', { hour12: false });
                }
              } catch (e) {
                /* 忽略日期解析错误 */
              }
            }
            return '<tr style="border-bottom: 1px solid #334155;">' +
              '<td style="padding: 12px; color: #e2e8f0; font-family: monospace; cursor: pointer;" onclick="copyIPToClipboard(this)" title="点击复制 IP" data-ip="' + ip.ip + '">' + ip.ip + ' 📋</td>' +
              '<td style="padding: 12px; ' + latencyClass + '">' + ip.latency + 'ms</td>' +
              '<td style="padding: 12px; ' + bandwidthClass + '">' + (ip.bandwidth || 0) + ' Mbps</td>' +
              '<td style="padding: 12px; color: #e2e8f0;">' + countryName + '</td>' +
              '<td style="padding: 12px; color: #94a3b8;">' + (ip.city || '-') + '</td>' +
              '<td style="padding: 12px; color: #94a3b8; font-size: 12px;">' + lastTested + '</td>' +
            '</tr>';
          }).join('');
        }
      }
    } catch (error) {
      document.getElementById('bandwidthPoolTableBody').innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: #ef4444;">加载失败: ' + error.message + '</td></tr>';
    }
  }

  // 复制IP到剪贴板
  function copyIPToClipboard(element) {
    var ip = element.getAttribute('data-ip');
    if (!ip) return;
    navigator.clipboard.writeText(ip).then(function() {
      var originalHTML = element.innerHTML;
      element.innerHTML = ip + ' ✓';
      element.style.color = '#10b981';
      setTimeout(function() {
        element.innerHTML = originalHTML;
        element.style.color = '#e2e8f0';
      }, 1500);
    }).catch(function(err) {
      /* 忽略复制错误 */
    });
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
      const res = await fetch('/api/get-logs');
      const data = await res.json();
      const panel = document.getElementById('logPanel');
      if (data.logs?.length) panel.innerHTML = data.logs.map(l => '<div class="log-entry"><span class="log-time">[' + l.timeStr + ']</span> ' + escapeHtml(l.message) + '</div>').join('');
      else panel.innerHTML = '<div class="log-entry">暂无日志</div>';
    } catch(e) {}
  }
  
  async function clearLogs() {
    showConfirm('清除所有日志？', async () => {
      await fetch('/api/clear-logs', { method: 'POST' });
      await loadLogs();
    });
  }
  
  async function refreshLogs() { await loadLogs(); }
  
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
    } catch(e) {}
  }
  
  function copyIP(ip) { navigator.clipboard.writeText(ip); showToast('IP 已复制', 'success'); }
  
  function toggleParamsCard() {
    const body = document.getElementById('paramsCardBody');
    const icon = document.getElementById('paramsToggleIcon');
    if (body.style.display === 'none') {
      body.style.display = 'block';
      icon.textContent = '▲';
    } else {
      body.style.display = 'none';
      icon.textContent = '▼';
    }
  }
  
  function toggleLogsCard() {
    const body = document.getElementById('logsCardBody');
    const icon = document.getElementById('logsToggleIcon');
    if (body.style.display === 'none') {
      body.style.display = 'block';
      icon.textContent = '▲';
    } else {
      body.style.display = 'none';
      icon.textContent = '▼';
    }
  }
  
  function exportIPs() {
    window.location.href = '/api/export-ips';
  }
  
  function exportBackupIPs() {
    window.location.href = '/api/export-backup-ips';
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
  
  async function updateDNSForAllCountries() {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '更新中...';
    try {
      const res = await fetch('/api/update-dns-all-countries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const data = await res.json();
      if (data.success) {
        showToast('所有国家DNS更新成功！成功 ' + data.successCount + '/' + data.totalCount + ' 个国家', 'success');
      } else {
        showToast('DNS更新失败：' + (data.error || '请检查国家域名配置'), 'error');
      }
    } catch(e) {
      showToast('更新失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🌍 更新所有国家DNS';
    }
  }
  
  async function updateDNSWithSmartRouting() {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '更新中...';
    try {
      const res = await fetch('/api/update-dns-smart-routing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const data = await res.json();
      if (data.success) {
        showToast('智能分流DNS更新成功！共更新 ' + (data.updatedCountries?.length || 0) + ' 个国家', 'success');
      } else {
        showToast('DNS更新失败：' + (data.error || '请检查配置'), 'error');
      }
    } catch(e) {
      showToast('更新失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🧠 智能分流更新';
    }
  }
  
  function addSpeedResult(ip, result) {
    const score = result.success ? calculateScore(result.latency, result.bandwidth) : 0;
    speedTestResults.unshift({
      id: Date.now() + Math.random(), ip, latency: result.latency || null, bandwidth: result.bandwidth || null,
      success: result.success, score, country: result.country || 'unknown',
      countryName: window.countryNames?.[result.country] || result.country || '未知',
      timeStr: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
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
          /* 忽略DNS更新错误 */
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
    const testCount = parseInt(document.getElementById('testCount').value) || 30;
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
  
  async function clearFailedIPs() {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '清空中...';
    try {
      const res = await fetch('/api/clear-failed-ips', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('失败IP黑名单已清空', 'success');
      } else {
        showToast('清空失败：' + (data.error || '未知错误'), 'error');
      }
    } catch(e) {
      showToast('清空失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🗑️ 清空失败IP黑名单';
    }
  }
  
  async function saveAdvancedSettings() {
    const maxPoolSizeElement = document.getElementById('maxPoolSize');
    const failedCooldownElement = document.getElementById('failedCooldown');
    const maxBackupPoolSizeElement = document.getElementById('maxBackupPoolSize');
    
    if (!maxPoolSizeElement || !failedCooldownElement || !maxBackupPoolSizeElement) {
      showToast('设置项元素未找到', 'error');
      return false;
    }
    
    const maxPoolSize = parseInt(maxPoolSizeElement.value) || 50;
    const failedCooldown = parseInt(failedCooldownElement.value) || 15;
    const maxBackupPoolSize = parseInt(maxBackupPoolSizeElement.value) || 50;
    
    if (maxPoolSize < 10 || maxPoolSize > 100) { showToast('带宽池容量必须在10-100之间', 'error'); return false; }
    if (failedCooldown < 1 || failedCooldown > 30) { showToast('冷却天数必须在1-30之间', 'error'); return false; }
    if (maxBackupPoolSize < 50 || maxBackupPoolSize > 500) { showToast('备用池容量必须在50-500之间', 'error'); return false; }
    
    try {
      const res = await fetch('/api/save-advanced-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxHighQualityPoolSize: maxPoolSize, failedIpCooldownDays: failedCooldown, maxBackupPoolSize: maxBackupPoolSize }) });
      if (!res.ok) {
        throw new Error('网络请求失败');
      }
      const data = await res.json();
      if (data.success) { showToast('高级设置保存成功', 'success'); await loadAdvancedConfig(); return true; }
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
      const maxBackupPoolSize = document.getElementById('maxBackupPoolSize');
      if (maxPoolSize) maxPoolSize.value = data.maxHighQualityPoolSize || 20;
      if (failedCooldown) failedCooldown.value = data.failedIpCooldownDays || 15;
      if (maxBackupPoolSize) maxBackupPoolSize.value = data.maxBackupPoolSize || 50;
    } catch(e) {
      const maxPoolSize = document.getElementById('maxPoolSize');
      const failedCooldown = document.getElementById('failedCooldown');
      const maxBackupPoolSize = document.getElementById('maxBackupPoolSize');
      if (maxPoolSize) maxPoolSize.value = 30;
      if (failedCooldown) failedCooldown.value = 15;
      if (maxBackupPoolSize) maxBackupPoolSize.value = 50;
    }
  }

  async function saveUIConfig() {
    const ipCount = parseInt(document.getElementById('ipCount').value) || 3;
    const testCount = parseInt(document.getElementById('testCount').value) || 30;
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
      if (testCount) testCount.value = data.testCount || 30;
      if (threadCount) threadCount.value = data.threadCount || 10;
      if (bandwidthFileSize) bandwidthFileSize.value = data.bandwidthFileSize || 3;
    } catch(e) {
      const ipCount = document.getElementById('ipCount');
      const testCount = document.getElementById('testCount');
      const threadCount = document.getElementById('threadCount');
      const bandwidthFileSize = document.getElementById('bandwidthFileSize');
      if (ipCount) ipCount.value = 3;
      if (testCount) testCount.value = 30;
      if (threadCount) threadCount.value = 10;
      if (bandwidthFileSize) bandwidthFileSize.value = 3;
    }
  }
  
  window.onload = async () => {
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
      <div class="form-group" style="margin-top: 12px;">
        <label>自动更新DNS排序方式</label>
        <select id="autoUpdateSortBy">
          <option value="score">📊 综合评分 (推荐)</option>
          <option value="bandwidth">⚡ 带宽优先</option>
          <option value="latency">🚀 延迟优先</option>
        </select>
        <div class="info-text">选择自动更新DNS时IP的排序依据</div>
      </div>
      <div class="form-group" style="margin-top: 20px;">
        <label>国家域名映射 (按国家更新DNS)</label>
        <div id="countryDomainsContainer">
          <div class="info-text">点击下方按钮添加国家域名映射</div>
        </div>
        <button class="btn btn-secondary" style="margin-top: 10px;" onclick="addCountryDomain()">➕ 添加国家域名映射</button>
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
      document.getElementById('autoUpdateSortBy').value = data.autoUpdateSortBy || 'score';
      document.getElementById('telegramEnabled').checked = data.telegramEnabled || false;
      document.getElementById('telegramBotToken').value = data.telegramBotToken || '';
      document.getElementById('telegramChatId').value = data.telegramChatId || '';
      document.getElementById('telegramHideIP').checked = data.telegramHideIP !== false;
      toggleTelegramConfig();
      
      // 加载国家域名映射
      const container = document.getElementById('countryDomainsContainer');
      container.innerHTML = '';
      
      if (data.countryDomains && typeof data.countryDomains === 'object') {
        const countryDomains = data.countryDomains;
        const countryCodes = Object.keys(countryDomains);
        
        if (countryCodes.length > 0) {
          countryCodes.forEach(country => {
            const domain = countryDomains[country];
            const domainItem = document.createElement('div');
            domainItem.className = 'country-domain-item';
            domainItem.style.display = 'flex';
            domainItem.style.alignItems = 'center';
            domainItem.style.marginTop = '10px';
            domainItem.style.padding = '10px';
            domainItem.style.backgroundColor = '#1e293b';
            domainItem.style.borderRadius = '8px';
            
            // 创建选择框
            const select = document.createElement('select');
            select.className = 'country-select';
            select.style.flex = '1';
            select.style.marginRight = '10px';
            
            // 添加选项
            const countryNames = {"CN":"中国","US":"美国","JP":"日本","SG":"新加坡","KR":"韩国","DE":"德国","GB":"英国","FR":"法国","CA":"加拿大","AU":"澳大利亚","IN":"印度","TW":"台湾","HK":"香港","MO":"澳门","unknown":"未知"};
            Object.entries(countryNames).forEach(([code, name]) => {
              const option = document.createElement('option');
              option.value = code;
              option.textContent = code + ' - ' + name;
              if (code === country) {
                option.selected = true;
              }
              select.appendChild(option);
            });
            
            // 创建输入框
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'domain-input';
            input.placeholder = '例如: cn.yourdomain.com';
            input.value = domain;
            input.style.flex = '2';
            input.style.marginRight = '10px';
            
            // 创建删除按钮
            const button = document.createElement('button');
            button.className = 'btn btn-danger';
            button.style.padding = '6px 12px';
            button.textContent = '❌';
            button.onclick = function() {
              removeCountryDomain(this);
            };
            
            // 组装元素
            domainItem.appendChild(select);
            domainItem.appendChild(input);
            domainItem.appendChild(button);
            
            container.appendChild(domainItem);
          });
        } else {
          container.innerHTML = '<div class="info-text">点击下方按钮添加国家域名映射</div>';
        }
      } else {
        container.innerHTML = '<div class="info-text">点击下方按钮添加国家域名映射</div>';
      }
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
  
  function addCountryDomain() {
    const container = document.getElementById('countryDomainsContainer');
    const domainItem = document.createElement('div');
    domainItem.className = 'country-domain-item';
    domainItem.style.display = 'flex';
    domainItem.style.alignItems = 'center';
    domainItem.style.marginTop = '10px';
    domainItem.style.padding = '10px';
    domainItem.style.backgroundColor = '#1e293b';
    domainItem.style.borderRadius = '8px';
    
    // 创建选择框
    const select = document.createElement('select');
    select.className = 'country-select';
    select.style.flex = '1';
    select.style.marginRight = '10px';
    
    // 添加选项
    const countryNames = {"CN":"中国","US":"美国","JP":"日本","SG":"新加坡","KR":"韩国","DE":"德国","GB":"英国","FR":"法国","CA":"加拿大","AU":"澳大利亚","IN":"印度","TW":"台湾","HK":"香港","MO":"澳门","unknown":"未知"};
    Object.entries(countryNames).forEach(([code, name]) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = code + ' - ' + name;
      select.appendChild(option);
    });
    
    // 创建输入框
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'domain-input';
    input.placeholder = '例如: cn.yourdomain.com';
    input.style.flex = '2';
    input.style.marginRight = '10px';
    
    // 创建删除按钮
    const button = document.createElement('button');
    button.className = 'btn btn-danger';
    button.style.padding = '6px 12px';
    button.textContent = '❌';
    button.onclick = function() {
      removeCountryDomain(this);
    };
    
    // 组装元素
    domainItem.appendChild(select);
    domainItem.appendChild(input);
    domainItem.appendChild(button);
    
    container.appendChild(domainItem);
  }
  
  function removeCountryDomain(btn) {
    const item = btn.closest('.country-domain-item');
    item.remove();
  }
  
  async function saveAllConfig() {
    const countryDomains = {};
    const domainItems = document.querySelectorAll('.country-domain-item');
    domainItems.forEach(item => {
      const country = item.querySelector('.country-select').value;
      const domain = item.querySelector('.domain-input').value.trim();
      if (country && domain) {
        countryDomains[country] = domain;
      }
    });
    
    const config = {
      apiToken: document.getElementById('apiToken').value.trim(),
      zoneId: document.getElementById('zoneId').value.trim(),
      recordName: document.getElementById('recordName').value.trim(),
      proxied: document.getElementById('proxied').value === 'true',
      autoUpdate: document.getElementById('autoUpdate').checked,
      autoUpdateAfterTest: document.getElementById('autoUpdateAfterTest').checked,
      autoUpdateSortBy: document.getElementById('autoUpdateSortBy').value || 'score',
      countryDomains: countryDomains,
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
  window.onload = async () => { await loadDataSources(); await loadConfig(); await loadCustomIPs(); await loadLogConfig(); };
</script>
</body>
</html>`;
}

// 区域9: 主入口与API路由

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const config = getEnvConfig(env);

    ctx.waitUntil((async () => {
      await initDatabase(env);
    })().catch(() => {}));
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
    

    if (path === '/api/force-clean-pool' && request.method === 'POST') {
      const result = await cleanHighQualityPool(env, true);
      highQualityCache.clear();
      await addSystemLog(env, `🔧 手动强制清理带宽池完成`);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/backup-pool-ips') {
      const country = url.searchParams.get('country');
      const minBandwidth = parseInt(url.searchParams.get('minBandwidth')) || 0;
      const maxLatency = parseInt(url.searchParams.get('maxLatency')) || 9999;
      const sortBy = url.searchParams.get('sortBy') || 'bandwidth';
      const limit = parseInt(url.searchParams.get('limit')) || 100;
      
      try {
        let sql = `
          SELECT ip, latency, bandwidth, country, city, last_tested 
          FROM backup_quality_ips 
          WHERE 1=1
        `;
        const params = [];
        
        if (country && country !== 'all') {
          sql += ` AND country = ?`;
          params.push(country);
        }
        if (minBandwidth > 0) {
          sql += ` AND bandwidth >= ?`;
          params.push(minBandwidth);
        }
        if (maxLatency < 9999) {
          sql += ` AND latency <= ?`;
          params.push(maxLatency);
        }
        
        // 排序
        if (sortBy === 'bandwidth') {
          sql += ` ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC, latency ASC`;
        } else if (sortBy === 'latency') {
          sql += ` ORDER BY latency ASC, (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC`;
        } else if (sortBy === 'country') {
          sql += ` ORDER BY country ASC, (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC`;
        }
        
        sql += ` LIMIT ?`;
        params.push(limit);
        
        const result = await env.DB.prepare(sql).bind(...params).all();
        
        // 获取所有国家列表（用于筛选）
        const countriesResult = await env.DB.prepare(`
          SELECT DISTINCT country FROM backup_quality_ips ORDER BY country
        `).all();
        
        return new Response(JSON.stringify({
          success: true,
          ips: result.results || [],
          countries: countriesResult.results?.map(r => r.country) || [],
          total: result.results?.length || 0
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { headers: { 'Content-Type': 'application/json' } });
      }
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
    if (path === '/api/bandwidth-pool-ips') {
      const country = url.searchParams.get('country');
      const minBandwidth = parseInt(url.searchParams.get('minBandwidth')) || 0;
      const maxLatency = parseInt(url.searchParams.get('maxLatency')) || 9999;
      const sortBy = url.searchParams.get('sortBy') || 'bandwidth';
      const limit = parseInt(url.searchParams.get('limit')) || 100;
      
      try {
        let sql = `
          SELECT ip, latency, bandwidth, country, city, last_tested 
          FROM high_quality_ips 
          WHERE 1=1
        `;
        const params = [];
        
        if (country && country !== 'all') {
          sql += ` AND country = ?`;
          params.push(country);
        }
        if (minBandwidth > 0) {
          sql += ` AND bandwidth >= ?`;
          params.push(minBandwidth);
        }
        if (maxLatency < 9999) {
          sql += ` AND latency <= ?`;
          params.push(maxLatency);
        }
        
        // 排序
        if (sortBy === 'bandwidth') {
          sql += ` ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC, latency ASC`;
        } else if (sortBy === 'latency') {
          sql += ` ORDER BY latency ASC, (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC`;
        } else if (sortBy === 'country') {
          sql += ` ORDER BY country ASC, (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC`;
        }
        
        sql += ` LIMIT ?`;
        params.push(limit);
        
        const result = await env.DB.prepare(sql).bind(...params).all();
        
        // 获取所有国家列表（用于筛选）
        const countriesResult = await env.DB.prepare(`
          SELECT DISTINCT country FROM high_quality_ips ORDER BY country
        `).all();
        
        return new Response(JSON.stringify({
          success: true,
          ips: result.results || [],
          countries: countriesResult.results?.map(r => r.country) || [],
          total: result.results?.length || 0
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { headers: { 'Content-Type': 'application/json' } });
      }
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
      const logs = await getSystemLogs(env);
      return new Response(JSON.stringify({ logs }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/clear-logs' && request.method === 'POST') {
      await env.DB.exec('DELETE FROM system_logs');
      await addSystemLog(env, '📋 日志已被手动清除');
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
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
    if (path === '/api/export-backup-ips') {
      const backupIPs = await getBackupPoolIPs(env);
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
      var rows = backupIPs.map(function(item) {
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
          'Content-Disposition': 'attachment; filename="CF_BackupIP_' + new Date().toISOString().split('T')[0] + '.csv"'
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
      await addSystemLog(env, `🔍 获取高级配置: maxBackupPoolSize=${advancedConfig.maxBackupPoolSize}`);
      return new Response(JSON.stringify(advancedConfig), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/save-advanced-config' && request.method === 'POST') {
      const { maxHighQualityPoolSize, failedIpCooldownDays, maxBackupPoolSize } = await request.json();
      const advancedConfig = {
        maxHighQualityPoolSize: Math.min(50, Math.max(10, parseInt(maxHighQualityPoolSize) || 20)),
        failedIpCooldownDays: Math.min(30, Math.max(1, parseInt(failedIpCooldownDays) || 15)),
        maxBackupPoolSize: Math.min(500, Math.max(50, parseInt(maxBackupPoolSize) || 50))
      };
      await env.KV.put(CONFIG.kvKeys.advancedConfig, JSON.stringify(advancedConfig));
      await addSystemLog(env, `💾 保存高级配置: maxBackupPoolSize=${advancedConfig.maxBackupPoolSize}`);
      const cleanResult = await cleanHighQualityPool(env, false);
      await addSystemLog(env, `⚙️ 高级设置已保存`);
      return new Response(JSON.stringify({ success: true, config: advancedConfig, cleanResult }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/clear-failed-ips' && request.method === 'POST') {
      try {
        await env.DB.prepare('DELETE FROM failed_ips').run();
        await addSystemLog(env, '🗑️ 失败IP黑名单已手动清空');
        return new Response(JSON.stringify({ success: true, message: '失败IP黑名单已清空' }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        await addSystemLog(env, `❌ 清空失败IP黑名单失败: ${e.message}`);
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
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
      
      // 检查是否有国家域名映射，如果没有默认域名但有国家域名映射，使用第一个国家域名
      const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
      const countryDomains = dnsConfig?.countryDomains || {};
      let targetDomain = null;
      if (!dnsConfig?.recordName && Object.keys(countryDomains).length > 0) {
        const firstCountry = Object.keys(countryDomains)[0];
        targetDomain = countryDomains[firstCountry];
      }
      
      const result = await updateDNSBatch(env, targetIPs, triggerSource || 'manual', targetDomain);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/update-dns-by-country' && request.method === 'POST') {
      const { country, ips, count, triggerSource } = await request.json();
      if (!country) return new Response(JSON.stringify({ error: '缺少国家参数' }), { status: 400 });
      let targetIPs = ips;
      if (!targetIPs) {
        const config = getEnvConfig(env);
        const ipCount = count || config.defaultIpCount;
        const bestIPs = await getBestIPs(env, country, ipCount);
        targetIPs = bestIPs.map(item => item.ip);
      }
      if (!targetIPs || targetIPs.length === 0) return new Response(JSON.stringify({ error: '无可用IP' }), { status: 400 });
      const result = await updateDNSByCountry(env, country, targetIPs, triggerSource || 'manual');
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/update-dns-all-countries' && request.method === 'POST') {
      const { triggerSource } = await request.json();
      const result = await updateDNSForAllCountries(env, triggerSource || 'manual');
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/db-status') {
      const status = await handleDBStatus(env);
      return new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/update-dns-smart-routing' && request.method === 'POST') {
      const result = await updateDNSSmartRouting(env, 'manual');
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    return scheduled(event, env, ctx);
  }
};

// 区域6: 测速功能

// 简化的测速函数（Cron专用）- 只测1次延迟 + 1次带宽
async function simpleSpeedTest(env, ip, ctx = null) {
  try {
    // 1. 只测1次延迟（不是3次）
    let latency = null;
    try {
      const startTime = Date.now();
      const response = await fetch('https://speed.cloudflare.com/__down?bytes=1000', {
        headers: { 'Host': 'speed.cloudflare.com' },
        cf: { resolveOverride: ip },
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        await response.text();
        latency = Date.now() - startTime;
      }
    } catch (e) {
      return { success: false, ip, error: '延迟测试失败' };
    }
    
    if (!latency) {
      return { success: false, ip, error: '延迟测试失败' };
    }
    
    // 2. 获取地理位置（如果缓存中没有）
    let geo = await getIPGeo(env, ip);
    const countryName = COUNTRY_NAMES[geo.country] || geo.country || '未知';
    
    // 3. 只测1次带宽（简化版，使用小文件）
    let bandwidthMbps = null;
    try {
      const testBytes = 1000000; // 1MB（减小文件大小）
      const downloadStartTime = Date.now();
      const response = await fetch(`https://speed.cloudflare.com/__down?bytes=${testBytes}`, {
        headers: { 'Host': 'speed.cloudflare.com' },
        cf: { resolveOverride: ip },
        signal: AbortSignal.timeout(15000) // 15秒超时
      });
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        const downloadTime = (Date.now() - downloadStartTime) / 1000;
        bandwidthMbps = Math.round((arrayBuffer.byteLength * 8) / (downloadTime * 1000000) * 100) / 100;
      }
    } catch (e) {
      // 带宽测试失败，使用估算值
      bandwidthMbps = estimateBandwidthByLatency(latency);
    }
    
    // 4. 计算评分
    const score = calculateIPScore(latency, bandwidthMbps || 0);
    const bandwidthLevel = getBandwidthLevel(bandwidthMbps);
    
    // 5. 写入数据库（异步，不阻塞）
    const writePromise = (async () => {
      try {
        await env.DB.prepare(`
          INSERT OR REPLACE INTO speed_results 
          (ip, delay, test_count, bandwidth, country, city, last_tested) 
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(ip, latency, 1, bandwidthMbps || null, geo.country, geo.city).run();
      } catch (e) {
        // 忽略写入错误
      }
    })();
    
    if (ctx) {
      ctx.waitUntil(writePromise);
    }
    
    // 6. 检查带宽池状态
    const isHighQuality = (bandwidthMbps || 0) >= 100;
    const inBandwidthPool = await checkInBandwidthPool(env, ip);
    
    if (isHighQuality) {
      // 质量达标，加入或更新带宽池
      if (!inBandwidthPool) {
        await addToBandwidthPool(env, ip, latency, bandwidthMbps, geo, score);
      }
    } else {
      // 质量不达标，如果在带宽池中则移除
      if (inBandwidthPool) {
        try {
          await env.DB.prepare('DELETE FROM high_quality_ips WHERE ip = ?').bind(ip).run();
          await addSystemLog(env, `🗑️ ${ip} 质量下降(带宽${bandwidthMbps || 0}Mbps)，已从优质池移除`);
          // 添加到备用池
          await env.DB.prepare(`
            INSERT OR REPLACE INTO backup_quality_ips 
            (ip, latency, bandwidth, country, city, last_tested) 
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).bind(ip, latency, bandwidthMbps || null, geo.country, geo.city).run();
        } catch (e) {
          // 忽略错误
        }
      }
    }
    
    // 7. 记录日志
    const bandwidthInfo = bandwidthMbps ? ` | 带宽: ${bandwidthMbps} Mbps ${bandwidthLevel.star}` : ' | 带宽: 估算值';
    await addSystemLog(env, `✅ ${ip} (${countryName}) - 延迟:${latency}ms ${bandwidthInfo} | 评分:${score}`);
    
    return { 
      success: true, ip, latency, 
      bandwidth: bandwidthMbps, 
      score, 
      country: geo.country, 
      countryName 
    };
    
  } catch (error) {
    return { success: false, ip, error: error.message };
  }
}

// 限制子请求版本的Cron测速流程 - 严格控制在指定数量内
async function fullCronSpeedTestLimited(env, ctx, maxSubrequests, maxTestIPs = 15) {
  await addSystemLog(env, `⏰ Cron测速任务开始（限制子请求模式，最多${maxTestIPs}个IP，预算${maxSubrequests}个子请求）`);
  
  // 子请求计数器（实际消耗）
  let subrequestCount = 0;
  
  try {
    // 获取所有待测IP
    const allIPs = await getAllIPs(env);
    
    if (allIPs.length === 0) {
      await addSystemLog(env, `⚠️ 没有可测速的IP`);
      return { successCount: 0, failCount: 0, bandwidthCount: 0, subrequestCount: 0 };
    }
    
    // 获取配置
    const advancedConfig = await getAdvancedConfig(env);
    const maxPoolSize = advancedConfig.maxHighQualityPoolSize;
    
    // 获取当前带宽池状态
    const bandwidthPoolIPs = await getBandwidthPoolIPs(env);
    const currentBandwidthCount = bandwidthPoolIPs.length;
    
    // 使用传入的最大测试数量，限制在8-20范围内
    // Cron定时任务模式下，优先使用根据子请求预算计算的maxTestIPs，不受UI设置限制
    const finalTestCount = Math.max(8, Math.min(maxTestIPs, 20));
    
    // 记录带宽池状态
    if (currentBandwidthCount >= maxPoolSize * 0.9) {
      await addSystemLog(env, `📊 带宽池状态: 较满(${currentBandwidthCount}/${maxPoolSize})`);
    } else if (currentBandwidthCount < maxPoolSize * 0.3) {
      await addSystemLog(env, `📊 带宽池状态: 较空(${currentBandwidthCount}/${maxPoolSize})`);
    }
    
    // ===== 智能IP选择策略 =====
    const existingIPs = new Set([...bandwidthPoolIPs.map(ip => ip.ip)]);
    
    // 1. 获取历史高带宽IP
    const highBandwidthIPs = await env.DB.prepare(`
      SELECT ip, bandwidth 
      FROM speed_results 
      WHERE bandwidth >= 100 
        AND julianday('now') - julianday(last_tested) < 30
      ORDER BY bandwidth DESC 
      LIMIT 50
    `).all();
    const highBandwidthIPList = (highBandwidthIPs.results || []).map(item => item.ip);
    const highBandwidthNewIPs = highBandwidthIPList.filter(ip => !existingIPs.has(ip));
    
    // 2. 获取备用池IP
    const backupPoolResult = await env.DB.prepare(`
      SELECT ip, bandwidth 
      FROM backup_quality_ips 
      ORDER BY (CASE WHEN bandwidth IS NULL OR bandwidth = 0 THEN 0 ELSE bandwidth END) DESC
    `).all();
    const backupPoolIPList = (backupPoolResult.results || []).map(item => item.ip);
    
    // 3. 获取新IP
    const backupPoolSet = new Set(backupPoolIPList);
    const newIPs = allIPs.filter(ip => !existingIPs.has(ip) && !backupPoolSet.has(ip));
    
    // 智能分配测试名额（去掉失败池，比例重新分配）
    // 新IP: 45% | 高带宽新IP: 30% | 带宽池: 15% | 备用池: 10%
    // 使用Math.round确保能填满finalTestCount
    let testSlots = {
      newIPs: Math.round(finalTestCount * 0.45),
      highBandwidthNewIPs: Math.round(finalTestCount * 0.30),
      bandwidthPoolIPs: Math.round(finalTestCount * 0.15),
      backupPoolIPs: Math.round(finalTestCount * 0.10)
    };
    
    // 调整配额确保总和等于finalTestCount（单域名模式下子请求充足）
    const totalSlots = testSlots.newIPs + testSlots.highBandwidthNewIPs + testSlots.bandwidthPoolIPs + testSlots.backupPoolIPs;
    if (totalSlots < finalTestCount) {
      // 将差额分配给新IP（优先探索新IP）
      testSlots.newIPs += (finalTestCount - totalSlots);
    }
    
    // 构建测试队列
    let ipsToTest = [];
    
    if (newIPs.length > 0) {
      const sampled = shuffleArray(newIPs).slice(0, testSlots.newIPs);
      ipsToTest.push(...sampled);
    }
    
    if (highBandwidthNewIPs.length > 0) {
      const sampled = shuffleArray(highBandwidthNewIPs).slice(0, testSlots.highBandwidthNewIPs);
      ipsToTest.push(...sampled);
    }
    
    if (bandwidthPoolIPs.length > 0) {
      const sortedByTime = bandwidthPoolIPs
        .sort((a, b) => new Date(a.last_tested) - new Date(b.last_tested))
        .map(ip => ip.ip);
      const sampled = sortedByTime.slice(0, testSlots.bandwidthPoolIPs);
      ipsToTest.push(...sampled);
    }
    
    if (backupPoolIPList.length > 0) {
      const sampled = shuffleArray(backupPoolIPList).slice(0, testSlots.backupPoolIPs);
      ipsToTest.push(...sampled);
    }
    
    // 去重并限制数量
    ipsToTest = [...new Set(ipsToTest)].slice(0, finalTestCount);
    ipsToTest = shuffleArray(ipsToTest);
    
    await addSystemLog(env, `📊 Cron智能测速: 测试 ${ipsToTest.length}/${finalTestCount} 个IP ` +
      `(新IP:${Math.min(newIPs.length, testSlots.newIPs)}, ` +
      `高带宽:${Math.min(highBandwidthNewIPs.length, testSlots.highBandwidthNewIPs)}, ` +
      `带宽池:${Math.min(bandwidthPoolIPs.length, testSlots.bandwidthPoolIPs)}, ` +
      `备用池:${Math.min(backupPoolIPList.length, testSlots.backupPoolIPs)})`);
    
    // 执行测速（串行执行，用实际子请求数控制）
    const testResults = { successCount: 0, failCount: 0, testedIPs: [] };
    
    for (let i = 0; i < ipsToTest.length; i++) {
      // 检查剩余子请求是否足够测试下一个IP（每个IP约2个子请求）
      if (subrequestCount + 2 > maxSubrequests) {
        await addSystemLog(env, `⚠️ 子请求即将达到限制(${subrequestCount}/${maxSubrequests})，停止测速，已测试 ${i} 个IP`);
        break;
      }
      
      const ip = ipsToTest[i];
      try {
        const result = await simpleSpeedTest(env, ip, ctx);
        // 每个IP测试消耗约2个子请求（延迟+带宽）
        subrequestCount += 2;
        
        if (result.success) {
          testResults.successCount++;
          testResults.testedIPs.push({ 
            ip: result.ip, 
            latency: result.latency, 
            bandwidth: result.bandwidth 
          });
        } else {
          testResults.failCount++;
        }
      } catch (e) {
        testResults.failCount++;
      }
      
      // 每个IP测试后短暂延迟（给子请求完成时间）
      await new Promise(r => setTimeout(r, 100));
    }
    
    await addSystemLog(env, `✅ Cron测速完成: 成功 ${testResults.successCount}, 失败 ${testResults.failCount}, 消耗 ${subrequestCount} 个子请求`);
    
    // 计算统计数据
    const testedIPs = testResults.testedIPs;
    const avgLatency = testedIPs.length ? 
      Math.round(testedIPs.reduce((a, b) => a + b.latency, 0) / testedIPs.length) : 0;
    const avgBandwidth = testedIPs.length ? 
      Math.round(testedIPs.reduce((a, b) => a + (b.bandwidth || 0), 0) / testedIPs.length) : 0;
    
    return {
      successCount: testResults.successCount,
      failCount: testResults.failCount,
      bandwidthCount: testedIPs.filter(ip => (ip.bandwidth || 0) >= 100).length,
      subrequestCount: subrequestCount,
      testedIPs: testedIPs,
      stats: {
        avgLatency: avgLatency,
        avgBandwidth: avgBandwidth
      }
    };
    
  } catch (error) {
    await addSystemLog(env, `❌ Cron测速异常: ${error.message}`);
    return { successCount: 0, failCount: 0, bandwidthCount: 0, subrequestCount: subrequestCount, testedIPs: [], stats: { avgLatency: 0, avgBandwidth: 0 } };
  }
}

// 区域7: DNS更新功能

// 限制子请求版本的DNS更新 - 严格控制在指定数量内
async function optimizedDNSUpdateLimited(env, ctx, maxSubrequests, dnsIPCount = 3, updateBothDomains = false) {
  const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
  
  if (!dnsConfig?.autoUpdate) {
    return { success: false, reason: 'not_enabled' };
  }
  
  if (!dnsConfig?.apiToken || !dnsConfig?.zoneId) {
    await addSystemLog(env, `❌ DNS更新: 配置不完整`);
    return { success: false, reason: 'config_incomplete' };
  }
  
  // 估算DNS更新需要的子请求数
  // 查询1 + 删除最多3 + 创建最多dnsIPCount = 1+3+dnsIPCount个子请求
  const estimatedSubrequestsPerDomain = 1 + 3 + dnsIPCount + 1; // +1余量
  const domainCount = updateBothDomains ? 2 : 1;
  const totalEstimatedSubrequests = estimatedSubrequestsPerDomain * domainCount;
  
  if (maxSubrequests < totalEstimatedSubrequests) {
    await addSystemLog(env, `⚠️ DNS更新: 子请求不足(需${totalEstimatedSubrequests},剩${maxSubrequests})，跳过`);
    return { success: false, reason: 'insufficient_subrequests' };
  }
  
  try {
    // 使用传入的IP数量（定时任务模式下直接使用传入的dnsIPCount，不受UI限制）
    const ipCount = dnsIPCount;
    
    const countryDomains = dnsConfig?.countryDomains || {};
    const hasCountryDomains = Object.keys(countryDomains).length > 0;
    const hasRecordName = dnsConfig?.recordName;
    
    let results = [];
    let subrequestUsed = 0;
    
    // 如果同时设置了两种域名，先更新国家域名，再更新recordName
    if (hasCountryDomains) {
      // 多国家模式 - 轮询更新1个国家
      const countryKeys = Object.keys(countryDomains);
      const totalCountries = countryKeys.length;
      
      // 从KV获取上次更新的国家索引
      let lastCountryIndex = 0;
      try {
        const savedIndex = await env.KV.get('last_dns_country_index');
        if (savedIndex !== null) {
          lastCountryIndex = parseInt(savedIndex, 10) || 0;
        }
      } catch (e) {}
      
      // 计算本次要更新的国家索引
      const currentIndex = lastCountryIndex % totalCountries;
      const countryToUpdate = countryKeys[currentIndex];
      const domain = countryDomains[countryToUpdate];
      
      // 保存下一个国家索引
      try {
        await env.KV.put('last_dns_country_index', String((currentIndex + 1) % totalCountries));
      } catch (e) {}
      
      await addSystemLog(env, `🌍 DNS多国家更新(轮询模式): ${countryToUpdate} (${currentIndex + 1}/${totalCountries})`);
      
      // 检查剩余子请求
      if (subrequestUsed + 7 <= maxSubrequests) {
        // 直接从数据库获取最佳IP
        const bestIPs = await env.DB.prepare(`
          SELECT ip FROM high_quality_ips 
          WHERE country = ? OR country = 'unknown'
          ORDER BY bandwidth DESC, latency ASC 
          LIMIT ?
        `).bind(countryToUpdate, ipCount).all();
        
        const ips = (bestIPs.results || []).map(r => r.ip);
        
        if (ips.length > 0) {
          const result = await updateDNSBatchLimited(env, ips, 'cron', domain, maxSubrequests - subrequestUsed);
          results.push({ country: countryToUpdate, domain, ...result });
          subrequestUsed += result.subrequestCount || 0;
          await addSystemLog(env, `✅ ${countryToUpdate} DNS更新: ${result.count || 0} 个IP (${domain})`);
        }
      } else {
        await addSystemLog(env, `⚠️ DNS更新: 子请求即将耗尽，跳过国家域名更新`);
      }
    }
    
    // 如果同时设置了recordName，也更新它
    if (updateBothDomains && hasRecordName) {
      const domain = dnsConfig.recordName;
      await addSystemLog(env, `🌐 DNS主域名更新: ${domain}`);
      
      // 检查剩余子请求
      if (subrequestUsed + 7 <= maxSubrequests) {
        const bestIPs = await env.DB.prepare(`
          SELECT ip FROM high_quality_ips 
          ORDER BY bandwidth DESC, latency ASC 
          LIMIT ?
        `).bind(ipCount).all();
        
        const ips = (bestIPs.results || []).map(r => r.ip);
        
        if (ips.length > 0) {
          const result = await updateDNSBatchLimited(env, ips, 'cron', domain, maxSubrequests - subrequestUsed);
          results.push({ domain: domain, type: 'main', ...result });
          subrequestUsed += result.subrequestCount || 0;
          await addSystemLog(env, `✅ 主域名DNS更新: ${result.count || 0} 个IP (${domain})`);
        }
      } else {
        await addSystemLog(env, `⚠️ DNS更新: 子请求即将耗尽，跳过主域名更新`);
      }
    }
    
    // 如果没有国家域名，只有recordName
    if (!hasCountryDomains && hasRecordName) {
      // 单域名模式
      const domain = dnsConfig.recordName;
      
      // 检查剩余子请求
      if (subrequestUsed + 7 > maxSubrequests) {
        await addSystemLog(env, `⚠️ DNS更新: 子请求不足，跳过`);
        return { success: false, reason: 'insufficient_subrequests', subrequestCount: subrequestUsed };
      }
      
      const bestIPs = await env.DB.prepare(`
        SELECT ip FROM high_quality_ips 
        ORDER BY bandwidth DESC, latency ASC 
        LIMIT ?
      `).bind(ipCount).all();
      
      const ips = (bestIPs.results || []).map(r => r.ip);
      
      if (ips.length > 0) {
        const result = await updateDNSBatchLimited(env, ips, 'cron', domain, maxSubrequests - subrequestUsed);
        results.push({ domain, ...result });
        subrequestUsed += result.subrequestCount || 0;
        await addSystemLog(env, `✅ DNS更新: ${result.count || 0} 个IP (${domain})`);
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    return { 
      success: successCount > 0, 
      results, 
      successCount, 
      totalCount: results.length,
      subrequestCount: subrequestUsed
    };
    
  } catch (error) {
    await addSystemLog(env, `❌ DNS更新异常: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// 限制子请求版本的DNS批量更新
async function updateDNSBatchLimited(env, ips, triggerSource = 'manual', recordName = null, maxSubrequests = 10) {
  let subrequestCount = 0;
  
  try {
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    if (!dnsConfig || !dnsConfig.apiToken || !dnsConfig.zoneId) {
      return { success: false, error: 'DNS配置不完整', subrequestCount };
    }

    if (!ips || ips.length === 0) {
      return { success: false, error: '没有可用的IP地址', subrequestCount };
    }

    const targetRecordName = recordName || dnsConfig.recordName;
    if (!targetRecordName) {
      return { success: false, error: '域名未配置', subrequestCount };
    }

    // 使用传入的ips数组（调用者已控制长度）
    const url = `https://api.cloudflare.com/client/v4/zones/${dnsConfig.zoneId}/dns_records`;

    // 获取现有DNS记录列表 (1个子请求)
    if (subrequestCount + 1 > maxSubrequests) {
      return { success: false, error: '子请求不足', subrequestCount };
    }
    
    const listResp = await fetch(`${url}?type=A&name=${targetRecordName}`, {
      headers: { 'Authorization': `Bearer ${dnsConfig.apiToken}` }
    });
    subrequestCount++;
    const listData = await listResp.json();

    // 串行删除现有记录
    if (listData.success && listData.result.length > 0) {
      for (const record of listData.result) {
        if (subrequestCount + 1 > maxSubrequests) {
          await addSystemLog(env, `⚠️ DNS更新: 子请求不足，停止删除`);
          break;
        }
        
        try {
          await fetch(`${url}/${record.id}`, { 
            method: 'DELETE', 
            headers: { 'Authorization': `Bearer ${dnsConfig.apiToken}` } 
          });
          subrequestCount++;
          await new Promise(r => setTimeout(r, 100));
        } catch (e) {
          // 忽略删除错误
        }
      }
    }

    // 串行创建新记录
    let successCount = 0;
    for (const ip of ips) {
      if (subrequestCount + 1 > maxSubrequests) {
        await addSystemLog(env, `⚠️ DNS更新: 子请求不足，停止创建`);
        break;
      }
      
      try {
        const createResp = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${dnsConfig.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'A', name: targetRecordName, content: ip, ttl: 120, proxied: dnsConfig.proxied || false })
        });
        subrequestCount++;
        const result = await createResp.json();
        if (result.success) successCount++;
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        // 忽略创建错误
      }
    }

    if (successCount > 0) {
      await addSystemLog(env, `✅ DNS更新成功: ${successCount} 个IP (域名: ${targetRecordName}, 消耗子请求: ${subrequestCount})`);
    }
    
    return { success: successCount > 0, count: successCount, domain: targetRecordName, subrequestCount };
  } catch (e) {
    await addSystemLog(env, `❌ DNS更新失败: ${e.message}`);
    return { success: false, error: e.message, count: 0, subrequestCount };
  }
}

// 区域8: 定时任务

// Cron定时任务入口 - 单次执行模式，严格控制在50个子请求内
async function scheduled(event, env, ctx) {
  await addSystemLog(env, `⏰ Cron定时任务启动（严格限制50子请求）`);

  // 子请求计数器
  let subrequestCount = 0;
  const MAX_SUBREQUESTS = 50; // 使用完整50个子请求限制

  try {
    // 获取DNS配置，检查是否同时设置了域名记录和国家域名
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json') || {};
    const hasRecordName = dnsConfig?.recordName;
    const hasCountryDomains = dnsConfig?.countryDomains && Object.keys(dnsConfig.countryDomains).length > 0;
    const hasBothDomains = hasRecordName && hasCountryDomains;

    // 计算DNS更新次数和预算
    const DNSUpdatesCount = hasBothDomains ? 2 : 1;
    // DNS预算: 查询1 + 删除最多3 + 创建最多3 + 余量1 = 8个/域名（安全预算）
    const DNS_SUBREQUESTS_PER_DOMAIN = 8;
    const DNS_SUBREQUESTS = DNS_SUBREQUESTS_PER_DOMAIN * DNSUpdatesCount;
    const NOTIFICATION_SUBREQUESTS = 1;

    // 计算测速可用预算和最大IP数
    // 每个IP实际消耗2个子请求（延迟+带宽）
    const availableSubrequestsForTest = MAX_SUBREQUESTS - DNS_SUBREQUESTS - NOTIFICATION_SUBREQUESTS;
    const maxTestIPsBySubrequest = Math.floor(availableSubrequestsForTest / 2);
    // 上限: 单域名21个, 双域名16个（优化设置，配合DNS动态调整）
    const minTestIPs = hasBothDomains ? 8 : 10;
    const maxTestIPsLimit = hasBothDomains ? 16 : 21;
    const maxTestIPs = Math.max(minTestIPs, Math.min(maxTestIPsLimit, maxTestIPsBySubrequest));
    
    await addSystemLog(env, `📊 预算分配: 测速最多${maxTestIPs}个IP(预算${availableSubrequestsForTest}个子请求), DNS${DNSUpdatesCount}个域名(预留${DNS_SUBREQUESTS}个), 通知${NOTIFICATION_SUBREQUESTS}个`);
    if (hasBothDomains) {
      await addSystemLog(env, `📝 检测到同时设置域名记录和国家域名，将同时更新两者`);
    }
    
    // 步骤1: 执行测速（用实际子请求数控制）
    const testResult = await fullCronSpeedTestLimited(env, ctx, availableSubrequestsForTest, maxTestIPs);
    
    // 使用测速实际返回的子请求数
    subrequestCount += testResult.subrequestCount || 0;
    
    // 检查剩余子请求是否足够执行DNS更新
    const remainingSubrequests = MAX_SUBREQUESTS - subrequestCount;
    await addSystemLog(env, `📊 测速阶段实际消耗 ${testResult.subrequestCount || 0} 个子请求，累计 ${subrequestCount} 个，剩余 ${remainingSubrequests} 个`);
    
    // 动态调整：根据剩余子请求调整DNS IP数量
    let dnsIPCount = 3; // 默认3个IP
    if (remainingSubrequests < DNS_SUBREQUESTS + NOTIFICATION_SUBREQUESTS + 2) {
      // 如果剩余很少，减少到2个IP
      dnsIPCount = 2;
      await addSystemLog(env, `⚠️ 子请求紧张，DNS IP数量调整为 ${dnsIPCount} 个`);
    }
    if (remainingSubrequests < DNS_SUBREQUESTS + NOTIFICATION_SUBREQUESTS - 2) {
      // 如果非常紧张，减少到1个IP
      dnsIPCount = 1;
      await addSystemLog(env, `⚠️ 子请求非常紧张，DNS IP数量调整为 ${dnsIPCount} 个`);
    }
    
    if (remainingSubrequests < 7) {
      await addSystemLog(env, `⚠️ 子请求不足，跳过DNS更新阶段`);
    } else {
      // 步骤2: 延迟后执行DNS更新（限制子请求）
      await new Promise(r => setTimeout(r, 2000));
      const dnsResult = await optimizedDNSUpdateLimited(env, ctx, remainingSubrequests, dnsIPCount, hasBothDomains);
      
      // 更新子请求计数
      if (dnsResult.subrequestCount) {
        subrequestCount += dnsResult.subrequestCount;
      }
      
      // 步骤3: 发送Telegram通知（1个子请求：直接使用已读取的dnsConfig，避免重复读取KV）
      try {
        // 检查是否还有剩余子请求
        if (subrequestCount + 1 <= MAX_SUBREQUESTS) {
          // 使用统一的Telegram通知函数，传入已读取的dnsConfig避免额外子请求
          await sendTelegramNotification(env, {
            message: {
              ipCount: testResult.successCount,
              source: 'Cron定时任务',
              domain: dnsResult.results?.map(r => r.domain || r.country).join(', ') || '未配置',
              ips: testResult.testedIPs?.slice(0, 5),
              stats: testResult.stats
            },
            hideIP: false,
            type: dnsResult.success ? 'success' : 'warning',
            dnsConfig: dnsConfig  // 传入已读取的配置，避免重复读取KV
          });
          subrequestCount++;
        } else {
          await addSystemLog(env, `⚠️ 子请求不足，跳过Telegram通知`);
        }
      } catch (e) {
        // 通知失败不影响主流程
      }
    }
    
    // 记录最终子请求使用情况
    await addSystemLog(env, `📊 本次Cron任务共消耗 ${subrequestCount} 个子请求`);
    
    await addSystemLog(env, `✅ Cron定时任务全部完成`);
    
  } catch (error) {
    await addSystemLog(env, `❌ Cron定时任务异常: ${error.message}`);
  } finally {
    await LogManager.flush(env);
  }
}