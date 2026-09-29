# 净网护航第一阶段 Extension RC 测试报告

本报告用于 `feature/extension-rc-materials` 分支的 Extension RC 签字材料。原始实机测试执行于 `f850476`；第一阶段冻结基线为 `f4192a0`。经差异核对，这两个提交在 `extension/` 与 `tests/extension/` 范围内没有 tracked 文件差异，因此前一轮 50 条本地可控 Demo、模式切换、生命周期和网站矩阵结果可继续作为有效证据。本轮在 RC 材料基线 `e540cb8` 上完成自动化复跑，本轮调整前材料 HEAD 为 `eead402`，本轮材料补件审计基线为 `655beec`，并按正式 `tests/samples/risk-samples.csv` 重整 RISK-036 至 RISK-045；逐条广告/负样本字段归档在 `tests/samples/ad-samples.csv`。

## 1 测试范围

- Extension 自动化回归
- 30 条广告正样本与 20 条正常负样本
- Normal、Strict、Elder、Child 模式与切换
- CSDN、淘宝、B站、百度网站矩阵
- Extension Reload、Service Worker 重启、白名单
- RISK-036 至 RISK-040 Extension E2E
- RISK-041 至 RISK-045 Child Mode
- 误杀与已知问题整理

## 2 测试环境与代码基线

| 项目 | 记录 |
| --- | --- |
| 测试日期 | 2026-09-18 |
| 操作系统 | Windows |
| 浏览器 | Microsoft Edge 153.0.4234.32 |
| 扩展 | 智能广告拦截和儿童模式 2.4.1，Manifest V3 |
| 原始插件开发版本 | `f850476` |
| 第一阶段冻结代码基线 | `f4192a0` |
| RC 材料基线 | `e540cb8` |
| 本轮材料 HEAD（调整前） | `eead402` |
| 本轮材料补件审计基线 | `655beec` |
| 材料分支 | `feature/extension-rc-materials` |

执行以下核对命令均无输出：

```text
git diff --name-status f850476 f4192a0 -- extension
git diff --name-status f850476 f4192a0 -- tests/extension
```

结论：不得把历史实测 Commit 直接改写成 `f4192a0`；应同时保留实际执行基线与冻结基线，并以无 tracked 差异作为证据。

## 3 Extension 自动化结果

执行命令：

```text
node --test extension\tests\*.test.js tests\extension\*.test.js
```

结果：

- 本地 Extension 自动化回归：`96 PASS / 0 FAIL`
- `background-risk-event`：`18 PASS / 0 FAIL`
- 上述本地 Node 测试合计：`114 PASS / 0 FAIL`，进程退出码为 0

## 4 50 条广告与负样本

该组样本是在项目本地可控广告 Demo 中执行的测试单元，不是 50 个公网真实网站。

| 类型 | 数量 | Normal | Strict | 误杀 |
| --- | ---: | --- | --- | ---: |
| 广告或推广正样本 | 30 | 30/30 PASS | 30/30 PASS | 不适用 |
| 正常元素负样本 | 20 | 20/20 PASS | 20/20 PASS | 0 |
| 合计 | 50 | 50/50 PASS | 50/50 PASS | 0 |

负样本覆盖登录二维码、验证码、搜索框、普通图片、视频播放器、导航栏、商品卡片、普通推荐内容和页面功能按钮。逐条记录已归档在 `tests/samples/ad-samples.csv`（历史实测日期 2026-09-09、Edge 152.0.4191.66、执行基线 `f850476`），批量结果截图为 `BATCH-BOTH-001.png`。当前样本表没有独立的普通 iframe 负样本，因此本报告不声明该项覆盖；历史数据也未改写成冻结基线。

## 5 CSDN 淘宝 B站 百度矩阵

前一轮实机矩阵在 `f850476` 执行；因 Extension 范围与 `f4192a0` 无 tracked 差异，功能结果仍有效。本轮已在 Edge 153.0.4234.32 上补充四站原始页面截图。结果按截图中的实际页面表现记录，不将可见广告或残留容器改写为通过。

| 网站 | Normal | Strict | 刷新 | 主要功能与误杀 | 本轮原始截图 |
| --- | --- | --- | --- | --- | --- |
| CSDN | FAIL | PASS | PASS | Normal 仍显示广告占位框；Strict 广告区域收起；主要内容可用 | `SITE-CSDN-001.png`、`SITE-CSDN-STRICT-001.png` |
| 淘宝 | PASS | PASS | PASS | 搜索、商品区域和导航正常，未见明显误杀 | `SITE-TAOBAO-001.png`、`SITE-TAOBAO-STRICT.png` |
| B站 | PASS | PASS | PASS | 两种模式页面表现一致；登录弹窗及推荐内容可用 | `SITE-BILIBILI-001.png` |
| 百度 | FAIL | FAIL | PASS | 两种模式均仍显示带“广告”标识的推广结果；搜索功能正常 | `SITE-BAIDU-001.png` |

## 6 模式与生命周期

| 项目 | 前一轮实机结果 | 本轮自动化覆盖 | 本轮截图 |
| --- | --- | --- | --- |
| Normal | PARTIAL | PASS | 模式启用 PASS；CSDN Normal 与百度仍有广告或占位残留 |
| Strict | 部分通过 | PASS | CSDN 通过；百度推广结果仍可见 |
| Elder | PASS | PASS | 已归档，页面字体和控件明显放大 |
| Child | 模式可启用，规则存在缺陷 | PASS | 已归档；开关和规则项正常显示，正式风险样本 0 PASS / 4 FAIL / 1 RETEST_REQUIRED |
| Normal 到 Strict | PASS | PASS | CSDN 对比截图已归档 |
| Child 到 Normal | PASS | PASS | 模式切换可用 |
| Child 到 Elder | PASS | PASS | Elder 与 Child 独立截图已归档 |
| Child 设置持久化 | PASS | PASS | 自定义关键词保存后仍显示在配置框中 |
| Extension Reload | PASS | PASS | 已归档；Reload 后扩展仍启用且加载路径正确 |
| Service Worker 重启 | PASS | PASS | 已归档；控制台显示 Service Worker 启动与配置初始化完成 |
| 白名单 | PASS | PASS | `WHITELIST-CONFIG-001.png` 显示 Child 白名单含 `csdn.net`；`WHITELIST-RESULT-001.png` 显示 CSDN 在 Child 模式下可访问 |

上述 114 项本地 Node 测试已覆盖模式归一化、存储持久化、Reload、Service Worker 重建、白名单门控以及 Child Mode 规则。实机结果表明自动化通过不等于站点规则全部有效：百度推广过滤和 Child Mode 正式文本处理仍存在差异。

## 7 RISK-036 至 RISK-045 正式样本

本节仅采用 `tests/samples/risk-samples.csv` 的正式定义。上一轮临时映射结果只作为附加验证材料，不计入正式 PASS 数量，也不得回填项目负责人维护的 `docs/rc/risk-test-result.csv`。

| 范围 | 类型 | 正式状态 | 说明 |
| --- | --- | --- | --- |
| RISK-036 至 RISK-040 | Extension E2E | 4 PASS / 1 RETEST_REQUIRED | RISK-036 至 039 证据闭环。RISK-040 现有 `TASK-E-RISK-EVENTS-001.json` 仅记录 2026-09-10 的旧 API/落库/Dashboard 证据，不能证明本轮 Edge E2E，需定向复测 |
| RISK-041 至 RISK-045 | Child Mode | 0 PASS / 4 FAIL / 1 RETEST_REQUIRED | RISK-041 的 `fake_gambling.html` 通过 URL 或 `data-danger-type` 触发，不能证明正式正文被识别；RISK-042 至 044 正式人工构造文本未被处理；RISK-045 自定义危险关键词未生效 |

正式逐条字段见 `extension-rc-risk-results.csv` 与独立结果表。RISK-036 至 RISK-039 保留现有可追溯的 Edge、API、RiskEvent 与 Dashboard 证据。RISK-040 原材料中不可追溯的事件编号和 event_uuid 已撤回；现有 JSON 只支持旧记录 163（medium，执行提交 `f850476`），且文件明确注明不构成完整 Edge E2E，因此该项改为 `RETEST_REQUIRED`。RISK-041 的现有截图仅证明 URL/页面元数据触发阻断，不证明正式正文检测，改为 `RETEST_REQUIRED`。RISK-042 至 RISK-045 未产生 RiskEvent，数据库与 Dashboard 字段按 N/A 记录。

## 8 误杀情况

- 20 条正常负样本误杀数：0。
- 四站搜索、导航、商品区和主要内容未发现明显误杀。
- Elder 模式按预期放大字体和控件，不计为误杀。
- B站截图存在站点自身登录弹窗，不属于扩展误杀。

## 9 已知问题

### Current P1

- **P1**：Child Mode 正式正文样本与策略存在核心缺陷。RISK-041 需在中性 URL 页面按正式正文复测；RISK-042 至 RISK-045 未触发预期处理；`child_game_demo.html` 在 Child Mode 且“娱乐内容限制”开启时仍可直接访问。该项阻断正式 RC 放行。

### Current P2

- **P2**：百度搜索结果中的推广内容在 Normal 和 Strict 下均仍显示，广告过滤未达到预期。
- **P2**：CSDN Normal 仍保留广告占位框；Strict 可正常收起该区域。
- **P2**：RISK-039 页面提示持续时间较短；已有同页截图与可追溯记录。
- **P2**：RISK-040 缺少本轮完整 Edge E2E 证据，当前状态为 `RETEST_REQUIRED`。

### Legacy / P2

| 编号 | 类型 | 描述 | 影响 | 处理 |
| --- | --- | --- | --- | --- |
| SG-CUR-001 | Legacy API / P2 | 旧版 `POST /url/check` 在数据库不可用时异常处理不完整，可能返回 HTTP 500 | 当前 Extension 与 Web 正式业务链路不调用该接口；正式采集入口为 `POST /api/risk/check` | 记录后进入 RC，第二阶段随 Legacy API 下线计划统一处理 |

### Resolved Issues

| 编号 | 描述 | 状态 |
| --- | --- | --- |
| SG-CSDN-001 | CSDN Strict 广告边框曾偶发残留 | 本轮 Strict 已恢复；Normal 仍有占位框 |

## 10 最终结论

本地 Extension 自动化回归为 `96 PASS / 0 FAIL`，`background-risk-event` 为 `18 PASS / 0 FAIL`，上述本地 Node 测试合计 `114 PASS / 0 FAIL`；50 条本地可控 Demo 为 30 条广告正样本与 20 条正常负样本，Normal 与 Strict 均为 50/50 PASS，正常负样本误杀 0。Reload、Service Worker、Elder、模式切换和白名单证据已完成。RISK-036 至 RISK-039 证据闭环；RISK-040 为 `RETEST_REQUIRED`。

材料已按现有证据收敛，但功能 Gate 仍被 Child Mode P1 阻断：百度 Normal/Strict 推广过滤失败，CSDN Normal 残留广告占位框，Child Mode 为 0 PASS / 4 FAIL / 1 RETEST_REQUIRED。待业务代码最小修复并完成 RISK-040、RISK-041 定向复测后，再更新 RC 放行结论。独立结果不直接修改 `docs/rc/risk-test-result.csv`，由项目负责人统一回填最终风险测试结果和 RC 报告。
