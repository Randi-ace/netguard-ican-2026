# 净网护航 Web 第一阶段最终测试报告

## 一、报告基线与验证来源

- 原 RC 文档形成基线：`feature/rc-materials`，Commit `e540cb8`
- Web RC 历史执行基线：`integration/backend-extension-week1-2`，Commit `f4192a0`
- 当前 Web RC 文档分支：`feature/frontend-rc-materials`
- 本轮前端材料审计基线：`8dc2fcf`
- 项目后续 Final Integration 代码基线：`87618cf`；`f4192a0` 至 `87618cf` 期间 Web UI 业务代码未发生相关变化，现有 Web RC 证据继续有效。
- Web 历史实测：保留第一阶段基于 `f4192a0` 已经完成的 Web 实机验证记录。
- 本地 Frontend automated：基于 Web RC 历史执行基线 `f4192a0` 执行。
- 跨端最终结果：引用项目负责人 Final Integration Gate 的验证结论，不表述为本轮 Web 人员重新实测。

## 二、Dashboard

| 测试项 | 操作/场景 | 预期结果 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| 今日风险 | Backend 正常时打开 Dashboard | 展示正式接口返回数量 | 正确展示真实数据 | PASS |
| 广告拦截 | 查看 Dashboard KPI | 展示正式接口返回数量 | 正确展示真实数据 | PASS |
| AI 检测 | 查看 Dashboard KPI | 展示正式接口返回数量 | 正确展示真实数据 | PASS |
| URL 检测 | 查看 Dashboard KPI | 展示正式接口返回数量 | 正确展示真实数据 | PASS |
| 高风险 | 查看 Dashboard KPI | 展示正式接口返回数量 | 正确展示真实数据 | PASS |
| 真实 0 | 接口字段返回 0 | 页面显示 0，不替换为 Mock 或占位值 | 正确显示 0 | PASS |
| Loading | Dashboard 正在请求正式 Backend 数据 | 显示明确加载状态 | 正确显示 Loading | PASS |
| Empty | 正式接口无可展示记录 | 显示明确空状态，不伪造业务数据 | 正确显示 Empty | PASS |
| Error | 停止 Flask 后触发刷新 | KPI 显示“—”并显示错误状态 | 正确显示 Error | PASS |
| Mock fallback | Backend 请求失败 | 不回退正式 Mock 数据 | 未出现 Mock fallback | PASS |
| Backend 恢复 | 重新启动 Flask 并刷新 | 恢复 Backend 真实 KPI 与记录 | 真实数据恢复 | PASS |
| 30 秒刷新 | 页面保持运行并观察周期请求 | 每 30 秒触发数据刷新 | 周期刷新正常 | PASS |

说明：Dashboard 数据请求失败时 KPI 显示“—”属于业务数据区 Error 行为，不代表设置模式被清空或自动回到 Normal。

## 三、AI 快速扫描

历史实测 URL：`https://example.com/login`

| 测试项 | 操作/场景 | 预期结果 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| 扫描请求 | 提交实际测试 URL | 调用正式 `POST /api/risk/check` | 请求成功完成 | PASS |
| 风险等级 | 查看扫描响应 | 正确展示接口返回的风险等级 | 高风险 | PASS |
| 风险分数 | 查看扫描响应 | 正确展示 Backend 返回分数 | 0.9 | PASS |
| 风险原因 | 查看扫描响应 | 正确展示 Backend 返回原因 | 检测到钓鱼网站特征 | PASS |
| 数据入库 | 扫描成功后检查记录 | 扫描记录进入数据库 | 已进入数据库 | PASS |
| 联动刷新 | 扫描成功后查看各数据区域 | Dashboard、最近事件、风险日志和图表更新 | 均随后更新 | PASS |

测试时 Backend 明确提示“未找到模型，使用关键词规则检测”。因此，高风险、0.9 和“检测到钓鱼网站特征”是该次关键词规则检测的接口返回，不代表真实 AI 模型推理能力。Web 侧验证范围是正式 `POST /api/risk/check` 请求、结果展示、记录入库和后续数据刷新闭环。

## 四、风险日志

| 测试项 | 操作/场景 | 预期结果 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| records | 加载风险日志 | 正确渲染返回记录 | 正确展示 | PASS |
| pagination | 翻页并检查页码和总数 | 正确消费分页字段 | 页码、总数和总页数正确 | PASS |
| page_size | 检查分页请求 | 正式日志每页请求 20 条 | `page_size=20` | PASS |
| 最近 3 条共享请求 | 刷新并检查 Network | Dashboard 与安全概览共享一次请求 | 每轮仅请求一次 | PASS |
| Loading | 风险日志请求处理中 | 显示明确加载状态 | 正确显示 Loading | PASS |
| Empty | 接口返回空记录 | 显示明确空状态 | 正确显示 Empty | PASS |
| Error / Retry | 日志接口请求失败 | 显示 Error 并提供重试 | 错误与重试状态可用 | PASS |
| null 风险等级 | 查看广告事件 | `risk_level=null` 显示“不适用” | 正确显示“不适用” | PASS |

## 五、数据分析

| 测试项 | 操作/场景 | 预期结果 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| 风险分布 | 进入数据分析页 | 展示正式风险分布 | 正确展示 | PASS |
| AI 识别统计 | 核对图表状态与正式 overview 数据绑定 | 使用正式 AI 检测数量，状态分支完整 | 已完成代码审计；未将其记录为独立数值实测 | 代码检查通过 |
| 近 7 天趋势 | 查看趋势图 | 展示正式日期及风险/广告数据 | 正确展示 | PASS |
| 事件分析 | 查看事件分析图 | 展示正式趋势数据 | 正确展示 | PASS |
| 隐藏期间刷新 | 离开页面后执行新风险扫描 | 后台数据完成刷新 | 新风险数据已产生 | PASS |
| 重新进入 | 再次进入数据分析页 | 图表展示隐藏期间产生的新数据 | 从 2026-08-30 更新并出现 2026-08-31 数据 | PASS |
| Chart 实例 | 多次切换和刷新 | 不重复积累实例 | 旧实例安全销毁后重建 | PASS |

## 六、安全概览

| 测试项 | 操作/场景 | 预期结果 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| KPI | 进入安全概览 | 展示正式统计数据 | 正确展示 | PASS |
| 累计防护统计 | 查看柱状图 | 使用正式 KPI 数据 | 正确展示 | PASS |
| 近期安全记录 | 查看记录列表 | 使用最近 3 条正式日志 | 正确展示 | PASS |
| 报告图表 | 直接进入和重复切换页面 | 正常初始化且不重复创建 | 正常工作 | PASS |
| PDF | 查看导出入口 | 明确说明尚未开放 | 已标注“开发中”并禁用 | PASS |

## 七、Network 与 Console

### Network

| 测试项 | 操作/场景 | 预期结果 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| Dashboard 概览 | 检查每轮请求 | `overview` 返回 200 | 200 | PASS |
| 7 天趋势 | 检查每轮请求 | `trend?days=7` 返回 200 | 200 | PASS |
| 风险分布 | 检查每轮请求 | `risk-distribution` 返回 200 | 200 | PASS |
| 最近记录 | 检查每轮请求 | `risk?page=1&page_size=3` 返回 200 | 200 | PASS |
| 正式日志 | 检查第一页请求 | `risk?page=1&page_size=20` 返回 200 | 200 | PASS |
| 请求去重 | 检查最近 3 条请求数量 | 每轮只请求一次 | 每轮一次 | PASS |
| 请求入口 | 检查 Network 发起位置 | 统一由 `api.js` 发起 | 发起位置统一 | PASS |

### Console

| 测试项 | 操作/场景 | 预期结果 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| 运行时异常 | 刷新并操作核心页面 | 无明显 Uncaught、TypeError、ReferenceError、Unhandled Promise | 未发现明显的上述异常 | PASS |

## 八、Web 异常与恢复

### Flask 关闭

| 测试项 | 操作/场景 | 预期结果 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| Dashboard KPI | 停止 Flask 后刷新 | KPI 显示“—” | 正确显示“—” | PASS |
| Dashboard 状态 | 停止 Flask 后刷新 | 显示 Error | 正确显示 Error | PASS |
| 数据分析 | 进入数据分析页 | 四个区域均显示 Error | 均显示加载失败 | PASS |
| 安全概览 | 进入安全概览 | KPI、图表、近期记录显示 Error | 正确显示 Error | PASS |
| Mock 回退 | 检查失败后的数据区域 | 不回退 Mock | 未出现 Mock | PASS |
| 状态优先级 | Error 后切换页面 | Error 不被 Empty 覆盖 | 保持 Error | PASS |

### Flask 恢复

| 测试项 | 操作/场景 | 预期结果 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| KPI 恢复 | 重新启动 Flask 并刷新 | 恢复真实 KPI | 已恢复 | PASS |
| 记录恢复 | 查看最近事件和风险日志 | 恢复真实记录 | 已恢复 | PASS |

## 九、响应式

| 测试项 | 操作/场景 | 预期结果 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| 1366 桌面 | 1366px 左右宽度访问核心页面 | 页面可操作，无明显错位 | 可用 | PASS |
| 常规桌面宽屏 | 静态检查响应式布局规则 | 不存在明确阻断布局 | 未发现明确静态阻断；不作为 1920px 实机测试记录 | 代码检查通过 |
| KPI | 检查卡片排列 | 无明显重叠 | 无明显重叠 | PASS |
| AI 扫描 | 检查完整表单 | 输入和按钮完整可用 | 完整可用 | PASS |
| 左侧栏 | 检查 Dashboard 导航 | 不遮挡正文 | 未遮挡 | PASS |
| 日志表格 | 缩窄页面宽度 | 支持横向滚动 | 横向滚动可用 | PASS |

## 十、Frontend Automated

Web RC 历史执行基线 `f4192a0` 的本地 Frontend automated 结果：

```text
20 passed / 0 failed
```

仓库内可确认的测试文件与执行命令：

```text
tests/frontend/test_settings_sync.js
node --test tests/frontend/test_settings_sync.js
```

结论：**PASS**。

## 十一、最终设置与模式状态

正式 Settings 共享字段：

- `mode`
- `elder_mode`
- `child_mode`
- `paused`

正式模式：

- Normal
- Strict
- Elder
- Child

正式规则：

- Elder 与 Child 互斥；
- Paused 独立于当前活动模式，不会把当前模式重置为 Normal；
- 模式优先级为 `Child > Elder > Strict > Normal`。

| 项目 | 最终状态 | 验证来源 |
| --- | --- | --- |
| Normal | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Strict | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Elder | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Child | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Paused | PASS | 项目负责人 Final Integration Gate 验证 PASS |

上述跨端模式最终状态引用项目负责人 Final Integration Gate 结论，不表述为本轮 Web 人员重新实测。原有 Web 历史实测中，Normal → Strict 保存、刷新后保持、正式 GET/POST `/api/settings` 以及保存失败回滚均已通过。

## 十二、Web 与 Extension 双向同步

当前正式链路：

```text
Web
↕
Backend /api/settings
↕
Extension
```

双向同步共享 `mode`、`elder_mode`、`child_mode`、`paused` 四个字段。

| 项目 | 最终状态 | 验证来源 |
| --- | --- | --- |
| Web → Extension sync | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Extension → Web sync | PASS | 项目负责人 Final Integration Gate 验证 PASS |

Web 设置不是仅供展示的平台原型，Extension 本地状态也不是跨端设置的唯一依据。Web 与 Extension 通过 Backend `/api/settings` 共享并同步正式设置。

## 十三、Backend Offline Preserve

最终已验证行为：

```text
已有 Strict / Elder / Child 等最近已知模式
→ Backend 临时离线
→ Web 保留最近一次已知模式
→ 页面显示设置同步异常
```

Web 不会因为临时接口失败清空已有模式，也不会自动回到 Normal。

| 项目 | 最终状态 | 验证来源 |
| --- | --- | --- |
| Backend offline preserve | PASS | 项目负责人 Final Integration Gate 验证 PASS |

## 十四、最终 CLOSED 项

### Official UI self-scan：CLOSED

官方 `UI/index.html` 已在根 `<html>` 元素加入：

```html
data-netguard-page="official-ui"
```

Extension trusted UI 判断会豁免官方页面的自动页面文本 AI Scan，不再因为官方产品说明中出现“诈骗”“钓鱼”等文字而自动判定为 high。

该豁免只针对 Extension 对官方 UI 的自动页面文本扫描。用户主动点击 Web“运行快速扫描”仍会正常调用正式 `POST /api/risk/check`，两条路径互不混淆。

最终状态：**CLOSED**。由项目负责人 Final Integration Gate 验证 PASS。

### Child fixed remaining placeholder：CLOSED

旧固定剩余时长占位数据已经删除。当前 UI 展示：

```text
今日剩余浏览：--
```

当前 Web 不声称掌握真实儿童剩余浏览时长；浏览时长保护由浏览器 Extension 实时执行。`childRemainingTime` DOM 插槽继续保留，供后续家庭管理 Backend 的 Child Status API 接入真实状态。

最终状态：**CLOSED**。该状态由本地 Frontend automated 覆盖，并由项目负责人 Final Integration Gate 确认。

## 十五、最终 PASS / CLOSED 矩阵

| 项目 | 最终状态 | 验证来源 |
| --- | --- | --- |
| 本地 Frontend automated | 20 passed / 0 failed | 本地 Frontend automated，Web RC 历史执行基线 `f4192a0` |
| Dashboard | PASS | Web 第一阶段已有历史实测 |
| Risk Logs | PASS | Web 第一阶段已有历史实测 |
| Data Analysis | PASS | Web 第一阶段已有历史实测 |
| AI Quick Scan | PASS | Web 第一阶段已有历史实测 |
| Normal | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Strict | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Elder | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Child | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Paused | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Web → Extension sync | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Extension → Web sync | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Backend offline preserve | PASS | 项目负责人 Final Integration Gate 验证 PASS |
| Official UI self-scan | CLOSED | 项目负责人 Final Integration Gate 验证 PASS |
| Child fixed remaining placeholder | CLOSED | 本地 Frontend automated / 项目负责人 Final Integration Gate |

## 十六、最终结论

- Web 第一阶段最终测试状态：**PASS**。
- 本地 Frontend automated：**20 passed / 0 failed**。
- 未发现新增 P0 / P1。
- Web RC 历史实测和本地 Frontend automated 基于 `f4192a0`；原 RC 文档形成基线为 `e540cb8`，本轮前端材料审计基线为 `8dc2fcf`。
- 项目后续 Final Integration 代码基线为 `87618cf`；期间 Web UI 业务代码未发生相关变化，现有 Web RC 证据继续有效，且未将历史测试表述为在 `87618cf` 上重新执行。
- Web 与 Extension 的模式、双向同步、Backend offline preserve 和 Official UI self-scan 等跨端最终结果引用项目负责人 Final Integration Gate，不表述为本轮 Web 人员重新实测。
