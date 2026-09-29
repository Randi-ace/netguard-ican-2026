# Extension RC 截图与证据清单

清单按最新 RC 要求登记真实 Edge 页面截图及必要的结构化补充证据。截图文件与补充证据会一并归档到 `docs/rc/evidence/extension/`；不把本地合成矩阵或说明页冒充公网实机截图。

| 编号 | 网站或项目 | 日期 | 模式 | 基线 | 用途 | 证据文件 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SITE-CSDN-001 | CSDN 首页 | 2026-09-18 | Normal | f4192a0 等价范围 | 广告过滤与页面布局 | `SITE-CSDN-001.png` | FAIL；广告占位框残留 |
| SITE-CSDN-001-S | CSDN 首页 | 2026-09-18 | Strict | f4192a0 等价范围 | 广告过滤与页面布局 | `SITE-CSDN-STRICT-001.png` | PASS；广告区域收起 |
| SITE-TAOBAO-001 | 淘宝首页 | 2026-09-18 | Normal / Strict | f4192a0 等价范围 | 页面功能与误杀 | `SITE-TAOBAO-001.png`、`SITE-TAOBAO-STRICT.png` | PASS；两种模式均可用 |
| SITE-BILIBILI-001 | B站首页 | 2026-09-18 | Normal / Strict | f4192a0 等价范围 | 页面功能与误杀 | `SITE-BILIBILI-001.png` | PASS；两种模式表现一致 |
| SITE-BAIDU-001 | 百度手机搜索结果 | 2026-09-18 | Normal / Strict | f4192a0 等价范围 | 搜索推广过滤 | `SITE-BAIDU-001.png` | FAIL；两种模式仍显示带“广告”标识的推广结果 |
| MODE-NORMAL-001 | CSDN 首页 | 2026-09-18 | Normal | f4192a0 等价范围 | 模式结果 | `MODE-NORMAL-001.png` | 模式启用：PASS；CSDN 广告过滤效果：FAIL；综合：PARTIAL |
| MODE-STRICT-001 | CSDN 首页 | 2026-09-18 | Strict | f4192a0 等价范围 | 模式结果 | `MODE-STRICT-001.png` | PASS |
| MODE-ELDER-001 | CSDN 首页 | 2026-09-18 | Elder | f4192a0 等价范围 | 老人模式生效 | `MODE-ELDER-001.png` | PASS |
| MODE-CHILD-001 | CSDN 首页与 Child 设置 | 2026-09-18 | Child | f4192a0 等价范围 | Child 开关与规则项 | `MODE-CHILD-001.png` | 模式可启用；正式风险样本 0 PASS / 4 FAIL / 1 RETEST_REQUIRED |
| LIFECYCLE-RELOAD-001 | Edge 扩展详情页 | 2026-09-18 | 当前模式 | e540cb8 | Reload 后扩展状态 | `LIFECYCLE-RELOAD-001.png` | PASS；扩展启用且路径正确 |
| LIFECYCLE-SW-001 | 扩展 Service Worker DevTools | 2026-09-18 | 当前模式 | e540cb8 | Service Worker 启动 | `LIFECYCLE-SW-001.png` | PASS；控制台显示启动与初始化完成 |
| BATCH-BOTH-001 | 50 条本地可控广告与负样本 | 2026-09-09 | Normal / Strict | f850476 | 批量结果与误杀统计 | `BATCH-BOTH-001.png` | PASS；50/50，正常负样本误杀 0 |
| WHITELIST-CONFIG-001 | Child 设置 | 2026-09-18 | Child | e540cb8 | 白名单配置 | `WHITELIST-CONFIG-001.png` | PASS；Child 模式已开启，白名单包含 `csdn.net` |
| WHITELIST-RESULT-001 | CSDN 首页 | 2026-09-18 | Child | e540cb8 | 白名单结果 | `WHITELIST-RESULT-001.png` | PASS；CSDN 在 Child 模式下可访问；需与配置截图成对审计 |
| RISK-036 | phishing-demo | 2026-09-18 | Extension E2E | e540cb8 | URL 风险拦截 | `RISK-036-PHISHING-BLOCK.png` | PASS |
| RISK-037 | high.html | 2026-09-18 | Extension E2E | e540cb8 | 95% 高风险弹窗 | `RISK-037-HIGH-RISK-95.png` | PASS |
| RISK-038 | demo_scam.html | 2026-09-18 | Extension E2E | e540cb8 | 高风险案例提示 | `RISK-038-SCAM-HIGH-95.png` | PASS |
| RISK-039 | demo_scam.html 转账区域 | 2026-09-18 | Extension E2E | e540cb8 | 账号验证诱导 | `RISK-039.png` | PASS；与 RISK-038 同页截图捕获案例 2 |
| RISK-040 | demo_scam.html 客服退款区域 | 2026-09-18 | Extension E2E | 待复测 | 完整 Edge E2E 闭环 | `TASK-E-RISK-EVENTS-001.json` | RETEST_REQUIRED；现有 JSON 仅含 2026-09-10 旧 API/落库/Dashboard 记录 163，不构成本轮 Edge E2E 证据 |
| RISK-041 | fake_gambling.html | 2026-09-18 | Child | 待复测 | 正式正文识别 | `RISK-041-CHILD-GAMBLING-BLOCK.png` | RETEST_REQUIRED；现有页面通过 URL 或 `data-danger-type` 触发，不能证明正文识别 |
| RISK-042 | 正式人工构造文本 | 2026-09-18 | Child | e540cb8 | 隐私诱导处理 | `RISK-042-CHILD-NOT-BLOCKED.png` | FAIL |
| RISK-043 | 正式人工构造文本 | 2026-09-18 | Child | e540cb8 | 高额充值诱导处理 | `RISK-043-CHILD-NOT-BLOCKED.png` | FAIL |
| RISK-044 | 正式人工构造文本 | 2026-09-18 | Child | e540cb8 | 私下转账诱导处理 | `RISK-044-CHILD-NOT-BLOCKED.png` | FAIL |
| RISK-045 | 自定义关键词 RISK-045 | 2026-09-18 | Child | e540cb8 | 自定义危险关键词规则 | `RISK-045-CHILD-CUSTOM-KEYWORD-NOT-BLOCKED.png` | FAIL |
