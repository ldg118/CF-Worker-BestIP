# DNS Manager - 域名与 SSL 证书管理系统

基于 Cloudflare Pages 的域名管理和 SSL 证书申请系统，支持多 DNS 提供商、手动域名添加和 Let's Encrypt SSL 证书自动申请。

## 功能特性

- **多 DNS 提供商支持**：Cloudflare（可扩展其他提供商）
- **域名管理**：
  - API 自动同步域名列表
  - 手动添加第三方域名（无法 API 同步的小域名）
  - 域名状态监控
- **SSL 证书管理**：
  - Let's Encrypt SSL 证书申请（DNS-01 验证）
  - 证书续期提醒和自动续期
  - 证书下载（CRT + KEY）
- **系统功能**：
  - 登录认证和密码管理
  - 系统日志记录
  - 自动续期配置

## 为什么选择 Cloudflare Pages？

相比 Workers，Pages Functions 提供：
- **更长的执行时间**：30秒（Workers 仅 50ms-10s）
- **适合 ACME 流程**：SSL 证书申请需要等待 DNS 传播和验证
- **更好的文件组织**：前后端代码分离

## 快速部署

### 方式一：Cloudflare Dashboard 部署（推荐）

1. **创建 D1 数据库**
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
   - 进入 "Workers & Pages" → "D1"
   - 点击 "Create"，命名为 `dns-manager-db`

2. **创建 KV 命名空间**
   - 进入 "Workers & Pages" → "KV"
   - 创建一个命名空间：`DNS_MANAGER_KV`

3. **创建 Pages 项目**
   - 进入 "Workers & Pages" → "Create application"
   - 选择 "Pages" → "Upload assets"
   - 上传 `pages` 目录下的所有文件

4. **绑定资源**
   - 在项目设置中，绑定 D1 数据库：
     - Variable name: `DB`
     - Database: `dns-manager-db`
   - 绑定 KV 命名空间：
     - Variable name: `KV`
     - KV namespace: `DNS_MANAGER_KV`

5. **重新部署**
   - 绑定资源后，重新部署项目

### 方式二：Git 集成部署

1. **Fork/创建 Git 仓库**
   - 将 `pages` 目录推送到 GitHub/GitLab

2. **连接 Cloudflare Pages**
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
   - 进入 "Workers & Pages" → "Create application"
   - 选择 "Pages" → "Connect to Git"
   - 选择你的仓库

3. **配置构建设置**
   - Build command: （留空，静态站点）
   - Build output directory: `public`

4. **绑定资源**（同上）
   - 部署完成后，在设置中绑定 D1 和 KV

## 配置说明

### 1. 默认登录信息

- **默认密码**: `admin123`
- **建议**: 首次登录后立即修改密码

### 2. DNS 提供商配置

#### Cloudflare

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 "My Profile" → "API Tokens"
3. 点击 "Create Token"
4. 使用模板 "Edit zone DNS"
5. 或自定义权限：
   - Zone:Read
   - DNS:Edit
6. 复制 Token 到系统添加账户

### 3. SSL 证书申请流程

1. **申请证书**
   - 在域名列表点击 "申请SSL"
   - 系统创建 ACME 订单并返回 DNS TXT 记录

2. **添加 DNS 记录**
   - 在域名 DNS 管理界面添加 TXT 记录
   - 记录名：`_acme-challenge.yourdomain.com`
   - 记录值：系统提供的值

3. **验证并下载**
   - 等待 DNS 生效（通常 1-5 分钟）
   - 点击 "我已添加，开始验证"
   - 验证通过后自动下载证书

4. **使用证书**
   - 在证书列表点击 "查看"
   - 复制证书内容（CRT）和私钥（KEY）
   - 配置到服务器或 CDN

## 使用指南

### 首次使用

1. 访问部署的 Pages URL
2. 使用默认密码 `admin123` 登录
3. 立即修改密码（系统设置页面）
4. 添加 DNS 账户
5. 同步或手动添加域名
6. 开始申请 SSL 证书

### 添加 DNS 账户

1. 点击左侧 "账户管理" 菜单
2. 点击 "添加账户" 按钮
3. 输入账户名称（自定义）
4. 选择提供商（Cloudflare）
5. 输入 API Token
6. 保存

### 同步域名

1. 添加账户后，点击 "域名管理" 菜单
2. 点击 "同步域名" 按钮
3. 系统会自动从 DNS 提供商获取域名列表

### 手动添加第三方域名

对于无法通过 API 同步的域名：

1. 点击 "域名管理" 菜单
2. 点击 "添加域名" 按钮
3. 输入域名名称
4. 保存后即可申请 SSL 证书

**注意**：手动添加的域名标记为"手动"类型

## 技术栈

- **平台**: Cloudflare Pages Functions
- **数据库**: Cloudflare D1 (SQLite)
- **缓存/会话**: Cloudflare KV
- **前端**: 原生 HTML5 + CSS3 + JavaScript
- **SSL**: Let's Encrypt ACME v2 协议

## 项目结构

```
pages/
├── functions/
│   ├── api/
│   │   └── [[path]].js      # API 路由入口
│   └── src/
│       ├── index.js         # 核心业务逻辑
│       └── acme.js          # ACME 客户端实现
├── public/
│   ├── css/
│   │   └── style.css        # 样式文件
│   ├── js/
│   │   └── app.js           # 前端交互逻辑
│   └── index.html           # 主页面
├── wrangler.toml            # Wrangler 配置
└── README.md                # 使用说明
```

## 数据存储说明

### D1 数据库（关系型数据）
- `dns_accounts` - DNS 账户信息
- `domains` - 域名列表
- `ssl_certificates` - SSL 证书存储
- `ssl_orders` - SSL 申请订单
- `system_logs` - 系统日志

### KV 存储（临时数据）
- `KV` - 用于存储会话、设置、SSL订单状态等临时数据

## 安全建议

1. **修改默认密码**：首次登录后立即修改
2. **使用强密码**：建议 8 位以上，包含大小写字母和数字
3. **保护 API Token**：不要泄露 DNS 提供商的 API Token
4. **定期查看日志**：监控异常操作
5. **使用 HTTPS**：Cloudflare Pages 默认启用 HTTPS

## 注意事项

1. **D1 数据库**：目前处于 Beta 阶段，建议定期备份重要数据
2. **SSL 证书**：Let's Encrypt 证书有效期 90 天，系统支持自动续期
3. **DNS 传播**：SSL 验证需要等待 DNS 记录传播，通常 1-5 分钟
4. **执行时间**：Pages Functions 最长执行 30 秒，适合 ACME 流程

## 许可证

MIT License
