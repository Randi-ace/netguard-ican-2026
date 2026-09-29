# SmartGuard-NetGuard 测试入口

## 1. 测试基线

本文档中的测试清单以第一阶段最终业务代码 `87618cf` 为准。

RC 材料基线 `5b0f18f` 不包含最终 Child Mode P1 修复及 `extension/tests/child-mode-p1.test.js`。运行最终回归前，必须确认当前代码包含 `87618cf`：

```powershell
git rev-parse HEAD
git branch --contains 87618cf
```

历史报告中的 PASS/FAIL 只能说明报告记录的执行基线，不等于测试已在当前工作树重新执行。最终 RC 历史结果见 [`../rc/rc-summary.md`](../rc/rc-summary.md) 和 [`../rc/risk-test-report.md`](../rc/risk-test-report.md)。

## 2. 测试类型

| 类型 | 目录/文件 | 是否需要 Backend | 是否可能写 MySQL |
|---|---|---:|---:|
| Backend 隔离自动化 | `tests/backend/test_*.py`，不含 API smoke 的主动执行 | 否 | 否 |
| Backend API smoke | `tests/backend/test_ai_api.py` | 是 | 是，调用旧 `/ai/check` |
| Extension 自动化 | `extension/tests/*.test.js`、`tests/extension/*.test.js` | 否 | 否 |
| Web 自动化 | `tests/frontend/*.test.js` | 否 | 否 |
| Browser 手工页 | `tests/browser/*.html` | 视场景而定 | 视场景而定 |
| RC 风险样本工具 | `tests/rc/` | 是 | 是，正式风险接口会保存事件 |
| Edge 真机/站点矩阵 | Edge + Extension + Demo/网站 | 是或视用例而定 | 可能 |

不要在包含重要本地数据的数据库上直接运行会写事件的测试。需要验证写入链路时，使用明确的测试数据库或可清理的受控本地环境。

## 3. 前置环境

### Python 测试

```powershell
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Backend 隔离测试使用 `unittest` 和测试内构造的假会话/SQLite，不要求安装 pytest。

### JavaScript 测试

确认 Node.js 提供内置测试运行器：

```powershell
node --version
node --test --help
```

仓库没有 `package.json`，当前 JavaScript 测试不需要执行 `npm install`。

## 4. Backend 测试

### 4.1 隔离自动化

在项目根目录运行：

```powershell
python -m unittest discover -s tests/backend -p "test_*.py"
```

覆盖范围包括：

- URL blacklist service；
- 风险检测与可选 `event_uuid` 幂等；
- 风险/广告事件校验和幂等；
- Dashboard、趋势、风险分布和统一日志；
- v1/v3 历史迁移 SQL 静态约束；
- v4 Gate precheck、upgrade、verify 和 rollback 静态约束。

`tests/backend/test_ai_api.py` 是带 `if __name__ == "__main__"` 的外部 smoke 脚本。`unittest discover` 可能导入它，但不会主动执行其中的 HTTP 测试。

### 4.2 Backend API smoke

先按 [`../DEVELOPMENT_SETUP.md`](../DEVELOPMENT_SETUP.md) 启动 MySQL 和 Backend，并确认：

```text
GET http://127.0.0.1:5000/health
database = available
```

然后运行：

```powershell
python tests/backend/test_ai_api.py
```

注意：该脚本测试的是兼容接口 `/ai/check`，不是新开发应使用的 `/api/risk/check`；它还可能向兼容表写入测试记录。正式风险接口行为由隔离自动化、Web 快速扫描和 RC 风险样本链路覆盖。

## 5. Extension 测试

### 5.1 全量本地自动化

在支持通配符传递给 Node 测试运行器的 PowerShell/Node 环境中执行：

```powershell
node --test extension/tests/*.test.js tests/extension/*.test.js
```

如果本机 Node 版本不接受通配符，逐个执行：

```powershell
node --test extension/tests/integration.test.js
node --test extension/tests/v1.0.1-integration.test.js
node --test extension/tests/child-mode-p1.test.js
node --test tests/extension/background-risk-event.test.js
```

### 5.2 Child Mode P1 定向回归

```powershell
node --test extension/tests/child-mode-p1.test.js
```

该文件只存在于包含 `87618cf` 的最终业务代码线上。覆盖重点包括：

- Child 正文危险内容识别；
- 安全宣传/新闻描述的误报控制；
- 隐私、转账、赌博和高额游戏充值场景；
- 自定义危险关键词；
- Child Game Policy；
- 娱乐限制和学习模式组合；
- Child Mode 开关、白名单和 blocker 行为。

### 5.3 真机测试

Node 自动化不能替代 Edge 真机验证。真机回归至少检查：

- Extension 能从 `extension/` 加载；
- Reload 后状态保留；
- Service Worker 重启后配置恢复；
- Normal/Strict/Elder/Child/Paused 模式切换；
- Web 与 Extension 经 `/api/settings` 双向同步；
- Child 网站白名单；
- 风险提示、广告事件与 Dashboard 链路；
- 官方 `UI/index.html` 不被 Extension 自动页面扫描误报；
- 用户主动 Web 快速扫描仍可调用 `/api/risk/check`。

历史截图和结果只能证明其注明的提交及测试日期。不要把旧 FAIL 截图删除或改写成最终 PASS，也不要把修复前报告当成 `87618cf` 的当前结论。

## 6. Web 自动化

```powershell
node --test tests/frontend/test_settings_sync.js
```

主要覆盖：

- 四模式设置结构；
- Web 设置保存与失败回滚；
- Backend 离线时保留最近一次已知状态；
- Child 剩余时间不展示伪造分钟数；
- Official UI trusted marker 相关行为。

该测试不验证浏览器布局、Chart.js CDN 或真实 Backend 数据链路。Web 人工验证需通过静态服务器访问：

```powershell
python -m http.server 8080 --bind 127.0.0.1
```

```text
http://127.0.0.1:8080/UI/index.html
```

## 7. Browser 手工测试页

`tests/browser/` 中的 HTML 文件用于特定 Extension/页面行为检查，不是统一自动化套件：

```text
test-elder-mode.html
test-risk-page.html
test_elder.html
test_full_loop.html
test_mode.html
test_popup.html
```

通过根目录静态服务器访问，例如：

```text
http://127.0.0.1:8080/tests/browser/test_full_loop.html
```

运行前记录：代码提交、Edge 版本、Extension 版本、Backend/数据库状态、测试 URL、预期与实际结果。

## 8. RC 风险样本工具

`tests/rc/run_risk_samples.py` 会调用：

```text
POST http://127.0.0.1:5000/api/risk/check
```

成功检测会写入 `risk_events`，因此该工具不是只读测试。使用前必须：

1. 确认当前代码基线；
2. 使用受控测试数据库；
3. 记录数据库初始状态；
4. 确认样本 CSV 与报告适用基线；
5. 不覆盖或重写现有 `docs/rc/` 材料。

当前 RC 材料是历史验收记录。本阶段文档工程化更新不重新生成、不移动也不修改这些材料。

## 9. 建议的本地回归顺序

```text
确认代码包含 87618cf
        ↓
安装 Python 依赖并确认 Node 测试运行器
        ↓
Backend 隔离自动化
        ↓
Extension 全量 + Child P1
        ↓
Web 自动化
        ↓
启动 MySQL、Backend 和静态服务
        ↓
Web / Extension / API 人工联调
        ↓
仅在受控数据库执行写入型 smoke 或 RC 样本
```

## 10. 结果记录要求

任何新测试报告至少记录：

- 实际执行的完整 Git commit；
- 测试日期和操作系统；
- Python、Node、Edge 和 MySQL 版本；
- 执行命令；
- Backend 与数据库是否启动；
- 是否写入数据库；
- PASS/FAIL/NOTE 数量；
- 失败项和复现步骤；
- 证据路径；
- 测试是在原提交执行，还是通过无差异证明沿用历史证据。

不得把材料整理提交写成业务执行提交，也不得把旧基线的测试结果直接改标为 `87618cf`。
