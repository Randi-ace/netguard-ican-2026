# SmartGuard-NetGuard 文档索引

## 文档基线与使用原则

| 项目 | 基线 |
|---|---|
| 第一阶段最终业务代码 | `87618cf` |
| RC 材料 | `5b0f18f` |
| 两条提交线的共同基线 | `f4192a0` |

`87618cf` 与 `5b0f18f` 不是祖先关系。RC 材料分支保留报告和证据，但不包含最终 Child Mode P1 业务修复。判断“当前已实现能力”时，以 `87618cf` 的代码为准；判断“测试在何时、何提交执行”时，以对应报告明确记录的执行基线为准。

文档发生冲突时，按以下优先级判断：

1. `87618cf` 中的代码、数据库脚本和测试；
2. 本索引列出的当前权威文档；
3. `docs/rc/` 中明确标注最终基线的 RC 总结与结果；
4. 其他历史设计、修复前报告和截图索引。

历史文档继续保留以便追溯，但“保留”不表示仍是当前实现契约。

## 新人入口

| 目标 | 当前入口 | 状态 |
|---|---|---|
| 了解项目和快速运行 | [`README.md`](../README.md) | 当前 |
| 配置完整本地开发环境 | [`DEVELOPMENT_SETUP.md`](DEVELOPMENT_SETUP.md) | 当前 |
| 查看 Backend API | [`backend_api.md`](backend_api.md) | 当前唯一 API 实现说明 |
| 运行自动化和手工测试 | [`testing/README.md`](testing/README.md) | 当前 |
| 初始化或迁移数据库 | [`database/README.md`](../database/README.md) | 部分需结合本文“数据库注意事项” |
| 使用 Web | [`web-user-guide.md`](web-user-guide.md) | 当前 |
| 查看最终 RC 状态 | [`rc/rc-summary.md`](rc/rc-summary.md) | 当前 RC 总结 |
| 查看最终风险测试结果 | [`rc/risk-test-report.md`](rc/risk-test-report.md) | 当前最终报告 |

## 当前实现文档

### 项目与开发

- [`README.md`](../README.md)：项目边界、架构、快速启动和正式文档入口。
- [`DEVELOPMENT_SETUP.md`](DEVELOPMENT_SETUP.md)：Python、MySQL、Backend、Web、Extension 和测试环境。
- [`CONTRIBUTING.md`](../CONTRIBUTING.md)：团队贡献流程。该文件仍含早期 master/develop 分支口径及旧文档路径，使用前应结合当前分支策略确认。
- [`CHANGELOG.md`](../CHANGELOG.md)：历史版本记录。目前尚未覆盖 `87618cf` 全部第一阶段变化，不能单独用来判断当前能力。

### Backend 与 API

- [`backend_api.md`](backend_api.md)：当前唯一 API 实现说明，覆盖正式接口、兼容接口、数据流和安全边界。
- [`ENVIRONMENT.md`](ENVIRONMENT.md)：早期环境变量参考。注意：`87618cf` 不会自动加载 `.env`，实际配置方式以 [`DEVELOPMENT_SETUP.md`](DEVELOPMENT_SETUP.md) 为准。

### 数据库

- [`database/README.md`](../database/README.md)：初始化及早期迁移流程。
- [`DATABASE_SCHEMA_v1alpha1.md`](DATABASE_SCHEMA_v1alpha1.md)：早期结构设计。该文档仍写 7 张初始化表，未完整覆盖 `url_blacklist` 和 v4 Gate，不应替代实际 SQL。
- [`DATABASE_CHANGE_RULES.md`](DATABASE_CHANGE_RULES.md)：数据库变更治理规则。

`87618cf` 的全新初始化基线为 8 张表。已有数据库的迁移还可能涉及 `database/migration/v4_gate_*`；v4 操作必须由 Backend/数据库负责人根据预检查结果执行，不能从旧文档机械推导迁移顺序。

### Web

- [`web-user-guide.md`](web-user-guide.md)：当前 Web 启动和功能使用说明。
- [`web-known-issues.md`](web-known-issues.md)：当前 Web P2 和已关闭问题。
- [`web-test-report.md`](web-test-report.md)：Web 第一阶段测试报告，实际执行基线以报告为准。
- [`web-first-stage-delivery.md`](web-first-stage-delivery.md)：第一阶段交付总结，与测试报告存在部分重复。
- [`web-screenshot-checklist.md`](web-screenshot-checklist.md)：Web RC 截图索引。

### Extension

- [`extension/tests/README.md`](../extension/tests/README.md)：早期单项测试说明。
- [`testing/README.md`](testing/README.md)：当前完整 Extension 测试入口。

当前仓库没有独立的 `extension/README.md`。安装方式、正确加载目录和 Backend 依赖暂以 [`DEVELOPMENT_SETUP.md`](DEVELOPMENT_SETUP.md) 为准。

## API 文档权威关系

| 文档 | 定位 |
|---|---|
| [`backend_api.md`](backend_api.md) | 当前实现契约，新开发和联调以此为准 |
| [`API_CONTRACT_v1alpha1.md`](API_CONTRACT_v1alpha1.md) | 历史设计契约，仅作设计演进追溯 |

历史契约中的 `check_type=text`、设置版本冲突结构、cursor 日志分页以及“不接收 event_uuid”等描述已经不符合 `87618cf`，不得用于实现新调用方。

## RC 与历史材料

### 当前最终材料

- [`rc/rc-summary.md`](rc/rc-summary.md)
- [`rc/risk-test-report.md`](rc/risk-test-report.md)
- `rc/risk-test-result.csv`
- `rc/evidence/extension/`
- `screenshots/web-rc/`

### 修复前或阶段性材料

- [`extension-rc-test-report.md`](extension-rc-test-report.md)
- [`extension-rc-screenshot-index.md`](extension-rc-screenshot-index.md)
- `extension-rc-risk-results.csv`
- [`final-integration-gate.md`](final-integration-gate.md)

上述材料没有移动或删除。其中 Extension 报告和索引主要反映 `f4192a0`/修复前状态；`final-integration-gate.md` 仍保留早期 PENDING 清单。最终 Child P1 和风险样本状态以 `rc/rc-summary.md`、`rc/risk-test-report.md` 及 `87618cf` 为准。

## 演示文档说明

[`AI_DEMO_GUIDE.md`](AI_DEMO_GUIDE.md) 是历史比赛演示材料，包含固定本机路径、已不存在的 `extension/adchacha` 路径和“语义模型”表述，不作为当前启动或能力说明。当前演示启动方式见 [`README.md`](../README.md) 和 [`DEVELOPMENT_SETUP.md`](DEVELOPMENT_SETUP.md)。

## 当前仍缺少的独立文档

以下内容尚未形成独立、已验证的正式文档，不应假定已经完成：

- 生产部署与 HTTPS/反向代理方案；
- 认证、授权、用户级数据隔离和限流；
- Extension 独立用户/开发指南；
- 完整数据库 v4 迁移操作手册；
- 发布版本号和组件版本号统一规则；
- 正式许可证文件。
