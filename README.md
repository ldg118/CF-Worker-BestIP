# CF 优选 IP · 双池智能优选

基于 Cloudflare Workers 的 IP 优选工具，支持带宽测试、延迟测试、智能 DNS 更新。
感觉有帮助的可以留颗小✨✨哦

## 功能特性

- 📡 IP 自动发现与测速
- 🎯 双池智能优选（带宽池 + 备用池）
- ⚡ 访客位置感知
- 🌐 自动 DNS 更新
- 📊 实时测速结果
- 📥 优质 IP 导出 (CSV格式)
- 🔧 数据库状态监控
- 🧠 智能测速策略
- 🗑️ 清理带宽池
- 🔍 搜索 IP 地址
- 📱 Telegram 通知
- ⏰ 定时任务维护
- 🔄 智能速率限制
- 📌 自定义 IP 导入
- 🌍 多地区 IP 管理
- 📝 日志管理（支持3-7天自动清理）

## 界面

### 1. 登录界面

<img width="1359" height="596" alt="image" src="https://github.com/user-attachments/assets/76593897-f556-4b4a-9c4c-6116b2ebf5fa" />

### 2. 操作界面

<img width="1350" height="599" alt="image" src="https://github.com/user-attachments/assets/a39c7b6c-a8c1-425c-a1f3-8f90c67a7b99" />
<img width="1352" height="591" alt="image" src="https://github.com/user-attachments/assets/11864fa9-908a-424e-9015-5051abe14c7f" />
<img width="1350" height="596" alt="image" src="https://github.com/user-attachments/assets/52abcb0f-216f-48fb-ab7e-37ed42704819" />

## 部署步骤

### 1. 准备工作

- Cloudflare 账号
- Workers KV 命名空间
- D1 数据库

### 2. 配置 KV 命名空间

1. 创建 KV 命名空间：`cf-best-ip`
2. 记录 KV 命名空间 ID

### 3. 配置 D1 数据库

1. 创建 D1 数据库：`cf-best-ip-db`
2. 执行初始化 SQL：

```sql
-- 系统日志表
CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_str TEXT,
  message TEXT
);

-- 测速结果表
CREATE TABLE IF NOT EXISTS speed_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT UNIQUE,
  latency REAL,
  bandwidth REAL,
  country TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 带宽优质池
CREATE TABLE IF NOT EXISTS high_quality_ips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT UNIQUE,
  latency REAL,
  bandwidth REAL,
  country TEXT,
  city TEXT,
  star_level INTEGER,
  last_tested TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  quality_type TEXT
);

-- 备用池
CREATE TABLE IF NOT EXISTS backup_quality_ips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT UNIQUE,
  latency REAL,
  bandwidth REAL,
  country TEXT,
  last_tested TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 失败 IP 表
CREATE TABLE IF NOT EXISTS failed_ips (
  ip TEXT PRIMARY KEY,
  failed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- IP 地理位置缓存
CREATE TABLE IF NOT EXISTS ip_geo_cache (
  ip TEXT PRIMARY KEY,
  country TEXT,
  country_name TEXT,
  city TEXT,
  cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 区域质量统计
CREATE TABLE IF NOT EXISTS region_quality (
  country TEXT PRIMARY KEY,
  avg_latency REAL,
  avg_bandwidth REAL,
  ip_count INTEGER,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 测速策略
CREATE TABLE IF NOT EXISTS speed_strategy (
  id INTEGER PRIMARY KEY,
  quality_mode TEXT DEFAULT 'bandwidth',
  last_region TEXT,
  last_maintain_time TIMESTAMP,
  global_maintain_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_high_quality_latency ON high_quality_ips(latency);
CREATE INDEX IF NOT EXISTS idx_high_quality_country ON high_quality_ips(country);
CREATE INDEX IF NOT EXISTS idx_high_quality_type ON high_quality_ips(quality_type);
CREATE INDEX IF NOT EXISTS idx_speed_results_country ON speed_results(country);
```

### 4. 配置环境变量

在 Worker 配置中添加以下环境变量：

| 环境变量                          | 默认值 | 说明            | 必填   |
| ----------------------------- | --- | ------------- | ---- |
| `ADMIN_PASSWORD`              | 123 | 管理员登录密码       | 建议修改 |
| `DEFAULT_IP_COUNT`            | 3   | 默认返回的 IP 数量   | 否    |
| `DEFAULT_TEST_COUNT`          | 50  | 默认测速 IP 数量    | 否    |
| `DEFAULT_THREAD_COUNT`        | 10  | 默认并发线程数       | 否    |
| `DEFAULT_BANDWIDTH_FILE_SIZE` | 3   | 带宽测试文件大小 (MB) | 否    |
| `FAILED_IP_COOLDOWN_DAYS`     | 15  | 失败 IP 冷却天数    | 否    |
| `MAX_HIGH_QUALITY_POOL_SIZE`  | 30  | 带宽池最大容量       | 否    |

### 5. 绑定 KV 和 D1 数据库

在 Worker 绑定配置中设置以下绑定：

| 绑定类型    | 变量名称 | 绑定名称            | 描述             |
| ------- | ---- | --------------- | -------------- |
| KV 命名空间 | `KV` | `cf-best-ip`    | 用于存储 IP 列表和配置  |
| D1 数据库  | `DB` | `cf-best-ip-db` | 用于存储测速结果和优质 IP |

### 6. 部署方法

#### 方法一：手动部署 Workers（推荐）

1. 复制 `混淆加密 `内容
2. 创建新的 Worker
3. 粘贴代码
4. 配置环境变量（见上面的环境变量表格）
5. 配置绑定（见上面的绑定表格）

#### 方法二：使用 Cloudflare Pages 部署

Cloudflare Pages 也支持部署 Workers Functions，适合需要同时部署静态网站和后端功能的场景。

1. 创建一个新的 Pages 项目
2. 选择你的代码仓库（如果使用 Git）或直接上传代码
3. 在 Pages 项目设置中：
   - 配置构建命令（如果需要）
   - 在 "Functions" 部分配置 Workers Functions
   - 绑定 D1 数据库和 KV 命名空间
4. 部署项目

**注意**：使用 Pages 部署时，代码结构需要调整为 Pages 要求的格式，将 Worker 代码放在 `functions/` 目录下。

#### 方法三：使用 Wrangler CLI 部署 Workers

1. 安装 Wrangler CLI：
   ```bash
   npm install -g wrangler
   ```
2. 登录 Cloudflare：
   ```bash
   wrangler login
   ```
3. 配置 `wrangler.toml` 文件：
   - 填写 `database_id`（D1 数据库 ID）
   - 填写 `id`（KV 命名空间 ID）
4. 部署 Worker：
   ```bash
   npm run deploy
   ```

### 7. 配置路由

- 设置 Worker 路由（例如：`cf-ip.your-domain.com/*`）

### 8. 配置 Cron 定时任务（可选，每小时自动测速）

1. 在 Worker 设置页面，找到 **触发器 → Cron Triggers**
2. 点击 **添加 Cron 触发器**
3. 输入：`0 * * * *`（每小时整点执行）
4. 点击保存

### 9. 配置 DNS 自动更新（可选）

如果你想让 Worker 自动更新 Cloudflare DNS 记录：

在设置页面填写：

- **API Token**：需要 Zone.DNS:Edit 权限的 Token
- **Zone ID**：你域名的 Zone ID
- **记录名称**：例如 cf.yourdomain.com
- **代理状态**：默认：灰色云 - 直接解析（不开启 Cloudflare 代理）

勾选以下选项：

- **每小时自动更新 DNS**：通过定时任务自动更新
- **测速完成后自动更新 DNS**：每次测速完成后自动更新

### 10. 配置 Telegram 通知（可选）

如果你想接收系统通知：

在设置页面填写：

- **Bot Token**：Telegram Bot 的 Token
- **Chat ID**：接收通知的聊天 ID
- **隐藏IP后两位**：是否隐藏IP地址的后两位（保护隐私）

勾选 **启用Telegram通知** 选项，然后点击 **测试通知** 按钮验证配置是否正确。

#### 通知内容

启用后，你将收到以下通知：

- **DNS更新通知**：
  - DNS更新成功时：包含更新数量、来源和时间
  - DNS更新失败时：包含失败原因、来源和时间
- **测速完成通知**：
  - 成功和失败的IP数量
  - 带宽池当前状态
  - 执行时间
- **Cron定时任务通知**：
  - 定时任务完成时发送通知
  - 包含执行时间

## 配置说明

### 运行参数

- **测速线程数**：1-10
- **测速数量**：10-100
- **DNS 自动添加 IP 数**：1-10
- **带宽优质池最大容量**：10-50
- **失败 IP 冷却天数**：1-30
- **带宽测试文件大小**：3-10MB

### 日志管理配置

- **自动清理过期日志**：开启/关闭自动清理功能
- **清理周期**：3-7天（设置日志保留的天数）

### 数据源配置

- 支持 HTTP/HTTPS 协议的 IP 列表
- 支持 CIDR 网段（仅 /24 段）

## 使用说明

1. 访问 Worker 域名
2. 点击"刷新 IP 列表"获取最新 IP
3. 点击"开始测速"进行批量测试
4. 点击"更新 DNS"自动配置最优 IP
5. 查看"优质 IP 列表"选择最佳 IP
6. 点击"导出优质 IP"下载 CSV 文件
7. 点击"清理带宽池"清空所有 IP

## 技术特性

### 增强型日志管理系统

**功能描述**：提供全面的系统日志管理功能，支持多级别、多分类的日志记录和管理。

**核心功能**：

1. **多级别日志**：
   - INFO：普通信息日志
   - WARNING：警告信息
   - ERROR：错误信息
   - DEBUG：调试信息
2. **多分类日志**：
   - SYSTEM：系统相关日志
   - SPEED\_TEST：测速相关日志
   - DNS\_UPDATE：DNS更新相关日志
   - TELEGRAM：Telegram通知相关日志
3. **日志过滤与搜索**：
   - 支持按日期范围过滤
   - 支持按级别过滤
   - 支持按分类过滤
   - 支持关键词搜索
4. **日志导出**：
   - 支持将过滤后的日志导出为 CSV 格式
   - 方便离线分析和备份
5. **自动清理**：
   - 支持 3-7 天的自动清理周期
   - 自动删除过期日志，节省存储空间

**工作原理**：

1. **日志记录**：系统在关键操作时生成相应级别的日志
2. **日志存储**：将日志存储在 D1 数据库的 system\_logs 表中
3. **日志查询**：通过 API 接口查询和过滤日志
4. **日志管理**：提供 Web 界面进行日志管理操作

### IP 自动发现与测速

#### IP 自动发现

**功能描述**：系统会自动从配置的数据源获取最新的 Cloudflare IP 列表，无需手动添加。

**工作原理**：

1. **数据源配置**：系统默认使用 GitHub 上的 IP 源，也支持用户添加自定义数据源
2. **自动更新**：
   - 手动点击"刷新 IP 列表"按钮触发更新
   - 定期通过 Cron 任务自动更新
3. **IP 处理**：
   - 支持直接 IP 地址和 CIDR 网段（如 1.1.1.0/24）
   - 自动展开 CIDR 网段为单个 IP
   - 去重处理，确保 IP 列表不重复
4. **存储**：将获取的 IP 存储在 KV 命名空间中，供后续测速使用

#### 测速功能

**功能描述**：对获取的 IP 进行延迟和带宽测试，评估其质量。

**测试指标**：

1. **延迟测试**：
   - 向 Cloudflare 测速服务器发送请求
   - 测试 3 次取平均值
   - 超时设置为 5 秒
2. **带宽测试**：
   - 下载 3-10MB 文件（可配置）
   - 计算下载速度（Mbps）
   - 智能速率限制，避免 Cloudflare 限流
3. **评分系统**：
   - 带宽权重：80%
   - 延迟权重：20%
   - 综合评分 = (带宽评分 × 0.8) + (延迟评分 × 0.2)

#### 工作流程

1. **IP 发现**：从配置的数据源获取 IP 列表
2. **智能筛选**：根据历史数据和当前状态，优先测试最有可能成为优质 IP 的地址
3. **批量测试**：按优先级对 IP 进行测试，限制并发数避免限流
4. **结果处理**：
   - 优质 IP（带宽 ≥ 100Mbps）进入带宽池
   - 普通 IP 进入备用池
   - 失败 IP 进入失败池
5. **持续维护**：定期重新测试池中的 IP，确保质量

### 智能测速策略

#### 触发方式

1. **手动触发**
   - **点击"智能测速"按钮**：在主页面的快速操作区域
   - **点击"为您优选测速"按钮**：基于访客位置的智能测速
2. **自动触发**
   - **Cron定时任务**：每小时自动执行（配置方法见部署步骤第8节）
   - **测速完成后自动更新DNS**：如果启用了此选项，测速完成后会自动更新DNS

#### 工作原理

- **双池状态分析**：根据带宽池和备用池的状态调整测速策略
- **IP优先级排序**：优先测试历史高带宽IP，然后是带宽优质池、备用池、总IP池、失败池
- **动态测试数量**：根据带宽池填充情况自动调整测试数量
  - 当带宽池接近满时，减少测试数量
  - 当带宽池较空时，增加测试数量
- **地区优先**：优先维护IP不足的地区，特别是亚洲地区
- **全球维护**：在亚洲时间0-6点进行全球范围的测速维护

#### 测试流程

1. 清理带宽池，确保池内IP质量
2. 分析双池状态，确定测试策略
3. 按优先级排序IP测试队列
4. 执行批量测试，限制并发数避免限流
5. 更新双池数据，淘汰低质量IP
6. 更新区域统计信息
7. 可选：自动更新DNS

### 地理位置识别

- 优先使用 ipapi.co
- 备用使用 ip-api.com
- 本地缓存提高性能

### 位置感知与全局优质IP的平衡

系统采用双重视角来平衡全局性能和本地体验：

#### 全局视角

- **Cron定时任务**：每小时自动测速和维护（配置方法见部署步骤第8节）
- **智能测速策略**：优先维护IP不足的地区
- **区域优先**：优先维护亚洲地区的IP资源
- **全球维护**：在亚洲时间0-6点进行全球范围的测速维护

#### 本地视角

- **访客位置感知**：根据用户实际位置推荐相应地区的IP
- **为您优选测速**：专门为用户所在地区进行测速
- **地区特定DNS更新**：基于用户位置更新DNS

#### 如何获得最适合您位置的IP

1. **使用"为您优选测速"**：点击主页面的"为您优选测速"按钮
2. **使用"更新DNS（优先您的位置）"**：基于您的位置更新DNS
3. **启用访客感知DNS更新**：系统会根据访问者的位置自动选择合适的IP

这样，系统就能在全局性能和本地体验之间取得平衡，为您提供既快速又适合您位置的IP选择。

## 项目结构

### 推荐项目结构

#### Workers 部署结构

```
├── worker.js             # 主要代码文件
├── wrangler.toml         # Wrangler 配置文件
├── package.json          # 项目依赖
├── migrations/           # 数据库迁移文件
│   └── 001_init.sql      # 初始化数据库
├── README.md             # 部署文档
└── .gitignore            # Git 忽略文件
```

#### Pages 部署结构

如果使用 Cloudflare Pages 部署，代码结构需要调整为：

```
├── functions/            # Workers Functions 目录
│   └── [[path]].js       # 处理所有路径的 Worker 函数
├── public/               # 静态文件目录（可选）
├── package.json          # 项目依赖
├── migrations/           # 数据库迁移文件
│   └── 001_init.sql      # 初始化数据库
├── README.md             # 部署文档
└── .gitignore            # Git 忽略文件
```

### 文件说明

#### Workers 部署文件说明

| 文件/目录           | 说明                            |
| --------------- | ----------------------------- |
| `worker.js`     | 主入口文件，处理所有请求                  |
| `wrangler.toml` | Wrangler 配置文件，定义 Worker 配置和绑定 |
| `package.json`  | 项目依赖文件，管理 npm 包               |
| `migrations/`   | 数据库迁移文件目录，存储数据库初始化和更新脚本       |
| `README.md`     | 项目文档，包含部署和使用说明                |
| `.gitignore`    | Git 忽略文件，指定不需要版本控制的文件         |

#### Pages 部署文件说明

| 文件/目录                   | 说明                                |
| ----------------------- | --------------------------------- |
| `functions/`            | Workers Functions 目录，存放 Worker 函数 |
| `functions/[[path]].js` | 处理所有路径的 Worker 函数，相当于主入口文件        |
| `public/`               | 静态文件目录，存放 HTML、CSS、JS 等静态资源       |
| `package.json`          | 项目依赖文件，管理 npm 包                   |
| `migrations/`           | 数据库迁移文件目录，存储数据库初始化和更新脚本           |
| `README.md`             | 项目文档，包含部署和使用说明                    |
| `.gitignore`            | Git 忽略文件，指定不需要版本控制的文件             |

## 常见问题

### Q: 登录后显示 401 未授权？

检查 ADMIN\_PASSWORD 环境变量是否正确设置

### Q: 测速没反应？

- 检查 D1 数据库是否正确绑定（变量名必须是 DB）
- 检查 KV 是否正确绑定（变量名必须是 KV）

### Q: 无法获取 IP 列表？

- 默认数据源是 GitHub 上的，确保 Worker 能访问外网（默认可以的）
- 也可以手动添加其他 IP 源

### Q: Cron 不执行？

- 检查 Cron 表达式格式：0 \* \* \* \*
- 确保 D1 和 KV 绑定正确

部署完成后，你就可以享受每小时自动测速、自动维护带宽池的功能了！

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！
