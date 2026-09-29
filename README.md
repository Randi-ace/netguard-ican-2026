# 净网护航 SmartGuard-NetGuard（iCAN 公开比赛版）

## 项目简介

净网护航是一套面向 Windows、Microsoft Edge 和本地受控环境的浏览器安全防护演示系统。它把 Edge 浏览器插件、Flask 后端、规则引擎、字符级文本分类模型、MySQL 风险事件和可视化 Dashboard 串成一条可复现链路：

## 比赛评审快速入口

“净网护航”不是单一 AI 文本分类项目，而是由 **Edge 浏览器插件 + 广告拦截 + URL 风险检测 + 网页风险识别 + Rule + AI 可信融合 + 风险提示 + 老人模式 + 儿童模式 + Flask 后端 + MySQL + Dashboard** 组成的完整浏览器安全防护系统。

完成下文的后端、插件和静态服务启动步骤后，评委第一推荐入口是完整功能演示中心：

<http://127.0.0.1:8080/demos/demo_center.html>

该入口集中展示项目的主要产品模块。位于 `demos/ai/context/` 的五个页面是 **AI 风险识别专项验证场景**，用于复现 Rule + AI 风险识别链路，不代表整个项目的全部功能。

## 系统架构

```text
Edge 插件
  └─ 采集 PageContext（URL、title、meta、有限正文）
       └─ POST /api/risk/check
            └─ Flask Backend
                 ├─ URL / 黑名单 / 内容规则（Rule）
                 ├─ TextRiskModel（字符级 TF-IDF + Logistic Regression）
                 ├─ Confidence Gate + Risk Fusion
                 └─ MySQL risk_events
                      └─ Dashboard / 风险日志
```

本项目用于本地比赛演示与安全教育，不是生产级反诈骗平台，也不应直接暴露到公网。

## 核心功能

- Edge Manifest V3 插件：采集有限页面上下文、调用后端检测，并展示风险提醒或 URL 阻断页。
- 统一风险接口：`POST /api/risk/check`，输出 `safe / low / medium / high` 四级结果。
- Rule + AI：规则结果与高置信文本模型结果融合；低置信或不可用的 AI 不参与融合。
- MySQL 事件链路：成功检测写入 `risk_events`，Dashboard 从正式事件表读取统计与日志。
- 完整演示中心：集中展示广告拦截、URL 风险、网页风险、老人模式、儿童模式和 Dashboard；另提供 AI 风险识别专项五场景。
- Dashboard：查看风险概览、趋势、风险等级分布和最近事件。

## 当前已实现主要能力

| 能力 | 当前实现 |
|---|---|
| 广告拦截 | Edge 插件识别并拦截页面广告，记录广告拦截事件。 |
| URL 风险检测 | 对 URL 黑名单和高风险 URL 特征进行检测，并可进入扩展阻断页。 |
| 网页风险识别 | 插件提取经过过滤和长度限制的 PageContext，调用正式风险接口完成页面检测。 |
| AI 可信融合 | 字符级 TF-IDF + Logistic Regression 结果经过 Confidence Gate 后，才可与 Rule 结果进行 Risk Fusion。 |
| 风险提示 | 插件根据 `safe / low / medium / high` 结果展示对应提示或高风险阻断。 |
| 老人模式 | 已实现面向老年用户的页面可读性增强和风险提醒演示。 |
| 儿童模式 | 已实现学习网站放行、娱乐/游戏限制和危险网站拦截等本地策略演示。 |
| 风险事件记录 | 正式检测结果写入 MySQL `risk_events`，广告事件写入 `ad_events`。 |
| Dashboard | 展示风险概览、趋势、风险等级分布和最近安全事件。 |
| 插件→后端→数据库→Web 完整闭环 | Edge 插件调用 Flask，Rule + AI 完成检测，MySQL 保存事件，Web Dashboard 查询并展示结果。 |

## 推荐评审顺序

1. **完整演示中心**：访问 <http://127.0.0.1:8080/demos/demo_center.html>，先了解完整产品能力。
2. **典型风险场景**：在演示中心体验广告拦截、URL 风险拦截和网页风险提示。
3. **老人/儿童模式**：分别查看 Elder 老人模式与 Child 儿童模式的交互和本地策略。
4. **Dashboard**：访问 <http://127.0.0.1:8080/UI/index.html> 并点击“个人中心”，查看后端与数据库形成的事件结果。
5. **AI 专项五场景**：最后访问 <http://127.0.0.1:8080/demos/ai/context/>，复现 Rule + AI、Confidence Gate 和 URL 阶段阻断。
6. **源码关键目录**：结合下面的源码导览核对插件、后端、模型、数据库、Web 和 Demo 的实现边界。

## 源码导览

| 路径 | 作用 |
|---|---|
| `extension/` | Edge Manifest V3 插件，包含广告拦截、页面上下文采集、风险提示以及老人/儿童模式等浏览器端能力。 |
| `backend/` | Flask 应用、正式 API、规则检测、风险融合、事件持久化和 Dashboard 数据接口。 |
| `backend/services/text_risk_model.py` | 正式 `TextRiskModel` 适配层，负责 v2-char 模型加载、完整性校验、推理与不可用降级。 |
| `models/ai/` | 正式 `tfidf-logreg-v2-char` 模型、manifest 和模型说明。 |
| `database/` | MySQL 初始化及历史兼容说明；正式事件表包括 `risk_events` 和 `ad_events`。 |
| `UI/` | Web 管理端与 Dashboard，读取后端统计、趋势和风险日志接口。 |
| `demos/` | 完整功能演示中心及广告、URL、老人、儿童、Dashboard、AI 等本地演示资源。 |
| `demos/ai/context/` | AI 风险识别专项验证场景；五页用于复现 Rule + AI 链路，不代表项目全部功能。 |

`tfidf-logreg-v1` 仅作为历史兼容与自动化回归测试 artifact 保留；
当前正式比赛运行模型为 `tfidf-logreg-v2-char`。

## 正式比赛版本

| 项目 | 冻结值 |
|---|---|
| 源码基线 commit | `da4393bcf677d4d350bd66a9b808d2acebb6eafd` |
| 源码基线 tag | `v1.3-v2-char-e2e-pass` |
| 正式模型版本 | `tfidf-logreg-v2-char` |
| 模型文件 | `models/ai/tfidf-logreg-v2-char.joblib` |
| 模型 manifest | `models/ai/tfidf-logreg-v2-char.manifest.json` |
| 正式风险接口 | `POST /api/risk/check` |

本比赛目录是从上述稳定版本导出的无 Git 历史源码副本；版本信息用于标识可复现基线，不要求评委初始化 Git。

## 环境要求

- Windows 10 或 Windows 11
- Microsoft Edge（支持“加载解压缩的扩展”）
- Python 3.12
- MySQL 5.7.26 或与现有 SQL/SQLAlchemy 用法兼容的 MySQL 环境
- 可选：可访问公网 CDN 的网络（仅影响 Dashboard 的 Chart.js 图表和在线字体）

下面所有 PowerShell 命令都假定当前目录是本项目根目录。

## 快速启动

### 1. 创建 Python 3.12 虚拟环境

先确认本机已安装 Python 3.12：

```powershell
py -3.12 --version
```

然后创建并激活虚拟环境：

```powershell
py -3.12 -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
python --version
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

激活后 `python --version` 应显示 Python 3.12.x。

运行自动化测试时安装开发依赖：

```powershell
python -m pip install -r requirements-dev.txt
```

### 2. 创建空 MySQL 数据库

评委只需创建一个空的 `net_guard` 数据库：

```powershell
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS net_guard CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

如果本机未配置 `mysql` 命令行，也可以使用 MySQL Workbench、phpMyAdmin 或其他 MySQL 管理工具创建同名空数据库 `net_guard`。

随后在下一步设置自己的 MySQL 用户名和密码。后端连接到这个空数据库后，会自动初始化运行所需的数据表；启动后通过 `/health` 确认 `database=available`。请勿用同名命令覆盖已有业务数据库；已有旧库的兼容说明见 `database/README.md`。

### 3. 在 PowerShell 显式设置正式配置

`.env.example` 只是配置模板，当前程序不会自动加载 `.env`。推荐在启动后端的同一个 PowerShell 会话中显式设置环境变量：

```powershell
$env:MYSQL_HOST = "127.0.0.1"
$env:MYSQL_PORT = "3306"
$env:MYSQL_USER = "root"
$env:MYSQL_PASSWORD = "你的本地 MySQL 密码"
$env:MYSQL_DB = "net_guard"
$env:SECRET_KEY = "仅用于本地比赛环境的随机字符串"

$env:AI_TEXT_MODEL_ENABLED = "true"
$env:AI_TEXT_MODEL_PATH = "models/ai/tfidf-logreg-v2-char.joblib"
$env:AI_MODEL_VERSION = "tfidf-logreg-v2-char"
$env:AI_MIN_CONFIDENCE = "0.70"
$env:AI_RULE_WEIGHT = "0.40"
$env:AI_WEIGHT = "0.60"
```

不要把真实数据库密码、Token、API Key 或其他 secret 写入源码和提交材料。

### 4. 启动 Flask 后端

保持上述 PowerShell 会话，进入 `backend` 后使用唯一推荐的正式启动命令：

```powershell
cd backend
python -m flask --app app run --host=127.0.0.1 --port=5000 --no-debugger --no-reload
```

该命令显式关闭 debugger 和 reloader，适合比赛演示。`python backend/app.py` 与 `python start_backend.py` 仅属于历史/开发便利入口，可能启用 debug/reloader，不作为正式推荐方式。

### 5. 检查 `/health`

另开 PowerShell：

```powershell
Invoke-RestMethod http://127.0.0.1:5000/health
```

浏览器也可访问：<http://127.0.0.1:5000/health>。

预期 `status` 为 `healthy`，并且 `database` 为 `available`。若数据库显示 `unavailable`，Flask 进程可能仍可响应，但 `/api/risk/check` 的事件持久化、Dashboard 和日志链路不能视为就绪。

### 6. 加载 Edge 插件

1. 在 Edge 打开 `edge://extensions/`。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择本项目根目录下的 `extension` 文件夹；该目录下应直接存在 `manifest.json`。
5. 确认后端仍运行在 `http://127.0.0.1:5000`。

### 7. 启动本地 Demo 与 Dashboard 静态服务

另开 PowerShell，回到项目根目录执行：

```powershell
python -m http.server 8080 --bind 127.0.0.1 --directory .
```

完整演示中心（评委第一推荐入口）：<http://127.0.0.1:8080/demos/demo_center.html>

AI 风险识别专项验证入口：<http://127.0.0.1:8080/demos/ai/context/>

Dashboard 入口：<http://127.0.0.1:8080/UI/index.html>

打开 Dashboard 入口后，点击顶部“个人中心”进入正式 Dashboard。前端默认请求 `http://127.0.0.1:5000`；不要直接双击 HTML 文件作为正式启动方式。

## 正式 AI 配置与能力

### AI 在系统中的定位

AI 是完整浏览器安全防护系统中的**风险识别增强模块**，不是独立于其他模块的最终裁决器。当前正式模型为字符级 TF-IDF + Logistic Regression；最终风险判断还包括 URL/内容规则检测、Confidence Gate 和 Risk Fusion。系统不把 AI 描述为大模型或深度语义理解能力，不声称 AI 能独立识别所有诈骗，也没有把 BERT/MacBERT 投入本正式比赛版本。

正式模型 `tfidf-logreg-v2-char` 是 scikit-learn Pipeline，使用字符级 TF-IDF（2–5 字符 n-gram）和 Logistic Regression。在线模型输出分类：

```text
normal / phishing / scam / gambling / adult / malicious
```

正式配置为：

```dotenv
AI_TEXT_MODEL_ENABLED=true
AI_TEXT_MODEL_PATH=models/ai/tfidf-logreg-v2-char.joblib
AI_MODEL_VERSION=tfidf-logreg-v2-char
AI_MIN_CONFIDENCE=0.70
AI_RULE_WEIGHT=0.40
AI_WEIGHT=0.60
```

当前机器学习模型主要使用网页正文 `text` 作为推理输入。URL、title、meta 会参与整体 PageContext 传递和规则分析，但不能表述为当前 ML 模型的联合训练输入。

Confidence Gate 规则：

- AI 置信度达到 `0.70` 时，才允许按 Rule `0.40`、AI `0.60` 参与融合；强规则证据仍保留下限保护。
- AI 置信度低于 `0.70` 时，AI 不参与最终融合，完整采用 Rule 结果。
- AI 被禁用、模型/manifest 缺失、校验失败或推理异常时，`TextRiskModel` 明确标记为不可用并回退 Rule；系统不得把“AI 不可用”伪造成 AI 判定安全。

正式公开风险等级只有：`safe / low / medium / high`。

## AI 风险识别专项验证场景

五个稳定验证页面全部位于 `demos/ai/context/`：

| 顺序 | 页面 | 正式预期 | 说明 |
|---:|---|---|---|
| 1 | `normal.html` | `safe / 0.05` | 普通安全页面 |
| 2 | `anti_fraud_education.html` | `medium / 0.65` | 含风险词的反诈教育语境 |
| 3 | `fake_refund.html` | `high / 0.95` | 最终 high 主要来自 Rule |
| 4 | `fake_prize.html` | `high / 0.95` | 最终 high 主要来自 Rule |
| 5 | `phishing.html` | URL 阶段 `high / 0.90` | 只证明 URL 阶段阻断，建议最后演示 |

访问方式：先打开 <http://127.0.0.1:8080/demos/ai/context/>，再依次点击页面。所有页面都是本地虚构的安全测试页面，不连接真实诈骗、支付或账号系统，也不提交真实表单。

这五页只用于复现 Rule + AI 风险识别链路，是完整演示中心之后的专项验证材料，不代表“净网护航”的全部产品功能。

重要说明：

- 页面中的“预期”文字是已有历史测试 fixture 的内容，不代表当前模型能力声明。
- `fake_refund.html` 和 `fake_prize.html` 的最终 high 主要来自 Rule；当前 v2-char 在这两个页面上的置信度低于 `0.70`，Confidence Gate 会拒绝低可信 AI 参与最终融合。
- `phishing.html` 会在 URL 阶段触发扩展阻断页，因此只证明 URL 阶段阻断，不代表正文模型独立完成识别。建议把它放在五场景最后；需要重新进入列表时，直接再次访问 Demo 入口。
- Demo 的 context 入口页同时包含“诈骗、退款、中奖、钓鱼”等场景文字，插件可能把入口页本身判为 `medium / 0.65`。入口页不是五个正式验收场景之一。

更集中的现场说明见 `demos/ai/context/README.md`。

## Dashboard

保持后端、MySQL 和根目录静态服务都在运行，然后访问：

```text
http://127.0.0.1:8080/UI/index.html
```

点击“个人中心”后可查看概览、趋势、风险分布和最近安全事件。Dashboard 的数据来自后端正式接口及 `risk_events` / `ad_events`。页面图表依赖公网 `Chart.js` CDN；离线或 CDN 不可达时图表可能无法渲染，但这不等同于后端检测链路失败。页面还引用了在线字体，断网时浏览器会回退到本地字体。

## 自动化测试

安装开发依赖后，在项目根目录执行：

```powershell
python -m pytest -q
```

比赛冻结版本的自动化测试全部通过。测试数量可能随 pytest 收集口径或本地环境显示不同；以“全部通过”和失败详情为判断依据，不在此改写比赛材料中已经冻结的统计数字。

## 隐私说明

- 插件采集 URL、title、meta description 和经过长度限制的有限正文，用于本地风险检测。
- 页面采集会过滤密码框、输入框、文本域和可编辑区域，避免把用户正在编辑的敏感内容纳入正文上下文。
- 默认后端地址为本机 `127.0.0.1:5000`，不要求用户上传账号密码。
- 五个 Demo 全部使用本地合成数据，不连接真实诈骗、支付或账号系统。
- `risk_events` 主要保存检测结果、URL、必要的风险分析信息与 AI 可用性/版本快照。
- 系统不以长期保存完整网页正文作为主要设计；部署或二次开发时仍应根据适用法律、组织政策和数据最小化原则复核日志保留策略。

## 能力边界

- 本系统使用轻量字符级 TF-IDF + Logistic Regression，不是大模型，也不具备通用深度语义理解能力。
- 不声称 AI 能独立识别所有诈骗；最终结果依赖 URL、规则、模型置信门控和融合策略。
- BERT、MacBERT 等模型未投入本正式比赛系统。
- 本地 Demo 用于验证固定安全场景和端到端链路，不等于开放互联网环境的准确率承诺。
- 当前环境没有正式登录鉴权、完整多用户隔离或生产级部署加固，不应直接暴露到公网。
- 自动检测可能出现误报或漏报，结果只能作为风险提示，不能代替人工核验、执法判断或金融机构的官方确认。

## 常见问题

### 后端能启动，但 Dashboard 没有数据

先访问 `/health`，确认 `database=available`；再确认 MySQL 中存在正式表，并通过插件或正式接口完成过检测。成功的 `/api/risk/check` 会写入 `risk_events`。

### 模型文件存在，为什么 AI 仍不可用

确认六项 AI 环境变量是在启动 Flask 的同一个 PowerShell 会话中设置，尤其是 `AI_TEXT_MODEL_ENABLED=true`。模型路径相对项目根目录解析，并需要同名 `.manifest.json`；模型哈希、类别或版本校验失败时会安全降级。

### 为什么退款或中奖场景不是由 AI 主导

这两个页面上 v2-char 的置信度低于 `0.70`。Confidence Gate 按设计拒绝低可信 AI，最终 high 主要来自 Rule。这是在演示“安全降级”，不是模型独立识别能力证明。

### 为什么 Demo 入口页会提示 medium

入口页同时列出多个风险场景词，可能被判为 `medium / 0.65`；它只是导航页，不在五个正式验收场景中。

### 为什么钓鱼场景打开后不能返回列表

该页面用于验证 URL 阶段阻断，会跳转到扩展阻断页。把它作为最后一项，或重新访问 <http://127.0.0.1:8080/demos/ai/context/>。

### Dashboard 图表空白或报错

确认可以访问 Chart.js CDN，同时检查浏览器控制台和后端 Dashboard API。CDN 失败只影响图表渲染；风险检测与数据库是否正常应分别通过 `/health` 和 API 验证。

### PowerShell 激活虚拟环境被阻止

只在当前终端临时允许脚本，然后重新激活：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

## 历史兼容说明

- `backend/services/ai_service.py` 仍保留早期 FastText 模型探测兼容代码，不应删除。
- 启动日志中的“未找到模型，使用关键词规则检测”来自旧 FastText 兼容探测，不代表正式 `tfidf-logreg-v2-char` 未加载。
- 正式 AI 状态应以 `TextRiskModel`、`POST /api/risk/check`，以及 `risk_events.details.ai.available` 和 `risk_events.details.ai.model_version` 为准。
- 旧接口 `POST /ai/check` 如仍存在，仅为 legacy 兼容入口；新调用必须使用 `POST /api/risk/check`。
- `python backend/app.py`、`python start_backend.py` 和其他组合启动脚本属于历史/开发便利入口；比赛正式演示统一使用本文的 Flask CLI 命令。

## 发布说明

本比赛仓库由正式稳定版本导出并重新初始化为独立公开仓库，不包含原开发仓库的历史提交记录。

公开发布时不包含 `.env`、虚拟环境、本地缓存、数据库备份、真实密码、Token、API Key 或其他本机敏感信息。
