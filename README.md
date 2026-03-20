## 如果这个项目对你有帮助，请给一个 ⭐️ Star 支持一下！
🌩️ CF-Worker-BestIP    

✨ 项目简介
CF-Worker-BestIP 是一个集IP收集、延迟测试、优选和DNS自动更新于一体的全能工具。它部署在 Cloudflare Workers 上，无需维护服务器，全程自动操作更新DNS，即可：

🚀 核心特性
特性	描述
🤖 全自动 IP 收集	定时从多个公开源拉取 Cloudflare IP 列表，自动去重与排序。

⚡ 多线程并发测速	支持自定义线程数（1-50），快速完成数百个 IP 的延迟测试。

🔄 DNS 自动更新	可定时（每小时）将域名解析记录更新为测速最快的 IP。

📥 自定义 IP 导入	支持单个 IP 或 CIDR 网段（如 172.64.229.0/24），系统自动展开。

📊 可视化面板	清晰的 Web 界面，实时查看 IP 列表、延迟状态，一键操作。

📝 系统日志	所有关键操作（登录、配置修改、DNS更新、Cron任务）均有记录。

🔐 安全登录	环境变量设置管理员密码，保护管理面板。

🎨 暗色主题界面	简洁美观、响应式设计的暗色主题，操作舒适。

# 📸 界面预览

# 登录界面

<img width="1364" height="594" alt="image" src="https://github.com/user-attachments/assets/297b3bfd-4836-450b-a419-5699c672b789" />

# 主面板	

<img width="1336" height="588" alt="image" src="https://github.com/user-attachments/assets/7b44ad84-66e9-4ab7-b7bb-149366aaba28" />
<img width="1338" height="568" alt="image" src="https://github.com/user-attachments/assets/a6e3f4a4-4f70-48a4-9b2a-711ab0ee8ea8" />
<img width="1348" height="590" alt="image" src="https://github.com/user-attachments/assets/37bfa615-ac05-45a5-b480-d0ef993e0768" />
<img width="1338" height="599" alt="image" src="https://github.com/user-attachments/assets/8ee6a3bb-085c-4ebc-a6fd-e2667c390b8d" />
<img width="1342" height="594" alt="image" src="https://github.com/user-attachments/assets/49344b88-6e3d-4302-af1a-3ddac5d78b8c" />




🛠️ 快速开始

CF-Worker-BestIP 部署教程
一、准备工作

1. 需要准备的东西

Cloudflare 账号

一个域名（用于 DNS 更新）

Telegram Bot Token（可选，用于通知）

2. 创建 KV 命名空间

进入存储和数据库选择 → Workers KV

点击 创建命名空间

名称填写：```CF_IP_KV ```

点击创建

3. 创建 D1 数据库
进入 存储和数据库选择 → SQL数据库

点击 创建数据库

名称填写：```cf-ip-db```

点击创建

二、部署 Worker
1. 创建 Worker
进入 Workers 和 Pages → 创建应用程序 → 创建 Worker

名称填写：```cf-best-ip```（或其他你喜欢的名字）

点击 部署

2. 配置 Worker
编辑代码：

点击 Worker 名称进入详情

点击 编辑代码

复制 ```混淆加密.js```(推荐）或者复制```woeker.js```

点击 保存并部署

绑定 KV 命名空间：

在 Worker 详情页，点击 设置 → 变量

找到 KV 命名空间绑定 部分

点击 添加绑定

变量名称：```KV```

KV 命名空间：选择你创建的 ``CF_IP_KV ```

点击 保存

## 绑定 D1 数据库：

1.在同一页面，找到 D1 数据库绑定

2.点击 添加绑定

3.变量名称：```DB```

4.D1 数据库：选择你创建的```cf-ip-db```

5.点击 保存

#环境变量 (必填)
| 变量名|	密码 | 
|--------|-------|
```ADMIN_PASSWORD ```		|your-strong-password	|

6.设置 Cron 触发器（可选，用于自动更新）
在 Cloudflare Dashboard 中找到你的 Worker，进入 “触发器” 选项卡，添加一个 Cron 触发器，例如 0 * * * *（每小时执行一次）。

⚙️ 配置说明
环境变量
| 变量名|	说明 |默认值 | 
|--------|---------|-----|
| ADMIN_PASSWOR D|	管理员密码（必填）|	your_secure_password|
| DEFAULT_IP_COUNT	| 默认IP数量（1-10）	| 3 |
| DEFAULT_TEST_COUNT	| 默认测速数量（1-1000）|	50
| DEFAULT_THREAD_COUNT	| 默认线程数（1-50）|	10
| FAILED_IP_COOLDOWN_DAYS |	失败IP冷却天数（1-30）|	15
| MAX_HIGH_QUALITY_POOL_SIZE	| 优质池最大容量（10-200）| 	50
 
注意：以上环境变量仅在首次部署或 KV 中无配置时作为默认值。界面上的修改会保存到 KV，并覆盖环境变量的默认值。

📖 使用指南
部署完成后，访问你的 worker.dev 域名或绑定的自定义域名即可看到登录页面。

1. 登录
输入你在环境变量中设置的 ```ADMIN_PASSWORD```。

2. 主面板 - IP 列表
查看 IP：左侧列表展示所有收集到的 IP，并按延迟从低到高排序（绿色<100ms，黄色100-200ms，红色>200ms）。

搜索 IP：使用上方的搜索框实时筛选 IP。

操作按钮：

导出：将当前列表所有 IP 导出为 TXT 文件。

刷新：手动触发从数据源更新 IP 列表。

测速：核心功能。点击后根据右侧配置的“测速数量”和“线程数”进行多线程测速。测速完成后，会自动将最快的 IP 更新到你的 DNS 记录中。

3. 右侧 - 配置面板
🔧 运行参数
IP数量：只读显示，由环境变量 ```DEFAULT_IP_COUNT``` 控制。

测速数量：自定义输入 (1-1000)，决定每次测速多少个 IP。

线程数：自定义输入 (1-50)，决定测速的并发数。数值越大，测速越快。

保存参数：保存“测速数量”和“线程数”的设置。

📌 DNS 配置
API Token / Zone ID：输入你的 Cloudflare API 密钥和区域 ID。输入框会以密码形式隐藏已保存的值。

域名：要更新的子域名（例如 cf.yourdomain.com）。

代理状态：选择 DNS 记录的代理状态（橙色云/灰色云）。

每小时自动更新DNS：勾选后，如果设置了 Cron 触发器，Worker 会每小时自动测速并更新 DNS。

保存DNS / 立即更新：保存配置，或手动触发一次 DNS 更新。

📥 自定义 IP
输入框：在此粘贴你的自定义 IP 列表，每行一个。支持单个 IP（1.1.1.1）或 CIDR 网段（172.64.229.0/24，系统会自动展开）。

加载 / 保存 / 清除：管理你的自定义 IP 列表。

4. 左侧 - 运行日志
所有重要操作（登录、配置修改、测速、DNS更新、Cron任务执行）都会实时记录在此。


可使用“清除”和“刷新”按钮进行管理。


⚠️ 注意事项
API Token 权限：请确保你的 Token 具有对应域名的 DNS 编辑 权限。

测速数量：建议单次测速不超过 500 个 IP，以免 Worker 执行超时（免费套餐限制为 10ms CPU 时间，但网络请求时间不严格计入，大量测速仍可能受总耗时影响）。

线程数：线程数过高（如 >30）可能导致部分请求因并发限制而失败，建议根据网络环境调整。

KV 限频：免费计划的 KV 有每日读写次数限制，大量操作（如高频日志记录）可能触及上限。

Cron 任务：确保在 Cloudflare Dashboard 中正确设置了 Cron 触发器，否则“自动更新”不会生效。




# 💬 联系与支持

项目 Issues: https://github.com/ldg118/CF-Worker-BestIP/issues

作者: ldg118

如果这个项目对你有帮助，请给一个 ⭐️ Star 支持一下！
