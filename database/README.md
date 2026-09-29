# Database Documentation

本文档面向新加入项目的成员，说明 `database/` 目录、当前真实表结构、初始化流程、迁移历史、备份约定和已知限制。

编写原则：

- 本文只描述当前仓库中真实存在的内容。表名、字段、索引、约束和迁移版本均来自
  `database/init.sql`、`database/migration/**`、`backend/models/models.py`、
  `backend/services/**`、`backend/routes/**` 以及 `docs/` 中已有的数据库说明。
- 无法从仓库确认的信息，一律标注 **“当前仓库未提供正式定义”**，不做推测。
- 仓库内审核通过的 SQL 脚本是数据库结构的唯一基线，任何成员的本地数据库都不能替代它
  （依据 `docs/DATABASE_CHANGE_RULES.md`）。

当前 `database/` 目录真实结构（注意迁移目录名是单数 `migration`，仓库中不存在 `schema/` 目录）：

```text
database/
├── README.md                                 本文档
├── init.sql                                  全新空库初始化脚本（8 张表，不写入业务数据）
├── migration/
│   ├── v1_precheck.sql                        v1 迁移前只读预检查
│   ├── v1_migration.sql                       v1 旧库升级（一次性）
│   ├── v2_url_blacklist.sql                   v2 新增 url_blacklist 表
│   ├── v3_normalize_legacy_risk_events.sql    v3 历史风险事件口径补偿
│   ├── v4_gate_precheck.sql                   v4 迁移前只读预检查
│   ├── v4_gate_upgrade_mixed_net_guard.sql    v4 mixed-schema 正式升级
│   ├── v4_gate_verify.sql                     v4 迁移后只读验证
│   ├── v4_gate_rollback.sql                   v4 表名回滚（不完整物理回滚）
│   └── test/
│       ├── v3_legacy_fixture.sql              v3 专用测试库最小测试数据
│       └── v3_verify.sql                      v3 专用测试库只读验收
└── backup/                                   本地备份目录，已被 .gitignore 忽略，不提交
```

`database/schema/`：当前仓库不存在该目录，**当前仓库未提供正式定义**。

---

## 1. Database Overview

### 1.1 数据库用途

该数据库是“净网护航 / SmartGuard-NetGuard”后端的正式数据源，用于保存：

- 最小用户身份（`users`）；
- 每个用户当前的一份设置（`settings`）；
- AI 检测、URL 检测和插件本地规则产生的统一风险事件（`risk_events`）；
- 广告拦截、隐藏、放行事件（`ad_events`）；
- 后端权威的 URL 域名黑名单（`url_blacklist`）；
- 旧接口兼容表 `security_logs`、`detection_records`、`user_settings`（当前仍被部分路由读写，标记为 DEPRECATED）。

Extension 和 UI 不直接访问数据库，只通过后端 API 使用数据（依据 `docs/DATABASE_CHANGE_RULES.md`）。

### 1.2 当前技术栈

| 项目 | 当前仓库中的记录 |
|---|---|
| 数据库 | MySQL |
| 存储引擎 | `InnoDB`（`database/init.sql` 中 8 张表均为 InnoDB） |
| 数据库字符集 | `utf8mb4` |
| 数据库排序规则 | `utf8mb4_unicode_ci` |
| 时区约定 | 脚本内 `SET time_zone = '+00:00'`；`docs/DATABASE_SCHEMA_v1alpha1.md` 规定数据库存储 UTC 时间 |
| 后端语言/框架 | Python + Flask `2.3.3`、Flask-CORS `4.0.0`（`requirements.txt`） |
| ORM / 驱动 | SQLAlchemy `2.0.23` + PyMySQL `1.1.0`（`requirements.txt`） |
| 迁移方式 | 手写 SQL 脚本 + MySQL 存储过程，由人工执行 |
| 迁移框架 | 无。`requirements.txt` 中不存在 Alembic、Flask-Migrate 等迁移工具 |
| 数据定义位置 | `database/init.sql`（DDL）+ `backend/models/models.py`（ORM 模型） |

### 1.3 开发环境数据库版本

仓库中确实存在如下版本记录：

| 来源 | 记录内容 |
|---|---|
| `docs/DEVELOPMENT_SETUP.md` | 依赖表记录 `MySQL 5.7.26` 为正式本地数据源 |
| `database/init.sql` 头部注释 | “适用数据库：MySQL 5.7.26” |
| `database/migration/v1_precheck.sql` 头部注释 | “适用数据库：MySQL 5.7.8 及以上的 5.7 版本” |
| `database/migration/v1_migration.sql` 头部注释 | “适用数据库：MySQL 5.7.26” |
| `database/migration/v4_gate_precheck.sql` | 只接受 `5.7.26` 或 `5.7.8` 及以上的 5.7 版本，并要求会话 `sql_mode` 包含 `NO_ENGINE_SUBSTITUTION` |

生产环境或共享环境使用的 MySQL 版本、实例规格和部署方式：**当前仓库未提供正式定义**。

### 1.4 连接配置

后端读取以下环境变量（`backend/config.py`，模板见 `.env.example`）：

| 变量 | 代码中的默认值 |
|---|---|
| `MYSQL_HOST` | `127.0.0.1` |
| `MYSQL_PORT` | `3306` |
| `MYSQL_USER` | `root` |
| `MYSQL_PASSWORD` | `root`（phpStudy 默认值，仅用于本地开发） |
| `MYSQL_DB` | `net_guard` |
| `SECRET_KEY` | 未设置时回退到固定的开发用字符串 |

连接串由 `backend/config.py` 拼装为 `mysql+pymysql://...?charset=utf8mb4`。

注意事项（依据 `README.md`、`docs/DEVELOPMENT_SETUP.md`、`docs/ENVIRONMENT.md`）：

- 后端启动代码**不会自动读取 `.env` 文件**，需要在启动 `python start_backend.py` 的同一个终端里显式设置环境变量。
- `.env` 禁止提交 Git。
- `backend/db.py` 会在连接前尝试 `CREATE DATABASE IF NOT EXISTS net_guard`，并在连接失败时打印告警；数据库不可用时后端仍可能启动，但依赖数据库的接口会返回 503 或失败。

### 1.5 脚本中出现的数据库名

| 数据库名 | 来源 | 用途 |
|---|---|---|
| `net_guard` | `database/init.sql`、`backend/config.py`、v4 脚本 | 正式数据库名 |
| `net_guard_migration_test` | `v1_precheck.sql`、`v1_migration.sql` | v1 迁移演练用一次性库名 |
| `net_guard_migration_v3_test` | `database/migration/test/v3_legacy_fixture.sql`、`v3_verify.sql` | v3 补偿迁移专用测试库 |
| `net_guard_gate_migration_test` | `v4_gate_*.sql` | v4 Gate 迁移演练克隆库 |

---

## 2. Current Database Structure

### 2.1 当前真实存在的表（全新初始化的 8 张基线表）

`database/init.sql` 在全新空库中创建且仅创建以下 8 张表，不导入任何用户、设置或历史检测数据。
“代码中的写入来源”列取自后端实际调用路径。

| 表名 | 分类 | 用途 | 代码中的写入来源 | 结构定义位置 |
|---|---|---|---|---|
| `users` | 正式业务表 | 最小用户身份，供事件与设置关联 | `POST /api/settings` 首次访问时按需创建 `username='demo'` 的 Demo 用户（`backend/services/settings_service.py`）；`v4_gate_upgrade_mixed_net_guard.sql` 也会插入一条 Demo 用户 | `database/init.sql`、`backend/models/models.py` |
| `settings` | 正式业务表 | 每个用户唯一的一份当前设置（模式 + 偏好 + 版本号） | `POST /api/settings`、`POST /settings/mode`（`backend/services/settings_service.py`） | 同上 |
| `risk_events` | 正式业务表 | 统一风险事件（AI / URL / 本地规则） | `POST /api/risk/check`（`backend/services/risk_service.py`）、`POST /api/events/risk`（`backend/services/event_service.py`） | 同上 |
| `ad_events` | 正式业务表 | 广告拦截、隐藏、放行事件 | `POST /api/events/ad`（`backend/services/event_service.py`） | 同上 |
| `url_blacklist` | 正式业务表 | 后端权威 URL 域名黑名单 | 只读：`backend/services/blacklist_service.py` 仅做查询。仓库中没有写入接口、种子数据或导入脚本，**当前仓库未提供正式定义** | `database/init.sql`、`database/migration/v2_url_blacklist.sql`、`backend/models/models.py` |
| `security_logs` | 兼容支撑表（DEPRECATED） | 旧版混合安全日志，当前日志/统计/URL 检测路由仍在使用 | 写入：`POST /api/log`（`backend/routes/security_logs.py`）、`POST /ai/check`（`backend/routes/ai_check.py`）、`POST /url/check`（`backend/routes/url_check.py`）；读取：`GET /api/logs`、`GET /api/stats` | `database/init.sql`、`backend/models/models.py` |
| `detection_records` | 兼容支撑表（DEPRECATED） | 旧版检测记录，当前 AI 检测路由仍在写入 | 写入：`POST /ai/check`（与 `security_logs` 双写） | 同上 |
| `user_settings` | 兼容支撑表（DEPRECATED） | 旧版键值设置，正式设置请使用 `settings` | 仓库内没有引用该模型的读写代码路径，仅保留 ORM 模型注册与迁移兼容 | 同上 |

说明：

- 三张兼容支撑表的模型属性标注 `__deprecated__ = True`，但 `docs/DATABASE_SCHEMA_v1alpha1.md` 明确要求“未经代码依赖与迁移影响评估不得删除”。
- 初始化脚本创建的 8 张表全部为空表；Demo 用户与默认设置在第一次访问 `/api/settings` 时由后端按需创建。

### 2.2 表关系

```text
users
  ├── 1 : N ── risk_events   (risk_events.user_id -> users.id ON DELETE SET NULL)
  ├── 1 : N ── ad_events     (ad_events.user_id   -> users.id ON DELETE SET NULL)
  └── 1 : 1 ── settings      (settings.user_id    -> users.id ON DELETE CASCADE)
```

`security_logs`、`detection_records`、`user_settings` 与 `users` 之间没有外键（依据 `database/init.sql`）。

### 2.3 字段级结构（逐字取自 `database/init.sql`）

```text
users   InnoDB / utf8mb4 / utf8mb4_unicode_ci
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT   主键
  public_id     CHAR(36)         NOT NULL                  对外 UUID
  username      VARCHAR(64)      NULL                      登录名，允许 NULL
  display_name  VARCHAR(100)     NOT NULL DEFAULT '智盾用户'
  role          VARCHAR(32)      NOT NULL DEFAULT 'user'
  status        VARCHAR(16)      NOT NULL DEFAULT 'active'
  created_at    DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  updated_at    DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  索引：PRIMARY(id)、UNIQUE uq_users_public_id(public_id)、
        UNIQUE uq_users_username(username)、KEY ix_users_status_created_at(status, created_at)
```

```text
risk_events   InnoDB / utf8mb4 / utf8mb4_unicode_ci
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT   主键
  event_uuid    CHAR(36)         NOT NULL                  客户端幂等编号
  user_id       BIGINT UNSIGNED  NULL                      外键 -> users.id
  event_type    VARCHAR(32)      NOT NULL
  check_type    VARCHAR(20)      NOT NULL
  risk_level    VARCHAR(16)      NOT NULL
  risk_score    DECIMAL(5,4)     NOT NULL DEFAULT 0.0000
  url           TEXT             NULL
  url_hash      CHAR(64)         NULL
  reason        VARCHAR(1000)    NULL
  source        VARCHAR(20)      NOT NULL DEFAULT 'backend'
  details       JSON             NULL
  occurred_at   DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  created_at    DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  索引：PRIMARY(id)、UNIQUE uq_risk_events_event_uuid(event_uuid)、
        KEY ix_risk_events_user_occurred(user_id, occurred_at)、
        KEY ix_risk_events_level_occurred(risk_level, occurred_at)、
        KEY ix_risk_events_type_occurred(event_type, occurred_at)、
        KEY ix_risk_events_url_hash(url_hash)
  外键：fk_risk_events_user (user_id) REFERENCES users(id) ON DELETE SET NULL
```

```text
url_blacklist   InnoDB / utf8mb4 / utf8mb4_unicode_ci
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT   主键
  domain        VARCHAR(253)     NOT NULL
  match_type    VARCHAR(16)      NOT NULL DEFAULT 'domain'
  risk_level    VARCHAR(16)      NOT NULL DEFAULT 'high'
  score         DECIMAL(5,4)     NOT NULL DEFAULT 0.9500
  reason        VARCHAR(500)     NOT NULL
  enabled       TINYINT(1)       NOT NULL DEFAULT 1
  source        VARCHAR(32)      NOT NULL DEFAULT 'manual'
  created_at    DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  updated_at    DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  索引：PRIMARY(id)、UNIQUE uq_url_blacklist_domain(domain)、
        KEY ix_url_blacklist_enabled_domain(enabled, domain)
  约束：CHECK ck_url_blacklist_score_range (score >= 0 AND score <= 1)
        （脚本中声明；MySQL 5.7 对 CHECK 约束的行为需以实际数据库验证。
         `backend/models/models.py` 的 UrlBlacklist 另在 Python 层校验 score、risk_level、
         match_type 和 domain 规范化）
```

```text
ad_events   InnoDB / utf8mb4 / utf8mb4_unicode_ci
  id             BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT   主键
  event_uuid     CHAR(36)         NOT NULL
  user_id        BIGINT UNSIGNED  NULL                      外键 -> users.id
  action         VARCHAR(16)      NOT NULL
  mode           VARCHAR(16)      NOT NULL DEFAULT 'normal'
  page_url       TEXT             NULL
  url_hash       CHAR(64)         NULL
  resource_type  VARCHAR(32)      NULL
  rule_id        VARCHAR(100)     NULL
  blocked_count  INT UNSIGNED     NOT NULL DEFAULT 1
  reason         VARCHAR(500)     NULL
  source         VARCHAR(20)      NOT NULL DEFAULT 'extension'
  details        JSON             NULL
  occurred_at    DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  created_at     DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  索引：PRIMARY(id)、UNIQUE uq_ad_events_event_uuid(event_uuid)、
        KEY ix_ad_events_user_occurred(user_id, occurred_at)、
        KEY ix_ad_events_action_occurred(action, occurred_at)、
        KEY ix_ad_events_mode_occurred(mode, occurred_at)、
        KEY ix_ad_events_url_hash(url_hash)
  外键：fk_ad_events_user (user_id) REFERENCES users(id) ON DELETE SET NULL
```

```text
settings   InnoDB / utf8mb4 / utf8mb4_unicode_ci
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT   主键
  user_id       BIGINT UNSIGNED  NOT NULL                  外键 -> users.id
  mode          VARCHAR(16)      NOT NULL DEFAULT 'normal'
  preferences   JSON             NOT NULL                  由后端显式写入，无服务端默认值
  version       INT UNSIGNED     NOT NULL DEFAULT 1
  created_at    DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  updated_at    DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  索引：PRIMARY(id)、UNIQUE uq_settings_user_id(user_id)、
        KEY ix_settings_mode_updated_at(mode, updated_at)
  外键：fk_settings_user (user_id) REFERENCES users(id) ON DELETE CASCADE
```

```text
security_logs   InnoDB / utf8mb4 / utf8mb4_unicode_ci   （DEPRECATED，兼容保留）
  id          INT           NOT NULL AUTO_INCREMENT   主键
  type        ENUM('ai_check','url_check','ad_block','child_mode','elder_mode',
                   'strict_mode','entertainment_block','game_block','dangerous_block') NOT NULL
  risk_level  ENUM('safe','low','medium','high') NOT NULL
  url         VARCHAR(500)  NOT NULL
  reason      VARCHAR(1000) NULL
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
  索引：PRIMARY(id)、KEY ix_security_logs_type_created_at(type, created_at)、
        KEY ix_security_logs_risk_created_at(risk_level, created_at)
```

```text
detection_records   InnoDB / utf8mb4 / utf8mb4_unicode_ci   （DEPRECATED，兼容保留）
  id            INT           NOT NULL AUTO_INCREMENT   主键
  url           VARCHAR(500)  NOT NULL
  is_high_risk  TINYINT(1)    NOT NULL DEFAULT 0
  is_phishing   TINYINT(1)    NOT NULL DEFAULT 0
  risk_level    VARCHAR(20)   NOT NULL DEFAULT 'safe'
  risk_score    FLOAT         NOT NULL DEFAULT 0
  check_type    VARCHAR(20)   NOT NULL DEFAULT 'unknown'
  user_id       INT           NULL
  reason        VARCHAR(500)  NULL
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
  索引：PRIMARY(id)、KEY ix_detection_records_check_type(check_type)、
        KEY ix_detection_records_created_at(created_at)、KEY ix_detection_records_user_id(user_id)
```

```text
user_settings   InnoDB / utf8mb4 / utf8mb4_unicode_ci   （DEPRECATED，兼容保留）
  id             INT           NOT NULL AUTO_INCREMENT   主键
  setting_key    VARCHAR(100)  NOT NULL
  setting_value  VARCHAR(500)  NULL
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
  updated_at     DATETIME      NULL
  索引：PRIMARY(id)、UNIQUE uq_user_settings_setting_key(setting_key)
```

补充说明：

- `DATETIME(6)` 列使用 `DEFAULT CURRENT_TIMESTAMP(6)`；`database/init.sql` 中 `updated_at` 未声明
  `ON UPDATE`，因此只有经过 ORM 的更新才会刷新该列（`backend/models/models.py` 在模型层使用
  `onupdate`），直接执行 SQL `UPDATE` 不会自动刷新。
- `settings.preferences` 是 `NOT NULL` 且没有服务端默认值，因为 MySQL 5.7 的 JSON 列不能使用对象字面量
  作为 `DEFAULT`（`database/init.sql` 与 `backend/models/models.py` 注释均说明这一点），必须由后端显式写入。
- 当前后端实际写入的 `preferences` 键为 `elder_mode`、`child_mode`、`paused`
  （`backend/services/settings_service.py`）。`docs/DATABASE_SCHEMA_v1alpha1.md` 中的
  `elder` / `child` 嵌套示例是设计示例，不是当前代码写入的结构。

### 2.4 迁移后才会出现的归档表

执行 `database/migration/v4_gate_upgrade_mixed_net_guard.sql` 后，库中会额外保留以下归档表
（脚本使用带日期的名字，不删除旧数据）：

| 表名 | 来源 |
|---|---|
| `users_legacy_gate_20260831` | v4 升级中 `users` 被重命名保留 |
| `user_settings_legacy_gate_20260831` | v4 升级中 `user_settings` 被重命名保留 |
| `risk_events_pre_gate_20260831` | v4 升级中 `risk_events` 被重命名保留 |
| `ad_events_pre_gate_20260831` | v4 升级中 `ad_events` 被重命名保留 |
| `settings_pre_gate_20260831` | v4 升级中 `settings` 被重命名保留 |

`v4_gate_verify.sql` 会对这 5 张归档表做存在性校验，并要求临时表
`risk_events_gate_new`、`ad_events_gate_new`、`settings_gate_new` 为 0（已通过 RENAME 消耗掉）。

此外，v1 迁移在保留冲突旧表时使用另一组名字（来自 `v1_migration.sql`）：
`users_legacy_v22`、`user_settings_legacy_v22`。这些表是否存在于当前环境取决于该库实际执行过哪些迁移，
**当前仓库未提供各环境的状态记录**。

### 2.5 仓库中没有正式定义的表

以下表名只在文档或迁移脚本注释中出现，仓库内没有对应 DDL、ORM 模型或查询依赖：

| 表名 | 仓库中的出现位置 | 结论 |
|---|---|---|
| `ai_checks`、`url_checks`、`statistics`、`logs` | `docs/DATABASE_SCHEMA_v1alpha1.md`、`database/README.md`（历史版本）作为旧库历史表提及 | 当前仓库未提供正式定义 |
| `ai_keywords`、`url_rules`、`rule_versions` | 同上，作为测试/备用表提及 | 当前仓库未提供正式定义 |

注意：`/api/stats` 是接口名称，`ai_checks`、`url_checks` 也可能只是统计响应字段名，不代表必须有同名数据表。

### 2.6 枚举类字段的允许值

后台以 `VARCHAR` 保存枚举值，合法性由后端校验；固定值来自 `backend/models/models.py`：

| 字段 | 常量 | 允许值 |
|---|---|---|
| `risk_level` | `RISK_LEVELS` | `safe`、`low`、`medium`、`high` |
| `check_type` | `CHECK_TYPES` | `ai`、`url`、`rule` |
| `source` | `SOURCES` | `extension`、`ui`、`demo`、`backend` |
| `mode` | `MODES` | `normal`、`strict`、`elder`、`child` |
| `action` | `AD_ACTIONS` | `blocked`、`hidden`、`allowed` |
| `match_type` | `BLACKLIST_MATCH_TYPES` | `domain` |
| `security_logs.type` | `LOG_TYPES`（DDL 中为 ENUM） | `ai_check`、`url_check`、`ad_block`、`child_mode`、`elder_mode`、`strict_mode`、`entertainment_block`、`game_block`、`dangerous_block` |

### 2.7 已知的文档与实现不一致

以下差异来自仓库内容比对，新成员应以 SQL 脚本和后端代码为准：

| 项目 | `docs/DATABASE_SCHEMA_v1alpha1.md` 的写法 | 仓库实际内容 |
|---|---|---|
| 初始化表数量 | 写为 7 张（未含 `url_blacklist`） | `database/init.sql` 创建 8 张 |
| `check_type` 取值 | `text`、`url`、`rule` | `backend/models/models.py` 的 `CHECK_TYPES = ('ai', 'url', 'rule')` |
| `settings.preferences` | 展示 `elder` / `child` 嵌套示例 | 后端实际写入 `elder_mode`、`child_mode`、`paused` |
| 设置并发保存 | 描述 `expected_version` 不一致时返回 HTTP 409 | 当前 `backend/services/settings_service.py` 只递增 `version`，未实现 409 校验 |

`docs/index.md` 也已注明：`DATABASE_SCHEMA_v1alpha1.md` 是早期结构设计文档，未完整覆盖
`url_blacklist` 和 v4 Gate，不能替代实际 SQL。

---

## 3. Initialization

### 3.1 前置条件

- 本机已安装并启动 MySQL 5.7.26（仓库记录版本，见第 1.3 节）。
- 已安装后端依赖：`pip install -r requirements.txt`。
- 已准备数据库连接信息：`MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DB`。
- 只对**全新空环境**执行初始化；已有 `net_guard` 数据库不要覆盖执行（`README.md` 与
  `docs/DEVELOPMENT_SETUP.md` 均如此约定）。

### 3.2 初始化步骤

以下命令在项目根目录执行（PowerShell 写法，与 `README.md` 一致）：

```powershell
mysql -u root -p --execute="source database/init.sql"
mysql -u root -p net_guard -e "SHOW TABLES;"
```

`database/init.sql` 自身会执行 `CREATE DATABASE IF NOT EXISTS net_guard`、`USE net_guard`、
`SET NAMES utf8mb4`、`SET time_zone = '+00:00'`，然后创建 8 张空表，最后输出表清单。

bash / Git Bash 等价写法：

```bash
mysql -u root -p net_guard < database/init.sql
```

如果需要手动创建数据库，`database/init.sql` 头部与旧版说明使用：

```sql
CREATE DATABASE net_guard
DEFAULT CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;
```

### 3.3 初始化后的验证

```sql
SHOW TABLES;

SELECT COUNT(*) AS users_count FROM users;
SELECT COUNT(*) AS settings_count FROM settings;
SELECT COUNT(*) AS risk_events_count FROM risk_events;
SELECT COUNT(*) AS ad_events_count FROM ad_events;
SELECT COUNT(*) AS url_blacklist_count FROM url_blacklist;
SELECT COUNT(*) AS security_logs_count FROM security_logs;
SELECT COUNT(*) AS detection_records_count FROM detection_records;
SELECT COUNT(*) AS user_settings_count FROM user_settings;
```

期望结果（依据 `docs/DEVELOPMENT_SETUP.md` 与 `database/init.sql`）：

```text
users
settings
risk_events
ad_events
url_blacklist
security_logs
detection_records
user_settings
```

所有 `COUNT(*)` 均应为 `0`。初始化脚本不写入 Demo 用户、设置或历史检测数据。

### 3.4 Backend 启动前需要完成什么

1. 数据库 `net_guard` 及 8 张表已存在（全新环境执行 `database/init.sql`）。
2. 装好依赖并设置 `MYSQL_*`、`SECRET_KEY` 环境变量（`.env` 不会自动加载）。
3. 启动：`python start_backend.py`，访问 `http://127.0.0.1:5000/health`。
4. 当 `/health` 响应中的 `database` 为 `available` 时，依赖数据库的正式接口才可用；
   `database=unavailable` 表示后端进程可用但数据库链路未就绪。

启动时 `backend/app.py` 会调用 `Base.metadata.create_all(bind=engine)`，它会按 ORM 模型**补建缺失的表**，
但不会修改已有表结构，也不会执行 `database/migration/**` 中的任何脚本。因此：

- 全新环境仍应先执行 `database/init.sql`（或至少确认 `create_all` 的结果与 `init.sql` 一致）；
- 已有数据库的场景必须走迁移流程，不能依赖 `create_all` 完成结构升级。

### 3.5 已有数据库 / 非全新环境

如果 `net_guard` 已存在且包含表或数据：

1. 停止 Backend、Extension 联调和其他写入方；
2. 在仓库目录之外创建完整备份；
3. 识别数据库当前结构（例如 `database/migration/v4_gate_precheck.sql` 的只读盘点）；
4. 由 Backend / 数据库负责人选择迁移路径；
5. 在一次性测试库先演练；
6. 完成预检查、迁移、验证和应用验收后再处理正式库。

不允许凭经验猜测迁移顺序，也不允许绕过预检查执行迁移。

### 3.6 是否存在完整自动初始化流程

**没有。** 仓库中不存在以下内容：

- 一键初始化脚本（如 `make db-init`、`docker-compose`、`setup.py db` 等）；
- ORM 迁移框架配置（无 Alembic / Flask-Migrate）；
- `database/schema/` 目录或任何 schema 快照/种子数据文件；
- 初始化 `url_blacklist` 的种子或导入脚本；
- CI 配置（仓库根目录已确认没有 `.github/` 等 CI 配置）。

初始化完全依赖人工执行 `database/init.sql`；黑名单表初始化后为空，且**当前仓库未提供**正式的黑名单写入通道。

---

## 4. Migration History

迁移版本号只体现在文件名前缀（v1、v2、v3、v4）上。仓库中**不存在**迁移版本记录表
（如 `schema_migrations`、`alembic_version` 等），**当前仓库未提供正式定义**。

### 4.1 当前存在的迁移脚本

| 文件 | 版本 | 作用 | 适用对象 | 重复执行 |
|---|---|---|---|---|
| `migration/v1_precheck.sql` | v1 | 只读预检查：记录源表计数、外键、风险分数分布、时间范围、旧表存在性，并在会话变量中保存结果 | 尚未执行 v1 的旧库（`net_guard` 或 `net_guard_migration_test`） | 可以，只创建/删除临时存储过程，不改业务表 |
| `migration/v1_migration.sql` | v1 | 将旧库升级到 v1alpha1：重命名冲突旧表（`users` → `users_legacy_v22`、`user_settings` → `user_settings_legacy_v22`），创建 `users`、`risk_events`、`ad_events`、`settings`，重建兼容用 `user_settings`，并把 `detection_records`、`security_logs` 调整为兼容结构 | 已具备 `users`、`security_logs`、`detection_records`、`user_settings` 的旧库 | **否，一次性脚本**；需先在同一会话执行预检查 |
| `migration/v2_url_blacklist.sql` | v2 | `CREATE TABLE IF NOT EXISTS url_blacklist`，只新增空表，不写入数据 | 已完成 v1 初始化或迁移的库 | 可以（`IF NOT EXISTS`） |
| `migration/v3_normalize_legacy_risk_events.sql` | v3 | 规范化旧 v1 迁入 `risk_events` 的历史记录（仅处理 `details.legacy_table` 为 `security_logs`/`detection_records` 且存在 `details.legacy_id` 的行），只做 UPDATE 和只读验证 | 已运行旧版 v1 的库 | 可以，条件带非规范值判断 |
| `migration/v4_gate_precheck.sql` | v4 | 只读预检查：目标库名、MySQL 5.7、`sql_mode`、8 张 mixed-state 表是否存在、v4 归档名是否已存在、列签名、引擎/排序规则、重复与非法 `event_uuid`、孤儿数据等 | 特定 mixed-schema 状态的库（`net_guard` 或 `net_guard_gate_migration_test`） | 可以，全部为 SELECT |
| `migration/v4_gate_upgrade_mixed_net_guard.sql` | v4 | mixed-schema 正式升级：归档并重建 `users`、`user_settings`，复制并校验正式表数据（`risk_events`、`ad_events`、`settings`），原地把 `security_logs`、`detection_records` 升级到 ORM 兼容结构，最后用一条原子 `RENAME TABLE` 完成切换，并把数据库默认字符集设为 `utf8mb4` / `utf8mb4_unicode_ci` | MySQL 5.7.26，且预检查全部 PASS | **否**；要求停止所有写入方并先做完整锁定备份 |
| `migration/v4_gate_verify.sql` | v4 | 只读验证：8 张正式/兼容表、5 张归档表、0 张临时表、引擎与排序规则、精确列集合、索引与外键、重复与孤儿检查 | 执行完 v4 升级后的库 | 可以，全部为 SELECT |
| `migration/v4_gate_rollback.sql` | v4 | 回滚 v4 的表名切换（把归档表名切回正式表名） | 仅在全部写入方停止、且应用验收失败或演练库场景 | 需按脚本前置条件判断 |
| `migration/test/v3_legacy_fixture.sql` | v3 测试 | 仅在专用库 `net_guard_migration_v3_test` 中构造最小测试数据，库名不匹配或测试库非空会 `SIGNAL` 中止 | 一次性测试库 | 仅在专用测试库中重建时使用 |
| `migration/test/v3_verify.sql` | v3 测试 | 只读验收 SQL，使用全限定表名，只读取 `net_guard_migration_v3_test` | 同上的测试库 | 可以，全部为 SELECT |

### 4.2 迁移顺序（按数据库当前状态选择，不能混用）

| 数据库状态 | 执行顺序 |
|---|---|
| 全新空数据库 | 只执行 `init.sql`（已包含 `url_blacklist`；不要再执行 v1/v2） |
| 尚未执行 v1 的旧数据库 | `v1_precheck.sql` → `v1_migration.sql` → 按需执行后续增量（如 `v2_url_blacklist.sql`） |
| 已执行旧版 v1、存在旧风险事件口径 | 备份后执行 `v3_normalize_legacy_risk_events.sql` |
| 处于 v4 覆盖的 mixed-schema 状态 | `v4_gate_precheck.sql` → `v4_gate_upgrade_mixed_net_guard.sql` → `v4_gate_verify.sql`；应用验收失败时按条件使用 `v4_gate_rollback.sql` |

关键约束（来自脚本头部注释）：

- `v1_migration.sql` 是一次性迁移，不能重复执行；使用当前修正版 v1 的数据库不需要再执行 v3。
- v1 预检查结果保存在会话变量中，预检查与迁移必须在**同一个 MySQL 会话**中依次执行。
- v4 脚本明确**不会**把 `security_logs`、`detection_records` 导入 `risk_events`，只把它们升级到 ORM 兼容结构；
  v4 同时保留历史检测记录（脚本注释说明 `detection_records` 的历史 `risk_score` 不会被改写）。
- MySQL 5.7 的 DDL 会隐式提交，因此任何迁移都不能被视为整体事务回滚；v1 与 v4 都通过“重命名保留旧表”避免直接删除数据。

### 4.3 v4 的归档与回滚范围

v4 升级完成后：

- 5 张归档表保留原数据（见第 2.4 节）；
- `security_logs`、`detection_records` 是**原地升级**（`ALTER TABLE ... CONVERT TO CHARACTER SET`、增列、加索引），
  数据库默认字符集也是原地修改；
- 因此 `v4_gate_rollback.sql` 只还原表名切换，**不能**还原上述原地结构变化。脚本头部明确写道：
  精确的 pre-v4 回滚仍依赖迁移前的锁定全量备份，不应声称该脚本本身构成完整物理回滚。

### 4.4 迁移版本的历史记录情况

- `CHANGELOG.md` 的 “Database” 段落只记录了 `v1_precheck.sql` 与 `v1_migration.sql`；
  v2、v3、v4 没有出现在变更日志中。
- `docs/DATABASE_SCHEMA_v1alpha1.md` 只描述 v1alpha1 目标结构，未覆盖 v2 的 `url_blacklist` 与 v4 Gate。
- `docs/index.md` 已把“完整数据库 v4 迁移操作手册”列为当前仍缺少的独立文档。
- 仓库内**没有任何记录表明 v4 已在正式库执行过**，也没有对应的执行证据文件；
  各环境的实际迁移状态属于 **“当前仓库未提供正式定义”**。
- `database/backup/` 是本地目录，其中可能存放形如 `<migration-point-backup>.sql` 的迁移前备份；
  但该目录已被 Git 忽略，属于本机文件，不能作为迁移已正式完成的仓库证据。

### 4.5 迁移脚本的测试覆盖

`tests/backend/test_legacy_migration.py` 与 `tests/backend/test_v4_gate_migration.py` 会对
`database/migration/**` 的 SQL 文本做静态断言（例如禁止出现未授权的数据库名、要求使用 MySQL 5.7 语法）。
这些测试**不连接真实 MySQL 执行迁移**，仓库中也没有自动化迁移流水线。

---

## 5. Backup Policy

### 5.1 `database/backup/` 用途

`database/backup/` 是本地备份目录，用于存放开发/迁移前的数据库导出文件和恢复演练文件。
该目录下的文件仅存在于本地，不提交 Git，命名按用途区分即可，例如：

```text
database/backup/
├── <migration-point-backup>.sql    迁移前全量备份
└── <restore-test-backup>.sql       恢复演练用备份
```

目录本身在仓库中不包含任何被跟踪的文件（`git ls-files database` 未列出 `backup/` 下内容）。

### 5.2 为什么这些文件不提交 Git

- `.gitignore` 末尾有专门规则：`database/backup/`（对应条目注释为 “Database local backups”）。
- `.gitignore` 同时忽略 `*.dump`、`*.sql.gz`、`*.backup.sql`、`*_backup.sql`、`*-backup.sql`、
  `*_dump.sql`、`*-dump.sql`、`/backup/`、`/backups/`、`/mysql-data/` 等备份与本地数据文件。
- `CONTRIBUTING.md` 的“数据库文件”一节禁止提交 `*.sql` 备份文件和数据库备份文件，
  并给出 `net_guard_backup_v22.sql` 的反例；`docs/ENVIRONMENT.md` 同样禁止提交数据库备份文件。
- 备份内容会包含真实用户数据、检测历史和日志，属于隐私与安全风险，同时会显著增大仓库体积。

### 5.3 备份的使用场景

| 场景 | 说明 |
|---|---|
| 迁移前保护 | `database/README.md` 的历史流程与 `docs/DEVELOPMENT_SETUP.md` 要求：执行任何迁移前先在仓库目录之外生成完整备份 |
| v4 升级 | v4 要求停止所有写入方并做完整**锁定**备份（部分源表为 MyISAM，仅事务导出不是一致备份） |
| 回滚/恢复 | v1、v4 的脚本都不是完整物理回滚方案；精确恢复依赖迁移前备份 |
| 恢复演练 | `<restore-test-backup>.sql` 这类本地备份文件用于验证备份可恢复 |

仓库文档中给出的备份命令示例（`database/README.md` 历史版本）：

```bash
mysqldump -u root -p --default-character-set=utf8mb4 --routines --triggers --lock-all-tables net_guard > <backup-dir>/<migration-point-backup>.sql
```

恢复时使用对应的导入命令，例如：

```bash
mysql -u root -p net_guard < <backup-dir>/<migration-point-backup>.sql
```

### 5.4 备份策略中未定义的部分

以下内容在仓库中没有正式定义，属于 **“当前仓库未提供正式定义”**：

- 生产环境的自动备份机制、备份频率、保留周期与异地存储；
- 备份加密、访问审计与权限要求；
- 备份完整性校验流程和恢复演练记录模板；
- 除 `database/backup/` 之外的备份目录命名约定（备份必须存放在仓库之外，具体路径由成员本地决定）。

---

## 6. Current Limitations

1. **无生产级备份系统。** 备份依赖人工执行 `mysqldump`，示例输出路径是本机目录；
   仓库中没有自动备份脚本、保留策略或校验机制。
2. **无自动迁移流水线。** 没有 CI 配置、没有迁移执行工具；`database/migration/**` 必须由人工按状态选择并执行。
3. **无完整回滚机制。** MySQL 5.7 的 DDL 隐式提交使迁移无法整体事务回滚；
   `v4_gate_rollback.sql` 只还原表名切换，不还原 `security_logs`、`detection_records` 的原地结构升级和数据库默认字符集变化。
4. **无迁移版本记录表。** 库内不存在 `schema_migrations` 之类的版本表，只能通过文件名和人工排查判断已执行版本；
   各环境实际迁移状态在仓库中没有记录。
5. **迁移测试不覆盖真实数据库执行。** `tests/backend/test_legacy_migration.py`、`test_v4_gate_migration.py`
   只做 SQL 文本静态断言，不能在 CI 中验证真实迁移结果。
6. **schema 目录缺失。** 仓库没有 `database/schema/`，也没有初始化的 schema 快照文件；
   结构基线只能从 `database/init.sql` 与 `backend/models/models.py` 读取。
7. **结构文档与实现不同步。** `docs/DATABASE_SCHEMA_v1alpha1.md` 仍写 7 张初始化表和 `check_type=text`，
   未覆盖 `url_blacklist` 与 v4 Gate；当前后端实际使用 8 张表与 `check_type ∈ {ai, url, rule}`。
8. **部分设计未实现。** 文档描述的设置 `expected_version` 冲突返回 HTTP 409，在当前
   `backend/services/settings_service.py` 中未实现；`settings.preferences` 的实际键也与文档示例不同。
9. **`url_blacklist` 缺少写入通道。** 后端只有查询逻辑，仓库没有写入接口、种子数据或导入脚本，
   黑名单数据如何进入数据库**当前仓库未提供正式定义**。
10. **历史遗留表无定义。** `ai_checks`、`url_checks`、`statistics`、`logs`、`ai_keywords`、`url_rules`、
    `rule_versions` 只在文档中被提及，仓库内没有 DDL、模型或依赖，**当前仓库未提供正式定义**；
    成员本地库中的这类表不属于团队基线。
11. **无数据库部署与权限文档。** 生产/共享环境的 MySQL 版本、账号权限矩阵、连接数上限、
    网络与备份策略在仓库中均无正式定义。
12. **无 v4 操作手册。** `docs/index.md` 明确列出“完整数据库 v4 迁移操作手册”为仍缺少的独立文档；
    执行 v4 前应由 Backend / 数据库负责人结合 `v4_gate_precheck.sql` 的输出现场评审。

### 6.1 相关文档

| 文档 | 说明 |
|---|---|
| [`../docs/DATABASE_SCHEMA_v1alpha1.md`](../docs/DATABASE_SCHEMA_v1alpha1.md) | v1alpha1 早期结构设计（表数量与 `check_type` 取值已过时，见第 2.7 节） |
| [`../docs/DATABASE_CHANGE_RULES.md`](../docs/DATABASE_CHANGE_RULES.md) | 数据库变更治理流程、禁止事项与 PR 检查项 |
| [`../docs/DEVELOPMENT_SETUP.md`](../docs/DEVELOPMENT_SETUP.md) | Python、MySQL、Backend、Web、Extension 与测试环境搭建 |
| [`../docs/ENVIRONMENT.md`](../docs/ENVIRONMENT.md) | 环境变量说明 |
| [`../docs/index.md`](../docs/index.md) | 文档索引与“仍缺少的独立文档”清单 |
| [`../README.md`](../README.md) | 项目总览与快速开始 |

数据库结构变更必须遵循 `docs/DATABASE_CHANGE_RULES.md`：先提交 Issue、由 Backend / 数据库负责人评审，
同时更新 SQL 脚本、结构文档，并完成空库初始化与旧库迁移验证后再提交 Pull Request。
