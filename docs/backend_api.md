# 《净网护航》后端接口规范

| 文档属性 | 内容 |
|---|---|
| 项目名称 | 净网护航——基于 AI 的智能广告拦截与网络安全防护系统 |
| 文档类型 | 后端 HTTP API 接口规范 |
| 文档版本 | 1.0.2 |
| 接口阶段 | 第一阶段 RC 候选（本地受控环境） |
| 实现基线 | `87618cf` |
| 更新日期 | 2026-09-20 |
| 主要读者 | 后端负责人、Edge 插件负责人、Web 前端负责人、测试人员 |

本文档描述 `87618cf` 已经落地的事件上报、风险检测、Dashboard、统一日志和设置接口，是当前唯一 API 实现说明。接口调用方应以本文档为联调依据，不应根据数据库结构自行推断接口字段。

`docs/API_CONTRACT_v1alpha1.md` 保留为早期设计材料，其中的 `check_type=text`、设置版本冲突结构、cursor 日志分页和风险接口不接收 `event_uuid` 等内容已经过时，不再作为当前实现契约。RC 报告记录测试事实，也不替代本文档定义接口。

## 目录

1. [项目简介](#1-项目简介)
2. [后端架构说明](#2-后端架构说明)
3. [接口统一规范](#3-接口统一规范)
4. [接口总览](#4-接口总览)
5. [风险检测接口](#5-风险检测接口)
6. [事件上报接口](#6-事件上报接口)
7. [Dashboard 接口](#7-dashboard-接口)
8. [统一安全事件日志接口](#8-统一安全事件日志接口)
9. [设置与健康检查](#9-设置与健康检查)
10. [错误码说明](#10-错误码说明)
11. [数据流说明](#11-数据流说明)
12. [插件联调规范](#12-插件联调规范)
13. [前端调用规范](#13-前端调用规范)
14. [正式数据源与旧接口迁移](#14-正式数据源与旧接口迁移)
15. [开发与变更约束](#15-开发与变更约束)
16. [待确认事项](#16-待确认事项)

## 1. 项目简介

“净网护航”面向浏览器广告拦截、恶意网址识别、AI 内容风险检测和安全数据展示场景。当前系统由以下四部分组成：

- Edge 浏览器插件：执行网页侧检测、广告过滤、事件 UUID 生成和事件上报。
- Flask 后端：提供检测、事件接收、参数校验、数据持久化和统计查询能力。
- MySQL 数据库：保存用户、设置、风险事件和广告事件。
- Web 用户平台与演示中心：通过统一 Dashboard 和日志接口展示真实业务数据。

项目的数据闭环为：

~~~text
Edge 插件
    ↓ HTTP + JSON
Flask Route / Blueprint
    ↓
Service
    ↓ SQLAlchemy
MySQL
    ↓ 聚合查询
Dashboard Service / Log Service
    ↓
用户管理平台与演示中心
~~~

### 1.1 团队职责

| 角色 | 负责人 | 接口相关职责 |
|---|---|---|
| 项目与后端 | 周敏 | Flask 服务、数据库、AI 能力、接口实现和契约维护 |
| Edge 插件 | 插件负责人 | 风险触发、广告拦截、事件 UUID、失败重试和接口联调 |
| Web 前端 | 前端负责人 | Dashboard、日志、设置页面和异常状态展示 |

任何接口字段、枚举、统计口径或错误处理方式发生变化时，后端负责人应先更新本规范，再通知插件和前端负责人。

## 2. 后端架构说明

### 2.1 技术组成

| 层级 | 当前技术或职责 |
|---|---|
| HTTP 服务 | Flask |
| 路由组织 | Flask Blueprint |
| 跨域通信 | Flask-CORS |
| 业务逻辑 | Service 层 |
| ORM | SQLAlchemy |
| 数据库 | MySQL |
| 传输格式 | HTTP + JSON |

### 2.2 分层职责

~~~text
调用方
  ├── Edge 插件
  ├── 用户管理平台
  └── 演示中心
          ↓
Route / Blueprint
  ├── 读取 JSON 或查询参数
  ├── 调用 Service
  └── 组装 HTTP 响应
          ↓
Service
  ├── 参数校验
  ├── 数据转换
  ├── 事件幂等
  ├── 统计聚合
  └── 异常归类
          ↓
SQLAlchemy Model / Session
          ↓
MySQL
~~~

Route 层不得直接编写统计 SQL，也不得直接承担事件写入逻辑。事件保存、聚合统计和日志合并分别由 EventService、DashboardService 和 LogService 负责。

### 2.3 核心数据表

| 数据表 | 用途 | 是否为新业务正式数据源 |
|---|---|---|
| users | 用户身份信息 | 是 |
| settings | 用户当前配置 | 是 |
| risk_events | AI、URL、插件规则风险事件 | 是 |
| ad_events | 广告拦截统计事件 | 是 |
| url_blacklist | Backend 权威 URL 域名黑名单 | 是 |
| security_logs | 旧版混合安全日志 | 否，仅兼容保留 |
| detection_records | 旧版检测记录 | 否，仅兼容保留 |
| user_settings | 旧版键值设置 | 否，仅兼容保留 |

Dashboard 和新日志接口只允许从 risk_events 与 ad_events 读取业务数据。

## 3. 接口统一规范

### 3.1 服务地址

本地开发默认地址：

~~~text
http://127.0.0.1:5000
~~~

除健康检查外，新业务接口统一使用 /api 前缀。生产或联调环境的主机、端口应由环境配置提供，插件和前端不得在业务代码中散落硬编码地址。

### 3.2 接口版本管理

- 当前接口契约通过本文档版本管理，本次规范版本为 1.0.1。
- 当前暂不增加 URL 版本前缀，既有 /api 路径保持不变。
- 文档小版本修订用于澄清语义和兼容规则，不改变现有 API 路径。
- 后续如发生破坏性变更，应先由三方确认新的契约版本，再决定是否引入 URL 版本前缀。

### 3.3 HTTP 与 JSON

- 请求和响应字符集为 UTF-8。
- POST 请求必须设置 Content-Type: application/json。
- GET 请求使用 URL 查询参数，不发送 JSON 请求体。
- JSON 字段命名统一使用 snake_case。
- 调用方必须同时判断 HTTP 状态码和响应体 code。
- 前端不得仅以 HTTP 200 判断业务成功。

### 3.4 时间规范

- 服务端事件时间以 UTC 记录。
- 对外时间使用 ISO 8601 格式，例如 2026-08-04T02:30:45.123456Z。
- Dashboard 统计时区固定为 Asia/Shanghai，并使用 Python zoneinfo 处理时区转换。
- “今日”指北京时间 00:00:00 至次日 00:00:00；后端将该边界换算为 UTC 后查询数据库。
- 趋势接口的 dates 按北京时间自然日生成，风险与广告事件均按北京时间日期归组。
- 日志时间仍返回 UTC 时间戳；Web 页面可转换为北京时间展示，但不得修改接口原始值。
- 事件上报接口不接收客户端 occurred_at；occurred_at 和 created_at 均由服务端生成。

### 3.5 固定枚举

| 字段 | 允许值 | 说明 |
|---|---|---|
| risk_level | safe、low、medium、high | 风险等级由低到高 |
| check_type | ai、url、rule | ai 为后端 AI 文本检测，url 为后端 URL 检测，rule 为插件规则事件 |
| source | extension、ui、demo、backend | 风险事件来源 |
| mode | normal、strict、elder、child | 广告拦截模式 |
| Dashboard days | 7、30、90 | 趋势查询时间范围 |

枚举值区分大小写。调用方不得上传 High、HIGH 等非约定值。

### 3.6 新接口统一响应

普通成功：

~~~json
{
  "code": 0,
  "message": "success",
  "data": {}
}
~~~

失败：

~~~json
{
  "code": 400,
  "message": "错误信息",
  "data": null
}
~~~

失败响应的 code 与 HTTP 状态类别保持一致：参数错误使用 400，服务异常使用 500，数据库不可用或持久化失败使用 503。详细规则见第 10 章。

事件首次创建成功使用 HTTP 201；Dashboard 和日志查询成功使用 HTTP 200。

### 3.7 认证现状

当前阶段尚未在本文接口中启用 JWT，也未按登录用户隔离 risk_events 和 ad_events。接口适用于本地开发和受控演示环境，不应直接暴露到公网。

后续加入认证时，应优先通过请求身份绑定 user_id，不应要求插件或前端任意提交数据库主键。

## 4. 接口总览

| 方法 | 路径 | 状态 | 主要调用方 | 用途 |
|---|---|---|---|---|
| GET | /health | 已实现，兼容格式 | 插件、前端、运维 | 服务与数据库状态检查 |
| POST | /api/risk/check | 已实现，兼容错误码 | 插件、Web、Demo | 服务端执行 URL 与内容风险检测 |
| POST | /api/events/risk | 已实现 | 插件 | 上报插件侧风险事件 |
| POST | /api/events/ad | 已实现 | 插件 | 上报广告拦截统计 |
| GET | /api/dashboard/overview | 已实现 | 用户平台、演示中心 | 总览统计卡片 |
| GET | /api/dashboard/trend | 已实现 | 用户平台、演示中心 | 风险与广告趋势 |
| GET | /api/dashboard/risk-distribution | 已实现 | 用户平台、演示中心 | 风险等级分布 |
| GET | /api/logs/risk | 已实现 | 用户平台、演示中心 | 风险与广告统一日志 |
| GET | /api/settings | 已实现 | 插件、前端 | 读取当前演示用户设置 |
| POST | /api/settings | 已实现 | 插件、前端 | 更新当前演示用户设置 |

## 5. 风险检测接口

### 5.1 服务端风险检测

**请求**

~~~text
POST /api/risk/check
Content-Type: application/json
~~~

**用途**

对 URL 和页面文本进行综合检测，返回风险等级、风险评分和风险原因。检测成功后，后端自动写入一条 risk_events。`87618cf` 会先检查 URL 黑名单和 URL 规则，再调用文本关键词规则；仓库未附带可用的训练模型文件，因此当前结果不应描述为已完成真实语义模型推理。

**请求参数**

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---:|---|---|
| url | string | 是 | 非空，最长 4096 字符 | 检测目标 URL |
| content | string | 是 | 允许空字符串，检测最多使用前 3000 字符 | 页面正文或待分析内容 |
| source | string | 是 | extension、ui、demo、backend | 调用来源 |
| event_uuid | string | 否 | 有效 UUID | 调用方提供时用于请求重试幂等 |

**请求示例**

~~~json
{
  "event_uuid": "5559586c-fe8b-4ca1-97eb-c5f8472460d3",
  "url": "https://example.com/login",
  "content": "请立即验证账户并转账",
  "source": "extension"
}
~~~

**成功响应：HTTP 200**

~~~json
{
  "code": 0,
  "message": "风险检测完成",
  "data": {
    "risk_level": "high",
    "score": 0.9,
    "reason": "检测到钓鱼网站特征"
  }
}
~~~

**返回字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| risk_level | string | safe、low、medium 或 high |
| score | number | 0 至 1 之间的风险评分 |
| reason | string | 命中的检测原因 |

**持久化规则**

- 调用方未提供 event_uuid 时由后端生成；调用方提供时保存规范化后的 UUID。
- 提供 event_uuid 后，相同 UUID 的重试返回既有检测结果，不新增 risk_events 记录。
- URL 检测结果写入 event_type=extension_risk、check_type=url。
- AI 文本检测结果写入 event_type=extension_risk、check_type=ai。
- API 的 score 对应数据库字段 risk_score。
- 后端自动保存 url_hash、occurred_at 和 created_at。
- 数据库写入失败时返回 HTTP 503，不返回检测成功。

**check_type 生成规则**

- 调用方不提交 check_type。
- 最终采用 AI 文本检测结果时，后端自动写入 check_type=ai。
- 最终采用 URL 检测结果时，后端自动写入 check_type=url。
- 本接口不会产生 check_type=rule；rule 专用于插件规则事件上报。

**重要限制**

- `event_uuid` 是可选字段。未提供时，自动重试仍可能产生新的风险记录；需要请求级幂等的调用方应生成有效 UUID，并在同一次检测的所有重试中复用。
- 已存在相同 `event_uuid` 时，接口以 HTTP 200、`code=0` 返回既有事件对应的检测结果；当前响应不会额外返回 `duplicate` 标志。
- 调用 `/api/risk/check` 成功后，不得再为同一次检测调用 `/api/events/risk`，否则会形成两条业务事件。

## 6. 事件上报接口

事件上报接口用于把插件已经产生的事实事件写入正式事件表。插件负责生成 event_uuid，后端负责校验、幂等和持久化。

### 6.1 风险事件上报

**请求**

~~~text
POST /api/events/risk
Content-Type: application/json
~~~

**功能**

浏览器插件检测到风险网页、恶意 URL 或本地规则风险内容后，上报风险事件。该接口不再次执行 AI 检测。

**请求参数**

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---:|---|---|
| event_uuid | string | 是 | 有效 UUID | 事件唯一标识，用于幂等 |
| url | string | 是 | 非空，最长 4096 字符 | 检测目标 URL |
| risk_level | string | 是 | safe、low、medium、high | 风险等级 |
| score | number | 是 | 0 至 1，不能为布尔值 | 风险评分 |
| reason | string | 是 | 非空，最长 1000 字符 | 风险原因 |
| source | string | 是 | extension、ui、demo、backend | 事件来源 |
| check_type | string | 否 | ai、url、rule；默认 rule | 检测来源类型 |

**check_type 语义**

插件根据内部检测流程生成 check_type，不提供用户输入项：AI 文本检测使用 ai，URL 检测使用 url，其他本地规则检测使用 rule。兼容旧插件，省略 check_type 时后端默认保存为 rule。

**请求示例**

~~~json
{
  "event_uuid": "5559586c-fe8b-4ca1-97eb-c5f8472460d3",
  "url": "https://example.com",
  "risk_level": "high",
  "score": 0.95,
  "reason": "检测到诈骗关键词",
  "source": "extension",
  "check_type": "ai"
}
~~~

**首次创建成功：HTTP 201**

~~~json
{
  "code": 0,
  "message": "success",
  "data": {
    "event_id": 101,
    "event_uuid": "5559586c-fe8b-4ca1-97eb-c5f8472460d3",
    "occurred_at": "2026-08-04T02:30:45.123456Z"
  }
}
~~~

**重复事件：HTTP 200**

~~~json
{
  "code": 1,
  "message": "duplicate",
  "data": {
    "event_id": 101,
    "event_uuid": "5559586c-fe8b-4ca1-97eb-c5f8472460d3",
    "occurred_at": "2026-08-04T02:30:45.123456Z"
  }
}
~~~

**服务端自动生成或固定的字段**

| 字段 | 处理规则 |
|---|---|
| event_id | 数据库自增主键 |
| event_type | 固定为 extension_risk |
| check_type | 使用请求值；省略时默认为 rule |
| risk_score | 由请求 score 转换 |
| url_hash | URL 的 SHA-256 摘要 |
| occurred_at | 服务端接收并创建事件的 UTC 时间 |
| created_at | 服务端写入数据库的 UTC 时间 |

### 6.2 广告事件上报

**请求**

~~~text
POST /api/events/ad
Content-Type: application/json
~~~

**功能**

插件完成一次网页广告过滤后，上报该次网页处理实际拦截的广告数量。

**请求参数**

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---:|---|---|
| event_uuid | string | 是 | 有效 UUID | 事件唯一标识，用于幂等 |
| page_url | string | 是 | 非空，最长 4096 字符 | 发生广告拦截的页面 URL |
| resource_type | string | 否 | 最长 32 字符 | 资源类型，如 iframe、script、image |
| blocked_count | integer | 是 | 大于或等于 0，不能为布尔值 | 本次网页处理实际拦截数量 |
| mode | string | 否 | normal、strict、elder、child；默认 normal | 插件拦截模式 |

**请求示例**

~~~json
{
  "event_uuid": "1699888e-d9a6-4813-93c2-529df1e8ee75",
  "page_url": "https://example.com",
  "resource_type": "iframe",
  "blocked_count": 10,
  "mode": "normal"
}
~~~

**首次创建成功：HTTP 201**

~~~json
{
  "code": 0,
  "message": "success",
  "data": {
    "event_id": 201,
    "event_uuid": "1699888e-d9a6-4813-93c2-529df1e8ee75",
    "occurred_at": "2026-08-04T02:31:10.654321Z"
  }
}
~~~

**重复事件：HTTP 200**

~~~json
{
  "code": 1,
  "message": "duplicate",
  "data": {
    "event_id": 201,
    "event_uuid": "1699888e-d9a6-4813-93c2-529df1e8ee75",
    "occurred_at": "2026-08-04T02:31:10.654321Z"
  }
}
~~~

**服务端自动生成或固定的字段**

| 字段 | 处理规则 |
|---|---|
| event_id | 数据库自增主键 |
| action | 固定为 blocked |
| source | 固定为 extension |
| url_hash | page_url 的 SHA-256 摘要 |
| occurred_at | 服务端接收并创建事件的 UTC 时间 |
| created_at | 服务端写入数据库的 UTC 时间 |

blocked_count 是统计数量而不是数据库记录数量。一次网页处理拦截 10 个广告时，应上报一条 blocked_count=10 的事件；Dashboard 使用 SUM(blocked_count) 统计广告拦截总量。

### 6.3 事件幂等规则

- risk_events.event_uuid 与 ad_events.event_uuid 分别具有唯一约束。
- 插件每个新业务事件必须生成一个新的 UUID。
- 同一事件因超时或网络失败重试时，必须复用原 UUID。
- 相同 UUID 再次提交时，后端返回 code=1 和已有记录，不新增数据库行。
- code=1 表示请求已被接受过，插件应将其视为终态成功，不应继续重试。
- 当前实现不会比较重复请求的其他字段。插件不得对不同事件复用 UUID，也不得在重试时修改事件内容。

### 6.4 参数错误示例

~~~json
{
  "code": 400,
  "message": "score范围必须为0到1",
  "data": null
}
~~~

事件接口参数错误返回 HTTP 400 且 code=400；未预期服务异常返回 HTTP 500 且 code=500；数据库不可用或写入失败返回 HTTP 503 且 code=503。

## 7. Dashboard 接口

Dashboard 接口同时服务用户管理平台和演示中心。两类页面必须复用同一组接口，不得为单一页面创建同义统计接口。

### 7.1 总览统计

**请求**

~~~text
GET /api/dashboard/overview
~~~

无查询参数，无请求体。

**成功响应：HTTP 200**

~~~json
{
  "code": 0,
  "message": "success",
  "data": {
    "ai_check_count": 12,
    "url_check_count": 18,
    "high_risk_count": 5,
    "ad_block_count": 126,
    "child_mode_count": 4,
    "elder_mode_count": 3,
    "today_risk_count": 6,
    "today_ad_count": 20
  }
}
~~~

**统计口径**

| 返回字段 | 数据来源 | 统计规则 |
|---|---|---|
| ai_check_count | risk_events | check_type=ai 的记录数 |
| url_check_count | risk_events | check_type 为 url 或 rule 的记录数 |
| high_risk_count | risk_events | risk_level=high 的记录数 |
| ad_block_count | ad_events | SUM(blocked_count)，禁止使用记录数代替 |
| child_mode_count | ad_events | mode=child 的事件记录数 |
| elder_mode_count | ad_events | mode=elder 的事件记录数 |
| today_risk_count | risk_events | 北京时间当天风险事件记录数 |
| today_ad_count | ad_events | 北京时间当天 SUM(blocked_count) |

空数据库时所有字段返回整数 0，不返回 null。

### 7.2 趋势统计

**请求**

~~~text
GET /api/dashboard/trend?days=7
~~~

**查询参数**

| 参数 | 类型 | 必填 | 默认值 | 允许值 | 说明 |
|---|---|---:|---:|---|---|
| days | integer | 否 | 7 | 7、30、90 | 包含北京时间当天的连续自然日数量 |

**成功响应：HTTP 200**

~~~json
{
  "code": 0,
  "message": "success",
  "data": {
    "dates": [
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04"
    ],
    "risk_counts": [0, 1, 2, 0, 3, 1, 4],
    "ad_counts": [0, 5, 9, 0, 12, 6, 20]
  }
}
~~~

**统计规则**

- dates 按日期升序排列，长度恒等于 days。
- dates 表示 Asia/Shanghai 自然日，不是 UTC 日期。
- risk_counts 与 dates 按下标一一对应，使用 COUNT(risk_events)。
- ad_counts 与 dates 按下标一一对应，使用 SUM(ad_events.blocked_count)。
- 没有事件的日期补 0。
- days 不是 7、30 或 90 时返回 HTTP 400。

### 7.3 风险等级分布

**请求**

~~~text
GET /api/dashboard/risk-distribution
~~~

无查询参数，无请求体。

**成功响应：HTTP 200**

~~~json
{
  "code": 0,
  "message": "success",
  "data": {
    "safe": 20,
    "low": 8,
    "medium": 5,
    "high": 3
  }
}
~~~

按 risk_events.risk_level 分组并统计记录数。safe、low、medium、high 四个键始终返回；没有对应数据时值为 0。

## 8. 统一安全事件日志接口

### 8.1 分页查询

**请求**

~~~text
GET /api/logs/risk?page=1&page_size=20
~~~

**用途**

为演示中心和用户管理平台提供统一安全事件日志。尽管接口路径保留 /api/logs/risk，返回内容同时合并 risk_events 与 ad_events，包括风险检测事件和广告拦截事件。

**查询参数**

| 参数 | 类型 | 必填 | 默认值 | 约束 |
|---|---|---:|---:|---|
| page | integer | 否 | 1 | 正整数 |
| page_size | integer | 否 | 20 | 正整数，最大 100 |

**成功响应：HTTP 200**

~~~json
{
  "code": 0,
  "message": "success",
  "data": {
    "records": [
      {
        "id": 101,
        "type": "AI检测",
        "url": "https://example.com/login",
        "risk_level": "high",
        "reason": "检测到诈骗关键词",
        "time": "2026-08-04T02:30:45.123456Z"
      },
      {
        "id": 201,
        "type": "广告拦截",
        "url": "https://example.com",
        "risk_level": null,
        "reason": "iframe",
        "time": "2026-08-04T02:31:10.654321Z"
      }
    ],
    "pagination": {
      "page": 1,
      "page_size": 20,
      "total": 42
    }
  }
}
~~~

**记录字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | integer | 原事件表主键；风险与广告表的 id 可能相同 |
| type | string | AI检测、URL检测或广告拦截 |
| url | string | risk_events.url 或 ad_events.page_url |
| risk_level | string 或 null | 广告事件固定为 null |
| reason | string | 风险原因；广告事件优先使用 reason，其次 resource_type |
| time | string 或 null | UTC ISO 8601 时间 |

**类型映射**

| 数据来源 | 条件 | type |
|---|---|---|
| risk_events | check_type 为 ai；兼容既有 text 数据 | AI检测 |
| risk_events | 其他 check_type | URL检测 |
| ad_events | 全部 | 广告拦截 |

**排序与分页**

- 所有事件按 occurred_at 倒序排列。
- total 等于 risk_events 记录数与 ad_events 记录数之和。
- 超出最后一页时 records 返回空数组，pagination 仍返回请求页码和真实 total。
- 客户端不得只以 id 作为跨表全局唯一键；建议使用 type、id、time 的组合生成页面键。

## 9. 设置与健康检查

`/api/settings` 是 Web 与 Extension 当前正式使用的设置同步接口；`/health` 是本地服务与数据库状态入口。两者都属于当前实现，不是旧接口。设置接口当前只服务固定 Demo 用户，尚未形成认证后的多用户隔离。

### 9.1 获取设置

**请求**

~~~text
GET /api/settings
~~~

当前接口读取固定 demo 用户；不接收 user_id。

**成功响应：HTTP 200**

~~~json
{
  "code": 0,
  "message": "获取设置成功",
  "data": {
    "mode": "normal",
    "elder_mode": false,
    "child_mode": false,
    "paused": false
  }
}
~~~

### 9.2 更新设置

**请求**

~~~text
POST /api/settings
Content-Type: application/json
~~~

四个字段均为必填字段。

~~~json
{
  "mode": "strict",
  "elder_mode": false,
  "child_mode": false,
  "paused": false
}
~~~

| 字段 | 类型 | 约束 |
|---|---|---|
| mode | string | normal、strict、elder、child |
| elder_mode | boolean | 必须为 JSON 布尔值 |
| child_mode | boolean | 必须为 JSON 布尔值 |
| paused | boolean | 必须为 JSON 布尔值 |

成功返回更新后的四个字段，HTTP 200。

### 9.3 健康检查

**请求**

~~~text
GET /health
~~~

**当前响应**

~~~json
{
  "status": "healthy",
  "database": "available",
  "message": "NetGuard Backend Service"
}
~~~

database 可能为 available 或 unavailable。该接口属于兼容例外，当前不使用 code、message、data 三层格式。

## 10. 错误码说明

### 10.1 HTTP 状态码

| HTTP 状态码 | 场景 | 调用方处理 |
|---:|---|---|
| 200 | 查询成功、普通处理成功、重复事件已存在 | 检查响应体 code |
| 201 | 新事件创建成功 | 保存 event_uuid 的完成状态 |
| 400 | JSON、必填字段、类型、枚举或查询参数错误 | 修正请求，不应原样重试 |
| 500 | 未预期服务异常 | 记录错误并按有限策略重试 |
| 503 | 数据库不可用或持久化失败 | 保留原 event_uuid，稍后重试 |

### 10.2 新事件、Dashboard 与日志接口业务码

| HTTP 状态码 | code | message 典型值 | 含义 |
|---:|---:|---|---|
| 200 或 201 | 0 | success | 业务成功 |
| 200 | 1 | duplicate | 事件已存在，未重复写入 |
| 400 | 400 | 具体参数错误 | 请求体、字段或查询参数错误 |
| 500 | 500 | 服务暂时不可用 | 未预期服务异常 |
| 503 | 503 | 数据库不可用或保存失败 | 数据库连接、查询或持久化异常 |

### 10.3 风险检测与设置接口兼容业务码

| HTTP 状态码 | code | 含义 |
|---:|---:|---|
| 200 | 0 | 成功 |
| 400 | 40001 | 请求参数不合法 |
| 503 | 50301 | 数据库或持久化服务异常 |
| 500 | 50001 | 未预期服务异常 |

### 10.4 调用方判断顺序

1. 先判断请求是否获得 HTTP 响应。
2. 再判断 HTTP 状态码。
3. 最后判断响应体 code。
4. 对事件接口，HTTP 200 且 code=1 按幂等成功处理。
5. data 为 null 时不得继续读取业务字段。

## 11. 数据流说明

### 11.1 插件本地风险事件

~~~text
用户访问网页
    ↓
Edge 插件检测
    ↓
生成 event_uuid
    ↓
POST /api/events/risk
    ↓
EventService 参数校验与幂等处理
    ↓
risk_events
    ↓
DashboardService / LogService
    ↓
Web Dashboard 与风险日志展示
~~~

### 11.2 服务端风险检测

~~~text
插件、Web 或演示页面发起检测
    ↓
按需生成并复用 event_uuid
    ↓
POST /api/risk/check
    ↓
RiskService 校验 event_uuid、URL、内容和来源
    ↓
已有 UUID 返回既有结果；新请求执行检测并写入 risk_events
    ↓
返回 risk_level、score、reason
    ↓
Dashboard 与日志读取该事件
~~~

### 11.3 广告拦截事件

~~~text
网页加载
    ↓
Edge 插件过滤广告
    ↓
统计本次 blocked_count
    ↓
生成 event_uuid
    ↓
POST /api/events/ad
    ↓
EventService 参数校验与幂等处理
    ↓
ad_events
    ↓
Dashboard 使用 SUM(blocked_count) 聚合
    ↓
Web Dashboard 与统一日志展示
~~~

### 11.4 Dashboard 查询

~~~text
用户管理平台或演示中心
    ↓
GET /api/dashboard/*
    ↓
DashboardService
    ├── risk_events 聚合
    └── ad_events 聚合
    ↓
统一 JSON 响应
    ↓
统计卡片、趋势图、分布图
~~~

## 12. 插件联调规范

### 12.1 强制要求

插件负责人必须遵守以下规则：

1. 每个新风险事件或广告事件生成唯一 UUID。
2. 网络失败、超时或 HTTP 503 后重试同一事件时复用原 UUID。
3. 不得因每次重试而重新生成 UUID。
4. 不得将同一 UUID 用于不同业务事件。
5. 风险事件调用 /api/events/risk。
6. 广告事件调用 /api/events/ad。
7. 所有 POST 请求设置 Content-Type: application/json。
8. 收到 HTTP 201 且 code=0 后结束重试。
9. 收到 HTTP 200 且 code=1 后按已成功保存处理。
10. 收到 HTTP 400 后修正数据，不得无限重试。

### 12.2 UUID 生命周期

推荐在插件检测或拦截事实形成时立即生成 UUID，并将“UUID + 请求体 + 重试状态”作为同一个待发送对象。只有该对象收到成功或 duplicate 响应后才可标记完成。

### 12.3 广告数量上报

- blocked_count 表示一次网页处理实际拦截总数。
- 同一批次不要按 DOM 节点逐条上报，以减少网络请求。
- blocked_count=0 合法，但仅应在确有统计需求时上报。
- 插件重试同一批次时必须复用 UUID，避免 Dashboard 重复累计。

### 12.4 风险接口选择

| 场景 | 应调用接口 |
|---|---|
| 需要后端执行 URL 与页面内容检测 | POST /api/risk/check |
| 插件本地已经得出风险等级、评分和原因 | POST /api/events/risk |
| 插件完成广告拦截统计 | POST /api/events/ad |

同一次检测只能形成一条正式风险事件。/api/risk/check 成功后，调用方不得再次把相同检测结果上报到 /api/events/risk。

### 12.5 联调验收点

- 合法风险事件首次提交返回 HTTP 201、code=0。
- 同一风险 UUID 重复提交返回 HTTP 200、code=1，数据库仅一条记录。
- 合法广告事件首次提交返回 HTTP 201、code=0。
- blocked_count 的 Dashboard 累计值与插件上报总和一致。
- 数据库断开时返回 HTTP 503，插件保留原 UUID。
- Dashboard 和日志能够看到事件，而不是 Mock 数据。

## 13. 前端调用规范

### 13.1 用户管理平台

| 页面区域 | 接口 | 建议刷新方式 |
|---|---|---|
| 首页统计卡片 | GET /api/dashboard/overview | 页面进入时加载；事件写入后按需刷新 |
| 数据趋势图 | GET /api/dashboard/trend?days=7 | 用户切换 7、30、90 天时重新请求 |
| 风险等级饼图 | GET /api/dashboard/risk-distribution | 页面进入时加载 |
| 风险日志列表 | GET /api/logs/risk?page=1&page_size=20 | 翻页时请求对应页 |

### 13.2 演示中心

演示中心使用与用户管理平台完全相同的四个接口，不得维护第二套字段映射或单独的 Mock 数据源。

### 13.3 展示规则

- overview 所有计数字段按整数展示。
- trend 的 dates、risk_counts、ad_counts 必须按相同下标绑定。
- 空数据库返回 0 和空记录属于正常状态，不应显示为接口异常。
- 日志的 risk_level 允许为 null；广告日志不应强制显示风险等级。
- 日志记录的 id 不是跨 risk_events 和 ad_events 的全局唯一值。
- time 为 UTC 时间，前端可转换为 Asia/Shanghai 展示。
- 请求失败时展示明确的加载失败状态，不得静默回退到 Mock 数据。

### 13.4 当前数据范围

Dashboard 和日志接口当前返回全库统计，尚未按登录用户过滤。前端不得把当前结果标注为严格的“个人数据”，除非后端后续完成认证和 user_id 绑定。

## 14. 正式数据源与旧接口迁移

### 14.1 正式数据源

- 风险检测、风险统计和风险日志：risk_events。
- 广告统计和广告日志：ad_events。
- 用户信息：users。
- 当前配置：settings。
- URL 黑名单检测：url_blacklist。

新 Dashboard 与日志禁止读取 security_logs、detection_records 或 user_settings。

### 14.2 旧表

以下表继续保留以兼容旧功能，但不得新增依赖：

- security_logs
- detection_records
- user_settings

### 14.3 旧接口

| 旧接口 | 当前用途 | 新开发要求 |
|---|---|---|
| POST /ai/check | 旧 AI 检测与演示兼容 | 新调用迁移到 /api/risk/check |
| POST /url/check | 旧 URL 检测兼容 | 新调用迁移到 /api/risk/check |
| POST /api/log | 旧日志写入兼容 | 新事件按类型调用 /api/events/risk 或 /api/events/ad |
| GET /api/stats | 旧统计兼容 | 新页面使用 /api/dashboard/* |
| GET /api/logs | 旧日志查询兼容 | 新页面使用 /api/logs/risk |
| GET/POST /settings/mode | 旧设置兼容 | 新调用使用 /api/settings |

旧接口不在本规范中继续扩展。迁移期间不得删除旧接口，也不得继续向 security_logs 增加新业务逻辑。

## 15. 开发与变更约束

### 15.1 接口变更

以下变化属于破坏性变更，必须由三方确认并更新文档版本：

- 删除或重命名路径、请求字段或返回字段。
- 修改字段类型、必填性或枚举含义。
- 修改 Dashboard 统计口径。
- 修改事件幂等语义。
- 修改时间基准或日期分组时区。
- 修改成功和失败响应层级。

新增可选字段时，调用方必须保持前向兼容，不得因出现未知字段而报错。

### 15.2 数据一致性

- 广告拦截总数必须使用 SUM(blocked_count)。
- 风险数量使用风险事件记录数。
- 所有统计必须来自数据库真实数据。
- 前端不得用静态常量补充统计值。
- 插件不得通过重复事件制造累计量。

### 15.3 安全边界

当前接口缺少 JWT、用户级授权和请求级限流，仅适用于受控联调。对公网部署前至少需要补充认证、授权、来源限制、日志脱敏和速率限制规范。

## 16. 待确认事项

check_type 口径和 Dashboard 北京时间口径已在本版本中确认并固化。以下事项仍需后端负责人在下一次契约冻结前确认：

1. **用户数据隔离。** 当前事件上报未绑定已认证用户，Dashboard 和日志为全库数据。启用正式用户平台前需确定 JWT、用户映射和管理员全局视图规则。
2. **部署地址与 CORS 白名单。** 本地地址已经确定，生产或比赛演示地址、HTTPS 和允许来源仍需在部署文档中冻结。
3. **兼容接口下线计划。** /ai/check、/url/check、/api/log、/api/stats、/api/logs 和 /settings/mode 的停止使用时间尚未确定。
