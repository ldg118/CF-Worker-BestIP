🌩️ CF-Worker-BestIP

一个部署在 Cloudflare Workers 上的强大工具：自动收集、测速并优选 Cloudflare IP，支持多线程测速、DNS 自动更新，并能根据访客地区智能返回最优 IP。

✨ 项目简介
CF-Worker-BestIP 是一个集IP收集、测速、优选和DNS自动更新于一体的全能工具。它部署在 Cloudflare Workers 上，无需维护服务器，即可：

🚀 核心特性
特性	描述
🤖 全自动 IP 收集	定时从多个公开源拉取 Cloudflare IP 列表，自动去重与排序。

⚡ 多线程并发测速	支持自定义线程数（1-50），快速完成数百个 IP 的延迟测试。

🌍 地区智能优选	基于访客的 CF-IPCountry 头，为不同地区（中、美、日、新等 15+）返回最优 IP。

🔄 DNS 自动更新	可定时（每小时）将域名解析记录更新为测速最快的 IP。

📥 自定义 IP 导入	支持单个 IP 或 CIDR 网段（如 172.64.229.0/24），系统自动展开。

📊 可视化面板	清晰的 Web 界面，实时查看 IP 列表、延迟状态，一键操作。

📝 系统日志	所有关键操作（登录、配置修改、DNS更新、Cron任务）均有记录，保存 7 天。

🔐 安全登录	环境变量设置管理员密码，保护管理面板。

🎨 暗色主题界面	简洁美观、响应式设计的暗色主题，操作舒适。

📸 界面预览

登录界面	主面板	
<img width="1359" height="594" alt="image" src="https://github.com/user-attachments/assets/2e97acb2-19b1-405d-bf49-96d0d50cfeb7" />
<img width="1348" height="585" alt="image" src="https://github.com/user-attachments/assets/adf6352a-d966-4356-b3b4-32439a2428a7" />
<img width="1331" height="589" alt="image" src="https://github.com/user-attachments/assets/8dceb84c-17e5-4ab5-b619-018955011ce8" />


🛠️ 快速开始
前置要求
一个 Cloudflare 账号。

一个用于部署 Worker 的域名。

手动部署
1. 克隆或下载代码
将本仓库的 worker.js 。

2.  登录 Cloudflare
3.  选择Workers 和 Pages，把worker.js代码放进去
4. 创建 KV 命名空间命名为 ```CF_IP_KV ```
5. KV 命名空间绑定 ：名称 ```KV ```选择之前创建的 ```CF_IP_KV ```

##  环境变量 (必填)

#  管理员登录密码 (强烈建议修改)
 ```ADMIN_PASSWORD ``` = "your-strong-password"
#  以下为默认值，可按需修改（非必要）
 ```
DEFAULT_IP_COUNT = "3"

DEFAULT_TEST_COUNT = "200"

DEFAULT_THREAD_COUNT = "10"
```
6.设置 Cron 触发器（可选，用于自动更新）
在 Cloudflare Dashboard 中找到你的 Worker，进入 “触发器” 选项卡，添加一个 Cron 触发器，例如 0 * * * *（每小时执行一次）。

⚙️ 配置说明
环境变量
变量名	说明	默认值	范围
 ```ADMIN_PASSWORD ```	（必填） 管理员登录密码。	无	-
 
 ```DEFAULT_IP_COUNT ```	每次更新 DNS 时，优选 IP 的数量，默认	3，（	范围1 - 10）
 
 ```DEFAULT_TEST_COUNT ```	每次手动或自动测速时，测试的 IP 数量。默认200	（	范围1 - 1000）
 
 ```DEFAULT_THREAD_COUNT ```	测速时的并发线程数。	默认```10	```（范围1 - 50）
 
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

日志保存在 KV 中，自动保留 7 天。

可使用“清除”和“刷新”按钮进行管理。

🗺️ 地区支持列表
系统会根据访客的 CF-IPCountry 头，自动返回为该地区预选的最快 IP。目前支持以下地区：

代码	地区	代码	地区	代码	地区
default	默认	US	美国	JP	日本
SG	新加坡	KR	韩国	DE	德国
GB	英国	FR	法国	CA	加拿大
AU	澳大利亚	IN	印度	TW	台湾
HK	香港	MO	澳门		

⚠️ 注意事项
API Token 权限：请确保你的 Token 具有对应域名的 DNS 编辑 权限。

测速数量：建议单次测速不超过 500 个 IP，以免 Worker 执行超时（免费套餐限制为 10ms CPU 时间，但网络请求时间不严格计入，大量测速仍可能受总耗时影响）。

线程数：线程数过高（如 >30）可能导致部分请求因并发限制而失败，建议根据网络环境调整。

KV 限频：免费计划的 KV 有每日读写次数限制，大量操作（如高频日志记录）可能触及上限。

Cron 任务：确保在 Cloudflare Dashboard 中正确设置了 Cron 触发器，否则“自动更新”不会生效。




📄 许可证
本项目采用 MIT 许可证。详情请参见 LICENSE 文件。

💬 联系与支持
项目 Issues: https://github.com/ldg118/CF-Worker-BestIP/issues

作者: ldg118

如果这个项目对你有帮助，请给一个 ⭐️ Star 支持一下！
