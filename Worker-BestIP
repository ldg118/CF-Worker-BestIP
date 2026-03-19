// Cloudflare Worker 优选IP可视化面板 + 自动DNS + 多线程测速 + 地区自动优选
// 需要绑定的KV命名空间：CF_IP_KV
// 需要在环境变量中设置：ADMIN_PASSWORD
// 环境变量：DEFAULT_IP_COUNT (1-5，默认3) - 只读
// 环境变量：DEFAULT_TEST_COUNT (1-1000，默认200)
// 环境变量：DEFAULT_THREAD_COUNT (1-50，默认10)

const CONFIG = {
  sources: [
    'https://ip.164746.xyz',
    'https://cf.090227.xyz',
    'https://monitor.gacjie.cn/page/cloudflare/ipv4.html',
    'https://stock.hostmonit.com/CloudFlareYes'
  ],
  defaultInterval: 12,
  kvKeys: {
    ipList: 'ip_list',
    lastUpdate: 'last_update',
    dnsConfig: 'dns_config',
    speedTestResults: 'speed_results',
    sessions: 'sessions',
    customIPs: 'custom_ips',
    uiConfig: 'ui_config',
    systemLogs: 'system_logs',
    regionBestIPs: 'region_best_ips'
  }
};

// 国家代码映射
const COUNTRY_NAMES = {
  'CN': '中国',
  'US': '美国',
  'JP': '日本',
  'SG': '新加坡',
  'KR': '韩国',
  'DE': '德国',
  'GB': '英国',
  'FR': '法国',
  'CA': '加拿大',
  'AU': '澳大利亚',
  'IN': '印度',
  'TW': '台湾',
  'HK': '香港',
  'MO': '澳门',
  'unknown': '未知'
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // ========== 公开API ==========
    if (path === '/login') {
      return new Response(getLoginHTML(), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    if (path === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    if (path === '/api/check-auth') {
      return handleCheckAuth(request, env);
    }

    if (path === '/api/logout' && request.method === 'POST') {
      return handleLogout(request, env);
    }

    // ========== 获取访客信息和最优IP ==========
    if (path === '/api/visitor-info') {
      const clientIP = request.headers.get('CF-Connecting-IP') || 
                      request.headers.get('X-Forwarded-For') || 
                      '未知';
      const country = request.headers.get('CF-IPCountry') || 'unknown';
      const countryName = COUNTRY_NAMES[country] || country;
      
      const regionBestIPs = await env.KV.get(CONFIG.kvKeys.regionBestIPs, 'json') || {};
      
      let bestIP = null;
      let bestIPs = [];
      
      if (regionBestIPs[country] && regionBestIPs[country].length > 0) {
        bestIP = regionBestIPs[country][0];
        bestIPs = regionBestIPs[country];
      } else if (regionBestIPs.default && regionBestIPs.default.length > 0) {
        bestIP = regionBestIPs.default[0];
        bestIPs = regionBestIPs.default;
      }
      
      return new Response(JSON.stringify({
        clientIP: clientIP.replace(/\d+$/, '*.*'),
        country,
        countryName,
        bestIP,
        bestIPs,
        allRegions: regionBestIPs
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // ========== 需要验证的API ==========
    const sessionId = getSessionId(request);
    if (!await verifySession(sessionId, env)) {
      if (path.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: '未授权，请先登录' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      return Response.redirect(`${url.origin}/login`, 302);
    }

    // 主页
    if (path === '/') {
      return new Response(getHTML(env), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // ========== 日志API ==========
    if (path === '/api/get-logs') {
      const logs = await env.KV.get(CONFIG.kvKeys.systemLogs, 'json') || [];
      return new Response(JSON.stringify({ logs }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (path === '/api/clear-logs' && request.method === 'POST') {
      await env.KV.put(CONFIG.kvKeys.systemLogs, JSON.stringify([]));
      await addSystemLog(env, `📋 日志已被手动清除`);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // API: 获取IP列表和测速结果
    if (path === '/api/ips') {
      const ips = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
      const customIPs = await env.KV.get(CONFIG.kvKeys.customIPs, 'json') || [];
      const speeds = await env.KV.get(CONFIG.kvKeys.speedTestResults, 'json') || {};
      const lastUpdate = await env.KV.get(CONFIG.kvKeys.lastUpdate) || '--';
      
      const allIPs = [...new Set([...ips, ...customIPs])];
      
      return new Response(JSON.stringify({ 
        ips: allIPs, 
        customIPs,
        speeds, 
        lastUpdate 
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // ========== 获取界面配置 ==========
    if (path === '/api/get-ui-config') {
      const savedConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || {};
      
      let ipCount = 3;
      if (env.DEFAULT_IP_COUNT !== undefined) {
        ipCount = parseInt(env.DEFAULT_IP_COUNT);
        ipCount = Math.min(5, Math.max(1, ipCount));
      }
      
      let testCount = 200;
      if (env.DEFAULT_TEST_COUNT !== undefined) {
        testCount = parseInt(env.DEFAULT_TEST_COUNT);
        testCount = Math.min(1000, Math.max(1, testCount));
      } else {
        testCount = savedConfig.testCount || 200;
      }
      
      let threadCount = 10;
      if (env.DEFAULT_THREAD_COUNT !== undefined) {
        threadCount = parseInt(env.DEFAULT_THREAD_COUNT);
        threadCount = Math.min(50, Math.max(1, threadCount));
      } else {
        threadCount = savedConfig.threadCount || 10;
      }
      
      const uiConfig = { ipCount, testCount, threadCount };
      
      return new Response(JSON.stringify(uiConfig), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // API: 保存界面配置
    if (path === '/api/save-ui-config' && request.method === 'POST') {
      const { testCount, threadCount } = await request.json();
      
      const validTestCount = Math.min(1000, Math.max(1, parseInt(testCount) || 200));
      const validThreadCount = Math.min(50, Math.max(1, parseInt(threadCount) || 10));
      
      let ipCount = 3;
      if (env.DEFAULT_IP_COUNT !== undefined) {
        ipCount = parseInt(env.DEFAULT_IP_COUNT);
        ipCount = Math.min(5, Math.max(1, ipCount));
      }
      
      const uiConfig = {
        ipCount,
        testCount: validTestCount,
        threadCount: validThreadCount
      };
      
      await env.KV.put(CONFIG.kvKeys.uiConfig, JSON.stringify(uiConfig));
      await addSystemLog(env, `⚙️ 参数已保存: 测速数量=${validTestCount}, 线程数=${validThreadCount}`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        config: uiConfig 
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // API: 保存DNS配置
    if (path === '/api/save-config' && request.method === 'POST') {
      const config = await request.json();
      
      const oldConfig = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json') || {};
      
      const hasChanges = 
        config.apiToken !== oldConfig.apiToken ||
        config.zoneId !== oldConfig.zoneId ||
        config.recordName !== oldConfig.recordName ||
        config.proxied !== oldConfig.proxied ||
        config.autoUpdate !== oldConfig.autoUpdate;
      
      await env.KV.put(CONFIG.kvKeys.dnsConfig, JSON.stringify(config));
      
      if (hasChanges) {
        await addSystemLog(env, `🔐 DNS配置已更新${config.autoUpdate ? '，自动更新已开启' : ''}`);
      } else {
        await addSystemLog(env, `🔐 DNS配置保存成功（无变化）`);
      }
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // API: 获取DNS配置（返回时隐藏敏感信息）
    if (path === '/api/get-config') {
      const config = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json') || {
        apiToken: '',
        zoneId: '',
        recordName: '',
        proxied: true,
        autoUpdate: false,
        updateInterval: 12
      };
      
      const maskedConfig = {
        ...config,
        apiToken: config.apiToken ? '********' : '',
        zoneId: config.zoneId ? '********' : ''
      };
      
      return new Response(JSON.stringify(maskedConfig), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // API: 保存自定义IP
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
        await mergeIPs(env, expandedIPs);
        await addSystemLog(env, `📥 自定义IP已保存: ${validIPs.length} 个CIDR, 展开后 ${expandedIPs.length} 个IP`);
      }
      
      return new Response(JSON.stringify({ 
        success: true, 
        validCount: validIPs.length,
        expandedCount: expandedIPs.length,
        invalidCount: invalidIPs.length,
        invalidIPs
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // API: 清除自定义IP
    if (path === '/api/clear-custom-ips' && request.method === 'POST') {
      await env.KV.put(CONFIG.kvKeys.customIPs, JSON.stringify([]));
      await mergeIPs(env, []);
      await addSystemLog(env, `🗑️ 所有自定义IP已清除`);
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // API: 手动更新IP列表
    if (path === '/api/update') {
      ctx.waitUntil(updateIPs(env));
      await addSystemLog(env, `🔄 手动触发IP列表更新`);
      
      return new Response(JSON.stringify({ status: '更新任务已启动' }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // API: 批量更新DNS
    if (path === '/api/update-dns' && request.method === 'POST') {
      const { ips } = await request.json();
      const config = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
      
      if (!config || !config.apiToken || !config.zoneId || !config.recordName) {
        return new Response(JSON.stringify({ error: 'DNS配置不完整' }), { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      if (!ips || ips.length === 0) {
        return new Response(JSON.stringify({ error: '请提供至少一个IP' }), { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      const result = await updateDNSBatch(config, ips);
      if (result.success) {
        await addSystemLog(env, `✅ DNS手动更新成功: ${result.count} 个IP - ${result.ips.join(', ')}`);
      } else {
        await addSystemLog(env, `❌ DNS手动更新失败`);
      }
      
      return new Response(JSON.stringify({ 
        success: result.success, 
        count: result.count,
        ips: result.ips,
        errors: result.errors
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // API: 测速
    if (path === '/api/speedtest' && request.method === 'GET') {
      const ip = url.searchParams.get('ip');
      if (!ip) {
        return new Response(JSON.stringify({ error: '缺少IP参数' }), { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      try {
        const startTime = Date.now();
        const testUrl = 'https://speed.cloudflare.com/__down?bytes=1000';
        
        const response = await fetch(testUrl, {
          headers: { 'Host': 'speed.cloudflare.com' },
          cf: { resolveOverride: ip },
          signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        await response.text();
        const latency = Date.now() - startTime;

        const speeds = await env.KV.get(CONFIG.kvKeys.speedTestResults, 'json') || {};
        speeds[ip] = { delay: latency, timestamp: Date.now() };
        await env.KV.put(CONFIG.kvKeys.speedTestResults, JSON.stringify(speeds));

        return new Response(JSON.stringify({ 
          success: true, 
          ip, 
          latency,
          timestamp: new Date().toISOString()
        }), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });

      } catch (error) {
        return new Response(JSON.stringify({ 
          success: false, 
          ip, 
          error: error.message 
        }), {
          status: 500,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  },

  // 定时任务
  async scheduled(event, env, ctx) {
    const startTime = new Date().toLocaleString();
    console.log('Running scheduled task at', startTime);
    await addSystemLog(env, `⏰ Cron定时任务启动`);
    
    await updateIPs(env);
    
    // 更新各地区最优IP
    await updateRegionBestIPs(env);
    
    const config = await env.KV.get(CONFIG.kvKeys.dnsConfig, 'json');
    if (config?.autoUpdate) {
      await addSystemLog(env, `🤖 自动更新DNS已开启，开始优选IP...`);
      
      const regionBestIPs = await env.KV.get(CONFIG.kvKeys.regionBestIPs, 'json') || {};
      const defaultIPs = regionBestIPs.default || [];
      
      if (defaultIPs.length > 0) {
        const result = await updateDNSBatch(config, defaultIPs);
        if (result.success) {
          await addSystemLog(env, `✅ Cron自动更新DNS成功: ${result.count} 个IP`);
        } else {
          await addSystemLog(env, `❌ Cron自动更新DNS失败`);
        }
      } else {
        await addSystemLog(env, `⚠️ Cron无可用的IP进行更新`);
      }
    } else {
      await addSystemLog(env, `⏸️ 自动更新DNS未开启，跳过`);
    }
    
    await addSystemLog(env, `✅ Cron定时任务完成`);
  }
};

// ========== 更新各地区最优IP ==========
async function updateRegionBestIPs(env) {
  try {
    const ips = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
    const customIPs = await env.KV.get(CONFIG.kvKeys.customIPs, 'json') || [];
    const speeds = await env.KV.get(CONFIG.kvKeys.speedTestResults, 'json') || {};
    const uiConfig = await env.KV.get(CONFIG.kvKeys.uiConfig, 'json') || { ipCount: 3 };
    
    const allIPs = [...new Set([...ips, ...customIPs])];
    const ipCount = uiConfig.ipCount || 3;
    
    const regions = ['default', 'CN', 'US', 'JP', 'SG', 'KR', 'DE', 'GB', 'FR', 'CA', 'AU', 'IN', 'TW', 'HK', 'MO'];
    
    const regionBestIPs = {};
    
    for (const region of regions) {
      let ipWithDelay = allIPs.map(ip => ({
        ip,
        delay: speeds[ip]?.delay || Infinity
      }));
      
      const hasSpeedData = ipWithDelay.some(item => item.delay !== Infinity);
      if (hasSpeedData) {
        ipWithDelay = ipWithDelay.filter(item => item.delay !== Infinity);
      }
      
      ipWithDelay.sort((a, b) => a.delay - b.delay);
      regionBestIPs[region] = ipWithDelay.slice(0, ipCount).map(item => item.ip);
    }
    
    await env.KV.put(CONFIG.kvKeys.regionBestIPs, JSON.stringify(regionBestIPs));
    await addSystemLog(env, `🌍 各地区最优IP已更新`);
    
    return regionBestIPs;
  } catch (e) {
    console.error('Error updating region best IPs:', e);
    return {};
  }
}

// ========== 系统日志函数 ==========
async function addSystemLog(env, message) {
  try {
    const logs = await env.KV.get(CONFIG.kvKeys.systemLogs, 'json') || [];
    const now = Date.now();
    
    logs.push({
      time: now,
      timeStr: new Date(now).toLocaleTimeString(),
      message: message
    });
    
    const sevenDaysAgo = now - 604800000;
    const filteredLogs = logs.filter(log => log.time > sevenDaysAgo);
    
    if (filteredLogs.length > 500) {
      filteredLogs.splice(0, filteredLogs.length - 500);
    }
    
    await env.KV.put(CONFIG.kvKeys.systemLogs, JSON.stringify(filteredLogs));
  } catch (e) {
    console.error('Error adding system log:', e);
  }
}

// ========== 登录相关函数 ==========
async function handleLogin(request, env) {
  try {
    const { password } = await request.json();
    
    if (!env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: '管理员密码未配置' 
      }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (password === env.ADMIN_PASSWORD) {
      const sessionId = generateSessionId();
      const sessions = await env.KV.get(CONFIG.kvKeys.sessions, 'json') || {};
      
      sessions[sessionId] = {
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
      };
      
      await env.KV.put(CONFIG.kvKeys.sessions, JSON.stringify(sessions));
      await addSystemLog(env, `🔐 管理员登录成功`);

      return new Response(JSON.stringify({ 
        success: true, 
        sessionId,
        message: '登录成功'
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } else {
      await addSystemLog(env, `⚠️ 管理员登录失败 - 密码错误`);
      return new Response(JSON.stringify({ 
        success: false, 
        error: '密码错误' 
      }), {
        status: 401,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), {
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

async function handleCheckAuth(request, env) {
  const sessionId = getSessionId(request);
  const isValid = await verifySession(sessionId, env);
  
  return new Response(JSON.stringify({ 
    authenticated: isValid,
    hasAdminPassword: !!env.ADMIN_PASSWORD
  }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

async function handleLogout(request, env) {
  const sessionId = getSessionId(request);
  if (sessionId) {
    const sessions = await env.KV.get(CONFIG.kvKeys.sessions, 'json') || {};
    delete sessions[sessionId];
    await env.KV.put(CONFIG.kvKeys.sessions, JSON.stringify(sessions));
    await addSystemLog(env, `🔓 管理员登出`);
  }
  
  return new Response(JSON.stringify({ success: true }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function getSessionId(request) {
  const url = new URL(request.url);
  
  const cookie = request.headers.get('Cookie');
  if (cookie) {
    const match = cookie.match(/sessionId=([^;]+)/);
    if (match) return match[1];
  }
  
  const auth = request.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  
  return url.searchParams.get('session');
}

async function verifySession(sessionId, env) {
  if (!sessionId) return false;
  
  try {
    const sessions = await env.KV.get(CONFIG.kvKeys.sessions, 'json') || {};
    const session = sessions[sessionId];
    
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
      delete sessions[sessionId];
      await env.KV.put(CONFIG.kvKeys.sessions, JSON.stringify(sessions));
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Session verification error:', error);
    return false;
  }
}

function generateSessionId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ========== 工具函数 ==========

async function mergeIPs(env, newExpandedIPs) {
  const autoIPs = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
  const customIPs = await env.KV.get(CONFIG.kvKeys.customIPs, 'json') || [];
  
  let expandedCustomIPs = [];
  for (const item of customIPs) {
    if (item.includes('/')) {
      const ips = expandCIDR(item);
      expandedCustomIPs.push(...ips);
    } else {
      expandedCustomIPs.push(item);
    }
  }
  
  const allIPs = [...new Set([...autoIPs, ...expandedCustomIPs, ...(newExpandedIPs || [])])];
  await env.KV.put(CONFIG.kvKeys.ipList, JSON.stringify(allIPs));
  
  return allIPs;
}

async function updateIPs(env) {
  let allIPs = new Set();
  
  for (const source of CONFIG.sources) {
    try {
      const resp = await fetch(source);
      const text = await resp.text();
      const ips = text.match(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g) || [];
      ips.forEach(ip => {
        if (isValidIPv4(ip)) {
          allIPs.add(ip);
        }
      });
    } catch (e) {
      console.log(`抓取失败: ${source}`);
    }
  }

  const ipList = Array.from(allIPs).sort(compareIPs);
  const oldIPs = await env.KV.get(CONFIG.kvKeys.ipList, 'json') || [];
  
  await env.KV.put(CONFIG.kvKeys.ipList, JSON.stringify(ipList));
  
  await mergeIPs(env);
  
  await env.KV.put(CONFIG.kvKeys.lastUpdate, new Date().toISOString());
  
  await updateRegionBestIPs(env);
  
  const newCount = ipList.length;
  const oldCount = oldIPs.length;
  const diff = newCount - oldCount;
  
  if (diff !== 0) {
    await addSystemLog(env, `🔄 IP列表已更新: ${newCount} 个IP (${diff > 0 ? '+' + diff : diff})`);
  }
  
  return ipList;
}

function isValidIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return false;
    if (part.startsWith('0') && part.length > 1) return false;
  }
  
  if (ip.startsWith('10.') || 
      ip.startsWith('192.168.') ||
      (ip.startsWith('172.') && parseInt(parts[1]) >= 16 && parseInt(parts[1]) <= 31) ||
      ip.startsWith('127.') ||
      ip.startsWith('169.254.') ||
      ip === '255.255.255.255') {
    return false;
  }
  
  return true;
}

function isValidCIDR(cidr) {
  const parts = cidr.split('/');
  if (parts.length !== 2) return false;
  
  const ip = parts[0];
  const mask = parseInt(parts[1], 10);
  
  if (!isValidIPv4(ip)) return false;
  if (isNaN(mask) || mask < 16 || mask > 30) return false;
  
  return true;
}

function expandCIDR(cidr) {
  const [baseIP, mask] = cidr.split('/');
  const maskNum = parseInt(mask, 10);
  
  const ipParts = baseIP.split('.').map(Number);
  const ipNum = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  
  const maskBits = 32 - maskNum;
  const networkNum = ipNum & (~((1 << maskBits) - 1));
  const broadcastNum = networkNum | ((1 << maskBits) - 1);
  
  const ips = [];
  
  const maxIPs = Math.min(256, (1 << maskBits) - 2);
  
  for (let i = 1; i <= maxIPs; i++) {
    const currentNum = networkNum + i;
    if (currentNum >= broadcastNum) break;
    
    const ip = [
      (currentNum >> 24) & 255,
      (currentNum >> 16) & 255,
      (currentNum >> 8) & 255,
      currentNum & 255
    ].join('.');
    
    if (isValidIPv4(ip)) {
      ips.push(ip);
    }
  }
  
  return ips;
}

function compareIPs(a, b) {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    if (aParts[i] !== bParts[i]) {
      return aParts[i] - bParts[i];
    }
  }
  return 0;
}

async function updateDNSBatch(config, ips) {
  try {
    const url = `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/dns_records`;
    
    const listResp = await fetch(`${url}?type=A&name=${config.recordName}`, {
      headers: {
        'Authorization': `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    const listData = await listResp.json();
    
    if (listData.success && listData.result.length > 0) {
      for (const record of listData.result) {
        await fetch(`${url}/${record.id}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${config.apiToken}`
          }
        });
      }
    }
    
    let successCount = 0;
    let createdIPs = [];
    let errors = [];
    
    for (const ip of ips) {
      const dnsData = {
        type: 'A',
        name: config.recordName,
        content: ip,
        ttl: 120,
        proxied: config.proxied || false
      };
      
      const createResp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(dnsData)
      });
      
      const result = await createResp.json();
      if (result.success) {
        successCount++;
        createdIPs.push(ip);
      } else {
        errors.push({ ip, error: result.errors });
      }
    }
    
    return { 
      success: successCount > 0, 
      count: successCount,
      ips: createdIPs,
      errors: errors
    };
    
  } catch (e) {
    console.log('DNS批量更新失败:', e);
    return { success: false, count: 0, ips: [], errors: [{ error: e.message }] };
  }
}

// ========== 登录页面HTML ==========
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
    .input-group {
      margin-bottom: 20px;
    }
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
    button:hover {
      background: #1d4ed8;
    }
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
      <input type="password" id="password" placeholder="输入管理员密码" onkeypress="e => e.key === 'Enter' && login()">
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

// ========== 主界面HTML（快速日志更新） ==========
function getHTML(env) {
  let defaultIpCount = 3;
  if (env.DEFAULT_IP_COUNT !== undefined) {
    defaultIpCount = parseInt(env.DEFAULT_IP_COUNT);
    defaultIpCount = Math.min(5, Math.max(1, defaultIpCount));
  }
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CF优选IP · 地区自动优选</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
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
      gap: 12px;
      align-items: center;
    }
    .visitor-info {
      background: #1e293b;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 13px;
      border: 1px solid #334155;
      color: #94a3b8;
    }
    .visitor-info strong {
      color: #60a5fa;
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
    .card-header h2 {
      font-size: 16px;
      font-weight: 500;
      color: #f1f5f9;
    }
    .card-body {
      padding: 20px;
    }
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
    .form-group {
      margin-bottom: 16px;
    }
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
      height: 200px;
      overflow-y: auto;
      border: 1px solid #334155;
      margin: 16px 0;
    }
    .log-entry {
      color: #94a3b8;
      margin-bottom: 4px;
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
    .param-item {
      flex: 1;
    }
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
    .full-width {
      width: 100%;
    }
    hr {
      border: none;
      border-top: 1px solid #334155;
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🌩️ CF优选IP · 地区自动优选</h1>
      <div class="header-right">
        <span class="visitor-info" id="visitorInfo">加载中...</span>
        <span class="badge" id="lastUpdateBadge">加载中...</span>
        <button class="logout-btn" onclick="logout()">登出</button>
      </div>
    </div>

    <div class="grid">
      <!-- 左侧：IP列表 + 日志 -->
      <div>
        <!-- IP列表卡片 -->
        <div class="card">
          <div class="card-header">
            <h2>📋 IP列表</h2>
            <div>
              <button class="btn btn-sm btn-secondary" onclick="exportTXT()">导出</button>
              <button class="btn btn-sm btn-primary" onclick="manualUpdate()">刷新</button>
              <button class="btn btn-sm btn-warning" onclick="startSpeedTest()" id="speedTestBtn">测速</button>
            </div>
          </div>
          <div class="card-body">
            <div class="stats">
              <div class="stat-item">
                <div class="stat-label">总IP</div>
                <div class="stat-value" id="ipCount">0</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">已测速</div>
                <div class="stat-value" id="speedCount">0</div>
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
                    <th></th>
                  </tr>
                </thead>
                <tbody id="ipTable">
                  <tr><td colspan="3" style="text-align: center; padding: 30px;">加载中...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 日志卡片 -->
        <div class="card" style="margin-top: 20px;">
          <div class="card-header">
            <h2>📝 运行日志</h2>
            <div>
              <button class="btn btn-sm btn-danger" onclick="clearLogs()">清除</button>
              <button class="btn btn-sm btn-primary" onclick="refreshLogs()">刷新</button>
            </div>
          </div>
          <div class="card-body">
            <div class="log-panel" id="logPanel">
              <div class="log-entry"><span class="log-time">[系统]</span> 面板已初始化 | IP数量: ${defaultIpCount}</div>
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
          <!-- 运行参数 -->
          <div style="background: #0f172a; padding: 16px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="color: #60a5fa; font-size: 14px; margin-bottom: 12px;">🔧 运行参数</h3>
            
            <div class="params-row">
              <div class="param-item">
                <label>IP数量</label>
                <div class="param-value" id="ipCountDisplay">${defaultIpCount} 个</div>
                <input type="hidden" id="ipCount" value="${defaultIpCount}">
              </div>
              
              <div class="param-item">
                <label>测速数量</label>
                <input type="number" class="param-input" id="testCount" min="1" max="1000" value="200">
              </div>
              
              <div class="param-item">
                <label>线程数</label>
                <input type="number" class="param-input" id="threadCount" min="1" max="50" value="10">
              </div>
            </div>
            
            <button class="btn btn-primary full-width" onclick="saveUIConfig()">保存参数</button>
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

          <!-- 自定义IP导入 -->
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
    let ipList = [];
    let speeds = {};
    let dnsConfig = {};
    let isSpeedTesting = false;
    let customIPs = [];
    let uiConfig = {
      ipCount: ${defaultIpCount},
      testCount: 200,
      threadCount: 10
    };
    let activeThreads = 0;
    let totalTested = 0;
    let totalToTest = 0;
    let testQueue = [];

    window.onload = async () => {
      if (await checkAuth()) {
        await loadVisitorInfo();
        await loadUIConfig();
        await loadConfig();
        await loadIPs();
        await loadLogs(); // 只加载一次，不设定时器
      }
    };

    async function checkAuth() {
      try {
        const res = await fetch('/api/check-auth');
        const data = await res.json();
        if (!data.authenticated) window.location.href = '/login';
        return data.authenticated;
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

    // 访客信息
    async function loadVisitorInfo() {
      try {
        const res = await fetch('/api/visitor-info');
        const data = await res.json();
        document.getElementById('visitorInfo').innerHTML = 
          \`当前访问IP: \${data.clientIP} | 访问地区: \${data.countryName}\`;
      } catch {}
    }

    // 日志函数
    async function loadLogs() {
      try {
        const res = await fetch('/api/get-logs');
        const data = await res.json();
        renderLogs(data.logs || []);
      } catch {}
    }

    function renderLogs(logs) {
      const panel = document.getElementById('logPanel');
      if (!logs.length) {
        panel.innerHTML = '<div class="log-entry"><span class="log-time">[系统]</span> 暂无日志</div>';
        return;
      }
      // 显示最新的50条日志，按时间倒序
      const recentLogs = logs.slice(-50).reverse();
      panel.innerHTML = recentLogs.map(log => 
        \`<div class="log-entry"><span class="log-time">[\${log.timeStr}]</span> \${log.message}</div>\`
      ).join('');
      panel.scrollTop = panel.scrollHeight;
    }

    async function clearLogs() {
      if (!confirm('清除所有日志？')) return;
      const res = await fetch('/api/clear-logs', { method: 'POST' });
      if (res.ok) {
        await loadLogs();
        addUILog('✅ 日志已清除');
      }
    }

    async function refreshLogs() {
      await loadLogs();
      addUILog('🔄 日志已刷新');
    }

    // 本地日志（不保存到KV）
    function addUILog(msg) {
      const panel = document.getElementById('logPanel');
      const time = new Date().toLocaleTimeString();
      panel.innerHTML += \`<div class="log-entry"><span class="log-time">[\${time}]</span> \${msg}</div>\`;
      panel.scrollTop = panel.scrollHeight;
    }

    async function loadUIConfig() {
      try {
        const res = await fetch('/api/get-ui-config');
        uiConfig = await res.json();
        document.getElementById('ipCountDisplay').innerText = uiConfig.ipCount + ' 个';
        document.getElementById('ipCount').value = uiConfig.ipCount;
        document.getElementById('testCount').value = uiConfig.testCount;
        document.getElementById('threadCount').value = uiConfig.threadCount;
      } catch {}
    }

    async function saveUIConfig() {
      const testCount = parseInt(document.getElementById('testCount').value) || 200;
      const threadCount = parseInt(document.getElementById('threadCount').value) || 10;
      
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
        body: JSON.stringify({ testCount, threadCount })
      });
      const data = await res.json();
      if (data.success) {
        uiConfig = data.config;
        addUILog(\`✅ 参数已保存: 测速数量=\${testCount}, 线程数=\${threadCount}\`);
        await loadLogs(); // 立即刷新日志
      }
    }

    async function loadConfig() {
      try {
        const res = await fetch('/api/get-config');
        dnsConfig = await res.json();
        document.getElementById('apiToken').value = dnsConfig.apiToken || '';
        document.getElementById('zoneId').value = dnsConfig.zoneId || '';
        document.getElementById('recordName').value = dnsConfig.recordName || '';
        document.getElementById('proxied').value = dnsConfig.proxied ? 'true' : 'false';
        document.getElementById('autoUpdate').checked = dnsConfig.autoUpdate || false;
      } catch {}
    }

    async function saveConfig() {
      const config = {
        apiToken: document.getElementById('apiToken').value,
        zoneId: document.getElementById('zoneId').value,
        recordName: document.getElementById('recordName').value,
        proxied: document.getElementById('proxied').value === 'true',
        autoUpdate: document.getElementById('autoUpdate').checked,
        updateInterval: 12
      };

      const res = await fetch('/api/save-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      const data = await res.json();
      if (data.success) {
        dnsConfig = config;
        addUILog('✅ DNS配置已保存');
        await loadLogs(); // 立即刷新日志
      }
    }

    async function loadCustomIPs() {
      const res = await fetch('/api/ips');
      const data = await res.json();
      customIPs = data.customIPs || [];
      document.getElementById('customIPs').value = customIPs.join('\\n');
      addUILog(\`📂 已加载 \${customIPs.length} 个自定义IP\`);
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
        await loadLogs(); // 立即刷新日志
      }
    }

    async function clearCustomIPs() {
      if (!confirm('清除所有自定义IP？')) return;
      const res = await fetch('/api/clear-custom-ips', { method: 'POST' });
      if (res.ok) {
        document.getElementById('customIPs').value = '';
        addUILog('✅ 自定义IP已清除');
        setTimeout(loadIPs, 1000);
        await loadLogs(); // 立即刷新日志
      }
    }

    async function loadIPs() {
      const res = await fetch('/api/ips');
      const data = await res.json();
      ipList = data.ips || [];
      speeds = data.speeds || {};
      customIPs = data.customIPs || [];
      
      document.getElementById('ipCount').innerText = ipList.length;
      document.getElementById('speedCount').innerText = Object.keys(speeds).length;
      document.getElementById('lastUpdateBadge').innerText = data.lastUpdate ? 
        new Date(data.lastUpdate).toLocaleString() : '暂无更新';
      
      renderTable(ipList);
    }

    function renderTable(ips) {
      const search = document.getElementById('search').value.toLowerCase();
      const items = ips.map(ip => ({ ip, delay: speeds[ip]?.delay || Infinity }))
        .sort((a, b) => a.delay - b.delay)
        .filter(item => item.ip.toLowerCase().includes(search));
      
      document.getElementById('ipTable').innerHTML = items.length ? items.map(item => {
        const delay = item.delay === Infinity ? '--' : item.delay;
        const cls = item.delay < 100 ? 'delay-good' : item.delay < 200 ? 'delay-ok' : 'delay-bad';
        return \`<tr>
          <td class="ip-cell">\${item.ip}</td>
          <td class="\${cls}">\${delay}</td>
          <td><button class="btn btn-sm btn-secondary" onclick="copyIP('\${item.ip}')">复制</button></td>
        </tr>\`;
      }).join('') : '<tr><td colspan="3" style="text-align:center;padding:20px;">无匹配IP</td></tr>';
    }

    document.getElementById('search').addEventListener('input', () => renderTable(ipList));

    async function manualUpdate() {
      const res = await fetch('/api/update');
      const data = await res.json();
      addUILog(\`🔄 \${data.status}\`);
      setTimeout(loadIPs, 2000);
      await loadLogs(); // 立即刷新日志
    }

    async function exportTXT() {
      const blob = new Blob([ipList.join('\\n')], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = \`cf_ips_\${new Date().toISOString().slice(0,10)}.txt\`;
      a.click();
      addUILog(\`📥 已导出 \${ipList.length} 个IP\`);
    }

    function copyIP(ip) {
      navigator.clipboard.writeText(ip);
      addUILog(\`📋 已复制 \${ip}\`);
    }

    async function getBestIPs() {
      const ipCount = parseInt(document.getElementById('ipCount').value) || ${defaultIpCount};
      const items = ipList.map(ip => ({ ip, delay: speeds[ip]?.delay || Infinity }))
        .filter(item => item.delay !== Infinity)
        .sort((a, b) => a.delay - b.delay);
      return items.slice(0, ipCount).map(item => item.ip);
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
        await loadLogs(); // 立即刷新日志
      }
    }

    async function speedTestIP(ip) {
      try {
        const res = await fetch(\`/api/speedtest?ip=\${ip}\`);
        const data = await res.json();
        if (data.success) speeds[ip] = { delay: data.latency };
      } catch {}
      
      totalTested++;
      const pct = (totalTested / totalToTest * 100).toFixed(1);
      document.getElementById('speedProgressFill').style.width = pct + '%';
      document.getElementById('speedStatus').innerHTML = \`\${totalTested}/\${totalToTest} (\${pct}%)\`;
      renderTable(ipList);
      
      if (testQueue.length) {
        await speedTestIP(testQueue.shift());
      } else if (--activeThreads === 0) {
        const best = await getBestIPs();
        if (best.length) {
          const res = await fetch('/api/update-dns', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ips: best })
          });
          const data = await res.json();
          if (data.success) addUILog(\`⚡ 测速完成，自动更新 \${data.count} 个IP\`);
        }
        isSpeedTesting = false;
        document.getElementById('speedTestBtn').disabled = false;
        document.getElementById('speedTestBtn').textContent = '测速';
        document.getElementById('speedProgress').style.display = 'none';
        document.getElementById('speedStatus').style.display = 'none';
        document.getElementById('speedCount').innerText = Object.keys(speeds).length;
        await loadLogs(); // 立即刷新日志
      }
    }

    async function startSpeedTest() {
      if (isSpeedTesting || !ipList.length) return;

      const testCount = parseInt(document.getElementById('testCount').value) || 200;
      const threadCount = parseInt(document.getElementById('threadCount').value) || 10;
      
      isSpeedTesting = true;
      activeThreads = 0;
      totalTested = 0;
      totalToTest = Math.min(testCount, ipList.length);
      testQueue = ipList.slice(0, totalToTest);
      
      document.getElementById('speedTestBtn').disabled = true;
      document.getElementById('speedTestBtn').textContent = '测速中';
      document.getElementById('speedProgress').style.display = 'block';
      document.getElementById('speedStatus').style.display = 'block';
      
      speeds = {};
      
      for (let i = 0; i < threadCount && testQueue.length; i++) {
        activeThreads++;
        speedTestIP(testQueue.shift());
      }
    }
  </script>
</body>
</html>`;
}
