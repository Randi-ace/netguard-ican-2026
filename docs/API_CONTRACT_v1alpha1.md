# 净网护航后端 API 契约

- API 版本：`v1alpha1`
- 契约版本：`1.0.0-alpha.1`
- 适用版本：净网护航 `v1.0-alpha-team-ready`
- 状态：部分实现，`POST /api/risk/check` 已落地
- 适用成员：extension 负责人、backend 负责人、UI 负责人

## 1. 文档目的

本文档约定插件、后端和 Web 页面之间的接口名称、请求字段和响应字段。

三方开发时以本文档为准：

- extension 负责人只依赖本文档调用后端，不直接依赖数据库结构。
- backend 负责人保证接口路径、字段、状态码和数据库写入符合本文档。
- UI 负责人只读取本文档中定义的响应字段，不自行猜测后端返回结构。

在 `v1alpha1` 冻结后，任何字段改名、删除或含义变化，都必须先修改本文档并由三方确认。

## 2. 基础约定

### 2.1 服务地址

本地开发默认地址：

```text
http://127.0.0.1:5000
```

API 业务接口统一使用 `/api` 前缀。健康检查保留为 `/health`。

### 2.2 数据格式

- 请求和响应使用 JSON。
- 请求头使用 `Content-Type: application/json`。
- 字段名统一使用 `snake_case`。
- 时间统一使用 UTC ISO 8601 格式，例如 `2026-07-30T10:30:00Z`。
- API 风险检测结果使用 `score`，数据库对应字段为 `risk_score`，范围均为 `0.0` 至 `1.0`。
- URL 字段保存完整地址；前端展示时可以自行截断，但不得修改后再上报。

### 2.3 固定枚举

| 字段 | 允许值 |
|---|---|
| `risk_level` | `safe`、`low`、`medium`、`high` |
| `check_type` | `text`、`url`、`rule` |
| `source` | `extension`、`ui`、`demo`、`backend` |
| `mode` | `normal`、`strict`、`elder`、`child` |
| 广告 `action` | `blocked`、`hidden`、`allowed` |

不得在各模块中创建 `risk`、`level` 等同义字段。跨模块传输时统一使用 `risk_level`。

### 2.4 已实现风险接口响应格式

当前已经实现的 `POST /api/risk/check` 使用 `code`、`message`、`data` 三层结构。

成功响应：

```json
{
  "code": 0,
  "message": "风险检测完成",
  "data": {
    "risk_level": "safe",
    "score": 0.05,
    "reason": "未发现风险内容"
  }
}
```

失败响应：

```json
{
  "code": 40001,
  "message": "缺少必填字段: content",
  "data": null
}
```

约束：

- `code=0` 表示业务成功。
- `code` 非零时 `data` 为 `null`。
- 调用方必须同时检查 HTTP 状态码和 `code`。
- 本文档中其他尚未实现的接口响应属于设计草案，其落地阶段应同步为简洁、统一的响应结构。

### 2.5 常用状态码

| 状态码 | 含义 |
|---|---|
| `200` | 查询或更新成功 |
| `201` | 事件创建成功 |
| `400` | 请求 JSON 或字段不合法 |
| `404` | 用户或资源不存在 |
| `409` | 设置版本冲突 |
| `500` | 后端内部错误 |
| `503` | 数据库等依赖暂时不可用 |

参数错误不得返回 HTTP 200，也不得伪装成成功响应。

`POST /api/risk/check` 当前业务错误码：

| HTTP 状态码 | `code` | 含义 |
|---|---:|---|
| `200` | `0` | 风险检测及事件保存成功 |
| `400` | `40001` | 请求体、必填字段、字段类型或 `source` 不合法 |
| `503` | `50301` | 数据库不可用或风险事件保存失败 |
| `500` | `50001` | 未预期的风险检测异常 |

## 3. 接口总览

| 方法 | 路径 | 主要调用方 | 主要用途 |
|---|---|---|---|
| GET | `/health` | extension、UI、测试 | 检查后端是否可用 |
| POST | `/api/risk/check` | extension、UI、Demo | 综合检测 URL 和页面内容风险 |
| POST | `/api/events/risk` | extension | 上报插件本地识别的风险事件 |
| POST | `/api/events/ad` | extension | 上报广告拦截事件 |
| GET | `/api/settings` | extension、UI | 读取用户设置 |
| POST | `/api/settings` | extension、UI | 保存用户设置 |
| GET | `/api/stats` | UI、Demo Dashboard | 获取统计数据 |
| GET | `/api/logs` | UI、Demo Dashboard | 获取统一事件日志 |

## 4. 健康检查

### `GET /health`

请求：无 JSON body。

响应：

```json
{
  "api_version": "v1alpha1",
  "success": true,
  "data": {
    "status": "healthy",
    "database": "available"
  },
  "error": null,
  "request_id": "req_01"
}
```

`database` 允许值：

- `available`：后端和数据库均可使用。
- `unavailable`：Flask 已启动，但数据库不可用。

健康检查只能保留一个实现，不能在 `app.py` 和 Blueprint 中重复定义。

## 5. 风险检测

### `POST /api/risk/check`

负责人：backend。

调用方：extension、UI 或比赛 Demo。

实现位置：

- Route：`backend/routes/ai_check.py`
- Service：`backend/services/risk_service.py`
- 数据模型：`backend/models/models.py` 中的 `RiskEvent`

请求：

```json
{
  "url": "https://example.com/gambling",
  "content": "页面正文内容",
  "source": "extension"
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `url` | 是 | 非空字符串，最长 4096 字符 |
| `content` | 是 | 字符串；允许空字符串，检测时最多使用前 3000 字符 |
| `source` | 是 | `extension`、`ui`、`demo` 或 `backend` |

成功响应，HTTP 200：

```json
{
  "code": 0,
  "message": "风险检测完成",
  "data": {
    "risk_level": "high",
    "score": 0.95,
    "reason": "检测到高风险网址（赌博/色情类）"
  }
}
```

参数错误响应示例，HTTP 400：

```json
{
  "code": 40001,
  "message": "缺少必填字段: content",
  "data": null
}
```

数据库不可用或保存失败，HTTP 503：

```json
{
  "code": 50301,
  "message": "数据库不可用，风险事件未保存",
  "data": null
}
```

未预期异常，HTTP 500：

```json
{
  "code": 50001,
  "message": "风险检测服务暂时不可用",
  "data": null
}
```

检测规则：

- URL 使用赌博、色情和钓鱼类关键词规则检测。
- `content` 复用现有 AI 文本关键词检测服务。
- URL 与内容都会检测，最终采用风险等级更高的结果。
- 风险等级相同时采用分数更高的结果。
- API 输出字段使用 `risk_level` 和 `score`。

事件写入：

- 检测成功后必须写入一条 `risk_events`。
- `event_uuid` 由后端生成。
- URL 结果获胜时，`event_type=url_check`、`check_type=url`。
- 内容结果获胜时，`event_type=ai_check`、`check_type=text`。
- `risk_score` 保存 API 返回的 `score`。
- 同时保存 `url`、`url_hash`、`reason`、`source`、`occurred_at` 和 `created_at`。
- 数据库写入失败时不返回成功检测结果，而是返回 HTTP 503。

当前限制：

- 请求暂不接收客户端 `event_uuid`。
- 客户端自动重试会生成新的事件，当前版本尚未提供请求级幂等。
- 调用本接口成功后，不得再为同一次检测调用 `/api/events/risk`。

### 5.1 数据流

```text
extension / UI / Demo
        │
        │ POST /api/risk/check
        │ {url, content, source}
        ▼
backend/routes/ai_check.py
        │
        │ 仅处理 HTTP 和 JSON
        ▼
backend/services/risk_service.py
        ├── 校验 url、content、source
        ├── URL 关键词检测
        ├── AI 文本检测
        ├── 选择风险等级最高的结果
        └── 生成 UUID 和 URL 哈希
        │
        ▼
RiskEvent / risk_events
        │
        │ commit 成功
        ▼
{code, message, data:{risk_level, score, reason}}
```

Route 不得直接复制风险规则或数据库写入逻辑。风险检测和保存统一由 `RiskService` 负责。

## 6. 风险事件上报

### `POST /api/events/risk`

负责人：extension 负责构造事件，backend 负责校验和保存。

适用场景：儿童模式、老人模式、严格模式等由插件本地规则产生、未调用 `/api/risk/check` 的事件。

请求：

```json
{
  "event_uuid": "5559586c-fe8b-4ca1-97eb-c5f8472460d3",
  "user_id": 1,
  "event_type": "child_block",
  "check_type": "rule",
  "risk_level": "medium",
  "risk_score": 0.65,
  "url": "https://example.com/game",
  "reason": "儿童模式限制游戏网站",
  "source": "extension",
  "occurred_at": "2026-07-30T10:30:00Z",
  "details": {
    "matched_rule": "game-site"
  }
}
```

响应：

```json
{
  "api_version": "v1alpha1",
  "success": true,
  "data": {
    "event_id": 102,
    "event_uuid": "5559586c-fe8b-4ca1-97eb-c5f8472460d3"
  },
  "error": null,
  "request_id": "req_03"
}
```

首次创建返回 HTTP 201。相同 `event_uuid` 重试时返回已有事件，不重复计数。

## 7. 广告事件上报

### `POST /api/events/ad`

负责人：extension 负责构造事件，backend 负责校验和保存。

请求：

```json
{
  "event_uuid": "1699888e-d9a6-4813-93c2-529df1e8ee75",
  "user_id": 1,
  "action": "blocked",
  "mode": "strict",
  "page_url": "https://example.com",
  "resource_type": "iframe",
  "rule_id": "ad-selector-12",
  "blocked_count": 1,
  "reason": "命中广告选择器",
  "source": "extension",
  "occurred_at": "2026-07-30T10:31:00Z",
  "details": {}
}
```

响应：

```json
{
  "api_version": "v1alpha1",
  "success": true,
  "data": {
    "event_id": 201,
    "event_uuid": "1699888e-d9a6-4813-93c2-529df1e8ee75"
  },
  "error": null,
  "request_id": "req_04"
}
```

一次批量 DOM 清理可以通过 `blocked_count` 上报数量，不要求每个元素分别请求后端。

## 8. 用户设置

### `GET /api/settings`

请求示例：

```text
GET /api/settings?user_id=1
```

GET 请求不发送 JSON body。

响应：

```json
{
  "api_version": "v1alpha1",
  "success": true,
  "data": {
    "user_id": 1,
    "mode": "normal",
    "preferences": {
      "elder": {
        "font_scale": 1.35,
        "risk_highlight": true
      },
      "child": {
        "daily_minutes": 60
      }
    },
    "version": 3,
    "updated_at": "2026-07-30T10:00:00Z"
  },
  "error": null,
  "request_id": "req_05"
}
```

### `POST /api/settings`

请求：

```json
{
  "user_id": 1,
  "expected_version": 3,
  "settings": {
    "mode": "strict",
    "preferences": {
      "elder": {
        "font_scale": 1.35,
        "risk_highlight": true
      }
    }
  }
}
```

响应：

```json
{
  "api_version": "v1alpha1",
  "success": true,
  "data": {
    "user_id": 1,
    "mode": "strict",
    "preferences": {
      "elder": {
        "font_scale": 1.35,
        "risk_highlight": true
      }
    },
    "version": 4,
    "updated_at": "2026-07-30T10:35:00Z"
  },
  "error": null,
  "request_id": "req_06"
}
```

规则：

- `expected_version` 必须等于数据库当前版本。
- 保存成功后 `version` 加一。
- 版本不一致返回 HTTP 409，UI 或插件应重新读取设置后再提交。
- `mode` 是明确字段；老人、儿童等扩展配置放在 `preferences`。

## 9. 统计接口

### `GET /api/stats`

请求示例：

```text
GET /api/stats?user_id=1&from=2026-07-24&to=2026-07-30&timezone=Asia/Shanghai
```

查询参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `user_id` | 否 | 不提供时统计全部用户 |
| `from` | 否 | 开始日期 |
| `to` | 否 | 结束日期 |
| `timezone` | 否 | 展示时区，默认 `Asia/Shanghai` |

响应：

```json
{
  "api_version": "v1alpha1",
  "success": true,
  "data": {
    "period": {
      "from": "2026-07-24",
      "to": "2026-07-30",
      "timezone": "Asia/Shanghai"
    },
    "totals": {
      "risk_checks": 120,
      "ai_checks": 70,
      "url_checks": 50,
      "high_risk": 12,
      "ad_blocks": 560,
      "child_blocks": 8,
      "elder_warnings": 5
    },
    "risk_levels": {
      "safe": 75,
      "low": 20,
      "medium": 13,
      "high": 12
    },
    "trend": [
      {
        "date": "2026-07-30",
        "risk_events": 18,
        "ad_events": 80
      }
    ]
  },
  "error": null,
  "request_id": "req_07"
}
```

UI 和 Demo Dashboard 必须统一读取：

- `data.totals`
- `data.risk_levels`
- `data.trend`

`data.totals.ai_checks` 和 `data.totals.url_checks` 是聚合响应字段，不表示存在 `ai_checks` 或 `url_checks` 同名数据表。

不得继续使用顶层 `ai_count`、`url_count`、`high_risk_count` 等旧字段，与 `data.totals` 中的字段形成多套同义字段。

## 10. 统一日志查询

### `GET /api/logs`

请求示例：

```text
GET /api/logs?user_id=1&event_kind=all&risk_level=high&limit=20&cursor=
```

查询参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `user_id` | 否 | 用户编号 |
| `event_kind` | 否 | `all`、`risk` 或 `ad` |
| `risk_level` | 否 | 只筛选风险事件 |
| `limit` | 否 | 默认 20，最大 100 |
| `cursor` | 否 | 下一页游标 |

响应：

```json
{
  "api_version": "v1alpha1",
  "success": true,
  "data": {
    "items": [
      {
        "event_id": "risk:101",
        "event_kind": "risk",
        "event_type": "url_check",
        "risk_level": "high",
        "risk_score": 0.95,
        "action": null,
        "mode": null,
        "url": "https://example.com/gambling",
        "reason": "检测到赌博相关特征",
        "occurred_at": "2026-07-30T10:30:00Z"
      },
      {
        "event_id": "ad:201",
        "event_kind": "ad",
        "event_type": "ad_block",
        "risk_level": null,
        "risk_score": null,
        "action": "blocked",
        "mode": "strict",
        "url": "https://example.com",
        "reason": "命中广告选择器",
        "occurred_at": "2026-07-30T10:31:00Z"
      }
    ],
    "next_cursor": null,
    "has_more": false
  },
  "error": null,
  "request_id": "req_08"
}
```

## 11. 旧接口迁移

旧接口在一个 Alpha 迁移周期内可以作为兼容入口，但不得继续扩展：

| 旧接口 | 新接口 |
|---|---|
| `POST /ai/check` | `POST /api/risk/check`，将旧 `text` 映射为新 `content` |
| `POST /url/check` | `POST /api/risk/check`，提供 `url`、空 `content` 和 `source` |
| `POST /api/log` | `POST /api/events/risk` 或 `/api/events/ad` |
| `GET/POST /settings/mode` | `GET/POST /api/settings` |

兼容入口应调用同一套后端服务函数，不能重复实现业务逻辑。新代码禁止继续调用旧接口。

## 12. 三方职责

### extension 负责人

- 只使用本文档列出的路径和字段。
- 调用 `/api/risk/check` 时只提交 `url`、`content`、`source`。
- `/api/events/risk` 和 `/api/events/ad` 仍由客户端生成并复用 `event_uuid`。
- 当前 `/api/risk/check` 的事件 UUID 由后端生成，重试可能产生新事件。
- 后端不可用时允许本地功能继续运行，但不能伪造后端成功结果。
- 不再上报 `risk`、`level`、`type` 等旧字段。

### backend 负责人

- 校验必填字段和枚举。
- 保证 `/api/risk/check` 使用 `code`、`message`、`data` 响应和正确 HTTP 状态码。
- 风险检测成功后写入一条 `risk_events`，保存失败返回 HTTP 503。
- 事件上报接口应保证同一 `event_uuid` 不重复写入。
- 负责 API 到数据库模型的转换。
- 统计和日志接口只从正式事件表读取。

### UI 负责人

- 使用 `/api/stats` 和 `/api/logs`，不创建自定义接口名称。
- 正确读取统一响应的 `data` 字段。
- 处理空数据、后端不可用和 HTTP 409。
- 不依赖数据库字段，只依赖本文档响应字段。

## 13. 契约冻结流程

`v1alpha1` 冻结前必须完成：

1. 后端接口测试覆盖本文档的成功和失败示例。
2. extension、UI、Demo 不再调用旧接口。
3. 三方分别确认自己使用的字段。
4. 创建 Git 标签 `api-contract-v1alpha1`。

冻结后允许：

- 增加可选字段。
- 修正文案和示例。

冻结后禁止直接进行：

- 删除或重命名已有字段。
- 改变字段类型或枚举含义。
- 改变成功响应的层级结构。

确需破坏兼容性时，应创建新的 API 契约版本。
