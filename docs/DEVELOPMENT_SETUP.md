# SmartGuard-NetGuard 开发环境与本地启动

## 1. 适用范围

本文档描述第一阶段最终业务代码基线 `87618cf` 的本地开发环境。

RC 材料基线 `5b0f18f` 与 `87618cf` 从 `f4192a0` 分叉，材料分支不包含最终 Child Mode P1 修复。开始业务开发或回归前先确认当前代码包含 `87618cf`：

```powershell
git rev-parse HEAD
git branch --contains 87618cf
```

如果当前工作树用于 RC 材料整理，不要仅为了运行代码而在该工作树混合合并业务提交；应在对应集成分支或独立工作树中运行最终代码。

当前系统面向本地开发和受控演示。本文档不是生产部署手册。

## 2. 当前组件

```text
extension/   Edge Manifest V3 Extension
backend/     Flask API、Service 和 SQLAlchemy 模型
UI/          Web 管理端静态页面
database/    MySQL 初始化及迁移脚本
demos/       本地可控演示页面
tests/       自动化和浏览器手工测试
```

已实现的主要链路：

```text
Extension / Web
       │
       ├── /api/risk/check
       ├── /api/events/risk
       ├── /api/events/ad
       └── /api/settings
                │
                ▼
          Flask Backend
                │
                ▼
              MySQL
                │
                ├── /api/dashboard/*
                └── /api/logs/risk
```

## 3. 环境要求

第一阶段验证环境使用：

| 工具 | 建议环境 | 用途 |
|---|---|---|
| Windows | Windows 10/11 | 当前主要开发和实机测试环境 |
| Python | 3.12 | Backend、静态服务和 Python 测试 |
| MySQL | 5.7.26 | 正式本地数据源 |
| Microsoft Edge | 支持 Manifest V3 的版本 | Extension 加载与真机测试 |
| Node.js | 支持内置 `node:test` | Extension/Web JavaScript 自动化测试 |
| Git | 当前稳定版本 | 版本管理 |

仓库没有固定 Node.js 精确版本，也没有 `package.json`。如果 `node --test` 不可用，需要安装支持内置测试运行器的 Node.js 版本；不要自行引入 npm 依赖后把它描述为项目既有要求。

## 4. 获取代码与确认基线

```powershell
git clone https://github.com/Randi-ace/SmartGuard-NetGuard.git
cd SmartGuard-NetGuard
git fetch --all
git switch integration/backend-extension-week1-2
git rev-parse --short HEAD
```

本阶段最终业务提交应为：

```text
87618cf
```

如果远端分支后续前进，只要历史中包含 `87618cf`，即可继续按本文档验证；应同时审查其后的变化。

## 5. Python 环境

在项目根目录执行：

```powershell
python -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

运行依赖为 Flask、Flask-CORS、PyMySQL、SQLAlchemy、requests 和 tzdata。Backend 当前不是通过 Flask CLI、Gunicorn 或 Waitress 启动。

## 6. 环境变量

### 6.1 当前实际行为

`.env.example` 列出了需要的变量，但 `87618cf` 没有安装或调用 `.env` 加载器。复制为 `.env` 不会自动生效。

启动 Backend 前，在同一个 PowerShell 进程中设置：

```powershell
$env:MYSQL_HOST = "127.0.0.1"
$env:MYSQL_PORT = "3306"
$env:MYSQL_USER = "root"
$env:MYSQL_PASSWORD = "你的本地密码"
$env:MYSQL_DB = "net_guard"
$env:SECRET_KEY = "仅用于本地开发的随机字符串"
```

查看是否已设置时，不要把密码输出到共享日志或截图。

### 6.2 代码默认值

如果没有设置变量，当前代码会使用：

| 变量 | 默认值 |
|---|---|
| `MYSQL_HOST` | `127.0.0.1` |
| `MYSQL_PORT` | `3306` |
| `MYSQL_USER` | `root` |
| `MYSQL_PASSWORD` | `root` |
| `MYSQL_DB` | `net_guard` |
| `SECRET_KEY` | 开发用固定回退值 |

这些默认值只为本地开发保留，不是生产安全配置。当前项目也没有实现 JWT；不要把 `SECRET_KEY` 描述为已经启用的 JWT 密钥。

## 7. 数据库

### 7.1 全新空环境

启动 MySQL 5.7.26 后，在项目根目录执行：

```powershell
mysql -u root -p --execute="source database/init.sql"
mysql -u root -p net_guard -e "SHOW TABLES;"
```

`database/init.sql` 会创建并选择 `net_guard`。全新初始化应得到 8 张表：

| 分类 | 表 |
|---|---|
| 正式业务表 | `users`、`settings`、`risk_events`、`ad_events`、`url_blacklist` |
| 兼容支撑表 | `security_logs`、`detection_records`、`user_settings` |

初始化脚本不写入真实用户或历史检测数据。首次访问 `/api/settings` 时，Backend 会按需创建默认 Demo 用户及设置。

### 7.2 已有数据库

如果 `net_guard` 已存在且包含表或数据：

1. 停止 Backend、Extension 联调和其他写入方；
2. 在仓库目录外创建完整备份；
3. 识别数据库当前结构；
4. 由 Backend/数据库负责人选择迁移路径；
5. 在一次性测试库先演练；
6. 完成预检查、迁移、验证和应用验收后再处理正式库。

仓库中存在多代迁移：

```text
database/migration/v1_precheck.sql
database/migration/v1_migration.sql
database/migration/v2_url_blacklist.sql
database/migration/v3_normalize_legacy_risk_events.sql
database/migration/v4_gate_precheck.sql
database/migration/v4_gate_upgrade_mixed_net_guard.sql
database/migration/v4_gate_verify.sql
database/migration/v4_gate_rollback.sql
```

不能把上述文件理解为所有数据库都依次执行。尤其是 v4：

- 面向特定 mixed-schema 状态；
- 要求写入方全部停止并先完成完整锁定备份；
- MySQL 5.7 DDL 会隐式提交；
- `v4_gate_rollback.sql` 不能恢复所有原地结构变化，完整物理恢复仍依赖迁移前备份。

数据库基础说明见 [`database/README.md`](../database/README.md)，变更制度见 [`DATABASE_CHANGE_RULES.md`](DATABASE_CHANGE_RULES.md)。现有数据库结构不明确时必须停止并交由负责人判断。

## 8. 启动 Backend

确保虚拟环境、当前 PowerShell 环境变量和 MySQL 均已准备好：

```powershell
python start_backend.py
```

当前启动参数固定为：

```text
host = 127.0.0.1
port = 5000
debug = true
```

验证：

```text
http://127.0.0.1:5000/health
```

正常响应结构：

```json
{
  "status": "healthy",
  "database": "available",
  "message": "NetGuard Backend Service"
}
```

`database=unavailable` 表示 Flask 进程存在，但数据库依赖没有就绪。此时 `/api/risk/check`、事件、设置、Dashboard 和日志等正式数据链路不能视为正常。

## 9. 启动 Web

保持 Backend 运行，另开一个位于项目根目录的终端：

```powershell
python -m http.server 8080 --bind 127.0.0.1
```

打开：

```text
http://127.0.0.1:8080/UI/index.html
```

Web 当前特性：

- 默认 API 地址为 `http://127.0.0.1:5000`；
- 没有面向最终用户的 API 地址配置界面；
- Chart.js 和字体使用外部 CDN；
- 必须通过 HTTP 静态服务访问，不建议直接使用 `file://`；
- 家庭成员、设备、支付和登录等页面仍包含第一阶段原型内容；
- Child 实时剩余时长尚未接 Backend，页面显示 `--`。

使用说明见 [`web-user-guide.md`](web-user-guide.md)。

## 10. 加载 Edge Extension

1. 打开 Edge 的 `edge://extensions/`。
2. 开启“开发人员模式”。
3. 选择“加载解压缩的扩展”。
4. 选择项目根目录下的 `extension/`。
5. 确认所选目录中直接包含 `manifest.json`。
6. 修改 Extension 源文件后，在扩展管理页点击“重新加载”；涉及后台逻辑时同时检查 Service Worker。

当前 Extension 默认 API Base URL：

```text
http://127.0.0.1:5000
```

内部可通过 `chrome.storage.local` 的 `netguardApiBaseUrl` 覆盖，但当前 popup 没有正式的地址配置入口。不要加载历史文档中的 `extension/adchacha`，该目录不存在。

Extension 已实现 Normal、Strict、Elder、Child 四种活动模式和独立 Paused 状态。模式优先级与同步语义以 [`backend_api.md`](backend_api.md) 和 [`web-user-guide.md`](web-user-guide.md) 为准。

## 11. 演示环境

一条命令同时启动 Backend 和根目录静态服务：

```powershell
python start_demo_server.py
```

入口：

```text
演示中心  http://127.0.0.1:8080/demos/demo_center.html
Web       http://127.0.0.1:8080/UI/index.html
Backend   http://127.0.0.1:5000
```

该脚本仍使用 Flask debug server，只适合本地演示。

## 12. API 与测试入口

- 当前 API 实现说明：[`backend_api.md`](backend_api.md)
- 完整测试入口：[`testing/README.md`](testing/README.md)

`API_CONTRACT_v1alpha1.md` 是历史设计契约，其中部分字段、设置结构和分页方式已过时；新代码不得以它替代 `backend_api.md`。

## 13. 常见问题

### `.env` 已修改但连接信息不生效

当前代码不会自动加载 `.env`。请在启动 `python start_backend.py` 的同一终端显式设置 `$env:MYSQL_*`，然后重启 Backend。

### `/health` 正常但 Web 仍加载失败

检查 `/health` 的 `database` 是否为 `available`。`status=healthy` 只表示 Flask 服务可响应。

### Web 页面可以打开但图表报错

确认网络能够访问 Chart.js CDN。CDN 不可用时，非图表功能仍可使用，但图表区域会显示错误。

### Extension 加载失败

确认选择的是 `extension/`，并且该目录中直接存在 `manifest.json`。不要选择项目根目录或不存在的 `extension/adchacha`。

### Child P1 测试文件不存在

说明当前代码很可能是 RC 材料分支而非 `87618cf` 最终业务代码。先用 Git 确认提交关系，不要在材料分支上修改测试或业务代码来伪造最终基线。

### 端口被占用

当前 Web 和 Extension 默认依赖 Backend 的 `127.0.0.1:5000`，Web 文档默认使用 `127.0.0.1:8080`。更换端口前需同步检查调用方配置，不能只修改启动命令。
