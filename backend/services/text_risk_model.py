import hashlib
import json
import logging
import math
import threading
from numbers import Real
from pathlib import Path

from config import Config


logger = logging.getLogger(__name__)


class TextRiskModel:
    """算法无关的文本风险模型懒加载适配层。"""

    CATEGORIES = {
        'normal',
        'phishing',
        'scam',
        'gambling',
        'adult',
        'malicious',
    }

    def __init__(
        self,
        enabled=None,
        model_path=None,
        model_version=None,
        manifest_path=None,
        loader=None,
    ):
        self.enabled = (
            Config.AI_TEXT_MODEL_ENABLED
            if enabled is None
            else bool(enabled)
        )
        self.model_path = Path(
            model_path
            if model_path is not None
            else Config.AI_TEXT_MODEL_PATH
        )
        self.manifest_path = Path(
            manifest_path
            if manifest_path is not None
            else self.model_path.with_suffix('.manifest.json')
        )
        self.model_version = (
            model_version
            if model_version is not None
            else Config.AI_MODEL_VERSION
        )
        self._loader = loader or self._joblib_load
        self._model = None
        self._classes = None
        self._load_attempted = False
        self._unavailable = False
        self._load_lock = threading.Lock()

    def predict(self, url: str, title: str, text: str):
        """返回契约结果；任何不可用或异常情况都明确降级。"""
        if not self.enabled or self._unavailable:
            return self._unavailable_result()

        model = self._get_or_load_model()
        if model is None:
            return self._unavailable_result()

        try:
            # TF-IDF LR v1 currently consumes text only. url/title are
            # preserved by this interface for future model versions.
            raw_result = self._predict_with_pipeline(model, text)
            return self._normalize_result(raw_result)
        except Exception as exc:
            # 推理错误中可能携带输入内容，因此日志只记录异常类型。
            logger.warning(
                'TextRiskModel 推理失败，已安全降级（%s）',
                type(exc).__name__,
            )
            self._disable_loaded_model()
            return self._unavailable_result()

    def _get_or_load_model(self):
        if self._load_attempted:
            return self._model

        with self._load_lock:
            if self._load_attempted:
                return self._model

            self._load_attempted = True
            try:
                if not self.model_path.is_file():
                    logger.info('TextRiskModel 模型文件不存在，AI 不可用')
                    return None
                if not self.manifest_path.is_file():
                    logger.info('TextRiskModel manifest 不存在，AI 不可用')
                    return None
                self._model = self._load_model()
            except Exception as exc:
                # 不输出异常消息，避免第三方加载器把敏感信息带入日志。
                logger.warning(
                    'TextRiskModel 加载失败，已安全降级（%s）',
                    type(exc).__name__,
                )
                self._model = None
                self._classes = None

            return self._model

    def _load_model(self):
        manifest = self._load_manifest()
        manifest_classes = self._validate_manifest(manifest)
        self._validate_artifact_hash(manifest)

        model = self._loader(self.model_path)
        self._classes = self._validate_model(model, manifest_classes)
        return model

    def _load_manifest(self):
        with self.manifest_path.open('r', encoding='utf-8') as handle:
            manifest = json.load(handle)
        if not isinstance(manifest, dict):
            raise ValueError('manifest 必须是 JSON 对象')
        return manifest

    def _validate_manifest(self, manifest):
        manifest_version = manifest.get('model_version')
        if (
            not isinstance(manifest_version, str)
            or not manifest_version
            or manifest_version != self.model_version
        ):
            raise ValueError('manifest 模型版本不匹配')

        manifest_classes = manifest.get('classes')
        if (
            not isinstance(manifest_classes, list)
            or not manifest_classes
            or any(
                not isinstance(category, str) or not category
                for category in manifest_classes
            )
        ):
            raise ValueError('manifest classes 非法')
        return list(manifest_classes)

    def _validate_artifact_hash(self, manifest):
        artifact = manifest.get('artifact')
        expected_hash = (
            artifact.get('sha256')
            if isinstance(artifact, dict)
            else None
        )
        if (
            not isinstance(expected_hash, str)
            or len(expected_hash) != 64
        ):
            raise ValueError('manifest Artifact SHA-256 非法')
        if self._sha256_file(self.model_path) != expected_hash.lower():
            raise ValueError('Artifact SHA-256 不匹配')

    def _validate_model(self, model, manifest_classes):
        if not callable(getattr(model, 'predict_proba', None)):
            raise ValueError('模型不支持 predict_proba')

        try:
            classes = [str(category) for category in model.classes_]
        except (AttributeError, TypeError) as exc:
            raise ValueError('模型 classes_ 非法') from exc

        if classes != manifest_classes:
            raise ValueError('模型 classes_ 与 manifest 不一致')
        if len(classes) != len(self.CATEGORIES) or set(classes) != self.CATEGORIES:
            raise ValueError('模型 classes_ 不符合类别契约')
        if 'normal' not in classes:
            raise ValueError('模型 classes_ 缺少 normal')
        return classes

    def _predict_with_pipeline(self, model, text):
        probability_rows = list(model.predict_proba([text]))
        if len(probability_rows) != 1:
            raise ValueError('predict_proba 必须返回单行概率')

        probabilities = list(probability_rows[0])
        if self._classes is None or len(probabilities) != len(self._classes):
            raise ValueError('predict_proba 概率列数与 classes_ 不一致')

        normalized_probabilities = [
            self._validated_probability(value)
            for value in probabilities
        ]
        if not math.isclose(
            sum(normalized_probabilities),
            1.0,
            rel_tol=1e-6,
            abs_tol=1e-6,
        ):
            raise ValueError('predict_proba 概率和不等于 1')

        class_indexes = {
            category: index
            for index, category in enumerate(self._classes)
        }
        best_index = max(
            range(len(normalized_probabilities)),
            key=normalized_probabilities.__getitem__,
        )
        normal_probability = normalized_probabilities[
            class_indexes['normal']
        ]

        return {
            'ai_available': True,
            'ai_score': 1.0 - normal_probability,
            'ai_category': self._classes[best_index],
            'ai_confidence': normalized_probabilities[best_index],
            'ai_reasons': [],
        }

    @staticmethod
    def _joblib_load(path):
        # 延迟导入，确保 import service 不会立即加载 Runtime 或 Artifact。
        import joblib

        return joblib.load(path)

    @staticmethod
    def _sha256_file(path):
        digest = hashlib.sha256()
        with path.open('rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                digest.update(chunk)
        return digest.hexdigest()

    def _disable_loaded_model(self):
        with self._load_lock:
            self._model = None
            self._classes = None
            self._unavailable = True

    def _normalize_result(self, result):
        if not isinstance(result, dict):
            raise ValueError('模型结果必须是字典')
        if result.get('ai_available', True) is not True:
            raise ValueError('模型未返回可用结果')

        score = self._validated_score(result.get('ai_score'))
        confidence = self._validated_score(result.get('ai_confidence'))
        category = result.get('ai_category')
        if category not in self.CATEGORIES:
            raise ValueError('模型返回了非法类别')

        reasons = result.get('ai_reasons')
        if (
            not isinstance(reasons, list)
            or len(reasons) > 3
            or any(
                not isinstance(reason, str) or len(reason) > 120
                for reason in reasons
            )
        ):
            raise ValueError('模型返回了非法原因列表')
        if not isinstance(self.model_version, str) or not self.model_version:
            raise ValueError('模型版本不能为空')

        return {
            'ai_available': True,
            'ai_score': score,
            'ai_category': category,
            'ai_confidence': confidence,
            'ai_reasons': list(reasons),
            'model_version': self.model_version,
        }

    @staticmethod
    def _validated_probability(value):
        if isinstance(value, bool) or not isinstance(value, Real):
            raise ValueError('模型返回了非法概率')
        probability = float(value)
        if not math.isfinite(probability) or not 0.0 <= probability <= 1.0:
            raise ValueError('模型返回了越界概率')
        return probability

    @staticmethod
    def _validated_score(value):
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not 0.0 <= value <= 1.0
        ):
            raise ValueError('模型返回了非法分数')
        return float(value)

    @staticmethod
    def _unavailable_result():
        # 不提供伪造的 0 分；AI 不可用不代表页面安全。
        return {'ai_available': False}


text_risk_model = TextRiskModel()
