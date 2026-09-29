# 净网护航 Web 使用说明

## 一、运行环境

- Windows
- Python
- MySQL
- 项目根目录下的 `requirements.txt`
- Flask 后端：`127.0.0.1:5000`
- Web 静态服务：`127.0.0.1:8080`

## 二、首次运行

在项目根目录创建虚拟环境：

```powershell
python -m venv .venv
```

如果 PowerShell 禁止脚本执行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

激活虚拟环境：

```powershell
.\.venv\Scripts\Activate.ps1
```

安装依赖：

```powershell
pip install -r requirements.txt
```

提前启动 MySQL，并确认项目数据库连接配置可用。

启动后端：

```powershell
python start_backend.py
```

正常应看到：

```text
Running on http://127.0.0.1:5000
```

另开一个终端启动 Web 静态服务。此步骤只要求该终端中有可用的 Python，不要求必须激活项目虚拟环境：

```powershell
python -m http.server 8080 --bind 127.0.0.1
```

浏览器访问：

```text
http://127.0.0.1:8080/UI/index.html
```

## 三、页面与功能

- 首页：顶部主导航中的“首页”，用于查看净网护航产品介绍，并可通过“开始体验”进入个人中心。
- 个人中心：承载控制台首页、风险日志、安全概览、家庭管理、模式选择、数据分析等入口。
- 控制台首页 / Dashboard：个人中心侧栏入口名称为“首页”，页面标题为“控制台首页”；用于查看今日风险、广告拦截、AI 检测、URL 检测、高风险数量和最近安全事件。
- AI 快速扫描：位于控制台首页。输入 URL，可选填页面文本，点击“运行快速扫描”，即可提交正式风险检测请求并查看风险等级、分数和原因。
- 风险日志：查看分页风险与广告事件记录；支持上一页、下一页以及请求失败后的“重试”。
- 安全概览：查看累计 KPI、累计防护统计和近期安全记录。
- 数据分析：查看累计风险分布、AI 识别统计、近 7 天趋势和事件分析。
- 模式选择：进入正式模式设置区域，读取和保存普通、严格、老人、儿童模式及暂停防护设置；保存按钮名称为“保存设置”。

## 四、正式模式语义

当前正式模式和 UI 名称对应如下：

| 正式名称 | UI 名称 | 说明 |
| --- | --- | --- |
| Normal | 普通模式 | 在日常体验与防护之间保持平衡 |
| Strict | 严格模式 | 使用更严格的拦截与风险提示策略 |
| Elder | 老人模式 | 提供大字体、高对比和更强的风险提示 |
| Child | 儿童模式 | 使用学习优先、娱乐内容限制和浏览时长保护策略 |
| Paused | 暂停防护 | 独立的暂停状态，不是第五种活动模式 |

模式规则：

- Elder 与 Child 互斥，不能同时作为活动模式。
- Paused 独立于当前活动模式。
- 开启或关闭 Paused 不会把当前活动模式改回 Normal。
- 当输入状态存在冲突时，模式优先级为 `Child > Elder > Strict > Normal`。

## 五、Web 与 Extension 双向同步

当前正式设置链路：

```text
Web
↕
Backend /api/settings
↕
Extension
```

Web、Backend 与 Extension 共享以下字段：

- `mode`
- `elder_mode`
- `child_mode`
- `paused`

Web 修改并保存设置后，可以同步到 Extension；Extension 修改模式后，也可以通过 Backend 同步回 Web。双向同步已经完成，跨端结果由项目负责人 Final Integration Gate 验证 PASS。

## 六、Backend 临时离线与恢复

如果 Web 已经取得 Strict、Elder、Child 等最近一次已知模式，Backend 暂时离线时：

- Web 保留最近一次已知模式；
- 页面显示设置同步异常；
- 不清空已有模式；
- 不自动恢复为 Normal。

Backend 恢复后，Web 会继续通过 `/api/settings` 同步最新状态。

如果首次进入设置页面时从未成功取得过任何设置，页面会显示设置加载失败和“重试”，不会凭空创建 Normal 状态。

## 七、Child 当前状态

儿童模式预览当前显示：

```text
今日剩余浏览：--
```

这表示当前 Web 不声称掌握实时儿童剩余浏览分钟数。当前浏览时长保护由浏览器 Extension 实时执行。

页面继续保留 `childRemainingTime` DOM 插槽。后续家庭管理平台接入 Backend Child Status API 后，再由真实数据展示 elapsed / remaining。

## 八、Official UI trusted marker

官方 `UI/index.html` 已在根 `<html>` 元素加入 trusted marker：

```html
data-netguard-page="official-ui"
```

Extension 的 trusted UI 判断不再自动扫描官方 UI 页面自身的产品说明文字，避免“诈骗”“钓鱼”等说明词被误判为 high。

该自动扫描豁免不会影响用户主动使用 Web 的“运行快速扫描”。用户主动扫描仍会正常调用正式 `POST /api/risk/check`。

## 九、Error 与恢复行为

- Dashboard 请求失败时显示 Error，正式数据区不会回退 Mock。
- 风险日志请求失败时显示 Error，并提供“重试”。
- 数据分析请求失败时，对应图表组件显示 Error。
- 设置同步失败时显示同步异常；如果已有最近一次已知模式，则继续保留该模式。
- Error 与 Empty 是不同状态，Error 不会被 Empty 覆盖。
- Backend 恢复后，Dashboard、风险日志、数据分析和设置会重新请求并恢复或同步正式状态。

## 十、常见问题

1. `No module named flask`

   激活 `.venv`，然后执行：

   ```powershell
   pip install -r requirements.txt
   ```

2. `Activate.ps1` 禁止运行

   在当前 PowerShell 进程中执行：

   ```powershell
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   ```

3. 数据库连接失败

   检查 MySQL 是否启动，并核对数据库端口及项目配置。

4. Dashboard 显示加载失败

   检查 Flask 后端是否正在 `127.0.0.1:5000` 运行。

5. 图表组件加载失败

   检查当前网络是否能够加载 Chart.js CDN 资源，然后刷新页面。
