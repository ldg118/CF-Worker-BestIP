# CF 优选 IP

基于 Cloudflare Pages 的 IP 优选工具，支持带宽测试、延迟测试、智能 DNS 更新。

## 部署步骤

### 1. 安装依赖
```bash
npm install
```

### 2. 创建 D1 数据库
```bash
npm run d1:create
```
将返回的 `database_id` 填入 `wrangler.toml`。

### 3. 创建 KV 命名空间
```bash
npm run kv:create
```
将返回的 `id` 填入 `wrangler.toml`。

### 4. 执行数据库迁移
```bash
npm run d1:migrate
```

### 5. 部署到 Pages
```bash
npm run deploy
```

## 本地开发
```bash
npm run dev
```

## 配置说明

编辑 `wrangler.toml` 文件配置：
- `database_id` - D1 数据库 ID
- `id` / `preview_id` - KV 命名空间 ID
- `ADMIN_PASSWORD` - 管理员密码