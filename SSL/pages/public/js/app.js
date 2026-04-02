// DNS Manager Pro - Frontend JavaScript
// 适配 HTML 结构版本

const API_BASE = '/api';

// Global state
let currentTab = 'accounts';

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
    initEventListeners();
});

// Check authentication
async function checkAuth() {
    try {
        const response = await fetch(`${API_BASE}/auth/check`, {
            credentials: 'include'
        });
        
        if (response.ok) {
            showApp();
            loadStats();
            loadAccounts();
        } else {
            showLogin();
        }
    } catch (error) {
        showLogin();
    }
}

// Show login page
function showLogin() {
    document.getElementById('loginPage').style.display = 'flex';
    document.getElementById('appPage').style.display = 'none';
}

// Show main app
function showApp() {
    document.getElementById('loginPage').style.display = 'none';
    document.getElementById('appPage').style.display = 'block';
}

// Initialize event listeners
function initEventListeners() {
    // Login form
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    
    // Sidebar navigation
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.addEventListener('click', (e) => {
            const tab = item.dataset.tab;
            switchTab(tab);
        });
    });
}

// Handle login
async function handleLogin(e) {
    e.preventDefault();
    
    const password = document.getElementById('loginPassword').value;
    
    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showApp();
            loadStats();
            loadAccounts();
            showToast('登录成功', 'success');
        } else {
            showToast(data.error || '密码错误', 'error');
        }
    } catch (error) {
        console.error('Login error:', error);
        showToast('登录失败', 'error');
    }
}

// Logout
async function logout() {
    try {
        await fetch(`${API_BASE}/logout`, {
            method: 'POST',
            credentials: 'include'
        });
    } catch (error) {
        console.error('Logout error:', error);
    }
    showLogin();
}

// Switch tab
function switchTab(tab) {
    currentTab = tab;
    
    // Update sidebar active state
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.tab === tab) {
            item.classList.add('active');
        }
    });
    
    // Show corresponding tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`${tab}-tab`).classList.add('active');
    
    // Load tab data
    switch (tab) {
        case 'accounts':
            loadAccounts();
            break;
        case 'domains':
            loadDomains();
            break;
        case 'records':
            loadRecords();
            break;
        case 'certificates':
            loadCertificates();
            break;
        case 'logs':
            loadLogs();
            break;
    }
}

// Load statistics
async function loadStats() {
    try {
        const response = await fetch(`${API_BASE}/stats`, {
            credentials: 'include'
        });
        
        const data = await response.json();
        
        if (data.success && data.stats) {
            document.getElementById('accountCount').textContent = data.stats.accounts || 0;
            document.getElementById('domainCount').textContent = data.stats.domains || 0;
            document.getElementById('recordCount').textContent = data.stats.records || 0;
            document.getElementById('certCount').textContent = data.stats.certificates || 0;
        }
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

// Load accounts
async function loadAccounts() {
    try {
        const response = await fetch(`${API_BASE}/accounts`, {
            credentials: 'include'
        });
        
        const data = await response.json();
        
        if (data.success) {
            renderAccounts(data.accounts || []);
        }
    } catch (error) {
        console.error('Failed to load accounts:', error);
        showToast('加载账户失败', 'error');
    }
}

// Render accounts
function renderAccounts(accounts) {
    const container = document.getElementById('accountsList');
    
    if (accounts.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📁</div>
                <h3>暂无 DNS 账户</h3>
                <p>请点击上方按钮添加您的第一个账户</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = `
        <table class="data-table">
            <thead>
                <tr>
                    <th>名称</th>
                    <th>提供商</th>
                    <th>API Key</th>
                    <th>操作</th>
                </tr>
            </thead>
            <tbody>
                ${accounts.map(account => `
                    <tr>
                        <td>${account.name}</td>
                        <td>${account.provider}</td>
                        <td>${maskString(account.api_key)}</td>
                        <td>
                            <button class="btn btn-sm btn-primary" onclick="syncAccountDomains(${account.id})">同步</button>
                            <button class="btn btn-sm btn-danger" onclick="deleteAccount(${account.id})">删除</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

// Load domains
async function loadDomains() {
    try {
        const response = await fetch(`${API_BASE}/domains`, {
            credentials: 'include'
        });
        
        const data = await response.json();
        
        if (data.success) {
            renderDomains(data.domains || []);
            updateDomainSelect(data.domains || []);
        }
    } catch (error) {
        console.error('Failed to load domains:', error);
        showToast('加载域名失败', 'error');
    }
}

// Render domains
function renderDomains(domains) {
    const container = document.getElementById('domainsList');
    
    if (domains.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🌐</div>
                <h3>暂无域名</h3>
                <p>请先添加 DNS 账户并同步，或手动添加第三方域名</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = `
        <table class="data-table">
            <thead>
                <tr>
                    <th>域名</th>
                    <th>账户</th>
                    <th>类型</th>
                    <th>操作</th>
                </tr>
            </thead>
            <tbody>
                ${domains.map(domain => `
                    <tr>
                        <td>${domain.name}</td>
                        <td>${domain.account_name || '-'}</td>
                        <td>${domain.is_manual ? '手动' : 'API'}</td>
                        <td>
                            <button class="btn btn-sm btn-primary" onclick="applySSL('${domain.name}')">申请SSL</button>
                            <button class="btn btn-sm btn-danger" onclick="deleteDomain(${domain.id})">删除</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

// Update domain select dropdown
function updateDomainSelect(domains) {
    const select = document.getElementById('domainSelect');
    select.innerHTML = '<option value="">选择域名</option>' +
        domains.map(d => `<option value="${d.name}">${d.name}</option>`).join('');
}

// Load records
async function loadRecords() {
    const domain = document.getElementById('domainSelect').value;
    if (!domain) {
        document.getElementById('recordsList').innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📝</div>
                <h3>请选择域名</h3>
                <p>选择域名后查看解析记录</p>
            </div>
        `;
        return;
    }
    
    // TODO: 实现加载解析记录
    showToast('解析记录功能开发中', 'info');
}

// Load certificates
async function loadCertificates() {
    try {
        const response = await fetch(`${API_BASE}/certificates`, {
            credentials: 'include'
        });
        
        const data = await response.json();
        
        if (data.success) {
            renderCertificates(data.certificates || []);
        }
    } catch (error) {
        console.error('Failed to load certificates:', error);
        showToast('加载证书失败', 'error');
    }
}

// Render certificates
function renderCertificates(certificates) {
    const container = document.getElementById('certificatesList');
    
    if (certificates.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🔒</div>
                <h3>暂无 SSL 证书</h3>
                <p>点击上方按钮申请您的第一个证书</p>
            </div>
        `;
        return;
    }
    
    const now = new Date();
    
    container.innerHTML = `
        <table class="data-table">
            <thead>
                <tr>
                    <th>域名</th>
                    <th>颁发者</th>
                    <th>有效期至</th>
                    <th>状态</th>
                    <th>操作</th>
                </tr>
            </thead>
            <tbody>
                ${certificates.map(cert => {
                    const expireDate = new Date(cert.valid_to);
                    const daysLeft = Math.ceil((expireDate - now) / (1000 * 60 * 60 * 24));
                    let statusClass = 'badge-success';
                    let statusText = '有效';
                    
                    if (daysLeft <= 0) {
                        statusClass = 'badge-danger';
                        statusText = '已过期';
                    } else if (daysLeft <= 7) {
                        statusClass = 'badge-warning';
                        statusText = `${daysLeft}天后过期`;
                    }
                    
                    return `
                        <tr>
                            <td>${cert.domain_name}</td>
                            <td>${cert.issuer || 'Let\'s Encrypt'}</td>
                            <td>${formatDate(cert.valid_to)}</td>
                            <td><span class="badge ${statusClass}">${statusText}</span></td>
                            <td>
                                <button class="btn btn-sm btn-primary" onclick="viewCertificate(${cert.id})">查看</button>
                                <button class="btn btn-sm btn-warning" onclick="renewCertificate(${cert.id})">续期</button>
                                <button class="btn btn-sm btn-danger" onclick="deleteCertificate(${cert.id})">删除</button>
                            </td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;
}

// Load logs
async function loadLogs() {
    try {
        const response = await fetch(`${API_BASE}/logs`, {
            credentials: 'include'
        });
        
        const data = await response.json();
        
        if (data.success) {
            renderLogs(data.logs || []);
        }
    } catch (error) {
        console.error('Failed to load logs:', error);
        showToast('加载日志失败', 'error');
    }
}

// Render logs
function renderLogs(logs) {
    const container = document.getElementById('logsList');
    
    if (logs.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📋</div>
                <h3>暂无日志</h3>
                <p>系统操作记录将显示在这里</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = `
        <table class="data-table">
            <thead>
                <tr>
                    <th>时间</th>
                    <th>级别</th>
                    <th>消息</th>
                </tr>
            </thead>
            <tbody>
                ${logs.map(log => `
                    <tr>
                        <td>${formatDateTime(log.created_at)}</td>
                        <td><span class="badge badge-${log.level}">${log.level}</span></td>
                        <td>${log.message}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

// Show account modal
function showAccountModal() {
    const name = prompt('账户名称：');
    if (!name) return;
    
    const provider = 'cloudflare';
    const apiKey = prompt('API Token：');
    if (!apiKey) return;
    
    addAccount({ name, provider, api_key: apiKey });
}

// Add account
async function addAccount(account) {
    try {
        const response = await fetch(`${API_BASE}/accounts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(account)
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('账户添加成功', 'success');
            loadAccounts();
            loadStats();
        } else {
            showToast(data.error || '添加失败', 'error');
        }
    } catch (error) {
        console.error('Failed to add account:', error);
        showToast('添加账户失败', 'error');
    }
}

// Delete account
async function deleteAccount(id) {
    if (!confirm('确定要删除这个账户吗？')) return;
    
    try {
        const response = await fetch(`${API_BASE}/accounts/${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('账户删除成功', 'success');
            loadAccounts();
            loadStats();
        } else {
            showToast(data.error || '删除失败', 'error');
        }
    } catch (error) {
        console.error('Failed to delete account:', error);
        showToast('删除账户失败', 'error');
    }
}

// Sync account domains
async function syncAccountDomains(id) {
    showToast('正在同步域名...', 'info');
    
    try {
        const response = await fetch(`${API_BASE}/accounts/${id}/sync`, {
            method: 'POST',
            credentials: 'include'
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast(`同步成功，新增 ${data.count} 个域名`, 'success');
            loadDomains();
            loadStats();
        } else {
            showToast(data.error || '同步失败', 'error');
        }
    } catch (error) {
        console.error('Failed to sync domains:', error);
        showToast('同步域名失败', 'error');
    }
}

// Show manual domain modal
function showManualDomainModal() {
    const name = prompt('请输入域名（如：example.com）：');
    if (!name) return;
    
    addManualDomain(name.trim());
}

// Add manual domain
async function addManualDomain(name) {
    try {
        const response = await fetch(`${API_BASE}/domains/manual`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ name })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('域名添加成功', 'success');
            loadDomains();
            loadStats();
        } else {
            showToast(data.error || '添加失败', 'error');
        }
    } catch (error) {
        console.error('Failed to add domain:', error);
        showToast('添加域名失败', 'error');
    }
}

// Delete domain
async function deleteDomain(id) {
    if (!confirm('确定要删除这个域名吗？')) return;
    
    try {
        const response = await fetch(`${API_BASE}/domains/${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('域名删除成功', 'success');
            loadDomains();
            loadStats();
        } else {
            showToast(data.error || '删除失败', 'error');
        }
    } catch (error) {
        console.error('Failed to delete domain:', error);
        showToast('删除域名失败', 'error');
    }
}

// Apply SSL for domain
async function applySSL(domainName) {
    if (!confirm(`确定为域名 ${domainName} 申请 SSL 证书吗？`)) return;
    
    showToast('正在申请 SSL 证书...', 'info');
    
    try {
        const response = await fetch(`${API_BASE}/ssl/apply`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ domain: domainName })
        });
        
        const data = await response.json();
        
        if (data.success && data.stage === 'dns_required') {
            showDNSVerificationModal(data, domainName);
        } else if (data.success) {
            showToast('SSL 证书申请成功', 'success');
            loadCertificates();
            loadStats();
        } else {
            showToast(data.error || '申请失败', 'error');
        }
    } catch (error) {
        console.error('Failed to apply SSL:', error);
        showToast('申请 SSL 证书失败', 'error');
    }
}

// Show DNS verification modal
function showDNSVerificationModal(data, domainName) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <div class="modal-header">
                <h3>DNS 验证 - ${domainName}</h3>
                <button class="btn-close" onclick="this.closest('.modal').remove()">&times;</button>
            </div>
            <div class="modal-body">
                <p>请添加以下 DNS TXT 记录：</p>
                <div style="background: #1a1a2e; padding: 16px; border-radius: 8px; margin: 16px 0; font-family: monospace;">
                    <div style="margin-bottom: 8px;"><strong>类型：</strong>TXT</div>
                    <div style="margin-bottom: 8px;"><strong>名称：</strong>${data.dnsRecord.name}</div>
                    <div style="margin-bottom: 8px; word-break: break-all;"><strong>值：</strong>${data.dnsRecord.value}</div>
                    <div><strong>TTL：</strong>${data.dnsRecord.ttl}</div>
                </div>
                <p style="color: var(--text-secondary);">添加后等待 1-5 分钟，然后点击验证</p>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-primary" onclick="verifySSL('${data.orderUrl.split('/').pop()}', this)">验证</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

// Verify SSL
async function verifySSL(orderId, btn) {
    btn.disabled = true;
    btn.textContent = '验证中...';
    
    try {
        const response = await fetch(`${API_BASE}/ssl/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ orderId })
        });
        
        const data = await response.json();
        
        if (data.success) {
            btn.closest('.modal').remove();
            showToast('SSL 证书申请成功', 'success');
            loadCertificates();
            loadStats();
        } else {
            showToast(data.error || '验证失败', 'error');
            btn.disabled = false;
            btn.textContent = '验证';
        }
    } catch (error) {
        console.error('Failed to verify SSL:', error);
        showToast('验证失败', 'error');
        btn.disabled = false;
        btn.textContent = '验证';
    }
}

// View certificate
async function viewCertificate(id) {
    try {
        const response = await fetch(`${API_BASE}/certificates/${id}`, {
            credentials: 'include'
        });
        
        const data = await response.json();
        
        if (data.success && data.certificate) {
            const cert = data.certificate;
            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content" style="max-width: 700px;">
                    <div class="modal-header">
                        <h3>证书详情 - ${cert.domain_name}</h3>
                        <button class="btn-close" onclick="this.closest('.modal').remove()">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div class="form-group">
                            <label>证书 (CRT)</label>
                            <textarea class="form-control" rows="8" readonly style="font-family: monospace; font-size: 12px;">${cert.certificate || '暂无'}</textarea>
                        </div>
                        <div class="form-group">
                            <label>私钥 (KEY)</label>
                            <textarea class="form-control" rows="8" readonly style="font-family: monospace; font-size: 12px;">${cert.private_key || '暂无'}</textarea>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }
    } catch (error) {
        console.error('Failed to view certificate:', error);
        showToast('获取证书详情失败', 'error');
    }
}

// Renew certificate
async function renewCertificate(id) {
    if (!confirm('确定要续期这个证书吗？')) return;
    
    showToast('正在续期证书...', 'info');
    
    try {
        const response = await fetch(`${API_BASE}/certificates/${id}/renew`, {
            method: 'POST',
            credentials: 'include'
        });
        
        const data = await response.json();
        
        if (data.success && data.stage === 'dns_required') {
            showDNSVerificationModal(data, '续期域名');
        } else if (data.success) {
            showToast('证书续期成功', 'success');
            loadCertificates();
        } else {
            showToast(data.error || '续期失败', 'error');
        }
    } catch (error) {
        console.error('Failed to renew certificate:', error);
        showToast('续期证书失败', 'error');
    }
}

// Delete certificate
async function deleteCertificate(id) {
    if (!confirm('确定要删除这个证书吗？')) return;
    
    try {
        const response = await fetch(`${API_BASE}/certificates/${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('证书删除成功', 'success');
            loadCertificates();
            loadStats();
        } else {
            showToast(data.error || '删除失败', 'error');
        }
    } catch (error) {
        console.error('Failed to delete certificate:', error);
        showToast('删除证书失败', 'error');
    }
}

// Show change password modal
function showChangePasswordModal() {
    const currentPassword = prompt('当前密码：');
    if (!currentPassword) return;
    
    const newPassword = prompt('新密码：');
    if (!newPassword) return;
    
    const confirmPassword = prompt('确认新密码：');
    if (newPassword !== confirmPassword) {
        showToast('两次输入的密码不一致', 'error');
        return;
    }
    
    changePassword(currentPassword, newPassword);
}

// Change password
async function changePassword(currentPassword, newPassword) {
    try {
        const response = await fetch(`${API_BASE}/auth/password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('密码修改成功', 'success');
        } else {
            showToast(data.error || '修改失败', 'error');
        }
    } catch (error) {
        console.error('Failed to change password:', error);
        showToast('修改密码失败', 'error');
    }
}

// Sync all domains
async function syncDomains() {
    showToast('请先选择账户进行同步', 'info');
}

// Sync records
async function syncRecords() {
    showToast('解析记录同步功能开发中', 'info');
}

// Show record modal
function showRecordModal() {
    showToast('添加解析记录功能开发中', 'info');
}

// Show cert modal
function showCertModal() {
    const domain = prompt('请输入要申请证书的域名：');
    if (domain) {
        applySSL(domain.trim());
    }
}

// Utility functions
function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString('zh-CN');
}

function formatDateTime(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN');
}

function maskString(str) {
    if (!str) return '-';
    if (str.length <= 8) return '****';
    return str.substring(0, 4) + '****' + str.substring(str.length - 4);
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast toast-${type} show`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}
