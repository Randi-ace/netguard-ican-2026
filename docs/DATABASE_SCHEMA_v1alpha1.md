# 净网护航数据库结构规范

- 数据库版本：`v1alpha1`
- 对应 API：`API_CONTRACT_v1alpha1`
- 适用版本：净网护航 `v1.0-alpha-team-ready`
- 状态：待数据库迁移完成后冻结
- 数据库：MySQL

## 1. 文档目的

本文档冻结多人协作阶段使用的四张核心表：

- `users`
- `risk_events`
- `ad_events`
- `settings`

`database/init.sql` 的团队初始化基线还包含三张运行支撑表：

- `security_logs`：当前日志、统计和 URL 检测路由仍在使用；
- `detection_records`：当前 AI 检测路由仍在写入；
- `user_settings`：当前 SQLAlchemy 模型注册与迁移流程仍然需要。

因此，全新开发库共创建 7 张表。这三张运行支撑表用于保证当前系统和团队开发环境正常运行，未经代码依赖与迁移影响评估不得删除。

负责人本地存在的 `ai_checks`、`url_checks`、`statistics`、`logs` 属于旧库历史表；`ai_keywords`、`url_rules`、`rule_versions` 在当前仓库中没有模型、查询或迁移依赖，按测试/备用表处理。这 7 张表均不进入团队初始化基线。

设计目标是满足本科项目的插件、后端和 Web 展示需求，不引入复杂的企业级权限、审计、分库分表或消息队列设计。

只有 backend 负责人直接操作数据库。extension 和 UI 负责人通过 API 使用数据。

## 2. 表关系

```text
users
  ├── 1 : N ── risk_events
  ├── 1 : N ── ad_events
  └── 1 : 1 ── settings
```

含义：

- 一个用户可以产生多条风险事件。
- 一个用户可以产生多条广告事件。
- 一个用户只有一份当前设置。

初始化脚本不写入 Demo 用户或任何业务数据。Alpha 后端在首次访问设置接口时可以按需创建 Demo 用户，但所有事件和设置仍应通过 `user_id` 关联。

## 3. 通用规则

### 3.1 命名

- 表名和字段名使用小写 `snake_case`。
- 表名使用复数。
- 主键统一为 `id`。
- 外键统一为 `<表名单数>_id`，例如 `user_id`。
- 时间字段统一为 `created_at`、`updated_at`、`occurred_at`。

### 3.2 时间

- 数据库存储 UTC 时间。
- API 输出 ISO 8601 时间。
- 前端负责转换为北京时间或其他展示时区。
- MySQL 建议使用 `DATETIME(6)`。

### 3.3 枚举

为了降低本科项目迁移难度，数据库中使用 `VARCHAR` 保存枚举值，由后端统一校验。

固定值：

| 字段 | 允许值 |
|---|---|
| `risk_level` | `safe`、`low`、`medium`、`high` |
| `check_type` | `text`、`url`、`rule` |
| `source` | `extension`、`ui`、`demo`、`backend` |
| `mode` | `normal`、`strict`、`elder`、`child` |
| `action` | `blocked`、`hidden`、`allowed` |

### 3.4 URL

- 完整 URL 使用 `TEXT` 保存。
- 额外保存 `url_hash`，值为 URL 的 SHA-256 十六进制字符串。
- 统计和去重优先使用 `url_hash`，避免为长 URL 建立大索引。
- 页面内容不得整页写入数据库；确需保存检测信息时放入经过裁剪的 `details`。

### 3.5 事件写入

- `risk_events` 和 `ad_events` 是追加型事件表。
- 事件创建后原则上不修改。
- 客户端通过 `event_uuid` 保证网络重试不会重复记账。
- 删除用户时，历史事件的 `user_id` 设置为 `NULL`，保留比赛统计数据。

## 4. `users`

用途：保存最小用户身份，为事件和设置提供关联对象。

Alpha 阶段没有完整登录系统，因此不设计密码、登录令牌或复杂角色权限。

### 字段

| 字段 | MySQL 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `id` | `BIGINT UNSIGNED` | 是 | 自增 | 主键 |
| `public_id` | `CHAR(36)` | 是 | 无 | 对外使用的 UUID |
| `username` | `VARCHAR(64)` | 否 | `NULL` | 登录名，Alpha 可不使用 |
| `display_name` | `VARCHAR(100)` | 是 | `智盾用户` | 展示名称 |
| `role` | `VARCHAR(32)` | 是 | `user` | `user`、`admin` 或 `demo` |
| `status` | `VARCHAR(16)` | 是 | `active` | `active` 或 `disabled` |
| `created_at` | `DATETIME(6)` | 是 | 当前 UTC 时间 | 创建时间 |
| `updated_at` | `DATETIME(6)` | 是 | 当前 UTC 时间 | 更新时间 |

### 索引

| 索引 | 类型 | 用途 |
|---|---|---|
| `PRIMARY KEY (id)` | 主键 | 用户定位 |
| `UNIQUE (public_id)` | 唯一 | API 对外标识 |
| `UNIQUE (username)` | 唯一 | 防止重复用户名；允许 `NULL` |
| `INDEX (status, created_at)` | 普通 | 用户状态查询 |

### 说明

- API 示例暂时使用整数 `user_id`。
- 后续如果增加登录功能，应单独设计认证，不在本版本直接增加明文密码字段。
- Demo 环境可以由后端按需创建 `role=demo` 的用户，但不得将成员本地 Demo 数据写入初始化脚本。

## 5. `risk_events`

用途：统一保存 AI 检测、URL 检测、儿童模式、老人模式和本地规则产生的风险事件。

该表替代当前职责重叠的 `security_logs` 风险部分和 `detection_records`。

### 字段

| 字段 | MySQL 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `id` | `BIGINT UNSIGNED` | 是 | 自增 | 主键 |
| `event_uuid` | `CHAR(36)` | 是 | 无 | 客户端幂等编号 |
| `user_id` | `BIGINT UNSIGNED` | 否 | `NULL` | 关联 `users.id` |
| `event_type` | `VARCHAR(32)` | 是 | 无 | `ai_check`、`url_check`、`child_block` 等 |
| `check_type` | `VARCHAR(20)` | 是 | 无 | `text`、`url` 或 `rule` |
| `risk_level` | `VARCHAR(16)` | 是 | 无 | 风险等级 |
| `risk_score` | `DECIMAL(5,4)` | 是 | `0.0000` | 0 至 1 |
| `url` | `TEXT` | 否 | `NULL` | 完整页面地址 |
| `url_hash` | `CHAR(64)` | 否 | `NULL` | URL SHA-256 |
| `reason` | `VARCHAR(1000)` | 否 | `NULL` | 检测原因 |
| `source` | `VARCHAR(20)` | 是 | `backend` | 事件来源 |
| `details` | `JSON` | 否 | `NULL` | 命中规则、信号等扩展信息 |
| `occurred_at` | `DATETIME(6)` | 是 | 当前 UTC 时间 | 事件发生时间 |
| `created_at` | `DATETIME(6)` | 是 | 当前 UTC 时间 | 服务端写入时间 |

### 索引

| 索引 | 类型 | 用途 |
|---|---|---|
| `PRIMARY KEY (id)` | 主键 | 事件定位 |
| `UNIQUE (event_uuid)` | 唯一 | 防止请求重试造成重复事件 |
| `INDEX (user_id, occurred_at)` | 普通 | 用户时间线 |
| `INDEX (risk_level, occurred_at)` | 普通 | 风险等级统计 |
| `INDEX (event_type, occurred_at)` | 普通 | AI、URL、儿童等分类统计 |
| `INDEX (url_hash)` | 普通 | URL 查询和去重 |

外键：

```text
user_id -> users.id ON DELETE SET NULL
```

### 字段使用示例

AI 检测：

```json
{
  "event_type": "ai_check",
  "check_type": "text",
  "risk_level": "high",
  "risk_score": 0.95,
  "source": "extension"
}
```

儿童模式拦截：

```json
{
  "event_type": "child_block",
  "check_type": "rule",
  "risk_level": "medium",
  "risk_score": 0.65,
  "source": "extension"
}
```

### 不再保留的重复字段

- 不单独保存 `is_high_risk`，通过 `risk_level=high` 判断。
- 不单独保存 `is_phishing`，放入 `details.signals`。
- 不再同时使用 `risk`、`risk_level`、`level`，统一为 `risk_level`。
- 不把待检测文本错误地写入 `url` 字段。

## 6. `ad_events`

用途：保存广告拦截、隐藏和放行事件，与风险检测事件分离。

### 字段

| 字段 | MySQL 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `id` | `BIGINT UNSIGNED` | 是 | 自增 | 主键 |
| `event_uuid` | `CHAR(36)` | 是 | 无 | 客户端幂等编号 |
| `user_id` | `BIGINT UNSIGNED` | 否 | `NULL` | 关联 `users.id` |
| `action` | `VARCHAR(16)` | 是 | 无 | `blocked`、`hidden` 或 `allowed` |
| `mode` | `VARCHAR(16)` | 是 | `normal` | 当前插件模式 |
| `page_url` | `TEXT` | 否 | `NULL` | 发生事件的页面 |
| `url_hash` | `CHAR(64)` | 否 | `NULL` | 页面 URL SHA-256 |
| `resource_type` | `VARCHAR(32)` | 否 | `NULL` | `iframe`、`script`、`image`、`dom` 等 |
| `rule_id` | `VARCHAR(100)` | 否 | `NULL` | 命中的规则或选择器编号 |
| `blocked_count` | `INT UNSIGNED` | 是 | `1` | 本次处理的广告数量 |
| `reason` | `VARCHAR(500)` | 否 | `NULL` | 拦截原因 |
| `source` | `VARCHAR(20)` | 是 | `extension` | 事件来源 |
| `details` | `JSON` | 否 | `NULL` | 其他演示或调试信息 |
| `occurred_at` | `DATETIME(6)` | 是 | 当前 UTC 时间 | 事件发生时间 |
| `created_at` | `DATETIME(6)` | 是 | 当前 UTC 时间 | 服务端写入时间 |

### 索引

| 索引 | 类型 | 用途 |
|---|---|---|
| `PRIMARY KEY (id)` | 主键 | 事件定位 |
| `UNIQUE (event_uuid)` | 唯一 | 防止重复上报 |
| `INDEX (user_id, occurred_at)` | 普通 | 用户广告事件时间线 |
| `INDEX (action, occurred_at)` | 普通 | 拦截、隐藏、放行统计 |
| `INDEX (mode, occurred_at)` | 普通 | 普通和严格模式统计 |
| `INDEX (url_hash)` | 普通 | 页面查询 |

外键：

```text
user_id -> users.id ON DELETE SET NULL
```

### 上报粒度

- 一次批量清理可以保存为一条事件。
- 使用 `blocked_count` 记录本次处理数量。
- 不要求每个 DOM 元素单独创建一条数据库记录。

这样可以减少插件请求次数，也足够支持本科项目统计展示。

## 7. `settings`

用途：保存一个用户当前使用的主模式和扩展偏好。

该表替代当前与路由不匹配的 `setting_key/setting_value` 结构。

### 字段

| 字段 | MySQL 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `id` | `BIGINT UNSIGNED` | 是 | 自增 | 主键 |
| `user_id` | `BIGINT UNSIGNED` | 是 | 无 | 关联 `users.id` |
| `mode` | `VARCHAR(16)` | 是 | `normal` | 当前主模式 |
| `preferences` | `JSON` | 是 | 无，由后端显式写入 | 老人、儿童等扩展配置；MySQL 5.7 不设置 JSON 对象默认值 |
| `version` | `INT UNSIGNED` | 是 | `1` | 并发保存版本号 |
| `created_at` | `DATETIME(6)` | 是 | 当前 UTC 时间 | 创建时间 |
| `updated_at` | `DATETIME(6)` | 是 | 当前 UTC 时间 | 更新时间 |

### 索引

| 索引 | 类型 | 用途 |
|---|---|---|
| `PRIMARY KEY (id)` | 主键 | 设置定位 |
| `UNIQUE (user_id)` | 唯一 | 保证每个用户只有一份设置 |
| `INDEX (mode, updated_at)` | 普通 | 模式使用统计 |

外键：

```text
user_id -> users.id ON DELETE CASCADE
```

### `preferences` 示例

```json
{
  "elder": {
    "font_scale": 1.35,
    "risk_highlight": true,
    "page_simplify": false
  },
  "child": {
    "daily_minutes": 60,
    "learning_only": false
  }
}
```

### 保存规则

1. 客户端读取设置时获得当前 `version`。
2. 保存时提交 `expected_version`。
3. 两者一致时保存，并将数据库 `version` 加一。
4. 不一致时返回 HTTP 409，避免 UI 和插件互相覆盖配置。

## 8. API 与数据库对应关系

下表描述 v1alpha1 目标对应关系。当前路由和模型仍依赖运行支撑表，因此初始化脚本保留 `security_logs`、`detection_records` 和 `user_settings`；完成代码依赖与迁移影响评估前不得删除。

| API | 读取 | 写入 |
|---|---|---|
| `GET /health` | 数据库连接状态 | 无 |
| `POST /api/risk/check` | 无或风险规则 | `risk_events`，由 `record_event` 决定 |
| `POST /api/events/risk` | `users` | `risk_events` |
| `POST /api/events/ad` | `users` | `ad_events` |
| `GET /api/settings` | `settings` | 无 |
| `POST /api/settings` | `settings` | `settings` |
| `GET /api/stats` | `risk_events`、`ad_events` | 无 |
| `GET /api/logs` | `risk_events`、`ad_events` | 无 |

## 9. 当前模型迁移建议

当前表：

- `security_logs`
- `detection_records`
- `user_settings`

建议采用简单、可回滚的迁移方式：

1. 先创建四张新表，不立即删除旧表。
2. 创建一个 Demo 用户。
3. 将 `security_logs` 中的风险类事件复制到 `risk_events`。
4. 将 `security_logs` 中的 `ad_block` 复制到 `ad_events`。
5. 将 `detection_records` 中不重复的记录补充到 `risk_events`。
6. 从旧设置中能识别出的 `mode` 初始化到新 `settings`。
7. 后端 API 改为只写新表。
8. 统计和日志接口改为只读新表。
9. 联调确认后，再在后续版本决定是否删除旧表。

### 旧事件分类建议

| 旧 `type` | 新表 | 新 `event_type` |
|---|---|---|
| `ai_check` | `risk_events` | `ai_check` |
| `url_check` | `risk_events` | `url_check` |
| `child_mode` | `risk_events` | `child_block` 或 `child_access` |
| `elder_mode` | `risk_events` | `elder_warning` |
| `strict_mode` | `risk_events` | `strict_block` |
| `entertainment_block` | `risk_events` | `entertainment_block` |
| `game_block` | `risk_events` | `game_block` |
| `dangerous_block` | `risk_events` | `dangerous_block` |
| `ad_block` | `ad_events` | 通过 `action=blocked` 表示 |

迁移时必须通过规则避免 `security_logs` 和 `detection_records` 中的 AI 事件重复导入。

## 10. 三方职责边界

### extension 负责人

- 不直接了解或操作表结构。
- 按 API 契约生成 `event_uuid` 和请求 JSON。
- `record_event=true` 的检测结果不再次上报。
- 批量广告处理优先使用 `blocked_count`。

### backend 负责人

- 负责 SQLAlchemy 模型、迁移和外键。
- 负责 API 字段到数据库字段的映射。
- 负责事件去重、枚举校验和 UTC 时间处理。
- 负责统计与日志查询。

### UI 负责人

- 不直接依赖数据库字段。
- 只使用 `/api/stats`、`/api/logs` 和 `/api/settings`。
- 页面字段变化应通过 API 契约协调，不要求数据库负责人为页面临时添加同义字段。

## 11. 本版本不包含的设计

为了避免过度设计，`v1alpha1` 暂不包含：

- 完整注册和登录系统。
- 密码、Token 和权限表。
- 操作审计表。
- 软删除体系。
- 分库分表。
- 消息队列和异步事件平台。
- 数据仓库或复杂报表表。
- 为每个广告 DOM 元素单独建表。

如果比赛或课程后续明确需要，再在新的数据库版本中增加。

## 12. 数据库冻结条件

满足以下条件后可冻结为 `database-schema-v1alpha1`：

1. 四张表已通过迁移脚本创建。
2. 外键和唯一索引生效。
3. 相同 `event_uuid` 不产生重复记录。
4. `/api/settings` 能正确处理版本冲突。
5. `/api/stats` 和 `/api/logs` 只读取新事件表。
6. extension、backend、UI 三方确认字段含义。
7. 数据库迁移经过至少一次空库测试和一次已有旧表测试。

冻结后：

- 可以增加可空字段或新索引。
- 不得直接删除、改名或改变已有字段含义。
- 破坏兼容性的修改必须创建新的数据库结构版本。
