# AI Risk Engine v1 Shared Development Contract

## 1. 文档状态

| 项目 | 值 |
|---|---|
| 项目 | 净网护航（SmartGuard-NetGuard） |
| 契约版本 | AI Contract v1 |
| 第二阶段集成分支 | `integration/ai-risk-engine-v1` |
| 第二阶段起始基线 | `develop@dd36bb0a3d5277dd0961971092a9ffca4277e01c` |
| 第一阶段业务基线 | `87618cf432a6ded5bcb37a946209fb51464cd5e7` |
| 状态 | 第二阶段共同开发契约 |

本文档冻结 AI Risk Engine v1 的公共 API、内部结果、模型产物、数据集、持久化、Extension 页面上下文和团队协作边界。三名开发成员应以本文档作为第二阶段共同接口，不得自行改变字段名、枚举、分数量纲或公开响应。

本文档描述的是第二阶段目标契约，不表示所有能力已经在当前代码中实现。当前实现差异见第 15 节。

## 2. 目标与稳定边界

第二阶段在不破坏第一阶段稳定功能的前提下实现：

```text
网页
  → Extension 页面上下文采集
  → POST /api/risk/check
  → 现有 Rule Engine
  → Text ML Model
  → Risk Fusion
  → 最终 risk_level / score / reason
  → risk_events
  → 插件风险提示 / Dashboard
```

必须保持以下稳定边界：

- 第一阶段正式公开路径 `POST /api/risk/check` 不变；
- 老版本 Extension 不传第二阶段新增字段时仍能正常工作；
- 成功响应 `data` 继续只包含 `risk_level`、`score`、`reason`；
- 所有正式分数统一使用 `0.0`～`1.0`；
- 风险等级继续使用 `safe`、`low`、`medium`、`high`；
- 第一版不增加数据库字段、不执行 migration；
- AI 不可用时自动回退第一阶段 Rule Engine；
- RiskService 不得与 TF-IDF、Logistic Regression 或其他具体模型框架强耦合。

## 3. 公开风险检测 API

### 3.1 正式入口

```text
POST /api/risk/check
Content-Type: application/json
```

该接口是第一阶段已经发布、第二阶段继续复用的正式入口。新代码不得使用旧 `/ai/check` 替代本接口。

### 3.2 请求结构

第一阶段现有请求：

```json
{
  "url": "https://example.com",
  "content": "页面正文",
  "source": "extension",
  "event_uuid": "optional uuid"
}
```

第二阶段允许增量增加两个可选字段：

```json
{
  "url": "https://example.com",
  "title": "页面标题",
  "meta_description": "页面描述",
  "content": "页面正文",
  "source": "extension",
  "event_uuid": "optional uuid"
}
```

| 字段 | 类型 | 必填 | 约束 | 兼容规则 |
|---|---|---:|---|---|
| `url` | string | 是 | 非空，最多 4096 characters | 沿用第一阶段语义 |
| `title` | string | 否 | 最多 200 characters | 缺失或 `null` 按空字符串处理 |
| `meta_description` | string | 否 | 最多 300 characters | 缺失或 `null` 按空字符串处理 |
| `content` | string | 是 | 最多使用 3000 characters | 沿用第一阶段字段，允许空字符串 |
| `source` | string | 是 | `extension`、`ui`、`demo`、`backend` | 沿用第一阶段枚举 |
| `event_uuid` | string | 否 | 有效 UUID | 同一次请求重试必须复用 |

调用方必须在发送前遵守长度上限。Backend 必须做类型和边界防御，不能因可选字段缺失或超长内容返回 500。为保持第一阶段兼容性，`content` 仍为必填；老版本 Extension 只发送原字段时，Backend 必须将 `title`、`meta_description` 规范化为空字符串并继续检测。

### 3.3 成功响应

AI v1 接入期间，公开成功响应保持：

```json
{
  "code": 0,
  "message": "风险检测完成",
  "data": {
    "risk_level": "high",
    "score": 0.87,
    "reason": "疑似诈骗风险"
  }
}
```

`data` 中暂时禁止直接增加：

```text
ai_score
ai_confidence
ai_category
rule_score
model_version
rule_reasons
ai_reasons
```

原因是第一阶段 Backend 测试对 `risk_level`、`score`、`reason` 的字段集合存在严格断言，Extension 和 Web 也依赖现有响应层级。AI 详细结果统一保存到 `risk_events.details`，不进入 v1 公开响应。

### 3.4 分数和风险等级

所有内部和外部分数统一为：

```text
0.0 <= score <= 1.0
```

禁止在模型输出、Fusion 输入、持久化或 API 中使用 `0`～`100` 作为正式量纲。UI 如需百分数，只允许在展示层执行 `score * 100`。

风险等级固定为：

```text
safe
low
medium
high
```

AI v1 禁止增加 `critical` 或其他风险等级。新增等级必须升级契约版本并联合评审 Backend、Extension、Web、数据库统计和测试影响。

## 4. AI 风险类别

AI v1 类别固定为：

```text
normal
phishing
scam
gambling
adult
malicious
```

开发人员不得自行增加同义类别或新类别。需要扩展时必须先升级契约版本。

`ai_category` 表示模型判断的内容类型，`risk_level` 表示 Fusion 后的最终严重等级；两者不得互相替代，`normal` 也不等同于 AI 执行失败。

## 5. TextRiskModel 推理适配层

### 5.1 路径与接口

建议路径：

```text
backend/services/text_risk_model.py
```

对外接口语义：

```python
predict(
    url: str,
    title: str,
    text: str,
)
```

参数必须是 Backend 规范化后的字符串。`meta_description` 由 Backend 输入预处理层持有，可在不改变上述接口的前提下参与文本上下文组装。TextRiskModel 不接收原始 Flask request，也不直接读写数据库。

第一版主要模型为：

```text
TF-IDF + Logistic Regression
```

接口不得向 RiskService 暴露 TF-IDF vocabulary、sklearn estimator 或 joblib 对象，后续应能替换或扩展为 Chinese BERT、RoBERTa、URL ML Detector 或其他文本模型。

### 5.2 成功返回结构

```json
{
  "ai_available": true,
  "ai_score": 0.87,
  "ai_category": "scam",
  "ai_confidence": 0.91,
  "ai_reasons": [
    "存在异常退款诱导",
    "存在敏感信息索取"
  ],
  "model_version": "tfidf-lr-v1"
}
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `ai_available` | boolean | 成功结果固定为 `true` |
| `ai_score` | number | `0.0`～`1.0` |
| `ai_category` | string | 六类固定枚举之一 |
| `ai_confidence` | number | `0.0`～`1.0` |
| `ai_reasons` | array of string | 最多 3 条 |
| 单条 AI reason | string | 最多 120 characters |
| `model_version` | string | 非空，必须与 manifest 一致 |

RiskService 必须把缺字段、非法枚举、越界值、NaN、Infinity 等视为非法模型输出，不得把未经校验的结果用于 Fusion。

### 5.3 不可用与降级

以下情况不得让 `/api/risk/check` 返回 500：

- AI 关闭；
- 模型文件不存在；
- 模型文件损坏；
- 模型加载失败；
- 推理异常；
- 推理超时或资源错误；
- 模型输出非法。

TextRiskModel 应表现为：

```text
AI 不可用
  → 返回 None 或明确的 ai_available=false
  → RiskService 自动退回第一阶段 Rule Engine
```

必须明确：

```text
AI unavailable != safe
```

AI 不可用只表示本次 AI 分析没有成功执行，不能作为安全结论，也不能覆盖规则风险。模型异常日志不得包含完整网页正文、密码、编辑区内容或其他敏感数据。

## 6. Rule Engine 内部结果

RiskService 应把现有黑名单、URL 规则和文本规则结果整理为：

```json
{
  "rule_score": 0.65,
  "rule_level": "medium",
  "rule_reasons": [
    "命中风险关键词"
  ],
  "strong_hit": false
}
```

约束：

- `rule_score`：`0.0`～`1.0`；
- `rule_level`：`safe`、`low`、`medium`、`high`；
- `rule_reasons`：可解释的规则原因列表；
- `strong_hit`：是否存在不得被模型降低的确定性证据。

`strong_hit=true` 主要用于数据库黑名单、明确高危规则和其他确定性强证据。具体强规则集合由 Backend/Fusion 负责人维护并通过测试固定，Extension、模型训练代码和 UI 不得各自维护另一套定义。

## 7. Risk Fusion v1

AI v1 不冻结具体 `0.4/0.6` 等权重，只冻结以下原则：

```text
AI 不可用
  → final = rule

Strong Rule 命中
  → AI 不得把确定性高危结果降低

AI 高置信度
  → Rule + AI 参与融合

AI 低置信度
  → Rule 优先
```

初始权重、置信度阈值和风险等级阈值可作为实验参数，但最终必须依据 validation 数据校准，并由 Backend/Fusion 负责人统一维护。禁止把实验权重散落在 Route、Extension、UI 或训练脚本中。

Fusion 最终输出继续映射为：

```json
{
  "risk_level": "high",
  "score": 0.81,
  "reason": "疑似诈骗风险"
}
```

其中 `score`、`risk_level` 是最终权威结果，`reason` 是供用户理解的简洁结论。任何异常路径都必须能退回合法 Rule Engine 结果；Route 只负责协议封装，不得复制 Fusion 逻辑。

## 8. risk_events 持久化契约

### 8.1 不变字段

AI v1 不新增数据库字段、不执行 migration，继续复用：

```text
risk_level
risk_score
reason
details
```

- `risk_events.risk_level` 保存最终 Fusion 等级；
- `risk_events.risk_score` 保存最终 Fusion 分数，是权威分数；
- `risk_events.reason` 保存最终公开原因；
- `risk_events.details` 保存内部分析快照。

### 8.2 details v1 结构

```json
{
  "analysis_version": 1,
  "input_meta": {
    "title": "",
    "meta_description": "",
    "content_length": 0
  },
  "rule": {
    "score": 0.65,
    "level": "medium",
    "reasons": [],
    "strong_hit": false
  },
  "ai": {
    "available": true,
    "score": 0.87,
    "category": "scam",
    "confidence": 0.91,
    "reasons": [],
    "model_version": "tfidf-lr-v1"
  },
  "fusion": {
    "final_score": 0.81,
    "final_level": "high",
    "detection_source": "rule+ai",
    "version": "fusion-v1"
  }
}
```

持久化规则：

- `analysis_version` 固定为数字 `1`；
- `input_meta.title`、`input_meta.meta_description` 保存清洗、截断后的值；
- `input_meta.content_length` 保存实际参与检测的正文字符数；
- `ai.available=false` 时，不得伪造安全分数；
- `fusion.final_score` 只是分析快照，不能取代 `risk_events.risk_score`；
- 禁止把完整网页正文写入 `details`、其他数据库字段或普通日志；
- 历史记录的 `details` 可能为 `null` 或保存迁移来源信息；读取方必须先检查 `analysis_version`，不得假设所有记录都是 AI v1 结构。

## 9. Extension 页面上下文契约

### 9.1 请求内容

```json
{
  "url": "...",
  "title": "...",
  "meta_description": "...",
  "content": "...",
  "source": "extension",
  "event_uuid": "..."
}
```

### 9.2 正文提取优先级

```text
main
article
[role=main]
body（仅在前述区域没有有效正文时回退）
```

排除以下元素及其子树：

```text
script
style
noscript
svg
canvas
template
nav
header
footer
aside
```

同时不得主动采集：

```text
input[type=password]
textarea
contenteditable
```

实现应规范化连续空白和无意义布局文本，避免重复采集同一节点内容。

### 9.3 长度处理

正文最多 3000 characters。超过上限时建议保留：

```text
head 60%
+
tail 40%
```

不应只取最前部，以免丢失页面尾部的付款、联系方式、风险声明或诱导操作。`title`、`meta_description` 分别在 200、300 characters 上限内清洗和截断。

### 9.4 事件接口边界

AI v1 不使用 `/api/events/risk` 传输 AI metadata。当前生产七字段契约保持原样：

```text
event_uuid
url
risk_level
score
reason
source
check_type
```

本阶段不重构六字段测试辅助契约和七字段生产契约并存的历史问题。AI metadata 统一由以下链路保存：

```text
/api/risk/check
  → Backend
  → risk_events.details
```

## 10. 模型产物与 manifest

### 10.1 建议目录

```text
models/
├── text_risk_tfidf_lr_v1.joblib
└── text_risk_tfidf_lr_v1.manifest.json
```

模型文件必须来自受信任的项目训练流程，不得加载来源不明或校验失败的 joblib 文件。

### 10.2 manifest 最低字段

```json
{
  "model_version": "tfidf-lr-v1",
  "classes": [],
  "training_samples": 0,
  "sklearn_version": "",
  "sha256": "",
  "test_macro_f1": null
}
```

约束：

- `model_version` 必须与 TextRiskModel 返回一致；
- `classes` 必须来自实际训练产物；
- `training_samples` 必须是实际进入训练集的样本数；
- `sklearn_version` 必须是实际训练环境版本；
- `sha256` 必须根据最终模型文件计算；
- `test_macro_f1` 只能由冻结测试集真实评测填写；
- 未训练或未评测时保留空值或 `null`，禁止伪造、估算或预填最终指标。

## 11. AI 数据集契约

### 11.1 建议路径和字段

```text
tests/samples/ai-text-dataset.csv
```

```text
id
text
label
category
source
url
title
group_id
split
note
```

| 字段 | 约束或说明 |
|---|---|
| `id` | 稳定、唯一的样本标识 |
| `text` | 训练或评测文本，不得包含未经处理的敏感信息 |
| `label` | `risk` 或 `not_risk` |
| `category` | 六类固定枚举之一 |
| `source` | 必须可追溯的样本来源 |
| `url` | 可为空；存在时去除不必要的敏感查询参数 |
| `title` | 可为空的页面标题 |
| `group_id` | 模板、近重复或同源样本分组标识 |
| `split` | `train`、`val`、`test` |
| `note` | 数据说明、边界信息或人工复核备注 |

一致性要求：

- `label=not_risk` 应使用 `category=normal`；
- `label=risk` 应使用非 `normal` 风险类别；
- 相同 `group_id` 不得跨 `train`、`val`、`test`；
- 同模板、改写、镜像和近重复样本必须归入同一组；
- test 数据不得用于阈值调优、特征选择或训练；
- 来源、授权或合规状态无法确认的样本不得进入正式模型产物。

## 12. 团队文件所有权

### 12.1 周敏：AI Backend / Fusion / Integration

主要维护：

```text
backend/services/text_risk_model.py
backend/services/risk_service.py
backend/services/ai_service.py
backend/services/blacklist_service.py
backend/routes/ai_check.py
backend/config.py
tests/backend/ 中 AI 相关测试
requirements.txt
.env.example
docs/backend_api.md
```

职责包括 TextRiskModel 在线适配、Rule 结果规范化、Risk Fusion、API 兼容、`risk_events.details` 写入、AI 降级、Backend 回归和总体集成。

`requirements.txt` 由周敏单点维护。模型负责人提供依赖名称和已验证版本，不在并行分支中与 Backend 同时修改该文件。

### 12.2 前端负责人：模型与数据

主要维护：

```text
tests/ai/**
tests/samples/ai-text-dataset.csv
models/**
模型训练脚本
模型评测脚本
模型 manifest
```

职责包括数据集建设、泄漏防护、TF-IDF + Logistic Regression 训练、validation/test 评测、模型文件、checksum、manifest，以及后期少量 Web AI 展示。

该角色不直接修改 Backend Runtime、RiskService、正式 API 或数据库结构；需要运行依赖时向周敏提交明确版本和理由。

### 12.3 插件负责人：Extension AI Context

主要维护：

```text
extension/content.js
必要的 extension/background.js
Extension AI 相关测试
```

职责包括页面上下文采集和清洗、长度控制、敏感编辑区过滤、`/api/risk/check` 请求适配、原有模式回归和 Edge 真机闭环。

该角色不直接修改 Backend、模型训练代码、模型文件或数据库结构。

## 13. 分支与合并契约

集成分支：

```text
integration/ai-risk-engine-v1
```

Feature 分支：

```text
feature/ai-backend-fusion
feature/ai-model-baseline
feature/extension-ai-context
```

禁止直接在以下分支进行日常功能开发：

```text
master
develop
integration/ai-risk-engine-v1
```

Integration 主要用于 feature merge、冲突处理、集成测试和 Competition RC。公共字段、类别、风险等级、模型返回结构或 `details` 结构变更，必须先升级契约版本，再进入 Feature 实现。

## 14. 分支验收门槛

### 14.1 模型分支

必须满足：

```text
可训练
可加载
可预测
有真实评测指标
manifest 存在
```

同时必须证明 train/val/test 没有已知模板泄漏，并记录实际依赖版本和模型 checksum。

### 14.2 Backend 分支

必须满足：

```text
AI 正常可运行
AI 关闭不崩
模型不存在不崩
模型损坏不崩
推理异常不崩
输出非法不崩
原 API 兼容
公开响应仍为三字段
Backend 回归通过
```

### 14.3 Extension 分支

必须满足：

```text
title/meta/content 采集正确
长度限制正确
隐私过滤基本有效
旧 Backend 请求兼容
原有模式无回归
Extension 测试通过
```

### 14.4 Integration 最终 Gate

必须验证：

```text
网页
  → Extension
  → Backend
  → Rule
  → AI
  → Fusion
  → risk_events
  → 插件风险提示
```

同时验证 Dashboard 继续基于最终 `risk_level`、`risk_score`、`reason` 展示数据，且 AI 关闭或模型故障时第一阶段规则链路仍可用。

## 15. 当前代码状态与契约差异

截至起始基线 `dd36bb0`，以下第二阶段能力尚未实现：

| 契约项 | 当前代码真实状态 | 第二阶段要求 |
|---|---|---|
| `title`、`meta_description` | `/api/risk/check` 会忽略未知字段 | 增加可选字段校验、规范化和使用 |
| Text ML Model | 不存在真实模型和推理代码 | 新增算法无关的 TextRiskModel 适配层 |
| `backend/services/ai_service.py` | 使用关键词规则；只检查 `.ftz` 路径是否存在，没有真实加载和推理 | 明确规则降级职责或由新适配层接管推理 |
| Rule + AI Fusion | 当前从黑名单、URL 规则、关键词结果中按等级/分数取最大值 | 引入经 validation 校准的 Fusion |
| `risk_events.details` | 在线写入路径未保存 AI 信息 | 按 `analysis_version=1` 保存分析快照 |
| ML 依赖 | `requirements.txt` 没有 sklearn/joblib 等依赖 | 由 Backend 负责人按实际实现增加并固定版本 |
| `models/` | 不存在 | 由模型分支生成真实模型和 manifest |
| AI 数据集/训练/评测 | 不存在正式训练数据和流程 | 按第 11 节建立 |
| 公开成功响应 | 已固定为 `risk_level/score/reason`，测试存在严格字段断言 | 保持不变 |
| `/api/events/risk` | 主生产路径七字段；另有六字段测试辅助契约 | 本阶段保持现状，不传 AI metadata |

这些差异是第二阶段待实现工作，不代表第一阶段代码缺陷。不得把规划能力描述为已经完成。

## 16. AI v1 明确不实现的范围

```text
BERT / RoBERTa
URL ML
多模态
OCR
截图识别
完整重定向链
外部信誉库
Android
完整家庭协同
大规模数据库迁移
Dashboard 大重构
多模型编排
```

这些能力留给 iCAN 后续版本或 AIC 算法创新赛。当前接口必须允许未来把 TF-IDF + Logistic Regression 替换或扩展为 Chinese BERT / RoBERTa、URL ML Detector、Rule + URL + Text 多源 Fusion，而不破坏公开 API 和 RiskService 的算法隔离边界。

## 17. 契约变更规则

以下任一变化必须升级契约版本，并由三名成员共同确认：

- 增删或重命名公开请求/响应字段；
- 改变字段必填性、类型或长度；
- 增加风险等级或 AI 类别；
- 改变分数量纲；
- 改变 TextRiskModel 返回结构；
- 改变 Fusion 强规则保护原则；
- 改变 `risk_events.details` 主结构；
- 让 `/api/events/risk` 承载 AI metadata；
- 让 RiskService 直接依赖具体模型实现。

实验参数、模型内部特征和训练超参数可以在不破坏本契约的前提下迭代，但必须保留真实评测记录，不得以演示值冒充最终指标。
