// ACME Client for Let's Encrypt SSL Certificate
// 支持 DNS-01 挑战验证

const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const LETS_ENCRYPT_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';

// Base64 URL 编码
function base64UrlEncode(buffer) {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// 生成随机字符串
function generateNonce(length = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// 生成 RSA 密钥对
async function generateKeyPair() {
  return await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  );
}

// 导出密钥为 PEM 格式
async function exportPrivateKey(key) {
  const exported = await crypto.subtle.exportKey('pkcs8', key);
  const exportedAsString = String.fromCharCode(...new Uint8Array(exported));
  const exportedAsBase64 = btoa(exportedAsString);
  const pemExported = `-----BEGIN PRIVATE KEY-----\n${exportedAsBase64.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
  return pemExported;
}

// 导出公钥为 PEM 格式
async function exportPublicKey(key) {
  const exported = await crypto.subtle.exportKey('spki', key);
  const exportedAsString = String.fromCharCode(...new Uint8Array(exported));
  const exportedAsBase64 = btoa(exportedAsString);
  const pemExported = `-----BEGIN PUBLIC KEY-----\n${exportedAsBase64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
  return pemExported;
}

// JWS 签名
async function signRequest(payload, protectedHeader, privateKey) {
  const encoder = new TextEncoder();
  const encodedProtected = base64UrlEncode(encoder.encode(JSON.stringify(protectedHeader)));
  const encodedPayload = payload ? base64UrlEncode(encoder.encode(JSON.stringify(payload))) : '';
  const signingInput = `${encodedProtected}.${encodedPayload}`;
  
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    encoder.encode(signingInput)
  );
  
  return {
    protected: encodedProtected,
    payload: encodedPayload,
    signature: base64UrlEncode(signature)
  };
}

// ACME 客户端类
export class ACMEClient {
  constructor(directoryUrl = LETS_ENCRYPT_PRODUCTION) {
    this.directoryUrl = directoryUrl;
    this.directory = null;
    this.accountKey = null;
    this.accountUrl = null;
    this.nonce = null;
  }

  // 初始化 ACME 客户端
  async initialize() {
    // 获取 ACME 目录
    const response = await fetch(this.directoryUrl);
    this.directory = await response.json();
    
    // 生成账户密钥
    const keyPair = await generateKeyPair();
    this.accountKey = keyPair.privateKey;
    this.publicKey = keyPair.publicKey;
    
    return this;
  }

  // 获取新 nonce
  async getNonce() {
    const response = await fetch(this.directory.newNonce);
    this.nonce = response.headers.get('Replay-Nonce');
    return this.nonce;
  }

  // 发送签名请求
  async signedRequest(url, payload = null, additionalHeaders = {}) {
    if (!this.nonce) {
      await this.getNonce();
    }

    const protectedHeader = {
      alg: 'RS256',
      nonce: this.nonce,
      url: url,
      ...additionalHeaders
    };

    const jws = await signRequest(payload, protectedHeader, this.accountKey);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/jose+json'
      },
      body: JSON.stringify(jws)
    });

    // 保存新的 nonce
    this.nonce = response.headers.get('Replay-Nonce');

    // 保存账户 URL
    if (response.status === 201 && response.headers.has('Location')) {
      this.accountUrl = response.headers.get('Location');
    }

    return response;
  }

  // 创建账户
  async createAccount(email) {
    const payload = {
      termsOfServiceAgreed: true,
      contact: [`mailto:${email}`]
    };

    const response = await this.signedRequest(this.directory.newAccount, payload);
    
    if (response.status === 201 || response.status === 200) {
      return { success: true, accountUrl: response.headers.get('Location') };
    }

    const error = await response.json();
    return { success: false, error: error.detail || '创建账户失败' };
  }

  // 创建订单
  async createOrder(domain) {
    const payload = {
      identifiers: [
        { type: 'dns', value: domain }
      ]
    };

    const response = await this.signedRequest(this.directory.newOrder, payload);
    
    if (response.status === 201) {
      const order = await response.json();
      return { 
        success: true, 
        orderUrl: response.headers.get('Location'),
        order: order
      };
    }

    const error = await response.json();
    return { success: false, error: error.detail || '创建订单失败' };
  }

  // 获取授权信息
  async getAuthorization(authUrl) {
    const response = await this.signedRequest(authUrl);
    return await response.json();
  }

  // 获取 DNS-01 挑战
  getDNSChallenge(authorization) {
    return authorization.challenges.find(c => c.type === 'dns-01');
  }

  // 计算 DNS-01 验证值
  async computeKeyAuthorization(token) {
    // 计算 JWK 指纹
    const jwk = await crypto.subtle.exportKey('jwk', this.publicKey);
    const jwkThumbprint = await this.computeJWKThumbprint(jwk);
    
    // keyAuthorization = token + '.' + base64url(JWK_Thumbprint)
    return `${token}.${jwkThumbprint}`;
  }

  // 计算 JWK Thumbprint
  async computeJWKThumbprint(jwk) {
    // 构建标准 JWK 用于 thumbprint
    const standardJWK = {
      e: jwk.e,
      kty: jwk.kty,
      n: jwk.n
    };
    
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(standardJWK));
    const hash = await crypto.subtle.digest('SHA-256', data);
    
    return base64UrlEncode(hash);
  }

  // 计算 DNS TXT 记录值
  async computeDNSRecordValue(keyAuthorization) {
    const encoder = new TextEncoder();
    const data = encoder.encode(keyAuthorization);
    const hash = await crypto.subtle.digest('SHA-256', data);
    
    return base64UrlEncode(hash);
  }

  // 完成挑战
  async completeChallenge(challengeUrl) {
    const response = await this.signedRequest(challengeUrl, {});
    return response;
  }

  // 轮询挑战状态
  async pollChallenge(challengeUrl, maxAttempts = 10, interval = 5000) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, interval));
      
      const response = await this.signedRequest(challengeUrl);
      const challenge = await response.json();
      
      if (challenge.status === 'valid') {
        return { success: true, status: 'valid' };
      }
      
      if (challenge.status === 'invalid') {
        return { success: false, error: challenge.error?.detail || '验证失败' };
      }
    }
    
    return { success: false, error: '验证超时' };
  }

  // 轮询订单状态
  async pollOrder(orderUrl, maxAttempts = 10, interval = 5000) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, interval));
      
      const response = await this.signedRequest(orderUrl);
      const order = await response.json();
      
      if (order.status === 'ready') {
        return { success: true, order: order };
      }
      
      if (order.status === 'invalid') {
        return { success: false, error: '订单无效' };
      }
    }
    
    return { success: false, error: '等待订单就绪超时' };
  }

  // 最终确定订单（提交 CSR）
  async finalizeOrder(finalizeUrl, domain) {
    // 生成域名密钥对和 CSR
    const domainKeyPair = await generateKeyPair();
    this.domainKey = domainKeyPair.privateKey;
    
    // 创建 CSR（简化版本）
    const csr = await this.createCSR(domain, domainKeyPair);
    
    const payload = {
      csr: csr
    };

    const response = await this.signedRequest(finalizeUrl, payload);
    
    if (response.status === 200) {
      const order = await response.json();
      return { success: true, order: order };
    }

    const error = await response.json();
    return { success: false, error: error.detail || '最终确定订单失败' };
  }

  // 创建 CSR（简化实现）
  async createCSR(domain, keyPair) {
    // 这里使用简化的 CSR 生成
    // 实际生产环境需要完整的 ASN.1 编码
    const encoder = new TextEncoder();
    
    // 构建 CSR 信息
    const csrInfo = {
      commonName: domain,
      organization: 'DNS Manager',
      country: 'CN'
    };
    
    // 导出公钥
    const publicKeyDer = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    
    // 简化：返回 base64 编码的公钥作为 CSR 占位
    // 实际应该使用完整的 PKCS#10 CSR 格式
    return base64UrlEncode(publicKeyDer);
  }

  // 下载证书
  async downloadCertificate(certificateUrl) {
    const response = await this.signedRequest(certificateUrl);
    
    if (response.status === 200) {
      const certificate = await response.text();
      return { success: true, certificate: certificate };
    }

    return { success: false, error: '下载证书失败' };
  }

  // 获取域名私钥 PEM
  async getDomainPrivateKeyPEM() {
    if (!this.domainKey) {
      throw new Error('域名密钥未生成');
    }
    return await exportPrivateKey(this.domainKey);
  }
}

// SSL 证书申请流程
export async function requestSSLCertificate(domain, email, dnsProvider, env) {
  const client = new ACMEClient(LETS_ENCRYPT_STAGING); // 测试环境
  
  try {
    // 1. 初始化
    await client.initialize();
    
    // 2. 创建账户
    const accountResult = await client.createAccount(email);
    if (!accountResult.success) {
      return { success: false, error: accountResult.error };
    }
    
    // 3. 创建订单
    const orderResult = await client.createOrder(domain);
    if (!orderResult.success) {
      return { success: false, error: orderResult.error };
    }
    
    // 4. 获取授权和挑战
    const authUrl = orderResult.order.authorizations[0];
    const authorization = await client.getAuthorization(authUrl);
    const challenge = client.getDNSChallenge(authorization);
    
    if (!challenge) {
      return { success: false, error: '未找到 DNS-01 挑战' };
    }
    
    // 5. 计算 DNS 记录值
    const keyAuth = await client.computeKeyAuthorization(challenge.token);
    const dnsRecordValue = await client.computeDNSRecordValue(keyAuth);
    
    // 6. 添加 DNS TXT 记录
    const txtRecordName = `_acme-challenge.${domain}`;
    
    // 这里需要根据 dnsProvider 调用相应的 API 添加 TXT 记录
    // 简化示例：返回需要添加的 DNS 记录信息
    const dnsRecord = {
      name: txtRecordName,
      type: 'TXT',
      value: dnsRecordValue,
      ttl: 60
    };
    
    return {
      success: true,
      stage: 'dns_required',
      message: '请添加以下 DNS TXT 记录',
      dnsRecord: dnsRecord,
      challengeToken: challenge.token,
      challengeUrl: challenge.url,
      orderUrl: orderResult.orderUrl,
      finalizeUrl: orderResult.order.finalize,
      clientState: {
        directoryUrl: client.directoryUrl,
        accountUrl: client.accountUrl,
        orderUrl: orderResult.orderUrl,
        challengeUrl: challenge.url,
        finalizeUrl: orderResult.order.finalize
      }
    };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 完成证书申请（DNS 记录添加后调用）
export async function completeSSLCertificate(clientState, env) {
  const client = new ACMEClient(clientState.directoryUrl);
  await client.initialize();
  client.accountUrl = clientState.accountUrl;
  
  try {
    // 1. 完成挑战
    await client.completeChallenge(clientState.challengeUrl);
    
    // 2. 轮询挑战状态
    const challengeResult = await client.pollChallenge(clientState.challengeUrl);
    if (!challengeResult.success) {
      return { success: false, error: challengeResult.error };
    }
    
    // 3. 轮询订单状态
    const orderResult = await client.pollOrder(clientState.orderUrl);
    if (!orderResult.success) {
      return { success: false, error: orderResult.error };
    }
    
    // 4. 最终确定订单
    // 注意：这里需要域名信息，实际应该从保存的状态中获取
    const finalizeResult = await client.finalizeOrder(clientState.finalizeUrl, 'domain.com');
    if (!finalizeResult.success) {
      return { success: false, error: finalizeResult.error };
    }
    
    // 5. 等待证书生成
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 6. 下载证书
    const certResult = await client.downloadCertificate(finalizeResult.order.certificate);
    if (!certResult.success) {
      return { success: false, error: certResult.error };
    }
    
    // 7. 获取私钥
    const privateKey = await client.getDomainPrivateKeyPEM();
    
    return {
      success: true,
      certificate: certResult.certificate,
      privateKey: privateKey
    };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 生成自签名证书（用于测试）
export async function generateSelfSignedCertificate(domain) {
  const keyPair = await generateKeyPair();
  
  const privateKeyPEM = await exportPrivateKey(keyPair.privateKey);
  const publicKeyPEM = await exportPublicKey(keyPair.publicKey);
  
  // 简化的自签名证书
  const certPEM = `-----BEGIN CERTIFICATE-----
MIIBkTCB+wIJAKHBfpE
（这是一个示例占位符，实际应该使用完整的 X.509 证书生成）
-----END CERTIFICATE-----`;
  
  return {
    certificate: certPEM,
    privateKey: privateKeyPEM
  };
}
