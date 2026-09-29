# 正式比赛文本风险模型

本目录随 iCAN 公开比赛版提供正式模型 `tfidf-logreg-v2-char`。

## 正式文件

- `tfidf-logreg-v2-char.joblib`：已训练的 scikit-learn Pipeline。
- `tfidf-logreg-v2-char.manifest.json`：模型版本、训练数据版本、类别顺序、运行时版本、模型 SHA-256 和验证指标。

正式启动配置：

```dotenv
AI_TEXT_MODEL_ENABLED=true
AI_TEXT_MODEL_PATH=models/ai/tfidf-logreg-v2-char.joblib
AI_MODEL_VERSION=tfidf-logreg-v2-char
AI_MIN_CONFIDENCE=0.70
AI_RULE_WEIGHT=0.40
AI_WEIGHT=0.60
```

模型路径相对于项目根目录解析；加载器还会读取同名 manifest，并核对模型哈希、类别集合和模型版本。请保持 `.joblib` 与 `.manifest.json` 配套，不要单独替换其中一个文件。

## 模型结构与输入边界

正式模型使用单路字符级 TF-IDF（2–5 字符 n-gram）与 Logistic Regression，分类集合为：

```text
normal / phishing / scam / gambling / adult / malicious
```

当前机器学习 Pipeline 主要使用网页正文 `text` 推理。`TextRiskModel` 接口保留 URL 和 title 参数，PageContext 也包含 URL、title、meta description，但这些字段当前不是 ML Pipeline 的联合训练输入；它们会参与整体上下文传递或规则分析。

预测约定：

- `ai_score = 1 - P(normal)`
- `ai_category = argmax(probability)`
- `ai_confidence = max(probability)`
- `ai_category == normal` 时二元标签为 `not_risk`，否则为 `risk`

概率列必须按已加载 Pipeline 的 `classes_` 解释，不得假定业务类别声明顺序就是概率列顺序。

## Confidence Gate 与安全降级

- `ai_confidence >= 0.70` 时，AI 才可参与 Rule + AI Fusion。
- `ai_confidence < 0.70` 时，完整采用 Rule 结果。
- 模型被禁用、文件/manifest 缺失、完整性校验失败或推理异常时，AI 明确标记为不可用并回退 Rule，不得伪造 AI 安全结果。

正式 AI 运行状态以 `TextRiskModel`、`POST /api/risk/check`、`risk_events.details.ai.available` 和 `risk_events.details.ai.model_version` 为准。

## 历史兼容提示

`backend/services/ai_service.py` 中仍保留早期 FastText 探测兼容代码。启动日志出现“未找到模型，使用关键词规则检测”指的是旧 FastText 探测，不代表本目录的正式 v2-char 模型未加载。

本比赛目录未附带 v1 模型文件，v1 不再是推荐模型。

