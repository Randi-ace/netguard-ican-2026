# 净网护航 Web 已知问题

本文档记录 Web 第一阶段 RC 当前仍存在的 P2，以及已经关闭的问题。Web RC 历史执行基线为 `f4192a0`，原 RC 文档形成基线为 `e540cb8`，本轮前端材料审计基线为 `8dc2fcf`。项目后续 Final Integration 代码基线为 `87618cf`；`f4192a0` 至 `87618cf` 期间 Web UI 业务代码未发生相关变化，现有 Web RC 证据继续有效。

## Current Issues

本节所有项目均为 **P2 / 非阻断**，不属于 P0 或 P1。

### RC 核心限制

#### 1. 960px 附近布局细节

- 严重级别：P2 / 非阻断。
- 基础响应式支持已经完成。
- 960 × 768 截图与基础人工冒烟已经完成。
- 960px 附近的精细响应式优化仍作为 P2，不影响第一阶段 Gate。

#### 2. Chart.js CDN 依赖

- 严重级别：P2 / 非阻断。
- 当前图表组件依赖外部 Chart.js CDN。
- CDN 加载失败时页面会显示明确 Error，不会静默空白。
- 该问题属于部署与稳定性 P2，不影响当前 RC Gate。

#### 3. 本地 API Base URL

- 严重级别：P2 / 非阻断。
- 当前 RC / 本地 Gate 使用 `127.0.0.1:5000`。
- 正式部署前需要将 API Base URL 配置化。
- 该限制不影响当前本地 RC Gate。

#### 4. 家庭管理仍为第一阶段原型

- 严重级别：P2 / 非阻断。
- 家庭成员和设备管理尚未形成正式业务闭环。
- 完整的家庭管理属于第二阶段能力，不影响第一阶段 Web Gate。

#### 5. Child 实时剩余浏览时长尚未接 Backend

- 严重级别：P2 / 非阻断。
- 当前 Web 显示“今日剩余浏览：--”。
- 当前浏览时长保护由浏览器 Extension 实时执行。
- Web 不声称掌握真实 remaining / elapsed。
- `childRemainingTime` DOM 插槽已经保留，后续接入 Backend Child Status API 后再展示真实状态。

### 其他普通 P2

- 登录、第三方登录和个人资料仍为演示流程。
- 订阅、支付和账单尚未形成正式业务闭环。
- PDF 导出仍在开发中，当前入口已经明确标注并禁用。

以上项目均为 P2 / 非阻断，不影响第一阶段 RC Gate。

## Resolved Issues

### 1. Web / Extension Settings Divergence

状态：**CLOSED**

- Web 与 Extension 已通过 Backend `/api/settings` 完成双向同步。
- 正式共享字段为 `mode`、`elder_mode`、`child_mode`、`paused`。
- Web → Extension：PASS。
- Extension → Web：PASS。
- 跨端结果由项目负责人 Final Integration Gate 验证 PASS。

### 2. Official UI Self Scan

状态：**CLOSED**

- 官方 `UI/index.html` 已加入 `data-netguard-page="official-ui"`。
- Extension 不再自动把官方页面中“诈骗”“钓鱼”等产品说明文字判为 high。
- trusted marker 只豁免官方 UI 的自动页面扫描，不会关闭用户主动扫描。
- 用户主动点击“运行快速扫描”仍会正常调用正式 `POST /api/risk/check`。
- 跨端结果由项目负责人 Final Integration Gate 验证 PASS。

### 3. Child Fake Remaining Time

状态：**CLOSED**

- 旧固定剩余时长占位数据已经删除。
- 当前显示“今日剩余浏览：--”。
- Web 不再展示伪造的具体分钟数，也不声称掌握实时 remaining / elapsed。
- 实时浏览时长保护当前由浏览器 Extension 执行。
- `childRemainingTime` DOM 插槽继续保留，供后续 Backend Child Status API 接入真实状态。

## 当前严重级别结论

- 当前无新的 Web P0。
- 当前无新的 Web P1。
- Current Issues 中的项目全部为 P2 / 非阻断。
- Web / Extension 模式双向同步已经完成，不属于当前故障。
- 上述 Current Issues 不影响第一阶段 RC Gate。
