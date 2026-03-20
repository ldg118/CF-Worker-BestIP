// Cloudflare Worker 优选IP可视化面板 - 最终版（优质池只保存≤90ms）
// 版本: v2.8.0
// 项目地址: https://github.com/ldg118/CF-Worker-BestIP
// 需要绑定的KV命名空间：KV
// 需要绑定的D1数据库：DB
// 需要在环境变量中设置：ADMIN_PASSWORD
// 环境变量：DEFAULT_IP_COUNT (1-10，默认3)
// 环境变量：DEFAULT_TEST_COUNT (1-1000，默认50)
// 环境变量：DEFAULT_THREAD_COUNT (1-50，默认10)
// 环境变量：FAILED_IP_COOLDOWN_DAYS (1-30，默认15)
// 环境变量：MAX_HIGH_QUALITY_POOL_SIZE (10-200，默认50)

const VERSION = 'v2.8.0';
const GITHUB_URL = 'https://github.com/ldg118/CF-Worker-BestIP';

const CONFIG = {
  sources: [
    'https://raw.githubusercontent.com/ldg118/CF-Worker-BestIP/refs/heads/main/cfv4'
  ],
  kvKeys: {
    ipList: 'ip_list',
    lastUpdate: 'last_update',
    dnsConfig: 'dns_config',
    sessions: 'sessions',
    customIPs: 'custom_ips',
    uiConfig: 'ui_config'
  }
};

// 优质IP分级阈值
const QUALITY_LEVELS = {
  FIVE_STAR: 30,   // ⭐⭐⭐⭐⭐ <=30ms
  FOUR_STAR: 60,   // ⭐⭐⭐⭐ <=60ms
  THREE_STAR: 90,  // ⭐⭐⭐ <=90ms
  TWO_STAR: 120,   // ⭐⭐ <=120ms
  ONE_STAR: 150    // ⭐ <=150ms
};

// 国家代码映射
const COUNTRY_NAMES = {
  'CN': '中国', 'US': '美国', 'JP': '日本', 'SG': '新加坡',
  'KR': '韩国', 'DE': '德国', 'GB': '英国', 'FR': '法国',
  'CA': '加拿大', 'AU': '澳大利亚', 'IN': '印度',
  'TW': '台湾', 'HK': '香港', 'MO': '澳门', 'unknown': '未知'
};

// ========== D1数据库初始化SQL ==========
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS speed_results (
  ip TEXT PRIMARY KEY,
  delay INTEGER NOT NULL,
  test_count INTEGER DEFAULT 1,
  last_tested TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS high_quality_ips (
  ip TEXT PRIMARY KEY,
  latency INTEGER NOT NULL,
  star_level TEXT NOT NULL,
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
`;

// ========== 工具函数 ==========
function isValidIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return false;
  }
  return true;
}

function isValidCIDR(cidr) {
  const parts = cidr.split('/');
  if (parts.length !== 2) return false;
  const ip = parts[0];
  const mask = parseInt(parts[1], 10);
  return isValidIPv4(ip) && !isNaN(mask) && mask >= 16 && mask <= 30;
}

function expandCIDR(cidr) {
  try {
    const [ip, mask] = cidr.split('/');
    const maskNum = parseInt(mask, 10);
    if (maskNum !== 24) return [];
    
    const parts = ip.split('.');
    if (parts.length !== 4) return [];
    
    const base = `${parts[0]}.${parts[1]}.${parts[2]}`;
    const ips = [];
    for (let i = 0; i <= 255; i++) {
      const newIp = `${base}.${i}`;
      const nums = newIp.split('.').map(Number);
      let valid = true;
      for (const num of nums) {
        if (isNaN(num) || num < 0 || num > 255) {
          valid = false;
          break;
        }
      }
      if (valid) ips.push(newIp);
    }
    return ips;
  } catch (e) {
    return [];
  }
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

function getSessionId(request) {
  const cookie = request.headers.get('Cookie');
  if (cookie) {
    const match = cookie.match(/sessionId=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

function getEnvConfig(env) {
  return {
    adminPassword: env.ADMIN_PASSWORD,
    defaultIpCount: env.DEFAULT_IP_COUNT ? parseInt(env.DEFAULT_IP_COUNT) : 3,
    defaultTestCount: env.DEFAULT_TEST_COUNT ? parseInt(env.DEFAULT_TEST_COUNT) : 50,
    defaultThreadCount: env.DEFAULT_THREAD_COUNT ? parseInt(env.DEFAULT_THREAD_COUNT) : 10,
    failedIpCooldownDays: env.FAILED_IP_COOLDOWN_DAYS ? parseInt(env.FAILED_IP_COOLDOWN_DAYS) : 15,
    maxHighQualityPoolSize: env.MAX_HIGH_QUALITY_POOL_SIZE ? parseInt(env.MAX_HIGH_QUALITY_POOL_SIZE) : 50
  };
}

function getStarLevel(latency) {
  if (latency <= QUALITY_LEVELS.FIVE_STAR) return '⭐⭐⭐⭐⭐';
  if (latency <= QUALITY_LEVELS.FOUR_STAR) return '⭐⭐⭐⭐';
  if (latency <= QUALITY_LEVELS.THREE_STAR) return '⭐⭐⭐';
  if (latency <= QUALITY_LEVELS.TWO_STAR) return '⭐⭐';
  if (latency <= QUALITY_LEVELS.ONE_STAR) return '⭐';
  return '';
}

// ========== 发送Telegram通知 ==========
async function sendTelegramNotification(env, message) {
  try {
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json') || {};
    
    if (!dnsConfig.telegramEnabled || !dnsConfig.telegramBotToken || !dnsConfig.telegramChatId) {
      return false;
    }
    
    const url = `https://api.telegram.org/bot${dnsConfig.telegramBotToken}/sendMessage`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: dnsConfig.telegramChatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    
    const result = await response.json();
    return result.ok;
  } catch (e) {
    console.error('发送Telegram通知失败:', e);
    return false;
  }
}

// ========== 验证会话 ==========
async function verifySession(sessionId, env) {
  if (!sessionId) return false;
  try {
    const sessions = await env.KV.get(CONFIG.kvKeys.sessions, 'json');
    return sessions && sessions[sessionId];
  } catch {
    return false;
  }
}

// ========== D1数据库初始化 ==========
async function initDatabase(env) {
  try {
    const statements = INIT_SQL.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        try {
          await env.DB.prepare(stmt).run();
        } catch (e) {
          console.log('执行语句失败:', e.message);
        }
      }
    }
    return true;
  } catch (e) {
    console.error('数据库初始化失败:', e);
    return false;
  }
}

// ========== 添加系统日志 ==========
async function addSystemLog(env, message) {
  try {
    const now = new Date();
    const timeStr = now.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    
    await env.DB.prepare(
      'INSERT INTO system_logs (time_str, message) VALUES (?, ?)'
    ).bind(timeStr, message).run();
  } catch (e) {
    console.error('添加日志失败:', e.message);
  }
}

// ========== 获取系统日志 ==========
async function getSystemLogs(env) {
  try {
    const result = await env.DB.prepare(
      'SELECT time_str, message FROM system_logs ORDER BY id DESC LIMIT 100'
    ).all();
    
    return (result.results || []).map(row => ({
      timeStr: row.time_str || new Date().toLocaleString(),
      message: row.message || ''
    }));
  } catch (e) {
    return [];
  }
}

// ========== 更新优质池 ==========
async function updateHighQualityPool(env, ip, latency) {
  const config = getEnvConfig(env);
  if (latency > QUALITY_LEVELS.THREE_STAR) return;
  
  const starLevel = getStarLevel(latency);
  
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO high_quality_ips (ip, latency, star_level, last_tested) 
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(ip, latency, starLevel).run();
    
    const countResult = await env.DB.prepare('SELECT COUNT(*) as count FROM high_quality_ips').first();
    const currentCount = countResult.count;
    
    if (currentCount > config.maxHighQualityPoolSize) {
      await env.DB.prepare(
        `DELETE FROM high_quality_ips 
         WHERE ip IN (SELECT ip FROM high_quality_ips ORDER BY latency DESC LIMIT ?)`
      ).bind(currentCount - config.maxHighQualityPoolSize).run();
    }
  } catch (e) {
    console.error('更新优质池失败:', e);
  }
}

// ========== 获取优质池 ==========
async function getHighQualityIPs(env) {
  try {
    const result = await env.DB.prepare(
      `SELECT ip, latency, star_level FROM high_quality_ips 
       WHERE latency <= ? ORDER BY latency ASC`
    ).bind(QUALITY_LEVELS.THREE_STAR).all();
    return result.results || [];
  } catch (e) {
    return [];
  }
}

// ========== 添加失败IP ==========
async function addFailedIP(env, ip) {
  try {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO failed_ips (ip, failed_at) VALUES (?, CURRENT_TIMESTAMP)'
    ).bind(ip).run();
    await env.DB.prepare('DELETE FROM high_quality_ips WHERE ip = ?').bind(ip).run();
  } catch (e) {
    console.error('添加失败IP失败:', e);
  }
}

// ========== 获取失败IP数量 ==========
async function getFailedIPCount(env) {
  try {
    const result = await env.DB.prepare('SELECT COUNT(*) as count FROM failed_ips').first();
    return result ? result.count : 0;
  } catch (e) {
    return 0;
  }
}

// ========== 获取总IP数量 ==========
async function getTotalIPCount(env) {
  try {
    const ips = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
    return ips.length;
  } catch (e) {
    return 0;
  }
}

// ========== 获取所有IP ==========
async function getAllIPs(env) {
  try {
    const ips = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
    const customIPs = await env.KV.get(CONFIG.kvKeys.customIPs, 'json') || [];
    return [...new Set([...ips, ...customIPs])];
  } catch (e) {
    return [];
  }
}

// ========== 保存测速结果 ==========
async function saveSpeedResult(env, ip, latency, testCount) {
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO speed_results (ip, delay, test_count, last_tested) 
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(ip, latency, testCount).run();
  } catch (e) {
    console.error('保存测速结果失败:', e);
  }
}

// ========== 更新IP列表 ==========
async function updateIPs(env) {
  let allIPs = new Set();
  
  for (const source of CONFIG.sources) {
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
        } else {
          if (isValidIPv4(item)) allIPs.add(item);
        }
      }
      
      await addSystemLog(env, `📡 从 ${source} 获取到 ${matches.length} 个CIDR，展开后 ${expandedCount} 个IP`);
    } catch (e) {
      await addSystemLog(env, `❌ 从 ${source} 获取失败`);
    }
  }

  const customIPs = await env.KV.get(CONFIG.kvKeys.customIPs, 'json') || [];
  for (const item of customIPs) {
    if (item.includes('/')) {
      const expanded = expandCIDR(item);
      expanded.forEach(ip => allIPs.add(ip));
    } else {
      allIPs.add(item);
    }
  }

  const ipList = Array.from(allIPs).sort(compareIPs);
  await env.KV.put(CONFIG.kvKeys.ipList, JSON.stringify(ipList));
  await env.KV.put(CONFIG.kvKeys.lastUpdate, new Date().toLocaleString('zh-CN'));
  
  await addSystemLog(env, `🔄 IP列表已更新: ${ipList.length} 个IP`);
  return ipList;
}

// ========== 测速 ==========
async function speedTest(env, ip) {
  try {
    let totalLatency = 0;
    let successCount = 0;
    
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
    }
    
    if (successCount === 0) {
      await addFailedIP(env, ip);
      await addSystemLog(env, `❌ ${ip} - 测速失败（加入黑名单）`);
      return { success: false, ip };
    }
    
    const avgLatency = Math.round(totalLatency / successCount);
    await saveSpeedResult(env, ip, avgLatency, successCount);
    await updateHighQualityPool(env, ip, avgLatency);
    const starLevel = getStarLevel(avgLatency);
    await addSystemLog(env, `✅ ${ip} - ${avgLatency}ms ${starLevel}`);
    return { success: true, ip, latency: avgLatency, starLevel };
  } catch (error) {
    await addSystemLog(env, `❌ ${ip} - 测速异常`);
    return { success: false, ip };
  }
}

// ========== DNS更新 ==========
async function updateDNSBatch(env, ips, triggerSource = 'manual') {
  try {
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    if (!dnsConfig || !dnsConfig.apiToken || !dnsConfig.zoneId || !dnsConfig.recordName) {
      return { success: false, error: 'DNS配置不完整' };
    }
    
    const url = `https://api.cloudflare.com/client/v4/zones/${dnsConfig.zoneId}/dns_records`;
    
    const listResp = await fetch(`${url}?type=A&name=${dnsConfig.recordName}`, {
      headers: { 'Authorization': `Bearer ${dnsConfig.apiToken}` }
    });
    const listData = await listResp.json();
    
    if (listData.success && listData.result.length > 0) {
      for (const record of listData.result) {
        await fetch(`${url}/${record.id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${dnsConfig.apiToken}` }
        });
      }
    }
    
    let successCount = 0;
    for (const ip of ips) {
      const createResp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${dnsConfig.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'A',
          name: dnsConfig.recordName,
          content: ip,
          ttl: 120,
          proxied: dnsConfig.proxied || false
        })
      });
      const result = await createResp.json();
      if (result.success) successCount++;
    }
    
    // 发送Telegram通知
    if (dnsConfig.telegramEnabled && successCount > 0) {
      const now = new Date();
      const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      
      let triggerText = '';
      switch(triggerSource) {
        case 'cron': triggerText = '⏰ 定时任务'; break;
        case 'speedtest': triggerText = '⚡ 测速完成'; break;
        default: triggerText = '👤 手动操作';
      }
      
      // 获取更新IP的详细信息（延迟）
      const highQualityIPs = await getHighQualityIPs(env);
      const ipInfoMap = new Map();
      highQualityIPs.forEach(item => {
        ipInfoMap.set(item.ip, { latency: item.latency });
      });
      
      let message = `<b>🔔 DNS记录已更新</b>\n\n`;
      message += `📅 时间：${timeStr}\n`;
      message += `📌 域名：${dnsConfig.recordName}\n`;
      message += `🔄 触发：${triggerText}\n`;
      message += `📊 更新数量：${successCount} 个IP\n\n`;
      
      message += `<b>✨ 更新IP列表：</b>\n`;
      ips.forEach((ip, idx) => {
        const ipInfo = ipInfoMap.get(ip);
        const latency = ipInfo ? `${ipInfo.latency}ms` : '未知';
        
        // 根据设置决定是否隐藏IP
        let displayIp = ip;
        if (dnsConfig.telegramHideIP) {
          const ipParts = ip.split('.');
          displayIp = `${ipParts[0]}.${ipParts[1]}.***.***`;
        }
        
        message += `${idx + 1}. ${displayIp} - ${latency}\n`;
      });
      
      await sendTelegramNotification(env, message);
    }
    
    return { success: successCount > 0, count: successCount };
  } catch (e) {
    return { success: false, error: e.message, count: 0 };
  }
}

// ========== 获取最优IP列表 ==========
async function getBestIPs(env, count) {
  const highQualityIPs = await getHighQualityIPs(env);
  return highQualityIPs.slice(0, count).map(item => item.ip);
}

// ========== 检查优质池是否需要补充 ==========
async function checkAndRefillHighQualityPool(env) {
  try {
    const countResult = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM high_quality_ips WHERE latency <= ?'
    ).bind(QUALITY_LEVELS.THREE_STAR).first();
    const currentCount = countResult.count;
    
    if (currentCount < 30) {
      await addSystemLog(env, `🔍 优质池数量不足 (${currentCount}/30)，开始补充`);
      const allIPs = await getAllIPs(env);
      const existingResult = await env.DB.prepare('SELECT ip FROM high_quality_ips').all();
      const existingSet = new Set(existingResult.results.map(row => row.ip));
      const untestedIPs = allIPs.filter(ip => !existingSet.has(ip));
      const ipsToTest = untestedIPs.sort(() => 0.5 - Math.random()).slice(0, 50);
      
      if (ipsToTest.length > 0) {
        await addSystemLog(env, `📊 开始补充测速 ${ipsToTest.length} 个IP`);
        for (const ip of ipsToTest) {
          await speedTest(env, ip);
        }
        const newCountResult = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM high_quality_ips WHERE latency <= ?'
        ).bind(QUALITY_LEVELS.THREE_STAR).first();
        await addSystemLog(env, `✅ 补充测速完成，优质池现有 ${newCountResult.count} 个IP`);
      }
    }
  } catch (e) {
    console.error('检查优质池失败:', e);
  }
}

// ========== 处理登录 ==========
async function handleLogin(request, env) {
  try {
    const { password } = await request.json();
    const config = getEnvConfig(env);
    
    if (!config.adminPassword) {
      return new Response(JSON.stringify({ success: false, error: '管理员密码未配置' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (password === config.adminPassword) {
      const sessionId = generateSessionId();
      const sessions = await env.KV.get(CONFIG.kvKeys.sessions, 'json') || {};
      sessions[sessionId] = { createdAt: Date.now() };
      await env.KV.put(CONFIG.kvKeys.sessions, JSON.stringify(sessions));
      await addSystemLog(env, '🔐 管理员登录成功');
      return new Response(JSON.stringify({ success: true, sessionId }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      return new Response(JSON.stringify({ success: false, error: '密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ========== 处理登出 ==========
async function handleLogout(request, env) {
  const sessionId = getSessionId(request);
  if (sessionId) {
    const sessions = await env.KV.get(CONFIG.kvKeys.sessions, 'json') || {};
    delete sessions[sessionId];
    await env.KV.put(CONFIG.kvKeys.sessions, JSON.stringify(sessions));
    await addSystemLog(env, '🔓 管理员登出');
  }
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ========== 处理访客信息 ==========
async function handleVisitorInfo(request) {
  const clientIP = request.headers.get('CF-Connecting-IP') || '未知';
  const country = request.headers.get('CF-IPCountry') || 'unknown';
  const countryName = COUNTRY_NAMES[country] || country;
  return new Response(JSON.stringify({ clientIP, country, countryName }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ========== 数据库状态检查 ==========
async function handleDBStatus(env) {
  try {
    await env.DB.prepare("SELECT 1").run();
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const counts = {};
    for (const table of ['speed_results', 'high_quality_ips', 'failed_ips', 'system_logs']) {
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

// ========== 手动初始化数据库 ==========
async function handleManualInit(env) {
  const success = await initDatabase(env);
  const status = await handleDBStatus(env);
  await addSystemLog(env, '🗄️ 数据库手动初始化完成');
  return { success, ...status };
}

// ========== 调试接口 ==========
async function handleDebug(env) {
  const debug = {
    hasDB: !!env.DB,
    hasKV: !!env.KV,
    envKeys: Object.keys(env).filter(k => !k.startsWith('_')),
    timestamp: new Date().toLocaleString('zh-CN'),
    version: VERSION,
    github: GITHUB_URL
  };
  if (env.DB) {
    try {
      await env.DB.prepare("SELECT 1").run();
      debug.dbConnection = 'ok';
      const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      debug.tables = tables.results.map(t => t.name);
    } catch (e) {
      debug.dbConnection = 'failed: ' + e.message;
    }
  }
  return debug;
}

// ========== 主逻辑 ==========
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const config = getEnvConfig(env);

    ctx.waitUntil(initDatabase(env).catch(() => {}));

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (path === '/debug') {
      const debug = await handleDebug(env);
      return new Response(JSON.stringify(debug, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/login') {
      return new Response(getLoginHTML(), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    if (path === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    if (path === '/api/check-auth') {
      const sessionId = getSessionId(request);
      const isValid = await verifySession(sessionId, env);
      return new Response(JSON.stringify({ 
        authenticated: isValid, 
        hasAdminPassword: !!config.adminPassword 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/api/visitor-info') {
      return handleVisitorInfo(request);
    }

    if (path === '/api/db-status') {
      const status = await handleDBStatus(env);
      return new Response(JSON.stringify(status), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const sessionId = getSessionId(request);
    if (!await verifySession(sessionId, env)) {
      if (path.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: '未授权' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return Response.redirect(`${url.origin}/login`, 302);
    }

    if (path === '/') {
      return new Response(getMainHTML(env), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    if (path === '/api/logout' && request.method === 'POST') {
      return handleLogout(request, env);
    }

    if (path === '/api/init-db' && request.method === 'POST') {
      const result = await handleManualInit(env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/api/get-logs') {
      const logs = await getSystemLogs(env);
      return new Response(JSON.stringify({ logs }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/api/clear-logs' && request.method === 'POST') {
      try {
        await env.DB.exec('DELETE FROM system_logs');
        await addSystemLog(env, '📋 日志已被手动清除');
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (path === '/api/ips') {
      try {
        const [totalCount, highQualityIPs, lastUpdate, failedCount, customIPs, allIPs] = await Promise.all([
          getTotalIPCount(env).catch(() => 0),
          getHighQualityIPs(env).catch(() => []),
          env.KV.get(CONFIG.kvKeys.lastUpdate).catch(() => '--'),
          getFailedIPCount(env).catch(() => 0),
          env.KV.get(CONFIG.kvKeys.customIPs, 'json').catch(() => []),
          getAllIPs(env).catch(() => [])
        ]);
        
        return new Response(JSON.stringify({ 
          totalCount: totalCount || 0,
          highQualityIPs: highQualityIPs || [], 
          lastUpdate: lastUpdate || '--', 
          failedCount: failedCount || 0,
          customIPs: customIPs || [],
          allIPs: allIPs || []
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ 
          totalCount: 0,
          highQualityIPs: [], 
          lastUpdate: '--', 
          failedCount: 0,
          customIPs: [],
          allIPs: []
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (path === '/api/get-ui-config') {
      const savedConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
      return new Response(JSON.stringify({
        ipCount: savedConfig.ipCount || config.defaultIpCount,
        testCount: savedConfig.testCount || config.defaultTestCount,
        threadCount: savedConfig.threadCount || config.defaultThreadCount
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/api/save-ui-config' && request.method === 'POST') {
      const { ipCount, testCount, threadCount } = await request.json();
      const validIpCount = Math.min(10, Math.max(1, parseInt(ipCount) || config.defaultIpCount));
      const validTestCount = Math.min(1000, Math.max(1, parseInt(testCount) || config.defaultTestCount));
      const validThreadCount = Math.min(50, Math.max(1, parseInt(threadCount) || config.defaultThreadCount));
      
      const uiConfig = { ipCount: validIpCount, testCount: validTestCount, threadCount: validThreadCount };
      await env.KV.put(CONFIG.kvKeys.uiConfig, JSON.stringify(uiConfig));
      await addSystemLog(env, `⚙️ 参数已保存: IP数量=${validIpCount}, 测速数量=${validTestCount}, 线程数=${validThreadCount}`);
      return new Response(JSON.stringify({ success: true, config: uiConfig }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/api/get-config') {
      const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json') || {
        apiToken: '', zoneId: '', recordName: '', proxied: true, autoUpdate: false,
        autoUpdateAfterTest: false, telegramEnabled: false, telegramBotToken: '', telegramChatId: '',
        telegramHideIP: true
      };
      return new Response(JSON.stringify(dnsConfig), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/api/save-config' && request.method === 'POST') {
      const dnsConfig = await request.json();
      await env.KV.put(CONFIG.kvKeys.dnsConfig, JSON.stringify(dnsConfig));
      await addSystemLog(env, '🔐 DNS配置已保存');
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/api/save-custom-ips' && request.method === 'POST') {
      const { ips } = await request.json();
      const validIPs = [];
      const expandedIPs = [];
      
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
        await addSystemLog(env, `📥 自定义IP已保存: ${validIPs.length} 个CIDR, 展开后 ${expandedIPs.length} 个IP`);
      }
      return new Response(JSON.stringify({ success: true, expandedCount: expandedIPs.length, validCount: validIPs.length }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/api/clear-custom-ips' && request.method === 'POST') {
      await env.KV.put(CONFIG.kvKeys.customIPs, JSON.stringify([]));
      await addSystemLog(env, '🗑️ 所有自定义IP已清除');
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/api/update') {
      ctx.waitUntil(updateIPs(env));
      await addSystemLog(env, '🔄 手动触发IP列表更新');
      return new Response(JSON.stringify({ status: '更新任务已启动' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/api/speedtest' && request.method === 'GET') {
      const ip = url.searchParams.get('ip');
      if (!ip) return new Response(JSON.stringify({ error: '缺少IP参数' }), { status: 400 });
      const result = await speedTest(env, ip);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/api/update-dns' && request.method === 'POST') {
      const { ips, triggerSource } = await request.json();
      let targetIPs = ips;
      
      if (!targetIPs) {
        const uiConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
        const ipCount = uiConfig.ipCount || config.defaultIpCount;
        targetIPs = await getBestIPs(env, ipCount);
      }
      
      if (!targetIPs || targetIPs.length === 0) {
        return new Response(JSON.stringify({ error: '无可用IP' }), { status: 400 });
      }
      
      const result = await updateDNSBatch(env, targetIPs, triggerSource || 'manual');
      if (result.success) {
        await addSystemLog(env, `✅ DNS更新成功: ${result.count} 个IP`);
      } else {
        await addSystemLog(env, `❌ DNS更新失败: ${result.error || '未知错误'}`);
      }
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    await initDatabase(env);
    await addSystemLog(env, '⏰ Cron定时任务启动');
    await updateIPs(env);
    await checkAndRefillHighQualityPool(env);
    
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    if (dnsConfig?.autoUpdate) {
      const config = getEnvConfig(env);
      const uiConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
      const ipCount = uiConfig.ipCount || config.defaultIpCount;
      const bestIPs = await getBestIPs(env, ipCount);
      
      if (bestIPs.length > 0) {
        const result = await updateDNSBatch(env, bestIPs, 'cron');
        if (result.success) {
          await addSystemLog(env, `✅ Cron自动更新DNS成功: ${result.count} 个IP`);
        }
      }
    }
    await addSystemLog(env, '✅ Cron定时任务完成');
  }
};

// ========== 登录页面 ==========
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
      background: #0f172a;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-box {
      background: #1e293b;
      padding: 40px;
      border-radius: 16px;
      width: 100%;
      max-width: 360px;
      box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);
      border: 1px solid #334155;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      background: linear-gradient(135deg, #60a5fa, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 24px;
      text-align: center;
    }
    .input-group { margin-bottom: 20px; }
    label {
      display: block;
      font-size: 14px;
      color: #94a3b8;
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      padding: 10px 12px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #f1f5f9;
      font-size: 14px;
    }
    input:focus {
      outline: none;
      border-color: #60a5fa;
    }
    button {
      width: 100%;
      padding: 10px;
      background: #2563eb;
      border: none;
      border-radius: 8px;
      color: white;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: 0.2s;
    }
    button:hover { background: #1d4ed8; }
    .error {
      background: #991b1b;
      color: #fecaca;
      padding: 10px;
      border-radius: 6px;
      margin-top: 16px;
      font-size: 13px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>🔐 管理员登录</h1>
    <div class="input-group">
      <label>密码</label>
      <input type="password" id="password" placeholder="输入管理员密码">
    </div>
    <button onclick="login()" id="loginBtn">登录</button>
    <div class="error" id="error"></div>
  </div>
  <script>
    async function login() {
      const password = document.getElementById('password').value;
      const btn = document.getElementById('loginBtn');
      if (!password) return showError('请输入密码');
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
          document.cookie = \`sessionId=\${data.sessionId}; path=/; max-age=86400\`;
          window.location.href = '/';
        } else {
          showError(data.error || '登录失败');
        }
      } catch {
        showError('网络错误');
      } finally {
        btn.disabled = false;
        btn.textContent = '登录';
      }
    }
    function showError(msg) {
      const el = document.getElementById('error');
      el.textContent = msg;
      el.style.display = 'block';
    }
  </script>
</body>
</html>`;
}

// ========== 主页面 ==========
function getMainHTML(env) {
  const config = {
    defaultIpCount: env.DEFAULT_IP_COUNT ? parseInt(env.DEFAULT_IP_COUNT) : 3,
    defaultTestCount: env.DEFAULT_TEST_COUNT ? parseInt(env.DEFAULT_TEST_COUNT) : 50,
    defaultThreadCount: env.DEFAULT_THREAD_COUNT ? parseInt(env.DEFAULT_THREAD_COUNT) : 10
  };
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CF优选IP · 智能优选</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      background: linear-gradient(135deg, #60a5fa, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .header-right {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .github-btn {
      background: #1e293b;
      color: #94a3b8;
      text-decoration: none;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 13px;
      border: 1px solid #334155;
      transition: 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .github-btn:hover {
      color: #60a5fa;
      border-color: #60a5fa;
      background: #0f172a;
    }
    .visitor-info {
      background: #1e293b;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 13px;
      border: 1px solid #334155;
      color: #94a3b8;
    }
    .badge {
      background: #1e293b;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 13px;
      color: #94a3b8;
      border: 1px solid #334155;
    }
    .logout-btn {
      background: #4b5563;
      color: white;
      border: none;
      border-radius: 20px;
      padding: 6px 16px;
      font-size: 13px;
      cursor: pointer;
      transition: 0.2s;
    }
    .logout-btn:hover {
      background: #6b7280;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 20px;
    }
    .card {
      background: #1e293b;
      border-radius: 12px;
      border: 1px solid #334155;
      overflow: hidden;
    }
    .card-header {
      padding: 16px 20px;
      border-bottom: 1px solid #334155;
      background: #0f172a;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card-header h2 { font-size: 16px; font-weight: 500; color: #f1f5f9; }
    .card-body { padding: 20px; }
    
    .stats-row {
      display: flex;
      gap: 16px;
      margin-bottom: 20px;
    }
    .stat-card {
      flex: 1;
      background: #0f172a;
      padding: 16px;
      border-radius: 8px;
      text-align: center;
    }
    .stat-label {
      font-size: 12px;
      color: #94a3b8;
      margin-bottom: 4px;
    }
    .stat-value {
      font-size: 28px;
      font-weight: 600;
      color: #60a5fa;
    }
    
    .search-box {
      width: 100%;
      padding: 10px 12px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #f1f5f9;
      font-size: 14px;
      margin-bottom: 16px;
    }
    
    .table-container {
      max-height: 300px;
      overflow-y: auto;
      border: 1px solid #334155;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      background: #0f172a;
      padding: 10px 12px;
      text-align: left;
      font-weight: 500;
      color: #94a3b8;
      position: sticky;
      top: 0;
    }
    td {
      padding: 8px 12px;
      border-bottom: 1px solid #334155;
    }
    .ip-cell {
      font-family: monospace;
      color: #60a5fa;
    }
    .delay-good { color: #4ade80; }
    
    .custom-ip-section {
      background: #0f172a;
      border-radius: 8px;
      padding: 16px;
      margin-top: 20px;
    }
    .custom-ip-title {
      color: #60a5fa;
      font-size: 14px;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .custom-ip-textarea {
      width: 100%;
      padding: 12px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #f1f5f9;
      font-size: 13px;
      font-family: monospace;
      min-height: 80px;
      resize: vertical;
      margin-bottom: 12px;
    }
    .custom-ip-actions {
      display: flex;
      gap: 8px;
    }
    
    .btn {
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: 0.2s;
    }
    .btn-sm {
      padding: 4px 12px;
      font-size: 12px;
    }
    .btn-primary { background: #2563eb; color: white; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-secondary { background: #4b5563; color: white; }
    .btn-secondary:hover { background: #6b7280; }
    .btn-success { background: #059669; color: white; }
    .btn-success:hover { background: #047857; }
    .btn-warning { background: #d97706; color: white; }
    .btn-warning:hover { background: #b45309; }
    .btn-danger { background: #b91c1c; color: white; }
    .btn-danger:hover { background: #991b1b; }
    
    .form-group { margin-bottom: 16px; }
    .form-group label {
      display: block;
      font-size: 13px;
      color: #94a3b8;
      margin-bottom: 4px;
    }
    .form-group input, .form-group select {
      width: 100%;
      padding: 10px 12px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #f1f5f9;
      font-size: 14px;
    }
    .form-group input[type="password"] {
      font-family: monospace;
      letter-spacing: 2px;
    }
    
    .checkbox {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    
    .log-panel {
      background: #0f172a;
      border-radius: 8px;
      padding: 12px;
      font-family: monospace;
      font-size: 12px;
      height: 200px;
      overflow-y: auto;
      border: 1px solid #334155;
      margin: 16px 0;
    }
    .log-entry {
      color: #94a3b8;
      margin-bottom: 6px;
      border-bottom: 1px solid #1e293b;
      padding-bottom: 4px;
    }
    .log-time {
      color: #60a5fa;
      margin-right: 8px;
    }
    
    .progress-bar {
      height: 4px;
      background: #334155;
      border-radius: 2px;
      margin: 12px 0;
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
      margin: 8px 0;
      display: none;
    }
    .params-row {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }
    .param-item { flex: 1; }
    .param-item label {
      display: block;
      font-size: 13px;
      color: #94a3b8;
      margin-bottom: 4px;
    }
    .param-input {
      width: 100%;
      padding: 10px 12px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #f1f5f9;
      font-size: 14px;
    }
    .button-group {
      display: flex;
      gap: 8px;
      margin: 12px 0;
    }
    .full-width { width: 100%; }
    hr {
      border: none;
      border-top: 1px solid #334155;
      margin: 20px 0;
    }
    
    .db-status-card {
      background: #0f172a;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
      border-left: 4px solid #60a5fa;
    }
    .db-status-card.ok { border-left-color: #4ade80; }
    .db-status-card.error { border-left-color: #f87171; }
    .db-status-title {
      font-size: 13px;
      color: #94a3b8;
      margin-bottom: 8px;
    }
    .db-status-content {
      font-size: 13px;
      color: #f1f5f9;
      line-height: 1.5;
    }
    
    .auto-refresh-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #94a3b8;
    }
    .version-text {
      font-size: 10px;
      color: #4b5563;
      margin-left: 4px;
    }
    .telegram-section {
      background: #0f172a;
      border-radius: 8px;
      padding: 16px;
      margin: 16px 0;
      border: 1px solid #334155;
    }
    .telegram-title {
      color: #60a5fa;
      font-size: 14px;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🌩️ CF优选IP · 智能优选</h1>
      <div class="header-right">
        <a href="${GITHUB_URL}" target="_blank" class="github-btn">⭐ GitHub</a>
        <span class="visitor-info" id="visitorInfo">加载中...</span>
        <span class="badge" id="lastUpdateBadge">加载中...</span>
        <button class="logout-btn" onclick="logout()">登出</button>
      </div>
    </div>

    <div class="grid">
      <!-- 左侧 -->
      <div>
        <div class="card">
          <div class="card-header">
            <h2>📋 优质IP列表 (≤90ms) <span class="version-text">${VERSION}</span></h2>
            <div>
              <button class="btn btn-sm btn-primary" onclick="manualUpdate()">刷新IP列表</button>
              <button class="btn btn-sm btn-warning" onclick="startSpeedTest()" id="speedTestBtn">开始测速</button>
              <button class="btn btn-sm btn-success" onclick="exportHighQualityIPs()">导出优质IP</button>
            </div>
          </div>
          <div class="card-body">
            <div class="stats-row">
              <div class="stat-card">
                <div class="stat-label">总IP池</div>
                <div class="stat-value" id="totalCount">0</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">优质池</div>
                <div class="stat-value" id="highQualityCount">0</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">失败池</div>
                <div class="stat-value" id="failedCount">0</div>
              </div>
            </div>

            <div class="progress-bar" id="speedProgress">
              <div class="progress-bar-fill" id="speedProgressFill"></div>
            </div>
            <div class="speed-status" id="speedStatus"></div>

            <input type="text" class="search-box" id="search" placeholder="🔍 搜索优质IP...">

            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th>IP地址</th>
                    <th>延迟</th>
                    <th>星级</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="ipTable">
                  <tr><td colspan="4" style="text-align: center; padding: 30px;">暂无优质IP，请点击"开始测速"</td></tr>
                </tbody>
              </table>
            </div>

            <div class="custom-ip-section">
              <div class="custom-ip-title">
                <span>📥 自定义IP/CIDR</span>
                <span style="color: #94a3b8; font-size: 12px;">每行一个 (支持/24网段)</span>
              </div>
              <textarea class="custom-ip-textarea" id="customIPs" placeholder="例如：&#10;1.1.1.1&#10;162.159.38.0/24"></textarea>
              <div class="custom-ip-actions">
                <button class="btn btn-sm btn-success" style="flex: 1;" onclick="saveCustomIPs()">保存</button>
                <button class="btn btn-sm btn-danger" style="flex: 1;" onclick="clearCustomIPs()">清除</button>
              </div>
            </div>
          </div>
        </div>

        <div class="card" style="margin-top: 20px;">
          <div class="card-header">
            <h2>📝 运行日志</h2>
            <div style="display: flex; gap: 8px; align-items: center;">
              <div class="auto-refresh-toggle">
                <input type="checkbox" id="autoRefreshLogs" checked onchange="toggleAutoRefresh()">
                <label for="autoRefreshLogs">自动刷新</label>
              </div>
              <button class="btn btn-sm btn-danger" onclick="clearLogs()">清除</button>
              <button class="btn btn-sm btn-primary" onclick="refreshLogs()">刷新</button>
            </div>
          </div>
          <div class="card-body">
            <div class="log-panel" id="logPanel">
              <div class="log-entry"><span class="log-time">[系统]</span> 面板已初始化</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧 -->
      <div class="card">
        <div class="card-header">
          <h2>⚙️ 配置面板</h2>
        </div>
        <div class="card-body">
          <div class="db-status-card" id="dbStatusCard" style="display: none;">
            <div class="db-status-title">🗄️ 数据库状态</div>
            <div class="db-status-content" id="dbStatusContent"></div>
          </div>

          <div style="background: #0f172a; padding: 16px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="color: #60a5fa; font-size: 14px; margin-bottom: 12px;">🗄️ 数据库管理</h3>
            <button class="btn btn-success full-width" onclick="initDatabase()" id="initDbBtn">手动初始化数据库</button>
            <button class="btn btn-primary full-width" style="margin-top: 8px;" onclick="checkDBStatus()">检查数据库状态</button>
          </div>

          <div style="background: #0f172a; padding: 16px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="color: #60a5fa; font-size: 14px; margin-bottom: 12px;">🔧 运行参数</h3>
            
            <div class="params-row">
              <div class="param-item">
                <label>IP数量 <span style="color: #94a3b8;">(1-10)</span></label>
                <input type="number" class="param-input" id="ipCount" min="1" max="10" value="${config.defaultIpCount}">
              </div>
              
              <div class="param-item">
                <label>测速数量 <span style="color: #94a3b8;">(1-1000)</span></label>
                <input type="number" class="param-input" id="testCount" min="1" max="1000" value="${config.defaultTestCount}">
              </div>
              
              <div class="param-item">
                <label>线程数 <span style="color: #94a3b8;">(1-50)</span></label>
                <input type="number" class="param-input" id="threadCount" min="1" max="50" value="${config.defaultThreadCount}">
              </div>
            </div>
            
            <div style="font-size: 12px; color: #94a3b8; margin-top: 8px; text-align: center;">
              ⭐ 优质IP标准: ≤90ms (⭐⭐⭐及以上)
            </div>
            
            <button class="btn btn-primary full-width" style="margin-top: 12px;" onclick="saveUIConfig()">保存参数</button>
          </div>

          <h3 style="color: #60a5fa; font-size: 14px; margin-bottom: 12px;">📌 DNS配置</h3>
          <div class="form-group">
            <label>API Token</label>
            <input type="password" id="apiToken" placeholder="********">
          </div>
          <div class="form-group">
            <label>Zone ID</label>
            <input type="password" id="zoneId" placeholder="********">
          </div>
          <div class="form-group">
            <label>域名</label>
            <input type="text" id="recordName" placeholder="cf.yourdomain.com">
          </div>
          
          <div class="form-group">
            <label>代理状态</label>
            <select id="proxied">
              <option value="true">开启代理 (橙色云)</option>
              <option value="false">仅DNS (灰色云)</option>
            </select>
          </div>
          
          <div class="checkbox">
            <input type="checkbox" id="autoUpdate">
            <label>每小时自动更新DNS</label>
          </div>
          
          <div class="checkbox">
            <input type="checkbox" id="autoUpdateDNSAfterTest">
            <label>测速完成后自动更新DNS</label>
          </div>

          <!-- Telegram 通知配置 -->
          <div class="telegram-section">
            <div class="telegram-title">
              <span>📱 Telegram 通知</span>
            </div>
            <div class="checkbox">
              <input type="checkbox" id="telegramEnabled">
              <label>启用Telegram通知</label>
            </div>
            <div class="form-group">
              <label>Bot Token</label>
              <input type="password" id="telegramBotToken" placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz">
            </div>
            <div class="form-group">
              <label>Chat ID</label>
              <input type="password" id="telegramChatId" placeholder="123456789">
            </div>
            <div class="checkbox">
              <input type="checkbox" id="telegramHideIP" checked>
              <label>隐藏IP后两位 (显示为 ***.***)</label>
            </div>
            <div style="font-size: 12px; color: #94a3b8; margin-top: 8px;">
              💡 取消勾选将显示完整IP地址
            </div>
          </div>

          <div class="button-group">
            <button class="btn btn-success" style="flex: 1;" onclick="saveConfig()">保存DNS</button>
            <button class="btn btn-primary" style="flex: 1;" onclick="updateDNSWithBest()">立即更新</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let highQualityIPs = [];
    let allIPs = [];
    let uiConfig = {
      ipCount: ${config.defaultIpCount},
      testCount: ${config.defaultTestCount},
      threadCount: ${config.defaultThreadCount}
    };
    let autoRefreshInterval = null;
    let isSpeedTesting = false;
    let activeThreads = 0;
    let totalTested = 0;
    let totalToTest = 0;
    let testQueue = [];

    window.onload = async () => {
      if (await checkAuth()) {
        await Promise.all([
          loadVisitorInfo().catch(() => {}),
          loadUIConfig().catch(() => {}),
          loadConfig().catch(() => {}),
          loadIPs().catch(() => {}),
          loadLogs().catch(() => {}),
          checkDBStatus().catch(() => {})
        ]);
        startAutoRefresh();
      }
    };

    async function checkAuth() {
      try {
        const res = await fetch('/api/check-auth');
        const data = await res.json();
        if (!data.authenticated) {
          window.location.href = '/login';
          return false;
        }
        return true;
      } catch {
        window.location.href = '/login';
        return false;
      }
    }

    async function logout() {
      await fetch('/api/logout', { method: 'POST' });
      document.cookie = 'sessionId=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      window.location.href = '/login';
    }

    async function loadVisitorInfo() {
      try {
        const res = await fetch('/api/visitor-info');
        const data = await res.json();
        document.getElementById('visitorInfo').innerHTML = 
          \`当前访问IP: \${data.clientIP} | \${data.countryName}\`;
      } catch (e) {
        document.getElementById('visitorInfo').innerHTML = '无法获取访客信息';
      }
    }

    async function loadLogs() {
      try {
        const res = await fetch('/api/get-logs');
        const data = await res.json();
        const panel = document.getElementById('logPanel');
        if (data.logs && data.logs.length) {
          panel.innerHTML = data.logs.map(log => {
            return \`<div class="log-entry"><span class="log-time">[\${log.timeStr}]</span> \${log.message}</div>\`;
          }).join('');
        } else {
          panel.innerHTML = '<div class="log-entry">暂无日志</div>';
        }
      } catch (e) {
        console.error('加载日志失败:', e);
        document.getElementById('logPanel').innerHTML = '<div class="log-entry">加载日志失败</div>';
      }
    }

    async function clearLogs() {
      if (!confirm('清除所有日志？')) return;
      await fetch('/api/clear-logs', { method: 'POST' });
      await loadLogs();
    }

    async function refreshLogs() {
      await loadLogs();
    }

    function toggleAutoRefresh() {
      if (document.getElementById('autoRefreshLogs').checked) {
        startAutoRefresh();
      } else {
        if (autoRefreshInterval) {
          clearInterval(autoRefreshInterval);
          autoRefreshInterval = null;
        }
      }
    }

    function startAutoRefresh() {
      if (autoRefreshInterval) clearInterval(autoRefreshInterval);
      autoRefreshInterval = setInterval(() => {
        if (document.getElementById('autoRefreshLogs').checked) {
          loadLogs();
        }
      }, 3000);
    }

    async function checkDBStatus() {
      try {
        const res = await fetch('/api/db-status');
        const data = await res.json();
        const card = document.getElementById('dbStatusCard');
        const content = document.getElementById('dbStatusContent');
        
        if (data.connected) {
          card.className = 'db-status-card ok';
          content.innerHTML = \`✅ 数据库连接正常 | 优质池: \${data.counts?.high_quality_ips || 0}个IP\`;
        } else {
          card.className = 'db-status-card error';
          content.innerHTML = '❌ 数据库连接失败，请点击"手动初始化数据库"';
        }
        card.style.display = 'block';
      } catch (e) {
        console.error('检查数据库状态失败:', e);
      }
    }

    async function initDatabase() {
      const btn = document.getElementById('initDbBtn');
      btn.disabled = true;
      btn.textContent = '初始化中...';
      
      try {
        await fetch('/api/init-db', { method: 'POST' });
        await checkDBStatus();
        await loadLogs();
        alert('数据库初始化成功！');
      } catch (e) {
        console.error('初始化失败:', e);
        alert('初始化失败：' + e.message);
      }
      
      btn.disabled = false;
      btn.textContent = '手动初始化数据库';
    }

    async function loadUIConfig() {
      try {
        const res = await fetch('/api/get-ui-config');
        const data = await res.json();
        uiConfig = data;
        document.getElementById('ipCount').value = data.ipCount;
        document.getElementById('testCount').value = data.testCount;
        document.getElementById('threadCount').value = data.threadCount;
      } catch (e) {
        console.error('加载配置失败:', e);
      }
    }

    async function saveUIConfig() {
      const ipCount = parseInt(document.getElementById('ipCount').value) || 3;
      const testCount = parseInt(document.getElementById('testCount').value) || 50;
      const threadCount = parseInt(document.getElementById('threadCount').value) || 10;
      
      await fetch('/api/save-ui-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ipCount, testCount, threadCount })
      });
      
      uiConfig = { ipCount, testCount, threadCount };
      await loadLogs();
      alert('参数保存成功！');
    }

    async function loadConfig() {
      try {
        const res = await fetch('/api/get-config');
        const data = await res.json();
        document.getElementById('apiToken').value = data.apiToken || '';
        document.getElementById('zoneId').value = data.zoneId || '';
        document.getElementById('recordName').value = data.recordName || '';
        document.getElementById('proxied').value = data.proxied ? 'true' : 'false';
        document.getElementById('autoUpdate').checked = data.autoUpdate || false;
        document.getElementById('autoUpdateDNSAfterTest').checked = data.autoUpdateAfterTest || false;
        
        // Telegram配置
        document.getElementById('telegramEnabled').checked = data.telegramEnabled || false;
        document.getElementById('telegramBotToken').value = data.telegramBotToken || '';
        document.getElementById('telegramChatId').value = data.telegramChatId || '';
        document.getElementById('telegramHideIP').checked = data.telegramHideIP !== false;
      } catch (e) {
        console.error('加载DNS配置失败:', e);
      }
    }

    async function saveConfig() {
      const config = {
        apiToken: document.getElementById('apiToken').value,
        zoneId: document.getElementById('zoneId').value,
        recordName: document.getElementById('recordName').value,
        proxied: document.getElementById('proxied').value === 'true',
        autoUpdate: document.getElementById('autoUpdate').checked,
        autoUpdateAfterTest: document.getElementById('autoUpdateDNSAfterTest').checked,
        telegramEnabled: document.getElementById('telegramEnabled').checked,
        telegramBotToken: document.getElementById('telegramBotToken').value,
        telegramChatId: document.getElementById('telegramChatId').value,
        telegramHideIP: document.getElementById('telegramHideIP').checked
      };

      await fetch('/api/save-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      
      await loadLogs();
      alert('DNS配置保存成功！');
    }

    async function saveCustomIPs() {
      const text = document.getElementById('customIPs').value.trim();
      const lines = text.split('\\n').map(l => l.trim()).filter(l => l);
      if (!lines.length) return;

      try {
        const res = await fetch('/api/save-custom-ips', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ips: lines })
        });
        
        const data = await res.json();
        if (data.success) {
          alert(\`保存成功！展开后 \${data.expandedCount} 个IP\`);
          setTimeout(async () => {
            await manualUpdate();
          }, 2000);
        }
      } catch (e) {
        console.error('保存自定义IP失败:', e);
        alert('保存失败：' + e.message);
      }
    }

    async function clearCustomIPs() {
      if (!confirm('清除所有自定义IP？')) return;
      await fetch('/api/clear-custom-ips', { method: 'POST' });
      document.getElementById('customIPs').value = '';
      setTimeout(manualUpdate, 2000);
      await loadLogs();
    }

    async function loadIPs() {
      try {
        const res = await fetch('/api/ips');
        const data = await res.json();
        
        highQualityIPs = data.highQualityIPs || [];
        allIPs = data.allIPs || [];
        
        document.getElementById('totalCount').innerText = data.totalCount || 0;
        document.getElementById('highQualityCount').innerText = highQualityIPs.length;
        document.getElementById('failedCount').innerText = data.failedCount || 0;
        document.getElementById('lastUpdateBadge').innerText = data.lastUpdate || '暂无更新';
        
        renderTable();
        
      } catch (e) {
        console.error('加载IP失败:', e);
      }
    }

    async function manualUpdate() {
      const btn = document.querySelector('button[onclick="manualUpdate()"]');
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '更新中...';
      
      try {
        await fetch('/api/update', { method: 'POST' });
        
        setTimeout(async () => {
          await loadIPs();
          await loadLogs();
          btn.disabled = false;
          btn.textContent = originalText;
        }, 3000);
      } catch (e) {
        console.error('更新失败:', e);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }

    function renderTable() {
      const search = document.getElementById('search').value.toLowerCase();
      const items = highQualityIPs
        .filter(item => item.ip.toLowerCase().includes(search))
        .sort((a, b) => a.latency - b.latency);
      
      document.getElementById('ipTable').innerHTML = items.length ? items.map(item => 
        \`<tr>
          <td class="ip-cell">\${item.ip}</td>
          <td class="delay-good">\${item.latency}ms</td>
          <td>\${item.star_level || ''}</td>
          <td><button class="btn btn-sm btn-secondary" onclick="copyIP('\${item.ip}')">复制</button></td>
        </tr>\`
      ).join('') : '<tr><td colspan="4" style="text-align:center;padding:20px;">暂无优质IP，请点击"开始测速"</td></tr>';
    }

    document.getElementById('search').addEventListener('input', renderTable);

    function copyIP(ip) {
      navigator.clipboard.writeText(ip);
      alert('IP已复制到剪贴板');
    }

    function exportHighQualityIPs() {
      if (!highQualityIPs.length) {
        alert('暂无优质IP可导出');
        return;
      }
      
      let content = '# CF优选IP 优质池列表 (≤90ms)\\n';
      content += '# 生成时间: ' + new Date().toLocaleString('zh-CN') + '\\n';
      content += '# 总数量: ' + highQualityIPs.length + ' 个\\n\\n';
      
      highQualityIPs.forEach(item => {
        content += \`\${item.ip} \${item.latency}ms \${item.star_level || ''}\\n\`;
      });
      
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = \`cf_优质IP_\${new Date().getTime()}.txt\`;
      a.click();
      URL.revokeObjectURL(url);
    }

    async function updateDNSWithBest() {
      const best = highQualityIPs.slice(0, uiConfig.ipCount).map(item => item.ip);
      if (!best.length) return alert('无可用IP');
      
      await fetch('/api/update-dns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ips: best, triggerSource: 'manual' })
      });
      
      await loadLogs();
    }

    async function speedTestIP(ip) {
      try {
        const res = await fetch(\`/api/speedtest?ip=\${ip}\`);
        await res.json();
        
        if (totalTested % 5 === 0) {
          await loadLogs();
          await loadIPs();
        }
        
      } catch (e) {
        console.error(\`测速失败 \${ip}:\`, e);
      }
      
      totalTested++;
      const pct = (totalTested / totalToTest * 100).toFixed(1);
      document.getElementById('speedProgressFill').style.width = pct + '%';
      document.getElementById('speedStatus').innerHTML = \`\${totalTested}/\${totalToTest} (\${pct}%)\`;
      
      if (testQueue.length) {
        await speedTestIP(testQueue.shift());
      } else if (--activeThreads === 0) {
        isSpeedTesting = false;
        document.getElementById('speedTestBtn').disabled = false;
        document.getElementById('speedTestBtn').textContent = '开始测速';
        document.getElementById('speedProgress').style.display = 'none';
        document.getElementById('speedStatus').style.display = 'none';
        
        await loadLogs();
        await loadIPs();
        
        const autoUpdateAfterTestChecked = document.getElementById('autoUpdateDNSAfterTest').checked;
        if (autoUpdateAfterTestChecked) {
          const bestIPs = highQualityIPs.slice(0, uiConfig.ipCount).map(item => item.ip);
          
          if (bestIPs.length > 0) {
            const statusEl = document.getElementById('speedStatus');
            statusEl.style.display = 'block';
            statusEl.innerHTML = '🔄 正在自动更新DNS...';
            
            try {
              const dnsRes = await fetch('/api/update-dns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ips: bestIPs, triggerSource: 'speedtest' })
              });
              
              const dnsData = await dnsRes.json();
              
              if (dnsData.success) {
                statusEl.innerHTML = \`✅ DNS自动更新成功: \${dnsData.count || bestIPs.length} 个IP\`;
                setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
              } else {
                statusEl.innerHTML = '❌ DNS自动更新失败';
                setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
              }
            } catch (e) {
              console.error('自动更新DNS失败:', e);
              statusEl.innerHTML = '❌ DNS自动更新异常';
              setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
            }
            await loadLogs();
          }
        }
      }
    }

    async function startSpeedTest() {
      if (isSpeedTesting || !allIPs.length) {
        if (!allIPs.length) {
          alert('没有可测速的IP，请先点击"刷新IP列表"');
        }
        return;
      }

      const testCount = parseInt(document.getElementById('testCount').value) || 50;
      const threadCount = parseInt(document.getElementById('threadCount').value) || 10;
      
      const shuffled = [...allIPs].sort(() => 0.5 - Math.random());
      const queue = shuffled.slice(0, Math.min(testCount, allIPs.length));
      
      isSpeedTesting = true;
      activeThreads = 0;
      totalTested = 0;
      totalToTest = queue.length;
      testQueue = [...queue];
      
      document.getElementById('speedTestBtn').disabled = true;
      document.getElementById('speedTestBtn').textContent = '测速中';
      document.getElementById('speedProgress').style.display = 'block';
      document.getElementById('speedStatus').style.display = 'block';
      document.getElementById('speedProgressFill').style.width = '0%';
      
      await loadLogs();
      
      for (let i = 0; i < threadCount && testQueue.length; i++) {
        activeThreads++;
        speedTestIP(testQueue.shift());
      }
    }
  </script>
</body>
</html>`;
}
