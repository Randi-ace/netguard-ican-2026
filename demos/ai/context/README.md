# Edge 五场景本地演示说明

本目录中的 HTML/CSS 是既有历史测试 fixture。所有页面均为本地虚构安全内容，不连接真实诈骗、支付或账号系统，也不提交真实表单。页面内已有的“预期”文字属于历史 fixture，不代表当前模型能力声明。

## 启动

在项目根目录运行：

```powershell
python -m http.server 8080 --bind 127.0.0.1 --directory .
```

确认 Flask 后端运行于 `http://127.0.0.1:5000`，Edge 已加载项目的 `extension` 目录，然后访问：

<http://127.0.0.1:8080/demos/ai/context/>

## 正式验收顺序

| 顺序 | 页面 | 正式预期 | 验证重点 |
|---:|---|---|---|
| 1 | `normal.html` | `safe / 0.05` | 正常页面放行 |
| 2 | `anti_fraud_education.html` | `medium / 0.65` | 反诈教育语境 |
| 3 | `fake_refund.html` | `high / 0.95` | high 主要来自 Rule |
| 4 | `fake_prize.html` | `high / 0.95` | high 主要来自 Rule |
| 5 | `phishing.html` | URL 阶段 `high / 0.90` | URL 阶段阻断；建议最后演示 |

`fake_refund.html` 和 `fake_prize.html` 上，当前 v2-char 的置信度低于 `0.70`。Confidence Gate 会拒绝低可信 AI 参与最终融合，因此最终 high 主要来自 Rule。这是安全降级行为，不应宣传为 AI 独立识别。

`phishing.html` 会跳转至扩展阻断页，只证明 URL 阶段阻断。若需回到列表，直接再次访问：

<http://127.0.0.1:8080/demos/ai/context/>

## 入口页注意事项

context 入口页同时包含诈骗、退款、中奖、钓鱼等场景文字，插件可能把入口页本身判为 `medium / 0.65`。入口页只是导航，不属于五个正式验收场景。

