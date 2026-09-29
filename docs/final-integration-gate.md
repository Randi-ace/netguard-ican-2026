# 净网护航第一阶段 Final Integration Gate

> 文档状态：RC Candidate Validation v0.1  
> 文档更新日期：2026-09-06  
> 代码冻结候选基线：`f4192a0`  
> 当前结论：**CODE GATE PASS / MATERIAL GATE PENDING / RC NOT RELEASED**

---

## 1. 文档目的

本文档用于记录“净网护航——基于 AI 的智能广告拦截与网络安全防护系统”第一阶段最终集成验收状态，作为第一阶段 RC 候选版本的总体验收记录。

本文档主要回答以下问题：

1. Backend、Extension、Web 是否已经完成第一阶段核心功能；
2. Extension、Flask、MySQL、Web 是否已经形成真实业务闭环；
3. 第一阶段已发现的 P0 / P1 是否已经关闭；
4. 当前还有哪些测试样本、文档和交付材料尚未完成；
5. 当前代码是否可以继续保持冻结；
6. 何时可以正式创建 `release/v1.0-rc1` 和 `v1.0.0-rc1`。

本文件只记录 **Final Gate 结论、关键证据和 Release Blocking 状态**，不替代以下详细材料：

- Backend 测试记录；
- Extension RC 测试报告；
- Web 测试报告；
- 广告样本库；
- 风险样本库；
- API 文档；
- 数据库说明；
- 第一阶段总测试报告；
- 第二阶段 Backlog。

---

## 2. RC 候选基线

### 2.1 Git 基线

正式第一阶段集成分支：

```text
integration/backend-extension-week1-2
```

冻结候选 Commit：

```text
f4192a0
```

Commit Message：

```text
merge: child usage display fix into integration
```

截至 `f4192a0` 代码冻结审计，已经确认：

- Backend 最终第一阶段核心提交已合入 integration；
- Extension 最终第一阶段核心提交已合入 integration；
- Frontend 最终第一阶段核心提交已合入 integration；
- 三个开发 feature 分支不存在已知尚未合入 integration 的第一阶段核心代码；
- `f4192a0` 完成 Final Integration 验收时，integration tracked 工作区保持干净；
- `database/backup/` 保持既有 untracked 状态，不纳入版本控制。

后续新增的 RC 材料、样本、测试报告和证据提交属于 **材料收口工作**，不代表第一阶段核心代码重新开放开发。

---

### 2.2 当前冻结原则

从 `f4192a0` 起继续保持第一阶段核心代码冻结。

仅以下情况允许重新打开第一阶段核心代码：

- P0；
- P1；
- 联调阻断；
- 严重误杀；
- 数据错误；
- 核心功能失效；
- 第一阶段演示阻断。

以下事项不得作为重新打开核心代码的理由：

- 顺手优化 UI；
- 增加图表；
- 增加新的广告规则；
- 小范围兼容性改进；
- 非核心文案调整；
- 非阻塞性能优化；
- 第二阶段规划功能。

普通优化统一进入：

```text
docs/backlog-phase2.md
```

---

## 3. Feature 分支收口状态

| 模块 | 开发分支 | 第一阶段最终候选提交 | Integration 状态 |
|---|---|---:|---|
| Backend | `feature/backend-stabilization` | `b7c5ecd` | MERGED |
| Extension | `feature/extension` | `f850476` | MERGED |
| Frontend | `feature/frontend` | `3f603b4` | MERGED |

当前冻结 integration：

```text
integration/backend-extension-week1-2
HEAD = f4192a0
```

截至代码冻结审计，不存在已知未合入 integration 的第一阶段核心 feature 提交。

---

## 4. RC 材料分支规划

第一阶段核心代码冻结后，RC 材料采用独立分支完成，不直接在 integration 开发。

### 项目总材料

```text
feature/rc-materials
```

主要负责：

- `docs/final-integration-gate.md`
- `docs/first-stage-test-report.md`
- `docs/backlog-phase2.md`
- `tests/samples/risk-samples.csv`
- Final E2E 证据；
- API 文档最终校准；
- Release Notes；
- 版本收口。

### Extension RC 材料

```text
feature/extension-rc-materials
```

主要负责：

- ≥50 广告 / 正常负样本；
- Edge 四站实机测试矩阵；
- Extension RC 测试报告；
- 插件截图；
- Extension P2。

### Frontend RC 材料

```text
feature/frontend-rc-materials
```

主要负责：

- Web 五份既有文档校准；
- Web 最终截图；
- 响应式证据；
- Loading / Empty / Error 状态；
- Web P2；
- 演示素材。

---

## 5. 第一阶段 Gate 总览

| Gate | 验收目标 | 当前状态 | 说明 |
|---|---|---|---|
| Gate 1 | Extension 第一阶段规划功能完成 | **PASS** | 核心功能及自动化覆盖完成 |
| Gate 2 | Edge 插件 RC 稳定 | **FUNCTIONAL PASS / EVIDENCE PENDING** | 实机核心测试已通过，正式材料待归档 |
| Gate 3 | Extension → Flask → MySQL → Web 真实闭环 | **FUNCTIONAL PASS / EVIDENCE PENDING** | 核心联调已通过，正式 E2E 证据待归档 |
| Gate 4 | ≥100 样本 + 测试报告 + 文档材料 | **PENDING** | 当前第一阶段主要剩余任务 |
| Gate 5 | Final Gate + RC Freeze | **CODE PASS / MATERIAL PENDING** | 暂不创建 release/tag |

---

# 6. 自动化测试 Gate

## 6.1 Backend

安全自动化测试结果：

```text
96 passed
37 subtests passed
```

结论：

```text
PASS
```

说明：

```text
tests/backend/test_ai_api.py
```

会访问真实本地：

```text
127.0.0.1:5000
```

因此未纳入当前安全自动化测试套件。

---

## 6.2 Extension

第一阶段正式 Extension 测试：

```text
96 / 96 PASS
```

仓库另有 Extension 补充测试：

```text
18 / 18 PASS
```

结论：

```text
PASS
```

---

## 6.3 Frontend

最终 Frontend 自动化测试：

```text
20 / 20 PASS
```

结论：

```text
PASS
```

Frontend 第 20 项重点验证：

```text
child browsing status keeps a real-data slot without fabricated minutes
```

即：

- Child 剩余时间不再显示伪造的固定分钟数；
- 保留真实数据插槽；
- 等待第二阶段真实 Child Status API。

---

## 6.4 静态检查

已完成：

- Python syntax / parse：PASS；
- JavaScript `node --check`：PASS；
- JSON parse：PASS；
- `git diff --check`：PASS。

结论：

```text
PASS
```

---

# 7. Gate 1 —— Extension 第一阶段规划功能

当前已完成并经过自动化或人工验证的核心内容包括：

- Normal Mode；
- Strict Mode；
- Elder Mode；
- Child Mode；
- 儿童浏览时长统计；
- 浏览时长提醒；
- 每日浏览时长上限；
- 危险关键词；
- 娱乐网站规则；
- Learning Mode；
- Global Whitelist；
- Child Whitelist；
- Child Settings Persistence；
- Service Worker 状态恢复；
- Extension Reload 状态恢复；
- Edge 重启后关键状态恢复；
- 模式隔离；
- Paused 独立状态；
- Backend Offline Settings Pending；
- Backend 恢复后的 Push-first 同步。

---

## 7.1 模式规范

当前正式模式：

```text
Normal
Strict
Elder
Child
```

统一规范：

```text
Child > Elder > Strict / Normal
```

其中：

```text
paused
```

为独立状态。

Paused 不会自动把当前活动模式重置为 Normal。

---

## 7.2 Child Mode

已完成：

- Child 主模式；
- 儿童浏览时长累计；
- 周期提醒；
- 每日上限；
- Limit Reached 持久化；
- Service Worker 重建；
- Extension Reload 恢复；
- Child Whitelist；
- Dangerous Keywords；
- Entertainment Rules；
- Learning Mode；
- 设置持久化。

结论：

```text
PASS
```

---

## 7.3 Gate 1 最终结论

```text
GATE 1:
PASS
```

---

# 8. Gate 2 —— Edge RC 稳定性

第一阶段已经进行多轮 Edge 实机验证，主要覆盖：

- Normal；
- Strict；
- Elder；
- Child；
- 模式切换；
- Service Worker；
- Extension Reload；
- 页面刷新；
- Backend Offline；
- Whitelist；
- CSDN 登录二维码保护；
- 常用网站兼容性；
- 误杀检查。

---

## 8.1 已完成的核心实机验证

### CSDN

已实际验证：

- Normal 广告处理；
- Strict 广告处理；
- 页面主要功能；
- 登录二维码保护。

此前登录二维码误杀问题已修复并完成回归。

### 淘宝

已实际验证：

- Normal；
- Strict；
- 搜索与主要商品区域；
- 页面主要功能。

### Bilibili / B站

已实际验证：

- Normal；
- Strict；
- 页面主要功能；
- Child 娱乐网站相关规则。

### 百度

已实际验证：

- Normal；
- Strict；
- 搜索框；
- 页面主要功能。

---

## 8.2 Lifecycle / Reload

已实际验证：

- Extension Reload；
- Service Worker 生命周期；
- Child 配置持久化；
- 页面刷新；
- Edge 重启后关键状态恢复。

---

## 8.3 当前非阻塞问题

以下项目当前不作为第一阶段 RC 代码阻断：

- Luogu 广告覆盖仍可继续优化；
- Runoob 广告覆盖仍可继续优化；
- CSDN Strict 存在部分布局留白；
- 更多网站兼容性仍可增加；
- 局部广告覆盖率仍可进一步优化。

分类：

```text
P2 / PHASE 2 BACKLOG
```

---

## 8.4 Gate 2 仍缺少的正式证据

正式 RC 材料还需要由 Extension 负责人整理：

- ≥50 条广告 / 正常负样本；
- CSDN / 淘宝 / B站 / 百度正式测试矩阵；
- Normal / Strict 结果表；
- Elder / Child 快速回归结果；
- Edge Version；
- Commit；
- 测试日期；
- 截图编号；
- Extension RC 正式测试报告。

---

## 8.5 Gate 2 当前结论

```text
FUNCTIONAL GATE:
PASS

EVIDENCE GATE:
PENDING
```

---

# 9. Gate 3 —— 三端真实闭环

## 9.1 Risk Detection Chain

正式风险链路：

```text
Edge Page
↓
Extension
↓
POST /api/risk/check
↓
Backend Risk Service
↓
MySQL.risk_events
↓
Dashboard / Risk Logs
↓
User
```

该链路已经进行实际联调，并确认核心功能可以运行。

当前功能状态：

```text
PASS
```

---

## 9.2 Ad Event Chain

正式广告统计链路：

```text
Web Page
↓
Extension Ad Detection
↓
POST /api/events/ad
↓
Backend Event Service
↓
MySQL.ad_events
↓
Dashboard
↓
User
```

该链路已经进行实际联调，并确认：

- Extension 可生成广告事件；
- Backend 可接收广告事件；
- MySQL 可写入 ad_events；
- Dashboard 可显示真实统计；
- 当前不存在已知严重重复爆增问题。

当前功能状态：

```text
PASS
```

---

## 9.3 Settings Chain

正式 Settings 架构：

```text
Web
↕
Backend /api/settings
↕
Extension
```

正式共享设置字段：

```text
mode
elder_mode
child_mode
paused
```

已实际验证：

- Web → Backend → Extension：PASS；
- Extension → Backend → Web：PASS；
- Paused 保留当前活动模式：PASS；
- Backend Offline 时 Extension 本地 Pending：PASS；
- Backend 恢复后 Push-first：PASS；
- Web Backend Offline Preserve：PASS。

---

## 9.4 Gate 3 正式证据仍需归档

正式 RC 前仍需保存至少一组：

### Risk E2E

记录：

- 测试时间；
- Commit；
- 输入页面；
- event_uuid；
- API response；
- MySQL risk_events；
- Dashboard / Risk Logs；
- PASS / FAIL。

### Ad E2E

记录：

- 测试网页；
- Mode；
- Extension 结果；
- API response；
- MySQL ad_events；
- Dashboard；
- PASS / FAIL。

### Settings E2E

记录：

- Web → Backend → Extension；
- Extension → Backend → Web；
- 最终一致状态。

---

## 9.5 Gate 3 当前结论

```text
FUNCTIONAL GATE:
PASS

FINAL EVIDENCE ARCHIVE:
PENDING
```

---

# 10. 已关闭 P1

## 10.1 P1-01 —— Official UI Self Scan

### 原问题

官方：

```text
UI/index.html
```

包含：

- 诈骗；
- 钓鱼；
- 转账；

等产品说明文本。

Extension 自动页面 AI Scan 曾可能将官方 Web 自身错误识别为 High Risk，从而产生：

- 高风险 Popup；
- risk_event；
- MySQL 风险记录。

---

### 当前修复

Official UI 必须同时满足：

1. `location.protocol === "file:"`
2. normalized path 严格匹配 `/UI/index.html`
3. `<html>` 包含：

```html
data-netguard-page="official-ui"
```

只有满足上述 trusted UI 条件，才跳过 **自动页面文本 AI Scan**。

该机制不会关闭：

- 广告处理；
- Settings；
- Normal / Strict / Elder / Child；
- 用户主动执行 AI Quick Scan；
- 本地 phishing demo；
- 其他正常测试页面。

---

### 最终控制变量验证

执行：

```text
最新 integration
↓
Reload Extension
↓
关闭旧页面
↓
Backend Online
↓
打开 Official Web
```

结果：

- 无 High Risk Popup；
- MySQL 无新增 `UI/index.html` high risk event。

继续执行：

```text
Backend Offline
↓
打开 Official Web
↓
Backend 恢复
↓
等待同步 / retry
```

结果：

- 无 High Risk Popup；
- 无延迟补传的 `UI/index.html` high risk event。

最终状态：

```text
P1-01:
CLOSED
```

---

## 10.2 P1-02 —— Web / Extension Settings Divergence

### 原问题

Web 和 Extension 分别维护 Settings，可能出现：

```text
Web = Strict
Extension = Normal
```

等状态分裂。

---

### 当前正式架构

```text
Backend /api/settings
        ↑↓
Web     Extension
```

Backend 作为共享持久化 Source of Truth。

Extension：

```text
chrome.storage.local
```

用于：

- 本地执行缓存；
- Backend Offline 缓存；
- Pending Settings。

---

### 已验证

- Web → Extension：PASS；
- Extension → Web：PASS；
- Offline Pending：PASS；
- Service Worker Restart：PASS；
- Reconnect Push-first：PASS；
- Paused：PASS。

最终状态：

```text
P1-02:
CLOSED
```

---

## 10.3 P1-03 —— Child Fake Remaining-Time Display

### 原问题

Web Child 页面曾固定显示：

```text
今日剩余浏览 45 分钟
```

但第一阶段尚无真实 Child Runtime Status API，因此该数据显示具有误导性。

---

### 当前处理

现在显示：

```text
今日剩余浏览
--
```

并显示说明：

```text
浏览状态等待扩展同步；
当前浏览时长保护由浏览器扩展实时执行。
```

同时保留：

```html
id="childRemainingTime"
```

作为第二阶段真实 Child Status API 的 UI 插槽。

最终状态：

```text
P1-03:
CLOSED
```

---

# 11. 当前 P0 / P1 状态

## 11.1 P0

```text
OPEN P0:
0
```

---

## 11.2 P1

```text
OPEN P1:
0
```

已知重点 P1：

| ID | 问题 | 状态 |
|---|---|---|
| P1-01 | Official UI Self Scan | CLOSED |
| P1-02 | Web / Extension Settings Divergence | CLOSED |
| P1-03 | Child Fake Remaining Time | CLOSED |

---

# 12. Gate 4 —— Sample Gate

## 12.1 广告样本

负责人：

```text
黄培鑫
```

目标：

```text
≥50 条广告 / 正常负样本
```

要求至少记录：

- ID；
- 日期；
- Edge Version；
- Commit；
- 网站；
- 页面；
- URL；
- 样本类型；
- 元素类型；
- Normal 预期；
- Normal 实际；
- Strict 预期；
- Strict 实际；
- 是否误杀；
- 页面主要功能；
- Refresh；
- PASS / FAIL；
- 截图编号；
- 备注。

计划材料：

```text
tests/samples/ad-samples.csv
```

或等价正式样本文件。

当前状态：

```text
PENDING
```

完成后更新：

```text
TOTAL:
PASS:
FAIL:
FALSE POSITIVE:
```

---

## 12.2 风险样本

负责人：

```text
周敏
```

目标：

```text
≥50 条风险 / 正常对照样本
```

建议覆盖：

- 正常网页 / 正常文本；
- 可疑文本；
- 明显诈骗文本；
- 钓鱼场景；
- 本地 Risk Demo；
- Child Dangerous Content；
- 边界负样本；
- 误报测试。

计划文件：

```text
tests/samples/risk-samples.csv
```

建议字段：

- ID；
- 日期；
- Commit；
- 样本类别；
- URL / 页面；
- 输入文本或特征；
- 预期风险等级；
- 实际风险等级；
- Risk Score；
- Reason；
- risk_event 是否入库；
- Dashboard 是否展示；
- PASS / FAIL；
- 备注。

当前状态：

```text
PENDING
```

完成后更新：

```text
TOTAL:
PASS:
FAIL:
FALSE POSITIVE:
FALSE NEGATIVE:
```

---

# 13. Gate 4 —— Documentation / Evidence Gate

当前材料状态：

| 材料 | 当前状态 |
|---|---|
| Backend 自动化测试 | PASS |
| Extension 自动化测试 | PASS |
| Frontend 自动化测试 | PASS |
| Database 说明 | EXISTS |
| 安装 / 开发环境说明 | EXISTS |
| Web 用户说明 | EXISTS / FINAL UPDATE PENDING |
| Web 测试报告 | EXISTS / FINAL UPDATE PENDING |
| Web 已知问题 | EXISTS / FINAL UPDATE PENDING |
| Web Screenshot Checklist | EXISTS / FINAL UPDATE PENDING |
| Web First Stage Delivery | EXISTS / FINAL UPDATE PENDING |
| Extension RC 测试报告 | PENDING |
| Edge 正式兼容矩阵 | PENDING |
| ≥50 广告样本 | PENDING |
| ≥50 风险样本 | PENDING |
| Risk E2E 正式证据 | PENDING ARCHIVE |
| Ad E2E 正式证据 | PENDING ARCHIVE |
| Settings E2E 正式证据 | PENDING ARCHIVE |
| 第一阶段总测试报告 | PENDING |
| 第二阶段统一 Backlog | PENDING |
| API 最终契约校准 | PENDING |
| Version / CHANGELOG / Release Notes | PENDING |
| Final Integration Gate | IN PROGRESS |

---

# 14. Web 材料最终校准

Frontend 负责人需要基于：

```text
f4192a0
```

最终校准以下既有文档：

```text
docs/web-user-guide.md
docs/web-test-report.md
docs/web-known-issues.md
docs/web-screenshot-checklist.md
docs/web-first-stage-delivery.md
```

---

## 14.1 必须核对的最新状态

### Branding

正式用户可见品牌：

```text
净网护航
```

不得继续将 `ShieldFlow` 作为正式产品名。

内部代码注释或历史命名可进入第二阶段清理。

### Dashboard

正式 Dashboard：

- 使用真实 Backend；
- 不使用正式 Mock Fallback；
- Loading 已处理；
- Empty 已处理；
- Error 已处理；
- 周期刷新已实现。

### Settings

正式 Settings 已经：

```text
Web
↔ Backend
↔ Extension
```

完成双向同步。

### Child

不得继续出现：

```text
今日剩余浏览 45 分钟
```

当前必须与实际 UI 一致：

```text
今日剩余浏览
--
```

### Official UI

Official Web Self Scan 已关闭，不再作为 Current Issue。

### Resolved P1

以下内容不得继续列为当前开放问题：

- Official UI Self Scan；
- Web / Extension Settings Divergence；
- Child Fake Remaining Time。

可以移动到：

```text
Resolved Issues
```

---

# 15. API 文档最终校准

正式 RC 前需要对 API 文档执行最终实现一致性检查。

---

## 15.1 `/api/risk/check`

正式接口：

```text
POST /api/risk/check
```

需要确认 API 文档与当前实现一致，包括：

```text
event_uuid
```

以及对应幂等 / 重复事件语义。

不得继续保留与实际实现冲突的旧说明。

---

## 15.2 `/api/settings`

当前正式 Settings Contract：

```text
mode
elder_mode
child_mode
paused
```

旧的：

```text
expected_version
settings
preferences
```

等历史结构不得继续作为当前正式 API Contract。

当前状态：

```text
PENDING DOCUMENT ALIGNMENT
```

---

# 16. Database / Installation 文档

## 16.1 Database

当前已有：

```text
database/README.md
docs/DATABASE_SCHEMA_v1alpha1.md
```

状态：

```text
EXISTS
```

最终 RC 前再次核对：

- risk_events；
- ad_events；
- settings；
- 当前正式字段；
- 与 Backend 实现一致。

---

## 16.2 安装 / 开发环境

当前已有：

```text
README.md
docs/DEVELOPMENT_SETUP.md
```

状态：

```text
EXISTS
```

最终 RC 前需要确认：

- Python / Flask 启动方式；
- MySQL 配置方式；
- Extension 加载方式；
- Web 打开方式；
- 当前正式版本 / 分支；
- 测试环境说明。

---

# 17. 第二阶段 Backlog

统一文件：

```text
docs/backlog-phase2.md
```

第一阶段不再处理普通 P2。

---

## 17.1 Extension P2

当前已知包括：

- Luogu 广告覆盖优化；
- Runoob 广告覆盖优化；
- CSDN Strict 留白；
- 更多网站兼容性；
- 非核心广告检测覆盖率优化；
- 小范围误杀优化。

---

## 17.2 Web P2

当前已知包括：

- 960px 左右响应式细节；
- 内部遗留 `ShieldFlow` 命名清理；
- Chart.js CDN 依赖；
- API Base URL 配置化；
- 非核心 UI / UX 优化；
- Child 实时剩余时长展示。

---

## 17.3 Backend / Technical Debt

当前已知包括：

- 旧兼容 API 清理；
- demo / memory fallback 清理；
- 重复 `/health` 注册清理；
- API Base URL / Environment 配置化；
- 历史兼容代码收敛。

---

## 17.4 Family Management / Phase 2

第二阶段计划包括：

- Family Management；
- 家庭成员管理；
- Child Device Binding；
- Child Status API；
- daily_limit；
- elapsed；
- remaining；
- limit_reached；
- last_sync_at；
- 家长远程配置；
- 临时加时；
- 儿童使用记录；
- 家长查看儿童风险记录。

第一阶段 Web 保留：

```html
id="childRemainingTime"
```

作为真实 Runtime 数据接入插槽，不伪造数据。

---

# 18. Pre-Public-Deployment Hardening

> 本节内容 **不阻塞当前本地 / 学校项目第一阶段 RC**，但在未来进行真实公网部署、真实用户使用或正式生产发布前必须重新评估并完成。

包括：

- JWT / Authentication 强化；
- 用户身份与数据隔离；
- CORS 白名单；
- API Rate Limiting；
- HTTPS；
- 生产 WSGI；
- Secret / Environment Variable 管理；
- Production Logging；
- Database Backup / Recovery；
- Monitoring；
- Error Tracking；
- Base URL 配置化；
- 生产部署安全审计。

这些事项不得简单理解为“永远低优先级 P2”，而是：

```text
CURRENT LOCAL RC:
NON-BLOCKING

PUBLIC PRODUCTION RELEASE:
REQUIRED
```

---

# 19. Gate 5 —— RC Readiness

当前代码层面：

```text
Core Code:
PASS

Automated Tests:
PASS

Open P0:
0

Open P1:
0

Core Real-Machine Integration:
PASS
```

当前材料层面：

```text
Ad Sample Gate:
PENDING

Risk Sample Gate:
PENDING

Edge Evidence:
PENDING

Web Final Evidence:
PENDING

E2E Evidence Archive:
PENDING

First-stage Total Test Report:
PENDING

API Document Alignment:
PENDING

Version Alignment:
PENDING
```

因此：

```text
RC CODE CANDIDATE:
YES

RC MATERIAL READY:
NO

RC RELEASE:
NOT YET
```

---

# 20. Release Blocking Checklist

创建：

```text
release/v1.0-rc1
```

以及正式 Tag：

```text
v1.0.0-rc1
```

之前必须完成：

- [x] Core code integration
- [x] Backend automated tests
- [x] Extension automated tests
- [x] Frontend automated tests
- [x] Open P0 = 0
- [x] Open P1 = 0
- [x] Core three-stack real-machine validation
- [x] Official UI self-scan regression
- [x] Web → Extension settings validation
- [x] Extension → Web settings validation
- [x] Web offline preserve validation
- [ ] ≥50 ad / negative samples
- [ ] ≥50 risk / normal samples
- [ ] Extension RC test report
- [ ] Edge compatibility evidence
- [ ] Web final evidence update
- [ ] Risk E2E evidence archive
- [ ] Ad E2E evidence archive
- [ ] Settings E2E evidence archive
- [ ] First-stage total test report
- [ ] Phase 2 backlog
- [ ] API documentation alignment
- [ ] Version alignment
- [ ] CHANGELOG alignment
- [ ] Release Notes
- [ ] Final project lead review
- [ ] Final RC Readiness audit

---

# 21. 当前版本一致性问题

当前仓库仍存在历史版本口径差异：

```text
README / CHANGELOG:
v1.0-alpha

Extension tests:
v1.0.1

Extension manifest:
2.4.1

目标第一阶段 RC:
v1.0.0-rc1
```

正式 RC 前需要统一 **发布层面的版本表达**。

当前阶段暂不因为版本号问题重新开放核心功能代码。

版本统一安排在：

```text
Gate 4 完成
↓
Final Documentation Review
↓
Version Alignment
↓
Release Candidate
```

---

# 22. 第一阶段总测试报告

计划文件：

```text
docs/first-stage-test-report.md
```

该报告最终需要汇总：

1. 测试目标；
2. 测试环境；
3. Git / RC 基线；
4. Backend 自动化测试；
5. Extension 自动化测试；
6. Frontend 自动化测试；
7. Edge 实机测试；
8. ≥50 广告样本；
9. ≥50 风险样本；
10. Risk E2E；
11. Ad E2E；
12. Settings E2E；
13. P0 / P1 修复情况；
14. P2 / Phase 2 Backlog；
15. Final Gate 结论。

当前状态：

```text
PENDING
```

---

# 23. 当前第一阶段完成度

基于当前实际开发、自动化测试、人工联调和仓库材料状态：

```text
CORE CODE:
约 95%

CORE FUNCTION DEVELOPMENT:
基本完成

OPEN P0:
0

OPEN P1:
0

AUTOMATED TEST GATE:
PASS

CORE FINAL INTEGRATION:
PASS

SAMPLE GATE:
IN PROGRESS

DOCUMENTATION / EVIDENCE:
IN PROGRESS

RC RELEASE:
NOT YET
```

当前主要剩余工作已经从：

```text
Feature Development
```

切换为：

```text
Samples
+
Evidence
+
Documentation
+
Release Preparation
```

---

# 24. 当前冻结结论

当前冻结候选基线：

```text
f4192a0
```

应继续保持第一阶段核心代码冻结。

除非后续样本或正式回归发现：

- P0；
- P1；
- 严重误杀；
- 数据错误；
- 核心链路断裂；
- 演示阻断；

否则不得重新打开第一阶段核心功能开发。

所有普通优化统一进入第二阶段 Backlog。

---

# 25. 当前 Final Gate 结论

截至当前：

```text
CODE GATE:
PASS

AUTOMATED TEST GATE:
PASS

CORE REAL-MACHINE GATE:
PASS

OPEN P0:
0

OPEN P1:
0

SAMPLE GATE:
PENDING

DOCUMENTATION GATE:
PENDING

MATERIAL GATE:
PENDING

RC RELEASE:
NOT RELEASED
```

综合判断：

```text
CODE READY
MATERIALS IN PROGRESS
KEEP f4192a0 FROZEN
DO NOT CREATE RC TAG YET
```

---

# 26. 当前团队收口任务

## 26.1 周敏

负责：

- 完成 ≥50 风险 / 正常样本；
- 整理 Risk E2E 正式证据；
- 整理 Ad E2E 正式证据；
- 整理 Settings E2E 正式证据；
- 完成 `docs/backlog-phase2.md`；
- 校准 API 文档；
- 汇总 `docs/first-stage-test-report.md`；
- 最终更新 `docs/final-integration-gate.md`；
- 完成版本 / CHANGELOG / Release Notes 收口；
- 执行 Final RC Readiness 审计；
- 决定是否批准 RC 发布。

---

## 26.2 黄培鑫

负责：

- 完成 ≥50 广告 / 正常负样本；
- 完成 CSDN / 淘宝 / B站 / 百度 Edge 正式实机矩阵；
- 完成 Normal / Strict 结果表；
- 完成 Elder / Child 快速回归；
- 完成 Extension RC 正式测试报告；
- 整理插件正式截图；
- 整理 Extension P2。

---

## 26.3 王毓叶

负责：

- 校准现有 5 份 Web 文档；
- 整理最终 Web 截图；
- 完成 1366px / 960px 响应式记录；
- 整理 Loading / Empty / Error 状态；
- 更新 Web 已知问题；
- 更新已关闭 P1；
- 整理 Web P2；
- 整理演示素材。

---

# 27. Final Sign-off

当前：

```text
Project Lead Final Review:
PENDING

Extension Evidence:
PENDING

Web Evidence:
PENDING

Ad Sample Gate:
PENDING

Risk Sample Gate:
PENDING

E2E Evidence Gate:
PENDING

Documentation Gate:
PENDING

Version Alignment:
PENDING

RC Release Approval:
PENDING
```

所有 Release Blocking 项完成以后，将本节更新为：

```text
Project Lead Final Review:
PASS

Extension Evidence:
PASS

Web Evidence:
PASS

Ad Sample Gate:
PASS

Risk Sample Gate:
PASS

E2E Evidence Gate:
PASS

Documentation Gate:
PASS

Version Alignment:
PASS

RC Release Approval:
APPROVED
```

随后执行：

```text
integration/backend-extension-week1-2
↓
release/v1.0-rc1
↓
v1.0.0-rc1
```

至此完成第一阶段正式 RC 冻结。