# CF 优选 IP · 智能双池管理系统

<p align="center">
  <img src="https://img.shields.io/badge/version-v4.6.2-blue" alt="version">
  <img src="https://img.shields.io/badge/platform-Cloudflare%20Workers%20%7C%20Pages-orange" alt="platform">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
</p>

基于 Cloudflare Workers/Pages 的 IP 优选工具，集成带宽测试、延迟测试、智能 DNS 更新、多国家分流、Telegram 通知等功能。

## 功能特性

### 核心功能

| 功能                 | 描述                  |
| ------------------ | ------------------- |
| 📡 **IP 智能测速**     | 自动发现、延迟测试、带宽测试      |
| 🎯 **双池管理**        | 带宽优质池 + 备用池智能分类     |
| 🌍 **访客感知**        | 自动识别访客地理位置，推荐最优 IP  |
| 🌐 **DNS 自动更新**    | 智能分流更新到不同国家/地区的域名   |
| 📱 **Telegram 通知** | 测速完成、DNS 更新实时推送     |
| 📥 **数据导出**        | 支持 CSV 格式导出优质/备用 IP |
| 🗑️ **自动清理**       | 智能清理失效 IP 和黑名单      |
| 📝 **日志管理**        | 3-7 天自动清理，支持实时查看    |

### 界面特性

- 🎨 **卡片式布局** - 模块化设计，支持折叠展开
- ⚙️ **可视化配置** - 参数设置一目了然
- 📊 **实时数据** - 测速结果即时展示
- 🔍 **智能搜索** - IP 快速筛选定位
- 🌙 **深色主题** - 护眼配色方案


### 登录界面
https://github.com/ldg118/CF-Worker-BestIP/blob/main/docs/images/1.png

### 操作界面
https://github.com/ldg118/CF-Worker-BestIP/blob/main/docs/images/2.png
https://github.com/ldg118/CF-Worker-BestIP/blob/main/docs/images/3.png

## 快速开始

### 方式一：一键部署到 Cloudflare Workers（推荐）

#### 步骤 1：创建 Workers 项目

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers 和 Pages**
3. 点击 **创建服务**
4. 服务名称填写 `cf-best-ip`
5. 点击 **部署**

#### 步骤 2：上传代码

1. 点击 **编辑代码**
2. 删除默认代码
3. 复制 [`worker.js`](./worker.js) 全部内容粘贴进去
4. 点击 **保存并部署**

#### 步骤 3：配置环境变量

进入 **设置** → **变量**，添加：

```
ADMIN_PASSWORD = your_secure_password
```

#### 步骤 4：创建并绑定 D1 数据库

1. 进入 **Workers 和 Pages** → **D1**
2. 点击 **创建数据库**，名称 `cf-best-ip-db`
3. 回到 Worker → **设置** → **绑定** → **添加**
4. 选择 **D1 数据库**，变量名 `DB`，选择刚创建的数据库

> **注意**：数据库表结构会自动初始化，无需手动执行 SQL。

#### 步骤 5：创建并绑定 KV

1. 进入 **Workers 和 Pages** → **KV**
2. 点击 **创建命名空间**，名称 `cf-best-ip-kv`
3. 回到 Worker → **设置** → **绑定** → **添加**
4. 选择 **KV 命名空间**，变量名 `KV`，选择刚创建的命名空间

#### 步骤 6：配置定时任务（可选）

进入 **设置** → **触发器** → **添加 Cron 触发器**：

```
0 * * * *    # 每小时执行一次
```

***

### 方式二：Cloudflare Pages 部署

Pages 部署适合需要快速部署前端界面，同时支持后端 Functions 的场景。**注意：Pages 不支持 Cron 定时任务**。

#### 方案 A：Git 仓库自动部署（推荐）

##### 步骤 1：Fork 本仓库

点击右上角 **Fork** 按钮，将项目复制到你的 GitHub 账户。

##### 步骤 2：创建 D1 和 KV（提前准备）

1. **创建 D1 数据库**：
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
   - 进入 **Workers 和 Pages** → **D1**
   - 点击 **创建数据库**，名称填写 `cf-best-ip-db`
   - 记录数据库 ID
2. **创建 KV 命名空间**：
   - 进入 **Workers 和 Pages** → **KV**
   - 点击 **创建命名空间**，名称填写 `cf-best-ip-kv`
   - 记录命名空间 ID
     **方案 B：使用 Wrangler CLI（适合熟悉命令行的用户）**

##### 步骤 3：配置 Cloudflare Pages

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers 和 Pages** → **创建项目** → **Pages**
3. 点击 **连接到 Git**
4. 授权并选择你 Fork 的仓库
5. 构建设置：
   - **框架预设**：`None`
   - **构建命令**：留空（无需构建）
   - **构建输出目录**：`./`
6. 点击 **保存并部署**

##### 步骤 4：绑定 D1 和 KV

1. 进入 Pages 项目 → **设置** → **函数**
2. **KV 命名空间绑定**：
   - 变量名：`KV`
   - 选择刚创建的 KV 命名空间
3. **D1 数据库绑定**：
   - 变量名：`DB`
   - 选择刚创建的 D1 数据库
4. 点击 **保存**

##### 步骤 5：配置环境变量

在 Pages 项目 → **设置** → **环境变量** 中添加：

```
ADMIN_PASSWORD = your_secure_password
```

##### 步骤 6：重新部署

在 Pages 控制台点击 **重新部署**，使绑定和环境变量生效。

> **注意**：数据库表结构会在首次访问时自动初始化，无需手动执行 SQL。

#### 方案 B：直接上传部署

适合不想使用 Git 的用户。

##### 步骤 1：准备文件

1. 下载本仓库代码
2. 确保文件结构如下：
   ```
   /
   ├── _worker.js          # 主程序
   ├── migrations/
   │   └── 001_init.sql    # 数据库初始化脚本
   └── public/
       └── index.html      # 可选的静态页面
   ```
3. 将上述文件打包成 zip 压缩包

##### 步骤 2：创建 Pages 项目

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers 和 Pages** → **创建项目** → **Pages**
3. 点击 **直接上传**
4. 项目名称填写 `cf-best-ip`
5. 上传准备好的 zip 压缩包
6. 点击 **部署**

##### 步骤 3：创建并绑定资源

同方案 A 的步骤 2、4、5、6。

> **原理说明**：Pages 支持两种 Worker 方式：
>
> - **根目录 Worker**（`_worker.js`）：简单直接，适合单文件应用
> - **Functions 目录**（`/functions/`）：支持复杂路由，适合多文件应用
>
> 本项目使用根目录 Worker 方式，直接使用 `_worker.js` 文件。

***

## 配置说明

### 必需配置

| 变量名              | 说明    | 示例                |
| ---------------- | ----- | ----------------- |
| `ADMIN_PASSWORD` | 管理员密码 | `MySecureP@ss123` |

### 可选配置

| 变量名                           | 说明           | 默认值  |
| ----------------------------- | ------------ | ---- |
| `DEFAULT_IP_COUNT`            | 默认返回 IP 数量   | `3`  |
| `DEFAULT_TEST_COUNT`          | 默认测试 IP 数量   | `50` |
| `DEFAULT_THREAD_COUNT`        | 默认测试线程数      | `10` |
| `DEFAULT_BANDWIDTH_FILE_SIZE` | 带宽测试文件大小(MB) | `3`  |
| `FAILED_IP_COOLDOWN_DAYS`     | 失败 IP 冷却天数   | `15` |
| `MAX_HIGH_QUALITY_POOL_SIZE`  | 最大优质池容量      | `30` |

***

## 使用指南

### 首次使用

1. 访问部署后的域名（如 `https://cf-best-ip.your-subdomain.workers.dev`）
2. 输入管理员密码登录
3. 进入 **DNS 设置** 配置：
   - Cloudflare API Token
   - 区域 ID
   - 域名映射
4. 进入 **运行参数** 调整测试配置
5. 点击 **开始测速**

### 多国家 DNS 分流

在 **DNS 设置** → **国家域名映射** 中配置：

| 国家 | 域名                      |
| -- | ----------------------- |
| CN | `cf-cn.your-domain.com` |
| US | `cf-us.your-domain.com` |
| JP | `cf-jp.your-domain.com` |

系统会自动将对应国家的 IP 更新到相应域名。

### Telegram 通知配置

1. 创建 Telegram Bot（[@BotFather](https://t.me/botfather)）
2. 获取 Chat ID（[@userinfobot](https://t.me/userinfobot)）
3. 在 **DNS 设置** → **Telegram 通知** 中填入

***

## 获取 API Token

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 点击右上角头像 → **My Profile**
3. 选择 **API Tokens** → **Create Token**
4. 使用 **Custom token** 模板
5. 权限配置：
   - Zone:Read
   - Zone.DNS:Edit
   - Cloudflare Pages:Edit（如使用 Pages）
   - D1:Edit
   - Workers Scripts:Edit
6. 资源选择你的账户和域名
7. 点击 **Create Token**

***

## 项目结构

```
cf-best-ip/
├── worker.js              # 主程序入口
├── migrations/
│   └── 001_init.sql       # 数据库初始化脚本
├── public/
│   └── index.html         # 静态页面（可选）
├── wrangler.toml          # Wrangler 配置
├── package.json           # 项目依赖
└── README.md              # 本文件
```

### 部署文件说明

| 文件                        | Workers 部署 | Pages 自动部署（Git） | Pages 直接上传 | 说明       |
| ------------------------- | ---------- | --------------- | ------------ | -------- |
| `worker.js`               | ✅ 直接使用     | ✅ 直接使用          | ⚠️ 可选（优先使用 _worker.js） | 主程序文件    |
| `_worker.js`              | ❌ 不使用      | ❌ 不使用           | ✅ 直接使用          | 主程序文件（Pages 专用） |
| `functions/[[path]].js`   | ❌ 不使用      | ✅ 推荐使用          | ✅ 推荐使用          | Pages Functions 入口（推荐） |
| `wrangler.toml`           | ✅ 必需       | ⚠️ 可选            | ⚠️ 可选         | 配置文件     |
| `migrations/001_init.sql` | ✅ 必需       | ✅ 必需            | ✅ 必需         | 数据库初始化脚本 |

> **注意**：
> - **Pages 自动部署（Git）**：推荐使用 `functions/[[path]].js`，这是 Pages 的现代推荐方式
> - **Pages 直接上传**：可以使用 `_worker.js` 或 `functions/[[path]].js`
> - **Workers 部署**：直接使用 `worker.js`，无需重命名

### 部署方式对比

| 方式                  | 文件要求         | 定时任务  | 推荐度     |
| ------------------- | ------------ | ----- | ------- |
| **方式一 Workers**     | `worker.js`  | ✅ 支持  | ⭐⭐⭐ 最推荐 |
| **方式二 A Pages 自动部署（Git）** | `functions/[[path]].js`  | ❌ 不支持 | ⭐⭐ 推荐   |
| **方式二 B Pages 直接上传**  | `_worker.js` 或 `functions/[[path]].js` | ❌ 不支持 | ⭐⭐ 推荐   |

***

## 常见问题

### Q: 部署后提示 "DB is not defined"

**A**: 未正确绑定 D1 数据库。请检查 Workers/Pages 设置中的绑定配置。

### Q: DNS 更新失败

**A**: 检查 API Token 是否有 Zone.DNS:Edit 权限，以及区域 ID 是否正确。

### Q: Telegram 通知收不到

**A**: 确认 Bot Token 和 Chat ID 正确，且已向 Bot 发送过 `/start`。

### Q: Pages 部署后定时任务不执行

**A**: Pages 不支持 Cron 触发器，如需定时任务请使用 Workers 部署。

### Q: Pages 上传部署后提示 Worker 错误

**A**: 确认根目录存在 `_worker.js` 文件，这是 Pages 识别 Worker 的必要条件。

***

## 技术栈

- **运行时**: Cloudflare Workers / Pages Functions
- **数据库**: Cloudflare D1 (SQLite)
- **缓存**: Cloudflare KV
- **前端**: 原生 HTML + CSS + JavaScript
- **部署**: Cloudflare Dashboard 控制台

***

## 更新日志

### v4.6.2

- 优化双池智能管理算法
- 新增访客地理位置感知
- 改进 UI 响应式设计
- 修复 DNS 批量更新问题

***

## 许可证

[MIT License](./LICENSE)

***

<p align="center">
  如果这个项目对你有帮助，请给个 ⭐ Star 支持一下！
</p>
