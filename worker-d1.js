// Cloudflare Worker 优选IP可视化面板 - 修复参数和日志问题
// 需要绑定的KV命名空间：KV
// 需要绑定的D1数据库：DB
// 需要在环境变量中设置：ADMIN_PASSWORD
// 环境变量：DEFAULT_IP_COUNT (1-5，默认3) - 可选，现在可以在界面修改
// 环境变量：DEFAULT_TEST_COUNT (1-1000，默认50)
// 环境变量：DEFAULT_THREAD_COUNT (1-50，默认10)
// 环境变量：FAILED_IP_COOLDOWN_DAYS (1-30，默认15)
// 环境变量：MAX_HIGH_QUALITY_POOL_SIZE (10-200，默认50)

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
    uiConfig: 'ui_config',
    regionBestIPs: 'region_best_ips',
    lastTestIndex: 'last_test_index'
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
-- 创建测速结果表
CREATE TABLE IF NOT EXISTS speed_results (
  ip TEXT PRIMARY KEY,
  delay INTEGER NOT NULL,
  test_count INTEGER DEFAULT 1,
  last_tested TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建优质IP池表
CREATE TABLE IF NOT EXISTS high_quality_ips (
  ip TEXT PRIMARY KEY,
  latency INTEGER NOT NULL,
  star_level TEXT NOT NULL,
  last_tested TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建失败IP表
CREATE TABLE IF NOT EXISTS failed_ips (
  ip TEXT PRIMARY KEY,
  failed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reason TEXT
);

-- 创建系统日志表
CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  time_str TEXT NOT NULL,
  message TEXT NOT NULL
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_speed_results_delay ON speed_results(delay);
CREATE INDEX IF NOT EXISTS idx_high_quality_latency ON high_quality_ips(latency);
CREATE INDEX IF NOT EXISTS idx_failed_ips_failed_at ON failed_ips(failed_at);
CREATE INDEX IF NOT EXISTS idx_system_logs_time ON system_logs(time);
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
  const [baseIP, mask] = cidr.split('/');
  const maskNum = parseInt(mask, 10);
  const ipParts = baseIP.split('.').map(Number);
  const ipNum = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  const maskBits = 32 - maskNum;
  const networkNum = ipNum & (~((1 << maskBits) - 1));
  const ips = [];
  const maxIPs = Math.min(256, (1 << maskBits) - 2);
  for (let i = 1; i <= maxIPs; i++) {
    const currentNum = networkNum + i;
    const ip = [
      (currentNum >> 24) & 255,
      (currentNum >> 16) & 255,
      (currentNum >> 8) & 255,
      currentNum & 255
    ].join('.');
    if (isValidIPv4(ip)) ips.push(ip);
  }
  return ips;
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

// ========== 获取环境变量配置 ==========
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

// ========== 获取星星等级 ==========
function getStarLevel(latency) {
  if (latency <= QUALITY_LEVELS.FIVE_STAR) return '⭐⭐⭐⭐⭐';
  if (latency <= QUALITY_LEVELS.FOUR_STAR) return '⭐⭐⭐⭐';
  if (latency <= QUALITY_LEVELS.THREE_STAR) return '⭐⭐⭐';
  if (latency <= QUALITY_LEVELS.TWO_STAR) return '⭐⭐';
  if (latency <= QUALITY_LEVELS.ONE_STAR) return '⭐';
  return '';
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
          console.log('执行语句失败（可能已存在）:', e.message);
        }
      }
    }
    console.log('✅ D1数据库初始化完成');
    return true;
  } catch (e) {
    console.error('❌ D1数据库初始化失败:', e);
    return false;
  }
}

// ========== 添加系统日志（D1）==========
async function addSystemLog(env, message) {
  try {
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    await env.DB.prepare(
      'INSERT INTO system_logs (time_str, message) VALUES (?, ?)'
    ).bind(timeStr, message).run();
    
    // 清理7天前的日志
    try {
      await env.DB.exec("DELETE FROM system_logs WHERE time < datetime('now', '-7 days')");
    } catch (e) {
      // 忽略清理失败
    }
  } catch (e) {
    console.error('添加日志失败:', e.message);
  }
}

// ========== 获取系统日志（D1）==========
async function getSystemLogs(env) {
  try {
    const result = await env.DB.prepare(
      'SELECT time_str, message FROM system_logs ORDER BY time DESC LIMIT 100'
    ).all();
    
    return result.results.map(row => ({
      timeStr: row.time_str,
      message: row.message
    }));
  } catch (e) {
    console.error('获取日志失败:', e);
    return [];
  }
}

// ========== 更新优质池（D1）==========
async function updateHighQualityPool(env, ip, latency) {
  const config = getEnvConfig(env);
  
  if (latency > QUALITY_LEVELS.ONE_STAR) return;
  
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
         WHERE ip NOT IN (
           SELECT ip FROM high_quality_ips 
           ORDER BY latency ASC 
           LIMIT ?
         )`
      ).bind(config.maxHighQualityPoolSize).run();
      
      await addSystemLog(env, `📊 优质池已优化，保留 ${config.maxHighQualityPoolSize} 个最快IP`);
    }
  } catch (e) {
    console.error('更新优质池失败:', e);
  }
}

// ========== 获取优质池（D1）==========
async function getHighQualityIPs(env) {
  try {
    const result = await env.DB.prepare(
      'SELECT ip, latency, star_level FROM high_quality_ips ORDER BY latency ASC'
    ).all();
    return result.results;
  } catch (e) {
    console.error('获取优质池失败:', e);
    return [];
  }
}

// ========== 添加失败IP（D1）==========
async function addFailedIP(env, ip) {
  try {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO failed_ips (ip, failed_at) VALUES (?, CURRENT_TIMESTAMP)'
    ).bind(ip).run();
    
    await env.DB.prepare('DELETE FROM high_quality_ips WHERE ip = ?').bind(ip).run();
    
    await addSystemLog(env, `⛔ ${ip} 加入失败黑名单（冷却15天）`);
  } catch (e) {
    console.error('添加失败IP失败:', e);
  }
}

// ========== 检查IP是否在失败池中 ==========
async function isIPFailed(env, ip) {
  try {
    const result = await env.DB.prepare(
      'SELECT failed_at FROM failed_ips WHERE ip = ? AND failed_at > datetime("now", ?)'
    ).bind(ip, `-${getEnvConfig(env).failedIpCooldownDays} days`).first();
    
    return !!result;
  } catch (e) {
    console.error('检查失败IP失败:', e);
    return false;
  }
}

// ========== 获取失败IP数量 ==========
async function getFailedIPCount(env) {
  try {
    const result = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM failed_ips WHERE failed_at > datetime("now", "-15 days")'
    ).first();
    return result.count || 0;
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

// ========== 获取所有IP（包含自定义）==========
async function getAllIPs(env) {
  try {
    const ips = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
    const customIPs = await env.KV.get(CONFIG.kvKeys.customIPs, 'json') || [];
    return [...new Set([...ips, ...customIPs])];
  } catch (e) {
    console.error('获取所有IP失败:', e);
    return [];
  }
}

// ========== 保存测速结果（D1）==========
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

// ========== 获取测速结果（D1）==========
async function getSpeedResults(env) {
  try {
    const result = await env.DB.prepare('SELECT ip, delay FROM speed_results').all();
    const speeds = {};
    for (const row of result.results) {
      speeds[row.ip] = { delay: row.delay };
    }
    return speeds;
  } catch (e) {
    console.error('获取测速结果失败:', e);
    return {};
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
  await env.KV.put(CONFIG.kvKeys.lastUpdate, new Date().toISOString());
  
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
      } catch (e) {
        // 单次失败继续尝试
      }
    }
    
    if (successCount === 0) {
      await addFailedIP(env, ip);
      return { success: false, ip, error: '全部测速失败' };
    }
    
    const avgLatency = Math.round(totalLatency / successCount);
    
    await saveSpeedResult(env, ip, avgLatency, successCount);
    await updateHighQualityPool(env, ip, avgLatency);
    
    return { 
      success: true, 
      ip, 
      latency: avgLatency, 
      starLevel: getStarLevel(avgLatency) 
    };
  } catch (error) {
    return { success: false, ip, error: error.message };
  }
}

// ========== DNS更新 ==========
async function updateDNSBatch(env, ips) {
  try {
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    if (!dnsConfig || !dnsConfig.apiToken || !dnsConfig.zoneId || !dnsConfig.recordName) {
      return { success: false, error: 'DNS配置不完整' };
    }
    
    const url = `https://api.cloudflare.com/client/v4/zones/${dnsConfig.zoneId}/dns_records`;
    
    const listResp = await fetch(`${url}?type=A&name=${dnsConfig.recordName}`, {
      headers: {
        'Authorization': `Bearer ${dnsConfig.apiToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    const listData = await listResp.json();
    
    if (listData.success && listData.result.length > 0) {
      for (const record of listData.result) {
        await fetch(`${url}/${record.id}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${dnsConfig.apiToken}`
          }
        });
      }
    }
    
    let successCount = 0;
    let createdIPs = [];
    
    for (const ip of ips) {
      const dnsData = {
        type: 'A',
        name: dnsConfig.recordName,
        content: ip,
        ttl: 120,
        proxied: dnsConfig.proxied || false
      };
      
      const createResp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${dnsConfig.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(dnsData)
      });
      
      const result = await createResp.json();
      if (result.success) {
        successCount++;
        createdIPs.push(ip);
      }
    }
    
    return { success: successCount > 0, count: successCount, ips: createdIPs };
  } catch (e) {
    console.log('DNS更新失败:', e);
    return { success: false, count: 0, ips: [] };
  }
}

// ========== 获取最优IP列表 ==========
async function getBestIPs(env, count) {
  const highQualityIPs = await getHighQualityIPs(env);
  return highQualityIPs.slice(0, count).map(item => item.ip);
}

// ========== 处理登录 ==========
async function handleLogin(request, env) {
  try {
    const { password } = await request.json();
    const config = getEnvConfig(env);
    
    if (!config.adminPassword) {
      return new Response(JSON.stringify({ success: false, error: '管理员密码未配置' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    
    if (password === config.adminPassword) {
      const sessionId = generateSessionId();
      const sessions = await env.KV.get(CONFIG.kvKeys.sessions, 'json') || {};
      sessions[sessionId] = { createdAt: Date.now(), expiresAt: Date.now() + 86400000 };
      await env.KV.put(CONFIG.kvKeys.sessions, JSON.stringify(sessions));
      await addSystemLog(env, '🔐 管理员登录成功');
      
      return new Response(JSON.stringify({ success: true, sessionId }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    } else {
      await addSystemLog(env, '⚠️ 管理员登录失败');
      return new Response(JSON.stringify({ success: false, error: '密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
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
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// ========== 处理访客信息 ==========
async function handleVisitorInfo(request, env) {
  const clientIP = request.headers.get('CF-Connecting-IP') || '未知';
  const country = request.headers.get('CF-IPCountry') || 'unknown';
  const countryName = COUNTRY_NAMES[country] || country;
  
  return new Response(JSON.stringify({ clientIP, country, countryName }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// ========== 数据库状态检查 ==========
async function handleDBStatus(env) {
  try {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all();
    
    const tableNames = tables.results.map(t => t.name);
    
    const counts = {};
    for (const table of ['speed_results', 'high_quality_ips', 'failed_ips', 'system_logs']) {
      try {
        const result = await env.DB.prepare(`SELECT COUNT(*) as count FROM ${table}`).first();
        counts[table] = result.count;
      } catch (e) {
        counts[table] = -1;
      }
    }
    
    return {
      success: true,
      tables: tableNames,
      counts: counts,
      initialized: tableNames.length >= 4
    };
  } catch (e) {
    return {
      success: false,
      error: e.message
    };
  }
}

// ========== 手动初始化数据库 ==========
async function handleManualInit(env) {
  const success = await initDatabase(env);
  const status = await handleDBStatus(env);
  
  return {
    success,
    ...status
  };
}

// ========== 主逻辑 ==========
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const config = getEnvConfig(env);

    // 初始化数据库
    ctx.waitUntil(initDatabase(env));

    // CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // 公共接口
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
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/visitor-info') {
      return handleVisitorInfo(request, env);
    }

    if (path === '/api/db-status') {
      const status = await handleDBStatus(env);
      return new Response(JSON.stringify(status), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 验证登录状态
    const sessionId = getSessionId(request);
    if (!await verifySession(sessionId, env)) {
      if (path.startsWith('/api/') && path !== '/api/db-status') {
        return new Response(JSON.stringify({ error: '未授权，请先登录' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      if (!path.startsWith('/api/')) {
        return Response.redirect(`${url.origin}/login`, 302);
      }
    }

    // 需要登录的接口
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
      if (result.success) {
        await addSystemLog(env, '🗄️ 数据库手动初始化成功');
      }
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/get-logs') {
      const logs = await getSystemLogs(env);
      return new Response(JSON.stringify({ logs }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/clear-logs' && request.method === 'POST') {
      await env.DB.exec('DELETE FROM system_logs');
      await addSystemLog(env, '📋 日志已被手动清除');
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/ips') {
      const totalCount = await getTotalIPCount(env);
      const highQualityIPs = await getHighQualityIPs(env);
      const speeds = await getSpeedResults(env);
      const lastUpdate = await env.KV.get(CONFIG.kvKeys.lastUpdate) || '--';
      const failedCount = await getFailedIPCount(env);
      const customIPs = await env.KV.get(CONFIG.kvKeys.customIPs, 'json') || [];
      const allIPs = await getAllIPs(env);
      
      return new Response(JSON.stringify({ 
        totalCount,
        highQualityIPs, 
        speeds, 
        lastUpdate, 
        failedCount,
        customIPs,
        allIPs
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/get-ui-config') {
      const savedConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
      return new Response(JSON.stringify({
        ipCount: savedConfig.ipCount || config.defaultIpCount,
        testCount: savedConfig.testCount || config.defaultTestCount,
        threadCount: savedConfig.threadCount || config.defaultThreadCount
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/save-ui-config' && request.method === 'POST') {
      const { ipCount, testCount, threadCount } = await request.json();
      const validIpCount = Math.min(5, Math.max(1, parseInt(ipCount) || config.defaultIpCount));
      const validTestCount = Math.min(1000, Math.max(1, parseInt(testCount) || config.defaultTestCount));
      const validThreadCount = Math.min(50, Math.max(1, parseInt(threadCount) || config.defaultThreadCount));
      
      const uiConfig = { 
        ipCount: validIpCount, 
        testCount: validTestCount, 
        threadCount: validThreadCount 
      };
      
      await env.KV.put(CONFIG.kvKeys.uiConfig, JSON.stringify(uiConfig));
      await addSystemLog(env, `⚙️ 参数已保存: IP数量=${validIpCount}, 测速数量=${validTestCount}, 线程数=${validThreadCount}`);
      
      return new Response(JSON.stringify({ success: true, config: uiConfig }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/get-config') {
      const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json') || {
        apiToken: '', zoneId: '', recordName: '', proxied: true, autoUpdate: false
      };
      const maskedConfig = {
        ...dnsConfig,
        apiToken: dnsConfig.apiToken ? '********' : '',
        zoneId: dnsConfig.zoneId ? '********' : ''
      };
      return new Response(JSON.stringify(maskedConfig), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/save-config' && request.method === 'POST') {
      const dnsConfig = await request.json();
      await env.KV.put(CONFIG.kvKeys.dnsConfig, JSON.stringify(dnsConfig));
      await addSystemLog(env, '🔐 DNS配置已保存');
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/save-custom-ips' && request.method === 'POST') {
      const { ips } = await request.json();
      const validIPs = [];
      const invalidIPs = [];
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
          } else {
            invalidIPs.push(item);
          }
        } else {
          invalidIPs.push(item);
        }
      }
      
      if (expandedIPs.length > 0) {
        await env.KV.put(CONFIG.kvKeys.customIPs, JSON.stringify(validIPs));
        
        const allIPs = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
        const newIPs = [...new Set([...allIPs, ...expandedIPs])];
        await env.KV.put(CONFIG.kvKeys.ipList, JSON.stringify(newIPs.sort(compareIPs)));
        
        await addSystemLog(env, `📥 自定义IP已保存: ${validIPs.length} 个CIDR, 展开后 ${expandedIPs.length} 个IP`);
      }
      
      return new Response(JSON.stringify({ 
        success: true, 
        validCount: validIPs.length,
        expandedCount: expandedIPs.length,
        invalidCount: invalidIPs.length,
        invalidIPs
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/clear-custom-ips' && request.method === 'POST') {
      await env.KV.put(CONFIG.kvKeys.customIPs, JSON.stringify([]));
      await addSystemLog(env, '🗑️ 所有自定义IP已清除');
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/update') {
      ctx.waitUntil(updateIPs(env));
      await addSystemLog(env, '🔄 手动触发IP列表更新');
      return new Response(JSON.stringify({ status: '更新任务已启动' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/speedtest' && request.method === 'GET') {
      const ip = url.searchParams.get('ip');
      if (!ip) {
        return new Response(JSON.stringify({ error: '缺少IP参数' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      
      const result = await speedTest(env, ip);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/update-dns' && request.method === 'POST') {
      const { ips } = await request.json();
      let targetIPs = ips;
      
      if (!targetIPs) {
        const uiConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
        const ipCount = uiConfig.ipCount || config.defaultIpCount;
        targetIPs = await getBestIPs(env, ipCount);
      }
      
      if (!targetIPs || targetIPs.length === 0) {
        return new Response(JSON.stringify({ error: '无可用IP' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      
      const result = await updateDNSBatch(env, targetIPs);
      if (result.success) {
        await addSystemLog(env, `✅ DNS更新成功: ${result.count} 个IP`);
      }
      
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    await initDatabase(env);
    await addSystemLog(env, '⏰ Cron定时任务启动');
    await updateIPs(env);
    
    const dnsConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    if (dnsConfig?.autoUpdate) {
      await addSystemLog(env, '🤖 自动更新DNS已开启');
      const config = getEnvConfig(env);
      const uiConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
      const ipCount = uiConfig.ipCount || config.defaultIpCount;
      const bestIPs = await getBestIPs(env, ipCount);
      
      if (bestIPs.length > 0) {
        const result = await updateDNSBatch(env, bestIPs);
        if (result.success) {
          await addSystemLog(env, `✅ Cron自动更新DNS成功: ${result.count} 个IP`);
        } else {
          await addSystemLog(env, '❌ Cron自动更新DNS失败');
        }
      } else {
        await addSystemLog(env, '⚠️ Cron无可用的IP');
      }
    }
    
    await addSystemLog(env, '✅ Cron定时任务完成');
  }
};

// ========== HTML页面 ==========
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
  <meta name="viewport" content="width=device-width, initial-scale-1.0">
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
    .header-right { display: flex; gap: 12px; align-items: center; }
    .visitor-info {
      background: #1e293b;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 13px;
      border: 1px solid #334155;
      color: #94a3b8;
    }
    .visitor-info strong { color: #60a5fa; }
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
    .stats {
      display: flex;
      gap: 16px;
      margin-bottom: 20px;
    }
    .stat-item {
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
      max-height: 350px;
      overflow-y: auto;
      border: 1px solid #334155;
      border-radius: 8px;
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
    .delay-ok { color: #fbbf24; }
    .delay-bad { color: #f87171; }
    .btn {
      padding: 6px 12px;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: 0.2s;
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
    .btn-sm {
      padding: 4px 8px;
      font-size: 11px;
    }
    .form-group { margin-bottom: 16px; }
    .form-group label {
      display: block;
      font-size: 13px;
      color: #94a3b8;
      margin-bottom: 4px;
    }
    .form-group input, .form-group select, .form-group textarea {
      width: 100%;
      padding: 10px 12px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #f1f5f9;
      font-size: 14px;
    }
    .form-group input:focus, .form-group textarea:focus {
      outline: none;
      border-color: #60a5fa;
    }
    .form-group textarea {
      font-family: monospace;
      min-height: 80px;
      resize: vertical;
    }
    .checkbox {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .checkbox input { width: auto; }
    .log-panel {
      background: #0f172a;
      border-radius: 8px;
      padding: 12px;
      font-family: monospace;
      font-size: 12px;
      height: 250px;
      overflow-y: auto;
      border: 1px solid #334155;
      margin: 16px 0;
    }
    .log-entry {
      color: #94a3b8;
      margin-bottom: 6px;
      border-bottom: 1px solid #1e293b;
      padding-bottom: 4px;
      font-size: 12px;
    }
    .log-time {
      color: #60a5fa;
      margin-right: 8px;
      font-weight: 500;
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
    .param-value {
      background: #0f172a;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid #334155;
      font-size: 14px;
      color: #f1f5f9;
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
    .db-status {
      background: #0f172a;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 16px;
      font-size: 12px;
      border-left: 4px solid #60a5fa;
      display: none;
    }
    .db-status.ok { border-left-color: #4ade80; }
    .db-status.error { border-left-color: #f87171; }
    .auto-refresh-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🌩️ CF优选IP · 智能优选</h1>
      <div class="header-right">
        <span class="visitor-info" id="visitorInfo">加载中...</span>
        <span class="badge" id="lastUpdateBadge">加载中...</span>
        <button class="logout-btn" onclick="logout()">登出</button>
      </div>
    </div>

    <!-- 数据库状态提示 -->
    <div class="db-status" id="dbStatus"></div>

    <div class="grid">
      <!-- 左侧：测速IP列表 + 日志 -->
      <div>
        <div class="card">
          <div class="card-header">
            <h2>📋 测速IP列表</h2>
            <div>
              <button class="btn btn-sm btn-primary" onclick="manualUpdate()">刷新</button>
              <button class="btn btn-sm btn-warning" onclick="startSpeedTest()" id="speedTestBtn">测速</button>
            </div>
          </div>
          <div class="card-body">
            <div class="stats">
              <div class="stat-item">
                <div class="stat-label">总IP</div>
                <div class="stat-value" id="totalCount">0</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">优质池</div>
                <div class="stat-value" id="highQualityCount">0</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">失败池</div>
                <div class="stat-value" id="failedCount">0</div>
              </div>
            </div>

            <div class="progress-bar" id="speedProgress">
              <div class="progress-bar-fill" id="speedProgressFill"></div>
            </div>
            <div class="speed-status" id="speedStatus"></div>

            <input type="text" class="search-box" id="search" placeholder="🔍 搜索IP...">

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
                  <tr><td colspan="4" style="text-align: center; padding: 30px;">暂无测速数据，请点击"测速"开始</td></tr>
                </tbody>
              </table>
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

      <!-- 右侧：配置面板 -->
      <div class="card">
        <div class="card-header">
          <h2>⚙️ 配置面板</h2>
        </div>
        <div class="card-body">
          <!-- 数据库管理 -->
          <div style="background: #0f172a; padding: 16px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="color: #60a5fa; font-size: 14px; margin-bottom: 12px;">🗄️ 数据库管理</h3>
            <button class="btn btn-success full-width" onclick="initDatabase()" id="initDbBtn">手动初始化数据库</button>
            <button class="btn btn-primary full-width" style="margin-top: 8px;" onclick="checkDBStatus()">检查数据库状态</button>
          </div>

          <!-- 运行参数 -->
          <div style="background: #0f172a; padding: 16px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="color: #60a5fa; font-size: 14px; margin-bottom: 12px;">🔧 运行参数</h3>
            
            <div class="params-row">
              <div class="param-item">
                <label>IP数量 <span style="color: #94a3b8;">(1-5)</span></label>
                <input type="number" class="param-input" id="ipCount" min="1" max="5" value="${config.defaultIpCount}">
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
              ⭐ 星级规则: ≤30ms(⭐⭐⭐⭐⭐), ≤60ms(⭐⭐⭐⭐), ≤90ms(⭐⭐⭐), ≤120ms(⭐⭐), ≤150ms(⭐)
            </div>
            
            <button class="btn btn-primary full-width" style="margin-top: 12px;" onclick="saveUIConfig()">保存参数</button>
          </div>

          <!-- DNS配置 -->
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

          <div class="button-group">
            <button class="btn btn-success" style="flex: 1;" onclick="saveConfig()">保存DNS</button>
            <button class="btn btn-primary" style="flex: 1;" onclick="updateDNSWithBest()">立即更新</button>
          </div>

          <hr>

          <!-- 自定义IP -->
          <h3 style="color: #60a5fa; font-size: 14px; margin-bottom: 12px;">📥 自定义IP</h3>
          <div class="form-group">
            <textarea id="customIPs" placeholder="每行一个IP或CIDR&#10;1.1.1.1&#10;172.64.229.0/24"></textarea>
          </div>
          <div class="button-group">
            <button class="btn btn-secondary" style="flex: 1;" onclick="loadCustomIPs()">加载</button>
            <button class="btn btn-success" style="flex: 1;" onclick="saveCustomIPs()">保存</button>
            <button class="btn btn-danger" style="flex: 1;" onclick="clearCustomIPs()">清除</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let speeds = {};
    let dnsConfig = {};
    let isSpeedTesting = false;
    let customIPs = [];
    let highQualityIPs = [];
    let totalCount = 0;
    let failedCount = 0;
    let allIPs = [];
    let uiConfig = {
      ipCount: ${config.defaultIpCount},
      testCount: ${config.defaultTestCount},
      threadCount: ${config.defaultThreadCount}
    };
    let activeThreads = 0;
    let totalTested = 0;
    let totalToTest = 0;
    let testQueue = [];
    let autoRefreshInterval = null;
    let lastLogLength = 0;

    window.onload = async () => {
      if (await checkAuth()) {
        await loadVisitorInfo();
        await loadUIConfig();
        await loadConfig();
        await loadIPs();
        await loadLogs();
        await checkDBStatus();
        startAutoRefresh(); // 启动自动刷新日志
      }
    };

    // 自动刷新日志
    function startAutoRefresh() {
      if (autoRefreshInterval) clearInterval(autoRefreshInterval);
      autoRefreshInterval = setInterval(async () => {
        if (document.getElementById('autoRefreshLogs').checked) {
          await loadLogs();
        }
      }, 3000); // 每3秒刷新一次
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

    async function checkAuth() {
      const res = await fetch('/api/check-auth');
      const data = await res.json();
      if (!data.authenticated) window.location.href = '/login';
      return data.authenticated;
    }

    async function logout() {
      await fetch('/api/logout', { method: 'POST' });
      document.cookie = 'sessionId=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      window.location.href = '/login';
    }

    async function loadVisitorInfo() {
      const res = await fetch('/api/visitor-info');
      const data = await res.json();
      document.getElementById('visitorInfo').innerHTML = 
        \`当前访问IP: \${data.clientIP} | 访问地区: \${data.countryName}\`;
    }

    async function loadLogs() {
      try {
        const res = await fetch('/api/get-logs');
        const data = await res.json();
        renderLogs(data.logs || []);
      } catch (e) {
        console.error('加载日志失败:', e);
      }
    }

    function renderLogs(logs) {
      const panel = document.getElementById('logPanel');
      if (!logs.length) {
        if (lastLogLength !== 0) {
          panel.innerHTML = '<div class="log-entry"><span class="log-time">[系统]</span> 暂无日志</div>';
          lastLogLength = 0;
        }
        return;
      }
      
      // 只有当日志变化时才更新DOM
      const logsJson = JSON.stringify(logs);
      if (logsJson !== lastLogLength) {
        const recentLogs = logs.slice(0, 100); // 显示最新的100条
        panel.innerHTML = recentLogs.map(log => 
          \`<div class="log-entry"><span class="log-time">[\${log.timeStr}]</span> \${log.message}</div>\`
        ).join('');
        panel.scrollTop = 0; // 滚动到最新
        lastLogLength = logsJson;
      }
    }

    async function clearLogs() {
      if (!confirm('清除所有日志？')) return;
      await fetch('/api/clear-logs', { method: 'POST' });
      await loadLogs();
      addUILog('✅ 日志已清除');
    }

    async function refreshLogs() {
      await loadLogs();
      addUILog('🔄 日志已刷新');
    }

    function addUILog(msg) {
      const panel = document.getElementById('logPanel');
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      // 临时添加，下次刷新日志时会覆盖
      panel.innerHTML = \`<div class="log-entry"><span class="log-time">[\${time}]</span> \${msg}</div>\` + panel.innerHTML;
    }

    async function checkDBStatus() {
      const statusDiv = document.getElementById('dbStatus');
      try {
        const res = await fetch('/api/db-status');
        const data = await res.json();
        
        if (data.success) {
          if (data.initialized) {
            statusDiv.className = 'db-status ok';
            statusDiv.innerHTML = \`✅ 数据库正常 | 表: \${data.tables.join(', ')} | 优质池: \${data.counts.high_quality_ips}个IP\`;
          } else {
            statusDiv.className = 'db-status error';
            statusDiv.innerHTML = \`⚠️ 数据库未完全初始化 | 现有表: \${data.tables.join(', ')} | 缺少表: \${['speed_results', 'high_quality_ips', 'failed_ips', 'system_logs'].filter(t => !data.tables.includes(t)).join(', ')}\`;
          }
        } else {
          statusDiv.className = 'db-status error';
          statusDiv.innerHTML = \`❌ 数据库连接失败: \${data.error}\`;
        }
        statusDiv.style.display = 'block';
      } catch (e) {
        statusDiv.className = 'db-status error';
        statusDiv.innerHTML = '❌ 无法检查数据库状态';
        statusDiv.style.display = 'block';
      }
    }

    async function initDatabase() {
      const btn = document.getElementById('initDbBtn');
      const originalText = btn.textContent;
      
      if (!confirm('确定要初始化数据库吗？如果表已存在不会覆盖。')) return;
      
      btn.disabled = true;
      btn.textContent = '初始化中...';
      
      try {
        const res = await fetch('/api/init-db', { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
          addUILog('✅ 数据库初始化成功');
          await checkDBStatus();
          await loadLogs();
        } else {
          addUILog('❌ 数据库初始化失败');
        }
      } catch (e) {
        addUILog('❌ 初始化请求失败');
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }

    async function loadUIConfig() {
      const res = await fetch('/api/get-ui-config');
      uiConfig = await res.json();
      document.getElementById('ipCount').value = uiConfig.ipCount;
      document.getElementById('testCount').value = uiConfig.testCount;
      document.getElementById('threadCount').value = uiConfig.threadCount;
    }

    async function saveUIConfig() {
      const ipCount = parseInt(document.getElementById('ipCount').value) || 3;
      const testCount = parseInt(document.getElementById('testCount').value) || 50;
      const threadCount = parseInt(document.getElementById('threadCount').value) || 10;
      
      if (ipCount < 1 || ipCount > 5) {
        alert('IP数量必须在1-5之间');
        return;
      }
      if (testCount < 1 || testCount > 1000) {
        alert('测速数量必须在1-1000之间');
        return;
      }
      if (threadCount < 1 || threadCount > 50) {
        alert('线程数必须在1-50之间');
        return;
      }
      
      const res = await fetch('/api/save-ui-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ipCount, testCount, threadCount })
      });
      const data = await res.json();
      if (data.success) {
        uiConfig = data.config;
        addUILog(\`✅ 参数已保存: IP数量=\${ipCount}, 测速数量=\${testCount}, 线程数=\${threadCount}\`);
        await loadLogs();
      }
    }

    async function loadConfig() {
      const res = await fetch('/api/get-config');
      dnsConfig = await res.json();
      document.getElementById('apiToken').value = dnsConfig.apiToken || '';
      document.getElementById('zoneId').value = dnsConfig.zoneId || '';
      document.getElementById('recordName').value = dnsConfig.recordName || '';
      document.getElementById('proxied').value = dnsConfig.proxied ? 'true' : 'false';
      document.getElementById('autoUpdate').checked = dnsConfig.autoUpdate || false;
    }

    async function saveConfig() {
      const config = {
        apiToken: document.getElementById('apiToken').value,
        zoneId: document.getElementById('zoneId').value,
        recordName: document.getElementById('recordName').value,
        proxied: document.getElementById('proxied').value === 'true',
        autoUpdate: document.getElementById('autoUpdate').checked
      };

      const res = await fetch('/api/save-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      if (res.ok) {
        dnsConfig = config;
        addUILog('✅ DNS配置已保存');
        await loadLogs();
      }
    }

    async function loadCustomIPs() {
      const res = await fetch('/api/ips');
      const data = await res.json();
      customIPs = data.customIPs || [];
      highQualityIPs = data.highQualityIPs || [];
      totalCount = data.totalCount || 0;
      failedCount = data.failedCount || 0;
      allIPs = data.allIPs || [];
      document.getElementById('customIPs').value = customIPs.join('\\n');
      document.getElementById('totalCount').innerText = totalCount;
      document.getElementById('highQualityCount').innerText = highQualityIPs.length;
      document.getElementById('failedCount').innerText = failedCount;
      addUILog(\`📂 已加载 \${customIPs.length} 个自定义IP，总IP \${totalCount} 个，优质池 \${highQualityIPs.length} 个，失败池 \${failedCount} 个\`);
      renderTable();
    }

    async function saveCustomIPs() {
      const text = document.getElementById('customIPs').value.trim();
      const lines = text.split('\\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      if (!lines.length) return;

      const res = await fetch('/api/save-custom-ips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ips: lines })
      });
      const data = await res.json();
      if (data.success) {
        addUILog(\`✅ 保存成功: \${data.expandedCount} 个IP\`);
        setTimeout(loadIPs, 1000);
        await loadLogs();
      }
    }

    async function clearCustomIPs() {
      if (!confirm('清除所有自定义IP？')) return;
      await fetch('/api/clear-custom-ips', { method: 'POST' });
      document.getElementById('customIPs').value = '';
      addUILog('✅ 自定义IP已清除');
      setTimeout(loadIPs, 1000);
      await loadLogs();
    }

    async function loadIPs() {
      const res = await fetch('/api/ips');
      const data = await res.json();
      highQualityIPs = data.highQualityIPs || [];
      speeds = data.speeds || {};
      customIPs = data.customIPs || [];
      totalCount = data.totalCount || 0;
      failedCount = data.failedCount || 0;
      allIPs = data.allIPs || [];
      
      document.getElementById('totalCount').innerText = totalCount;
      document.getElementById('highQualityCount').innerText = highQualityIPs.length;
      document.getElementById('failedCount').innerText = failedCount;
      document.getElementById('lastUpdateBadge').innerText = data.lastUpdate ? 
        new Date(data.lastUpdate).toLocaleString() : '暂无更新';
      
      renderTable();
    }

    function getStarLevel(latency) {
      if (latency <= 30) return '⭐⭐⭐⭐⭐';
      if (latency <= 60) return '⭐⭐⭐⭐';
      if (latency <= 90) return '⭐⭐⭐';
      if (latency <= 120) return '⭐⭐';
      if (latency <= 150) return '⭐';
      return '';
    }

    function renderTable() {
      const search = document.getElementById('search').value.toLowerCase();
      
      const items = highQualityIPs
        .filter(item => item.ip.toLowerCase().includes(search))
        .sort((a, b) => a.latency - b.latency);
      
      document.getElementById('ipTable').innerHTML = items.length ? items.map(item => {
        const starLevel = getStarLevel(item.latency);
        return \`<tr>
          <td class="ip-cell">\${item.ip}</td>
          <td class="delay-good">\${item.latency}ms</td>
          <td>\${starLevel}</td>
          <td><button class="btn btn-sm btn-secondary" onclick="copyIP('\${item.ip}')">复制</button></td>
        </tr>\`;
      }).join('') : '<tr><td colspan="4" style="text-align:center;padding:20px;">暂无测速数据</td></tr>';
    }

    document.getElementById('search').addEventListener('input', renderTable);

    async function manualUpdate() {
      await loadIPs();
      addUILog('🔄 已刷新列表');
    }

    function copyIP(ip) {
      navigator.clipboard.writeText(ip);
      addUILog(\`📋 已复制 \${ip}\`);
    }

    async function getBestIPs() {
      return highQualityIPs.slice(0, uiConfig.ipCount).map(item => item.ip);
    }

    async function updateDNSWithBest() {
      const best = await getBestIPs();
      if (!best.length) return addUILog('❌ 无可用IP');
      
      const res = await fetch('/api/update-dns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ips: best })
      });
      const data = await res.json();
      if (data.success) {
        addUILog(\`✅ DNS更新 \${data.count} 个IP\`);
        await loadLogs();
      }
    }

    async function speedTestIP(ip) {
      try {
        const res = await fetch(\`/api/speedtest?ip=\${ip}\`);
        const data = await res.json();
        if (data.success) {
          addUILog(\`✅ \${ip} - \${data.latency}ms \${getStarLevel(data.latency)}\`);
          await loadIPs();
        } else {
          addUILog(\`❌ \${ip} - 失败\`);
        }
      } catch (error) {
        addUILog(\`❌ \${ip} - 请求失败\`);
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
        document.getElementById('speedTestBtn').textContent = '测速';
        document.getElementById('speedProgress').style.display = 'none';
        document.getElementById('speedStatus').style.display = 'none';
        await loadLogs();
        await loadIPs();
      }
    }

    async function startSpeedTest() {
      if (isSpeedTesting) return;

      await loadIPs();
      
      const testCount = parseInt(document.getElementById('testCount').value) || 50;
      const threadCount = parseInt(document.getElementById('threadCount').value) || 10;
      
      if (allIPs.length === 0) {
        addUILog('❌ 没有可测速的IP，请先刷新IP列表');
        return;
      }
      
      const shuffled = [...allIPs].sort(() => 0.5 - Math.random());
      const queue = shuffled.slice(0, Math.min(testCount, allIPs.length));
      
      isSpeedTesting = true;
      activeThreads = 0;
      totalTested = 0;
      totalToTest = queue.length;
      testQueue = queue;
      
      document.getElementById('speedTestBtn').disabled = true;
      document.getElementById('speedTestBtn').textContent = '测速中';
      document.getElementById('speedProgress').style.display = 'block';
      document.getElementById('speedStatus').style.display = 'block';
      document.getElementById('speedProgressFill').style.width = '0%';
      
      addUILog(\`⚡ 开始测速，共 \${totalToTest} 个IP，线程数 \${threadCount}\`);
      
      for (let i = 0; i < threadCount && testQueue.length; i++) {
        activeThreads++;
        speedTestIP(testQueue.shift());
      }
    }
  </script>
</body>
</html>`;
}
