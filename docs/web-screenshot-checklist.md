# 净网护航 Web RC 最终截图清单

## 基线

- RC 文档分支：`feature/frontend-rc-materials`
- 原 RC 文档形成基线：`feature/rc-materials`，Commit `e540cb8`
- Web RC 历史执行分支：`integration/backend-extension-week1-2`
- Web RC 历史执行基线：`f4192a0`
- 本轮前端材料审计基线：`8dc2fcf`
- 项目后续 Final Integration 代码基线：`87618cf`

## 截图状态原则

本清单中的 16 个 PNG 已实际归档到 `docs/screenshots/web-rc/`，并已逐项确认文件存在。所有截图拍摄日期为 2026-09-18，Web RC 历史执行基线为 `f4192a0`。项目后续推进到 `87618cf`，但期间 Web UI 业务代码未发生相关变化，因此现有截图证据继续有效；这些截图不表述为在 `87618cf` 上重新拍摄。

## 最终截图清单

| 编号 | 页面/状态 | 证明内容 | 日期 | 业务 Commit | 截图文件 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | 官网首页 | “净网护航”正式品牌；首页正常加载 | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/01-home.png` | 已归档 | — |
| 02 | Dashboard | 正式 Backend KPI；真实 0 正确显示；页面正常且无 Error | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/02-dashboard.png` | 已归档 | — |
| 03 | 风险日志 | 正式风险记录；高风险等级；URL、原因、时间及分页状态 | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/03-risk-logs.png` | 已归档 | — |
| 04 | 数据分析 | 风险分布正常绘制；近 7 天趋势；事件分析；AI 统计 Empty 状态正常；无 Error | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/04-data-analysis.png` | 已归档 | — |
| 05 | AI 快速扫描 | 用户主动点击“运行快速扫描”；`/api/risk/check` Web 闭环正常；扫描结果展示；新记录进入最近安全事件 | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/05-ai-quick-scan.png` | 已归档 | 当前 Backend 未加载模型，测试结果来自关键词规则检测；该截图证明 Web/API 闭环，不证明真实 AI 模型推理效果 |
| 06 | Normal 普通模式 | Normal / 普通模式选中；Elder、Child、Paused 均关闭 | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/06-mode-normal.png` | 已归档 | — |
| 07 | Strict 严格模式 | Strict / 严格模式选中；其他模式开关关闭 | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/07-mode-strict.png` | 已归档 | — |
| 08 | Elder 老人模式 | Elder 开启；Child 关闭；老人模式页面效果正常 | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/08-mode-elder.png` | 已归档 | — |
| 09 | Child 儿童模式 | Child 开启；Elder 自动关闭；Elder / Child 互斥；学习模式状态正常 | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/09-mode-child.png` | 已归档 | — |
| 10 | Child “--”状态 | 显示“今日剩余浏览：--”；旧固定剩余时长占位数据已删除；当前浏览时长保护由 Extension 执行；Web 不声明掌握真实 remaining | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/10-child-remaining-empty.png` | 已归档 | — |
| 11 | Paused 暂停防护 | Child 仍开启且 Paused 同时开启；Paused 独立；活动模式未改回 Normal | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/11-mode-paused.png` | 已归档 | — |
| 12 | Backend 离线保留模式 | Backend 离线后显示设置同步失败和最近一次已知状态；Child、Paused 仍开启；状态未清空且未回到 Normal | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/12-backend-offline-preserve.png` | 已归档 | 该截图证明 Web 页面离线保留行为；跨端结果由项目负责人 Final Integration Gate 验证 PASS |
| 13 | Dashboard Error | KPI 显示“—”；Dashboard 显示 Error；不回退 Mock；页面结构稳定 | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/13-dashboard-error.png` | 已归档 | — |
| 14 | Backend 恢复 | Backend 恢复；同步异常提示消失；Child / Paused 状态保持；Web 恢复同步 | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/14-backend-recovery.png` | 已归档 | — |
| 15 | 1366px 布局 | 实际 viewport 为 1366 × 768，DPR 为 1；页面无明显重叠、遮挡或横向布局崩坏 | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/15-layout-1366.png` | 已归档 | — |
| 16 | 960px 布局 | 实际 viewport 为 960 × 768，DPR 为 1；窄桌面布局触发；无明显文字重叠或控件遮挡 | 2026-09-18 | `f4192a0` | `docs/screenshots/web-rc/16-layout-960.png` | 已归档 | 960px 仍属于已知 P2 的人工冒烟记录，不表示响应式完全无问题 |

## 跨端结果说明

截图包没有重新拍摄 Extension 端画面。以下跨端结果继续引用项目负责人 Final Integration Gate：

- Web → Extension sync：PASS
- Extension → Web sync：PASS
- Backend offline preserve：PASS；截图 12 仅直接证明 Web 页面离线保留行为
- Official UI self-scan：CLOSED

上述跨端最终状态均由项目负责人 Final Integration Gate 验证 PASS，不表述为本轮 Web 人员重新完成 Extension 端深度联调。

## 截图登记要求

每张截图已经登记：

- 编号
- 页面或状态
- 证明内容
- 拍摄日期 2026-09-18
- 业务 Commit `f4192a0`
- 真实相对文件路径
- 已归档状态
- 必要备注

## 归档目录

截图已统一归档到：

```text
docs/screenshots/web-rc/
```

## 截图总结

- RC Web 截图：16 / 16 已归档
- 拍摄日期：2026-09-18
- Web RC 历史执行基线：`f4192a0`
- 归档目录：`docs/screenshots/web-rc/`
- 1366 × 768：已完成
- 960 × 768：已完成
- 未发现截图阶段新增 P0 / P1
- 960px 细节继续作为非阻断 P2 记录
- 跨端最终结果引用项目负责人 Final Integration Gate
