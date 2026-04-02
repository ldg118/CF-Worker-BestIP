// DNS Manager - Core API Handler
// 支持域名管理和 SSL 证书申请

import { requestSSLCertificate, completeSSLCertificate, ACMEClient } from './acme.js';

const DEFAULT_PASSWORD = 'admin123';

// 数据库表创建语句
const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS dns_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, provider TEXT NOT NULL, api_key TEXT NOT NULL, api_secret TEXT, api_token TEXT, zone_id TEXT, is_active BOOLEAN DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS domains (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT NOT NULL, zone_id TEXT, status TEXT DEFAULT 'active', is_manual BOOLEAN DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS dns_records (id INTEGER PRIMARY KEY AUTOINCREMENT, domain_id INTEGER NOT NULL, record_id TEXT, name TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, ttl INTEGER DEFAULT 600, priority INTEGER DEFAULT 0, is_active BOOLEAN DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS ssl_certificates (id INTEGER PRIMARY KEY AUTOINCREMENT, domain_id INTEGER NOT NULL, domain_name TEXT NOT NULL, certificate TEXT, private_key TEXT, issuer TEXT, valid_from TIMESTAMP, valid_to TIMESTAMP, status TEXT DEFAULT 'pending', auto_renew BOOLEAN DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS ssl_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, provider TEXT DEFAULT 'letsencrypt', status TEXT DEFAULT 'pending', challenge_type TEXT DEFAULT 'dns-01', dns_records TEXT, certificate_id INTEGER, error_message TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS system_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT DEFAULT 'info', message TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS user_settings (id INTEGER PRIMARY KEY, admin_password TEXT DEFAULT 'admin123', session_timeout INTEGER DEFAULT 3600, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMP)`
];

// 确保数据库表存在
async function ensureTables(env) {
  try {
    await env.DB.prepare("SELECT 1 FROM domains LIMIT 1").first();
  } catch (e) {
    console.log('Tables not found, initializing database...');
    
    for (const sql of CREATE_TABLES) {
      try {
        await env.DB.prepare(sql).run();
      } catch (err) {
        console.error('Error creating table:', err.message);
      }
    }
    
    try {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO user_settings (id, admin_password, session_timeout)
        VALUES (1, ?, 3600)
      `).bind(DEFAULT_PASSWORD).run();
    } catch (err) {
      console.error('Error inserting default password:', err.message);
    }
    
    console.log('Database initialized successfully');
  }
}

// 生成会话 ID
function generateSessionId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// 创建会话
async function createSession(env) {
  try {
    const sessionId = generateSessionId();
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    
    if (env.KV) {
      await env.KV.put(`session:${sessionId}`, JSON.stringify({ user_id: 1, expires_at: expiresAt }), {
        expirationTtl: 24 * 60 * 60
      });
    }
    
    return sessionId;
  } catch (e) {
    console.error('Create session error:', e);
    return generateSessionId();
  }
}

// 验证会话
async function verifySession(env, sessionId) {
  try {
    if (!env.KV) return true;
    
    const session = await env.KV.get(`session:${sessionId}`);
    if (!session) return false;
    
    const data = JSON.parse(session);
    return data.expires_at > Date.now();
  } catch (e) {
    return false;
  }
}

// 验证密码
async function verifyPassword(env, password) {
  if (password === DEFAULT_PASSWORD) return true;
  
  try {
    if (env.KV) {
      const storedPassword = await env.KV.get('settings:admin_password');
      if (storedPassword) return storedPassword === password;
    }
  } catch (e) {
    console.error('Password verification error:', e);
  }
  
  return password === DEFAULT_PASSWORD;
}

// 添加日志
async function addLog(env, level, message) {
  try {
    if (env.DB) {
      await ensureTables(env);
      await env.DB.prepare('INSERT INTO system_logs (level, message) VALUES (?, ?)')
        .bind(level, message).run();
    }
  } catch (e) {
    console.error('Failed to add log:', e);
  }
}

// DNS 账户管理
async function addDNSAccount(env, account) {
  try {
    await ensureTables(env);
    const result = await env.DB.prepare(`
      INSERT INTO dns_accounts (name, provider, api_key, api_secret, api_token, zone_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(account.name, account.provider, account.api_key || '', account.api_secret || '', account.api_token || '', account.zone_id || '').run();
    return { success: true, id: result.meta?.last_row_id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getDNSAccounts(env) {
  try {
    await ensureTables(env);
    const accounts = await env.DB.prepare('SELECT * FROM dns_accounts ORDER BY created_at DESC').all();
    return accounts.results || [];
  } catch (e) {
    return [];
  }
}

// 域名管理
async function addDomain(env, domain) {
  try {
    await ensureTables(env);
    const result = await env.DB.prepare(`
      INSERT INTO domains (account_id, name, zone_id, status, is_manual)
      VALUES (?, ?, ?, ?, ?)
    `).bind(domain.account_id || null, domain.name, domain.zone_id, domain.status || 'active', domain.is_manual || 0).run();
    return { success: true, id: result.meta?.last_row_id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function addManualDomain(env, domainName) {
  try {
    await ensureTables(env);
    const result = await env.DB.prepare(`
      INSERT INTO domains (account_id, name, zone_id, status, is_manual)
      VALUES (NULL, ?, NULL, 'active', 1)
    `).bind(domainName).run();
    return { success: true, id: result.meta?.last_row_id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getDomains(env) {
  try {
    await ensureTables(env);
    const domains = await env.DB.prepare(`
      SELECT d.*, a.name as account_name, a.provider 
      FROM domains d 
      LEFT JOIN dns_accounts a ON d.account_id = a.id 
      ORDER BY d.created_at DESC
    `).all();
    return domains.results || [];
  } catch (e) {
    return [];
  }
}

// SSL 证书管理
async function addSSLCertificate(env, cert) {
  try {
    await ensureTables(env);
    const result = await env.DB.prepare(`
      INSERT INTO ssl_certificates (domain_id, domain_name, certificate, private_key, issuer, valid_from, valid_to, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(cert.domain_id, cert.domain_name, cert.certificate || '', cert.private_key || '', cert.issuer || '', cert.valid_from || null, cert.valid_to || null, cert.status || 'active').run();
    return { success: true, id: result.meta?.last_row_id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getSSLCertificates(env) {
  try {
    await ensureTables(env);
    const certs = await env.DB.prepare('SELECT * FROM ssl_certificates ORDER BY created_at DESC').all();
    return certs.results || [];
  } catch (e) {
    return [];
  }
}

// 创建 SSL 证书订单
async function createSSLOrder(env, orderData) {
  try {
    await ensureTables(env);
    const result = await env.DB.prepare(`
      INSERT INTO ssl_orders (domain, provider, status, challenge_type)
      VALUES (?, ?, 'pending', 'dns-01')
    `).bind(orderData.domain, orderData.provider || 'letsencrypt').run();
    return { success: true, id: result.meta?.last_row_id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getSSLOrders(env) {
  try {
    await ensureTables(env);
    const orders = await env.DB.prepare('SELECT * FROM ssl_orders ORDER BY created_at DESC').all();
    return orders.results || [];
  } catch (e) {
    return [];
  }
}

// 获取日志
async function getLogs(env, limit = 100) {
  try {
    await ensureTables(env);
    const logs = await env.DB.prepare('SELECT * FROM system_logs ORDER BY id DESC LIMIT ?').bind(limit).all();
    return logs.results || [];
  } catch (e) {
    return [];
  }
}

// 获取统计数据
async function getStats(env) {
  try {
    await ensureTables(env);
    const accounts = await env.DB.prepare('SELECT COUNT(*) as count FROM dns_accounts').first();
    const domains = await env.DB.prepare('SELECT COUNT(*) as count FROM domains').first();
    const records = await env.DB.prepare('SELECT COUNT(*) as count FROM dns_records').first();
    const certificates = await env.DB.prepare('SELECT COUNT(*) as count FROM ssl_certificates').first();
    
    return {
      accounts: accounts?.count || 0,
      domains: domains?.count || 0,
      records: records?.count || 0,
      certificates: certificates?.count || 0
    };
  } catch (e) {
    return { accounts: 0, domains: 0, records: 0, certificates: 0 };
  }
}

// 主请求处理函数
export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  
  // 设置 Cookie
  const setCookie = (sessionId) => `sessionId=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`;
  
  // JSON 响应
  const jsonResponse = (data, status = 200, extraHeaders = {}) => {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...extraHeaders }
    });
  };
  
  // 验证会话（除登录外）
  const requireAuth = async () => {
    const cookie = request.headers.get('Cookie');
    const sessionId = cookie?.match(/sessionId=([^;]+)/)?.[1];
    if (!sessionId || !(await verifySession(env, sessionId))) {
      return jsonResponse({ success: false, error: '未登录' }, 401);
    }
    return null;
  };
  
  // 登录
  if (path === '/api/login' && method === 'POST') {
    const body = await request.json();
    console.log('Login attempt:', { password: body?.password });
    
    if (!body || !body.password) {
      return jsonResponse({ success: false, error: '密码不能为空' }, 400);
    }
    
    if (body.password === DEFAULT_PASSWORD) {
      const sessionId = await createSession(env);
      await addLog(env, 'info', '用户登录成功');
      return jsonResponse({ success: true, sessionId }, 200, { 'Set-Cookie': setCookie(sessionId) });
    }
    
    await addLog(env, 'warning', '登录失败：密码错误');
    return jsonResponse({ success: false, error: '密码错误' }, 401);
  }
  
  // 检查认证
  const authError = await requireAuth();
  if (authError) return authError;
  
  // 初始化数据库
  if (path === '/api/init' && method === 'POST') {
    await ensureTables(env);
    return jsonResponse({ success: true });
  }
  
  // 获取统计
  if (path === '/api/stats' && method === 'GET') {
    const stats = await getStats(env);
    return jsonResponse({ success: true, stats });
  }
  
  // DNS 账户管理
  if (path === '/api/accounts' && method === 'GET') {
    const accounts = await getDNSAccounts(env);
    return jsonResponse({ success: true, accounts });
  }
  
  if (path === '/api/accounts' && method === 'POST') {
    const body = await request.json();
    const result = await addDNSAccount(env, body);
    if (result.success) await addLog(env, 'info', `添加DNS账户: ${body.name}`);
    return jsonResponse(result);
  }
  
  // 域名管理
  if (path === '/api/domains' && method === 'GET') {
    const domains = await getDomains(env);
    return jsonResponse({ success: true, domains });
  }
  
  if (path === '/api/domains' && method === 'POST') {
    const body = await request.json();
    const result = await addDomain(env, body);
    return jsonResponse(result);
  }
  
  if (path === '/api/domains/manual' && method === 'POST') {
    const body = await request.json();
    if (!body.name) {
      return jsonResponse({ success: false, error: '域名不能为空' });
    }
    const result = await addManualDomain(env, body.name.trim());
    if (result.success) await addLog(env, 'info', `手动添加域名: ${body.name}`);
    return jsonResponse(result);
  }
  
  // 删除域名
  if (path.match(/^\/api\/domains\/\d+$/) && method === 'DELETE') {
    const id = path.split('/')[3];
    
    try {
      await env.DB.prepare('DELETE FROM domains WHERE id = ?').bind(id).run();
      await addLog(env, 'info', `删除域名 ID: ${id}`);
      return jsonResponse({ success: true });
    } catch (e) {
      return jsonResponse({ success: false, error: e.message });
    }
  }
  
  // 同步账户域名
  if (path.match(/^\/api\/accounts\/\d+\/sync$/) && method === 'POST') {
    const accountId = path.split('/')[3];
    
    try {
      const account = await env.DB.prepare('SELECT * FROM dns_accounts WHERE id = ?').bind(accountId).first();
      
      if (!account) {
        return jsonResponse({ success: false, error: '账户不存在' });
      }
      
      // 根据提供商同步域名
      let domains = [];
      
      if (account.provider === 'cloudflare') {
        // Cloudflare API 获取域名列表
        const response = await fetch('https://api.cloudflare.com/client/v4/zones', {
          headers: {
            'Authorization': `Bearer ${account.api_key}`,
            'Content-Type': 'application/json'
          }
        });
        
        const data = await response.json();
        
        if (data.success) {
          domains = data.result.map(zone => ({
            name: zone.name,
            zone_id: zone.id,
            status: zone.status
          }));
        }
      }
      
      // 保存域名到数据库
      let addedCount = 0;
      for (const domain of domains) {
        const existing = await env.DB.prepare('SELECT id FROM domains WHERE name = ?').bind(domain.name).first();
        
        if (!existing) {
          await addDomain(env, {
            account_id: accountId,
            name: domain.name,
            zone_id: domain.zone_id,
            status: domain.status,
            is_manual: 0
          });
          addedCount++;
        }
      }
      
      await addLog(env, 'info', `同步账户 ${account.name} 域名，新增 ${addedCount} 个`);
      
      return jsonResponse({ success: true, count: addedCount, total: domains.length });
    } catch (e) {
      return jsonResponse({ success: false, error: e.message });
    }
  }
  
  // 删除账户
  if (path.match(/^\/api\/accounts\/\d+$/) && method === 'DELETE') {
    const id = path.split('/')[3];
    
    try {
      await env.DB.prepare('DELETE FROM dns_accounts WHERE id = ?').bind(id).run();
      await addLog(env, 'info', `删除账户 ID: ${id}`);
      return jsonResponse({ success: true });
    } catch (e) {
      return jsonResponse({ success: false, error: e.message });
    }
  }
  
  // SSL 证书管理
  if (path === '/api/certificates' && method === 'GET') {
    const certificates = await getSSLCertificates(env);
    return jsonResponse({ success: true, certificates });
  }
  
  if (path === '/api/certificates' && method === 'POST') {
    const body = await request.json();
    const result = await addSSLCertificate(env, body);
    return jsonResponse(result);
  }
  
  // SSL 订单管理
  if (path === '/api/ssl/orders' && method === 'GET') {
    const orders = await getSSLOrders(env);
    return jsonResponse({ success: true, orders });
  }
  
  if (path === '/api/ssl/orders' && method === 'POST') {
    const body = await request.json();
    const result = await createSSLOrder(env, body);
    return jsonResponse(result);
  }
  
  // SSL 证书申请 - 第一步：创建订单并获取 DNS 记录
  if (path === '/api/ssl/apply' && method === 'POST') {
    const body = await request.json();
    
    if (!body.domain) {
      return jsonResponse({ success: false, error: '域名不能为空' });
    }
    
    // 获取默认邮箱
    let email = body.email;
    if (!email && env.KV) {
      email = await env.KV.get('settings:default_email');
    }
    if (!email) {
      email = 'admin@' + body.domain;
    }
    
    // 开始 ACME 流程
    const result = await requestSSLCertificate(body.domain, email, body.dns_provider, env);
    
    if (result.success && result.stage === 'dns_required') {
      // 保存订单状态到 KV
      if (env.KV) {
        const orderKey = `ssl_order:${result.orderUrl.split('/').pop()}`;
        await env.KV.put(orderKey, JSON.stringify({
          domain: body.domain,
          email: email,
          clientState: result.clientState,
          dnsRecord: result.dnsRecord,
          createdAt: Date.now()
        }), { expirationTtl: 3600 }); // 1小时过期
      }
      
      await addLog(env, 'info', `SSL证书申请开始: ${body.domain}`);
    }
    
    return jsonResponse(result);
  }
  
  // SSL 证书申请 - 第二步：验证 DNS 并完成申请
  if (path === '/api/ssl/verify' && method === 'POST') {
    const body = await request.json();
    
    if (!body.orderId) {
      return jsonResponse({ success: false, error: '订单ID不能为空' });
    }
    
    // 从 KV 获取订单状态
    let orderData = null;
    if (env.KV) {
      const orderKey = `ssl_order:${body.orderId}`;
      const orderJson = await env.KV.get(orderKey);
      if (orderJson) {
        orderData = JSON.parse(orderJson);
      }
    }
    
    if (!orderData) {
      return jsonResponse({ success: false, error: '订单不存在或已过期' });
    }
    
    // 完成证书申请
    const result = await completeSSLCertificate(orderData.clientState, env);
    
    if (result.success) {
      // 保存证书到数据库
      const domain = await env.DB.prepare('SELECT id FROM domains WHERE name = ?').bind(orderData.domain).first();
      
      await addSSLCertificate(env, {
        domain_id: domain?.id || null,
        domain_name: orderData.domain,
        certificate: result.certificate,
        private_key: result.privateKey,
        issuer: 'Let\'s Encrypt',
        valid_from: new Date().toISOString(),
        valid_to: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        status: 'active'
      });
      
      // 删除 KV 中的临时订单数据
      if (env.KV) {
        await env.KV.delete(`ssl_order:${body.orderId}`);
      }
      
      await addLog(env, 'info', `SSL证书申请成功: ${orderData.domain}`);
    }
    
    return jsonResponse(result);
  }
  
  // 证书续期
  if (path === '/api/certificates/:id/renew' && method === 'POST') {
    const id = path.split('/')[3];
    
    // 获取证书信息
    const cert = await env.DB.prepare('SELECT * FROM ssl_certificates WHERE id = ?').bind(id).first();
    
    if (!cert) {
      return jsonResponse({ success: false, error: '证书不存在' });
    }
    
    // 重新申请证书
    let email = 'admin@' + cert.domain_name;
    if (env.KV) {
      const storedEmail = await env.KV.get('settings:default_email');
      if (storedEmail) email = storedEmail;
    }
    
    const result = await requestSSLCertificate(cert.domain_name, email, null, env);
    
    if (result.success && result.stage === 'dns_required') {
      // 保存续期订单状态
      if (env.KV) {
        const orderKey = `ssl_renew:${id}_${Date.now()}`;
        await env.KV.put(orderKey, JSON.stringify({
          certId: id,
          domain: cert.domain_name,
          email: email,
          clientState: result.clientState,
          dnsRecord: result.dnsRecord,
          createdAt: Date.now()
        }), { expirationTtl: 3600 });
      }
    }
    
    return jsonResponse(result);
  }
  
  // 删除证书
  if (path.match(/^\/api\/certificates\/\d+$/) && method === 'DELETE') {
    const id = path.split('/')[3];
    
    try {
      await env.DB.prepare('DELETE FROM ssl_certificates WHERE id = ?').bind(id).run();
      await addLog(env, 'info', `删除证书 ID: ${id}`);
      return jsonResponse({ success: true });
    } catch (e) {
      return jsonResponse({ success: false, error: e.message });
    }
  }
  
  // 获取单个证书详情
  if (path.match(/^\/api\/certificates\/\d+$/) && method === 'GET') {
    const id = path.split('/')[3];
    
    try {
      const cert = await env.DB.prepare('SELECT * FROM ssl_certificates WHERE id = ?').bind(id).first();
      if (cert) {
        return jsonResponse({ success: true, certificate: cert });
      }
      return jsonResponse({ success: false, error: '证书不存在' }, 404);
    } catch (e) {
      return jsonResponse({ success: false, error: e.message });
    }
  }
  
  // 日志
  if (path === '/api/logs' && method === 'GET') {
    const logs = await getLogs(env);
    return jsonResponse({ success: true, logs });
  }
  
  // 退出登录
  if (path === '/api/logout' && method === 'POST') {
    return jsonResponse({ success: true }, 200, { 'Set-Cookie': 'sessionId=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  }
  
  // 检查认证状态
  if (path === '/api/auth/check' && method === 'GET') {
    return jsonResponse({ success: true, authenticated: true });
  }
  
  // 修改密码
  if (path === '/api/auth/password' && method === 'POST') {
    const body = await request.json();
    
    if (!body.current_password || !body.new_password) {
      return jsonResponse({ success: false, error: '请提供当前密码和新密码' });
    }
    
    // 验证当前密码
    if (body.current_password !== DEFAULT_PASSWORD) {
      return jsonResponse({ success: false, error: '当前密码错误' });
    }
    
    // 保存新密码到 KV
    if (env.KV) {
      await env.KV.put('settings:admin_password', body.new_password);
    }
    
    await addLog(env, 'info', '修改管理员密码');
    return jsonResponse({ success: true });
  }
  
  // 获取设置
  if (path === '/api/settings' && method === 'GET') {
    let settings = {
      auto_renew: true,
      renew_days: 30,
      default_email: ''
    };
    
    if (env.KV) {
      const stored = await env.KV.get('settings:app_settings');
      if (stored) {
        settings = { ...settings, ...JSON.parse(stored) };
      }
    }
    
    return jsonResponse({ success: true, settings });
  }
  
  // 保存设置
  if (path === '/api/settings' && method === 'POST') {
    const body = await request.json();
    
    if (env.KV) {
      await env.KV.put('settings:app_settings', JSON.stringify(body));
      await env.KV.put('settings:default_email', body.default_email || '');
    }
    
    await addLog(env, 'info', '更新系统设置');
    return jsonResponse({ success: true });
  }
  
  return jsonResponse({ success: false, error: 'Not Found' }, 404);
}
