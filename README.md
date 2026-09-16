# 微博溯源采集系统（Weibo Trace）

微博"罗伯特"评论溯源数据采集 worker + 评论可见性实验平台。

## 模块结构

```
weibo/
├── robert-comments/            # 溯源采集（Node.js + TypeScript）
│   ├── trace-worker.mjs        # 核心采集 worker（多实例并行，住宅代理）
│   ├── collect-*.ts            # 关键词/扩容/被动范围采集入口
│   ├── src/                    # 采集库（微博 API / MongoDB / 配置）
│   └── _*.mjs                  # 运维工具（进度统计 / 暂停 / 账号检查 / 数据迁移）
└── weibo-experiment-platform/  # 实验平台（Next.js 16 + tsx 调度器）
    ├── src/app/                # Web 界面（扫码登录 / 账号 / 数据看板）
    ├── src/jobs/               # 调度任务（采集 / 评论 / 质检 / 监控）
    └── src/lib/                # 微博 API / MongoDB / 邮件告警
```

## 环境要求

- **Node.js 24+**（`--use-env-proxy` 代理开关必需，低版本不支持）
- **pnpm**
- **MongoDB 8**（默认 `mongodb://localhost:27017`，无认证）
- **Chrome**（平台扫码登录用，路径在 `start-weibo-browser.bat` 中配置）

## 快速开始

### robert-comments（采集）

```powershell
pnpm install
copy .env.example .env        # 填入微博 Cookie
```

启动采集（多 worker 并行参考 `_resume.ps1.example`）：

```powershell
node --use-env-proxy trace-worker.mjs --worker=suzhou --from-db=test_experiment --cookies=0,1 --rate=1500
```

常用运维：

| 命令 | 用途 |
|---|---|
| `node _stat.mjs` | 采集进度统计（权威口径） |
| `node _check-accounts.mjs` | Cookie 有效性检查 |
| `node _pause.mjs` | 暂停收尾（working 任务重置为 pending） |
| `node _db-transfer.mjs export <db>` | 数据库导出/导入（EJSON，跨机迁移用） |

### weibo-experiment-platform（平台）

```powershell
pnpm install
copy .env.example .env.local  # 填入数据库/邮件配置
start-weibo-browser.bat 1     # 启动账号 1 的 Chrome（CDP 9222）
start-scheduler.bat           # 启动调度器（或 watchdog-scheduler.bat 守护模式）
```

## 数据库（MongoDB）

| 库 | 用途 |
|---|---|
| `test_experiment` | 账号池（weibo_accounts）与平台数据 |
| `weibo_supplement` | 任务队列与溯源结果（trace_state / passive_ai_posts / posts_raw） |
| `weibo_base` | 三方基础数据（posts / comments / users） |

## 安全说明

本仓库已脱敏，以下内容**不入库**（均保留同名 `*.example` 模板，复制后填入凭据即可）：

- `.env` / `.env.local`（微博 Cookie、Supabase / SMTP / PostgreSQL 凭据）
- 含住宅代理凭据的启动脚本（`_resume.ps1`、`_run-workers.ps1`、`start-*.ps1`）
- `start-scheduler.bat`（SMTP 授权码）
- 浏览器 profile、数据库导出（`_dump`）、运行日志

数据库集合名在代码中经 `cn()` 函数自动加 `weibo_` 前缀，如 `cn('comment_templates')` → `weibo_comment_templates`。
