# SmartGuard-NetGuard RC阶段风险检测测试报告

## 1. 测试目的

本次测试用于验证 SmartGuard-NetGuard 在 RC（Release Candidate）阶段的风险检测能力与核心链路可用性，重点覆盖：

- AI 文本风险识别能力；
- 典型高风险内容检测能力；
- 可疑边界风险判断能力；
- 正常文本及安全宣传文本的误报情况；
- 后端风险检测接口的稳定性与结果返回能力。

完整风险检测链路如下：

```text
测试样本
    ↓
/api/risk/check
    ↓
RiskService
    ↓
风险检测
    ↓
结果返回
    ↓
RiskEvent记录
```

本报告的统计结论以 `docs/rc/risk-test-result.csv` 中现有 50 条记录为准。RISK-001～035 与 RISK-046～050 保留历史样本结果；原标记为 `MANUAL` 的 RISK-036～045 已在最终代码冻结基线 `87618cf` 上完成 Edge 真机回归。数据库记录 ID 仅在证据明确展示时填写，未展示的字段保持空白，不从历史材料推断。

---

## 2. 测试环境

### 2.1 软件环境

| 项目 | 环境或版本 |
| --- | --- |
| 操作系统 | Windows |
| Python | 3.12 |
| Web 框架 | Flask 2.3.3 |
| 数据库 | MySQL 5.7.26 |
| 风险检测接口 | `POST /api/risk/check` |
| Final Regression Code Baseline | `87618cf` |
| Final Regression Date | 2026-09-20 |

### 2.2 测试入口

| 测试入口 | 覆盖范围 | 当前验证方式 |
| --- | --- | --- |
| `API_DIRECT` | 直接调用后端风险检测接口，验证文本风险等级、评分和原因返回 | 自动执行并记录结果 |
| `EXTENSION_E2E` | 验证插件页面检测、风险提示、Backend 调用及 RiskEvent 链路 | 已在 `87618cf` 完成 Final Regression |
| `CHILD_MODE` | 验证 Child Mode 对未成年人危险内容的处理 | 已在 `87618cf` 完成 Final Regression |
| `OFFICIAL_UI_REGRESSION` | 验证官方 Web 页面不会因产品说明中的风险词汇触发错误拦截 | Official UI self-scan 已由项目负责人 Final Integration Gate 验证关闭；官方 UI 自动扫描跳过，用户主动 AI Quick Scan 保持可用 |

---

## 3. 测试样本设计

本次共设计 50 条风险检测样本，覆盖正常安全文本、可疑边界、高风险内容、插件风险 Demo、Child Mode 危险内容及误报边界回归场景。

| 编号范围 | 样本分类 | 数量 | 设计目的 |
| --- | --- | ---: | --- |
| RISK-001～RISK-015 | 正常安全负样本 | 15 | 验证普通文本及安全提示不会被错误判定为高风险 |
| RISK-016～RISK-025 | 可疑边界样本 | 10 | 验证登录异常、账号验证、退款等弱风险语义 |
| RISK-026～RISK-035 | 明显高风险样本 | 10 | 验证诈骗、转账诱导、冒充官方、刷单、虚假中奖等典型风险 |
| RISK-036～RISK-040 | 插件风险 Demo 样本 | 5 | 验证 Extension 风险提示与 Backend 完整链路 |
| RISK-041～RISK-045 | Child模式风险样本 | 5 | 验证 Child Mode 对未成年人危险内容的处理 |
| RISK-046～RISK-050 | 误报边界回归样本 | 5 | 验证反诈宣传、安全教育和官方产品说明等上下文中的误报 |
| **合计** |  | **50** |  |

---

## 4. 测试结果统计

| 测试结果 | 数量 | 含义 |
| --- | ---: | --- |
| PASS | 34 | 实际判断或 Final Regression 行为符合预期 |
| NOTE | 9 | 存在偏差，但属于当前规则模型能力边界 |
| FAIL | 7 | 自动判断未达到预期，主要集中在语义理解不足 |
| MANUAL | 0 | 原 10 条手工项已完成 Final Regression |
| **总计** | **50** |  |

`PASS` 表示样本结果符合预期；`NOTE` 表示存在误报或偏差，但已确认为当前规则模型的能力边界；`FAIL` 表示自动判断未达到预期，主要与弱语义、上下文理解不足有关。当前已无 `MANUAL` 项，但仍有 7 条 `FAIL` 和 9 条 `NOTE`，因此不能表述为 50/50 全部通过。

---

## 5. 测试结果分析

### 5.1 高风险内容识别能力

RISK-026～RISK-035 覆盖银行卡异常、虚假中奖、安全账户、刷单返利、冒充教师或公安、脱离平台付款、贷款保证金、退款赔偿和投资诱导等明显高风险场景。

依据当前结果 CSV，RISK-026～RISK-031、RISK-034、RISK-035 共 8 条识别为 `high` 并通过；RISK-032、RISK-033 被识别为 `safe`，未达到预期。因此当前真实结果为 **8/10 PASS、2/10 FAIL**。原定“RISK-026～RISK-035 全部识别成功”的验收结论与现存测试数据不一致，本报告不将其作为最终结论。

结果说明当前版本对典型转账、验证码、刷单、虚假中奖及冒充官方类内容具备较好的识别能力，但对“脱离平台私人付款”和“贷款前置费用”场景仍需补充语义或组合规则。

### 5.2 可疑边界风险识别能力

可疑边界样本中，抽奖诱导、限时奖励、退款处理、账号冻结和安全中心通知等场景能够触发风险判断；登录异常、账号验证、会员失效、订单异常和设备异常等弱风险语义识别不足，部分结果仍为 `safe`。

这表明当前检测逻辑对显式风险关键词较敏感，但对需要结合上下文、紧迫感和操作意图才能判断的边界风险覆盖不足。

### 5.3 误报分析

反诈宣传、安全教育、银行安全提示和官方产品功能说明等文本包含“诈骗”“转账”“钓鱼”“验证码”等风险关键词，当前规则模型可能将其判定为 `high`。RISK-010～RISK-013 及 RISK-046～RISK-050 共形成 9 条 `NOTE`。

此类偏差主要由关键词模型缺乏上下文理解能力导致，需要区分“实施风险行为”与“提醒用户防范风险”的语义方向。

### 5.4 插件风险链路验证

RISK-036～RISK-040 已在 `87618cf` 完成 5/5 Final Regression PASS：

- RISK-036 使用 `phishing-demo.html`，验证钓鱼页面拦截及 Extension → Backend/RiskEvent → Dashboard 完整链路；
- RISK-037 使用 AI `high.html` Demo，验证高风险提示及 Dashboard 最新记录；
- RISK-038～040 使用 `本地测试页面 neutral.html` 中性正文页，替代旧 `demo_scam.html` 作为当前自动正文风险检测的主要 E2E 入口；
- RISK-038、039 保存当前正文识别链证据，其中 RISK-039 Console 显示 `persisted_by_backend = true`，但两项均未声称单独保存 Dashboard 截图；
- RISK-040 同时验证 `persisted_by_backend = true` 和 Dashboard 最新风险记录，数据库记录 ID 保持空白。

旧 `demo_scam.html`、旧 RiskEvent 248、旧 UI 281、旧 event_uuid 与 `TASK-E-RISK-EVENTS-001.json` 继续作为历史材料，不作为本轮 Final Regression 的主要证明。

### 5.5 Child模式风险验证

RISK-041～RISK-045 已在 `87618cf` 完成 5/5 Final Regression PASS。该组验证 Child Policy、blocker 与 `dangerous_block` 链路，不使用 AI RiskScore：

- RISK-041 正式正文命中“博彩赌博诱导”；旧 `fake_gambling.html` 截图只保留为修复前历史证据；
- RISK-042 正式正文命中“索取隐私或验证信息”；
- RISK-043 正式正文命中“高额充值或绕过监管”；
- RISK-044 正式正文命中“隐瞒或私下资金诱导”；
- RISK-045 完成自定义危险关键词生命周期：未配置时不阻断，添加并保存后立即阻断，删除后同一正文恢复正常。

旧材料中的 `RETEST_REQUIRED`、`FAIL` 和旧 Demo 均属于修复前或补件前历史状态；最终验收状态以 `87618cf` 的 2026-09-20 真机回归为准，历史证据不删除。

### 5.6 Final Regression / Extension Final Gate

以下表格中的 Extension、Child P1、background-risk-event 与 settings 四组数据为本地自动化 Final Gate 结果，分别统计，不合并口径。

| Gate | 结果 |
| --- | --- |
| 代码基线 | `87618cf` |
| Extension 自动化 | 96 / 96 PASS |
| Child P1 自动化 | 102 / 102 PASS |
| background-risk-event | 18 / 18 PASS |
| settings | 20 / 20 PASS |
| Edge RISK-036～040 | 5 / 5 PASS |
| Edge RISK-041～045 | 5 / 5 PASS |
| Extension Reload | PASS；`CHILD-P1-RELOAD-PASS.png` |
| Service Worker Restart | PASS；`CHILD-P1-SW-RESTART-PASS.png` |
| Child 网站白名单 | PASS；`CHILD-P1-WHITELIST-BEFORE.png`、`CHILD-P1-WHITELIST-PASS.png` |
| 模式隔离 | Normal / Strict / Elder 均 PASS；`CHILD-P1-MODE-NORMAL-PASS.png`、`CHILD-P1-MODE-STRICT-PASS.png`、`CHILD-P1-MODE-ELDER-PASS.png` |
| 广告 Final Smoke | Normal / Strict 均 PASS；`RC-AD-SMOKE-NORMAL-PASS.png`、`RC-AD-SMOKE-STRICT-PASS.png` |

Child Game Policy 真机结果为 3/3 PASS：娱乐限制 ON + 学习 OFF 时 BLOCK，娱乐限制 OFF + 学习 ON 时 BLOCK，两者均 OFF 时 ALLOW。证据分别为 `CHILD-P1-GAME-ENTERTAINMENT-ON.png`、`CHILD-P1-GAME-LEARNING-ON.png` 和 `CHILD-P1-GAME-BOTH-OFF.png`。

本次两条广告测试是 `87618cf` 上的 Final Smoke，不替代历史完整批测。历史 50 条广告样本仍为 Normal 50/50、Strict 50/50、正常负样本误杀 0。当前正式 UI 没有独立的全局白名单用户配置入口，因此全局白名单记为 N/A；本轮验证的是 Child 网站白名单。

---

## 6. 已知问题

- AI 语义理解不足，无法稳定识别需要结合意图与上下文判断的风险文本；
- 关键词模型上下文能力不足，反诈宣传和安全教育文本可能因包含风险词汇而误报；
- 边界风险识别不足，登录异常、账号验证、订单异常等弱风险场景存在漏判；
- **P2**：娱乐内容限制 ON、学习模式 OFF 时游戏阻断功能正确，但 blocker 文案仍显示“当前为学习模式”；该 UI 文案不一致不阻断第一阶段 RC。

---

## 7. 后续优化方向

- 引入文本语义模型，增强风险意图和上下文理解能力；
- 采用规则与模型融合策略，保留规则可解释性的同时提高泛化能力；
- 优化风险评分，将单一关键词命中扩展为多特征综合评分；
- 结合用户行为和页面上下文，区分风险诱导、安全宣传及正常业务提示；
- 第二阶段继续扩充自然语言语义识别与边界样本覆盖。

---

## 8. 测试结论

基于当前 50 条样本结果和已完成的核心功能验证，**RC版本核心功能通过验收**。

当前版本已具备：

- 风险检测接口能力；
- 典型高风险内容识别能力；
- 插件风险检测链路的 Final Regression 证据；
- Child Mode P1 正式正文与自定义关键词生命周期验证；
- 风险结果返回能力。

原 10 条 `MANUAL` 已全部完成 Final Regression，当前为 34 条 `PASS`、9 条 `NOTE`、7 条 `FAIL`、0 条 `MANUAL`。本结论不等同于“全部样本通过”；后续仍需继续优化 AI 语义能力、边界风险识别和误报控制。

---

## 附录：测试材料

- 测试样本：`tests/samples/risk-samples.csv`
- 测试结果：`docs/rc/risk-test-result.csv`
- RC 测试工具：`tests/rc/`
