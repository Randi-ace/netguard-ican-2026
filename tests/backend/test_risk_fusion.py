import math
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy.orm import declarative_base


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# 允许本文件独立运行，不连接或修改开发者的真实数据库。
if 'db' not in sys.modules:
    fake_db = types.ModuleType('db')
    fake_db.Base = declarative_base()
    fake_db.SessionLocal = None
    fake_db.engine = None
    fake_db.database_available = False
    sys.modules['db'] = fake_db


class InitialAIService:
    @staticmethod
    def analyze_text(_content):
        return {
            'risk': 'safe',
            'score': 0.01,
            'reason': '文本为空',
        }


if 'services.ai_service' not in sys.modules:
    fake_ai_service = types.ModuleType('services.ai_service')
    fake_ai_service.ai_service = InitialAIService()
    sys.modules['services.ai_service'] = fake_ai_service

from services.risk_service import RiskService  # noqa: E402
from services.text_risk_model import TextRiskModel  # noqa: E402


class StubTextRiskModel:
    def __init__(self, result=None, error=None):
        self.result = result or {'ai_available': False}
        self.error = error
        self.calls = []

    def predict(self, url, title, text):
        self.calls.append((url, title, text))
        if self.error is not None:
            raise self.error
        return self.result


class RiskFusionTestCase(unittest.TestCase):
    FORMAL_LEVELS = {'safe', 'low', 'medium', 'high'}

    @staticmethod
    def _rule(
        score=0.65,
        level='medium',
        reason='检测到金融投资内容',
        strong=False,
    ):
        return {
            'rule_score': score,
            'rule_level': level,
            'rule_reasons': [reason],
            'strong_hit': strong,
        }

    @staticmethod
    def _ai(
        score=0.90,
        category='scam',
        confidence=0.90,
    ):
        return {
            'ai_available': True,
            'ai_score': score,
            'ai_category': category,
            'ai_confidence': confidence,
            'ai_reasons': [],
            'model_version': 'test-v1',
        }

    @staticmethod
    def _service(text_model=None, **overrides):
        return RiskService(
            text_model=text_model or StubTextRiskModel(),
            rule_weight=overrides.get('rule_weight', 0.40),
            ai_weight=overrides.get('ai_weight', 0.60),
            min_confidence=overrides.get('min_confidence', 0.70),
        )

    def test_ai_unavailable_returns_complete_rule_fallback(self):
        service = self._service()
        rule = self._rule()

        result = service.fuse_risk(rule, {'ai_available': False})

        self.assertEqual(result, {
            'final_score': 0.65,
            'final_level': 'medium',
            'final_reason': '检测到金融投资内容',
            'detection_source': 'rule',
        })

    def test_ai_disabled_does_not_load_and_returns_rule(self):
        loader_calls = []
        disabled_model = TextRiskModel(
            enabled=False,
            model_path='unused.joblib',
            loader=lambda path: loader_calls.append(path),
        )
        service = self._service(text_model=disabled_model)
        rule = self._rule()

        with patch.object(
            service,
            '_evaluate_rules',
            return_value=(rule, 'ai'),
        ):
            result = service.detect_risk(
                'https://example.com',
                '正文',
                title='标题',
            )

        self.assertEqual(result, {
            'check_type': 'ai',
            'risk_level': 'medium',
            'score': 0.65,
            'reason': '检测到金融投资内容',
        })
        self.assertEqual(loader_calls, [])

    def test_prediction_exception_returns_rule_without_raising(self):
        model = StubTextRiskModel(error=RuntimeError('prediction failed'))
        service = self._service(text_model=model)
        rule = self._rule()

        with patch.object(
            service,
            '_evaluate_rules',
            return_value=(rule, 'ai'),
        ), self.assertLogs(
            'services.risk_service',
            level='WARNING',
        ):
            result = service.detect_risk(
                'https://example.com',
                '敏感正文不应进入日志',
                title='标题',
            )

        self.assertEqual(result['risk_level'], 'medium')
        self.assertEqual(result['score'], 0.65)
        self.assertEqual(result['reason'], '检测到金融投资内容')

    def test_text_model_receives_url_title_and_text(self):
        model = StubTextRiskModel(result=self._ai())
        service = self._service(text_model=model)
        rule = self._rule(score=0.05, level='safe', reason='URL 未发现风险')

        with patch.object(
            service,
            '_evaluate_rules',
            return_value=(rule, 'url'),
        ):
            service.detect_risk(
                'https://example.com',
                '仅正文送入模型内部 Pipeline',
                title='页面标题',
            )

        self.assertEqual(model.calls, [(
            'https://example.com',
            '页面标题',
            '仅正文送入模型内部 Pipeline',
        )])

    def test_strong_high_rule_cannot_be_lowered_by_safe_ai(self):
        service = self._service()
        rule = self._rule(
            score=0.95,
            level='high',
            reason='检测到高风险网址（赌博/色情类）',
            strong=True,
        )

        result = service.fuse_risk(
            rule,
            self._ai(score=0.05, category='normal', confidence=0.95),
        )

        self.assertEqual(result['final_score'], 0.95)
        self.assertEqual(result['final_level'], 'high')
        self.assertEqual(
            result['final_reason'],
            '检测到高风险网址（赌博/色情类）',
        )
        self.assertEqual(result['detection_source'], 'rule+ai')

    def test_strong_rule_allows_ai_to_raise_but_keeps_rule_floor(self):
        service = self._service()
        rule = self._rule(
            score=0.65,
            level='medium',
            reason='命中确定性规则',
            strong=True,
        )

        result = service.fuse_risk(
            rule,
            self._ai(score=0.99, category='scam', confidence=0.99),
        )

        self.assertAlmostEqual(result['final_score'], 0.854)
        self.assertGreaterEqual(result['final_score'], rule['rule_score'])
        self.assertEqual(result['final_level'], 'high')
        self.assertEqual(result['final_reason'], 'AI文本模型识别为诈骗风险')

    def test_weak_rule_and_high_confidence_risk_ai_are_fused(self):
        service = self._service()
        rule = self._rule(score=0.35, level='low', reason='检测到诱导点击内容')

        result = service.fuse_risk(
            rule,
            self._ai(score=0.90, category='phishing', confidence=0.90),
        )

        self.assertAlmostEqual(result['final_score'], 0.68)
        self.assertEqual(result['final_level'], 'high')
        self.assertEqual(result['final_reason'], 'AI文本模型识别为钓鱼风险')
        self.assertEqual(result['detection_source'], 'rule+ai')

    def test_weak_rule_and_high_confidence_normal_ai_are_fused(self):
        service = self._service()
        rule = self._rule()

        result = service.fuse_risk(
            rule,
            self._ai(score=0.10, category='normal', confidence=0.90),
        )

        self.assertAlmostEqual(result['final_score'], 0.32)
        self.assertEqual(result['final_level'], 'low')
        self.assertEqual(
            result['final_reason'],
            'AI文本模型未识别到明显风险',
        )
        self.assertEqual(result['detection_source'], 'rule+ai')

    def test_low_confidence_ai_returns_rule_fallback(self):
        service = self._service(min_confidence=0.70)
        rule = self._rule()

        result = service.fuse_risk(
            rule,
            self._ai(score=0.99, category='scam', confidence=0.69),
        )

        self.assertEqual(result, service._rule_fallback(rule))

    def test_safe_rule_can_be_raised_by_high_confidence_risk_ai(self):
        service = self._service()
        rule = self._rule(
            score=0.05,
            level='safe',
            reason='URL 未发现风险',
        )

        result = service.fuse_risk(
            rule,
            self._ai(score=0.90, category='gambling', confidence=0.90),
        )

        self.assertAlmostEqual(result['final_score'], 0.56)
        self.assertEqual(result['final_level'], 'medium')
        self.assertEqual(result['final_reason'], 'AI文本模型识别为赌博风险')

    def test_contradictory_normal_ai_result_returns_rule_fallback(self):
        service = self._service()
        rule = self._rule()

        result = service.fuse_risk(
            rule,
            self._ai(score=0.90, category='normal', confidence=0.90),
        )

        self.assertEqual(result, service._rule_fallback(rule))

    def test_consistent_normal_ai_result_is_valid(self):
        service = self._service()
        rule = self._rule()

        result = service.fuse_risk(
            rule,
            self._ai(score=0.10, category='normal', confidence=0.90),
        )

        self.assertAlmostEqual(result['final_score'], 0.32)
        self.assertEqual(result['final_level'], 'low')
        self.assertEqual(result['detection_source'], 'rule+ai')

    def test_contradictory_risk_ai_result_returns_rule_fallback(self):
        service = self._service()
        rule = self._rule()

        result = service.fuse_risk(
            rule,
            self._ai(score=0.10, category='scam', confidence=0.90),
        )

        self.assertEqual(result, service._rule_fallback(rule))

    def test_consistent_risk_ai_result_is_valid(self):
        service = self._service()
        rule = self._rule(score=0.05, level='safe', reason='URL 未发现风险')

        result = service.fuse_risk(
            rule,
            self._ai(score=0.90, category='scam', confidence=0.70),
        )

        self.assertAlmostEqual(result['final_score'], 0.56)
        self.assertEqual(result['final_level'], 'medium')
        self.assertEqual(result['detection_source'], 'rule+ai')

    def test_confidence_equal_to_threshold_participates(self):
        service = self._service(min_confidence=0.70)
        rule = self._rule(score=0.05, level='safe', reason='URL 未发现风险')

        result = service.fuse_risk(
            rule,
            self._ai(score=0.70, category='scam', confidence=0.70),
        )

        self.assertAlmostEqual(result['final_score'], 0.44)
        self.assertEqual(result['final_level'], 'medium')
        self.assertEqual(result['detection_source'], 'rule+ai')

    def test_weak_high_rule_and_normal_ai_map_weighted_score(self):
        service = self._service()
        rule = self._rule(
            score=0.96,
            level='high',
            reason='检测到诈骗相关内容',
        )

        result = service.fuse_risk(
            rule,
            self._ai(score=0.30, category='normal', confidence=0.70),
        )

        self.assertAlmostEqual(result['final_score'], 0.564)
        self.assertEqual(result['final_level'], 'medium')
        self.assertEqual(result['detection_source'], 'rule+ai')

    def test_same_final_score_always_maps_to_same_level(self):
        service = self._service()
        normal_result = service.fuse_risk(
            self._rule(score=0.65, level='medium'),
            self._ai(score=0.30, category='normal', confidence=0.70),
        )
        risk_result = service.fuse_risk(
            self._rule(score=0.05, level='safe', reason='URL 未发现风险'),
            self._ai(score=0.70, category='scam', confidence=0.70),
        )

        self.assertAlmostEqual(normal_result['final_score'], 0.44)
        self.assertAlmostEqual(risk_result['final_score'], 0.44)
        self.assertEqual(normal_result['final_level'], 'medium')
        self.assertEqual(risk_result['final_level'], 'medium')

    def test_provisional_score_level_boundaries_are_stable(self):
        service = self._service()
        cases = (
            (0.00, 'safe'),
            (0.199999, 'safe'),
            (0.20, 'low'),
            (0.399999, 'low'),
            (0.40, 'medium'),
            (0.599999, 'medium'),
            (0.60, 'high'),
            (1.00, 'high'),
        )

        for score, expected_level in cases:
            with self.subTest(score=score):
                self.assertEqual(
                    service._level_from_score(score),
                    expected_level,
                )

    def test_raw_fusion_scores_are_canonicalized_before_level_mapping(self):
        service = self._service()
        cases = (
            (
                0.59994,
                self._rule(score=0.0, level='safe'),
                self._ai(
                    score=0.59994 / 0.60,
                    category='scam',
                    confidence=0.90,
                ),
                0.5999,
                'medium',
            ),
            (
                0.59995,
                self._rule(score=0.0, level='safe'),
                self._ai(
                    score=0.59995 / 0.60,
                    category='scam',
                    confidence=0.90,
                ),
                0.6000,
                'high',
            ),
            (
                0.59996,
                self._rule(score=0.0, level='safe'),
                self._ai(
                    score=0.59996 / 0.60,
                    category='scam',
                    confidence=0.90,
                ),
                0.6000,
                'high',
            ),
            (
                0.39994,
                self._rule(score=0.54985, level='medium'),
                self._ai(
                    score=0.30,
                    category='normal',
                    confidence=0.70,
                ),
                0.3999,
                'low',
            ),
            (
                0.39995,
                self._rule(score=0.549875, level='medium'),
                self._ai(
                    score=0.30,
                    category='normal',
                    confidence=0.70,
                ),
                0.4000,
                'medium',
            ),
            (
                0.19994,
                self._rule(score=0.34985, level='low'),
                self._ai(
                    score=0.10,
                    category='normal',
                    confidence=0.90,
                ),
                0.1999,
                'safe',
            ),
            (
                0.19995,
                self._rule(score=0.349875, level='low'),
                self._ai(
                    score=0.10,
                    category='normal',
                    confidence=0.90,
                ),
                0.2000,
                'low',
            ),
        )

        for raw_score, rule, ai_result, expected_score, expected_level in cases:
            with self.subTest(raw_score=raw_score):
                result = service.fuse_risk(rule, ai_result)
                self.assertEqual(result['final_score'], expected_score)
                self.assertEqual(result['final_level'], expected_level)
                self.assertEqual(result['detection_source'], 'rule+ai')

    def test_rule_fallback_is_not_canonicalized_or_remapped(self):
        service = self._service()
        rule = self._rule(score=0.59996, level='medium')

        result = service.fuse_risk(rule, {'ai_available': False})

        self.assertEqual(result, {
            'final_score': 0.59996,
            'final_level': 'medium',
            'final_reason': '检测到金融投资内容',
            'detection_source': 'rule',
        })

    def test_canonical_score_keeps_strong_rule_score_floor(self):
        service = self._service()
        rule = self._rule(
            score=0.60004,
            level='high',
            reason='命中确定性规则',
            strong=True,
        )

        result = service.fuse_risk(
            rule,
            self._ai(score=0.10, category='normal', confidence=0.90),
        )

        self.assertEqual(result['final_score'], 0.6001)
        self.assertGreaterEqual(result['final_score'], rule['rule_score'])
        self.assertEqual(result['final_level'], 'high')

    def test_ai_participation_can_leave_result_unchanged(self):
        service = self._service()
        rule = self._rule(
            score=0.90,
            level='high',
            reason='检测到诈骗相关内容',
        )

        result = service.fuse_risk(
            rule,
            self._ai(score=0.90, category='scam', confidence=0.70),
        )

        self.assertAlmostEqual(result['final_score'], 0.90)
        self.assertEqual(result['final_level'], 'high')
        self.assertEqual(result['final_reason'], '检测到诈骗相关内容')
        self.assertEqual(result['detection_source'], 'rule+ai')

    def test_invalid_ai_score_returns_rule_fallback(self):
        service = self._service()
        rule = self._rule()

        for invalid_score in (-0.1, 1.1, math.nan, math.inf, True, '0.9'):
            with self.subTest(invalid_score=invalid_score):
                ai_result = self._ai()
                ai_result['ai_score'] = invalid_score
                self.assertEqual(
                    service.fuse_risk(rule, ai_result),
                    service._rule_fallback(rule),
                )

    def test_invalid_ai_confidence_returns_rule_fallback(self):
        service = self._service()
        rule = self._rule()

        for invalid_confidence in (
            -0.1,
            1.1,
            math.nan,
            math.inf,
            False,
            '0.9',
        ):
            with self.subTest(invalid_confidence=invalid_confidence):
                ai_result = self._ai()
                ai_result['ai_confidence'] = invalid_confidence
                self.assertEqual(
                    service.fuse_risk(rule, ai_result),
                    service._rule_fallback(rule),
                )

    def test_illegal_ai_category_returns_rule_fallback(self):
        service = self._service()
        rule = self._rule()

        result = service.fuse_risk(
            rule,
            self._ai(category='unknown'),
        )

        self.assertEqual(result, service._rule_fallback(rule))

    def test_missing_ai_fields_return_rule_fallback(self):
        service = self._service()
        rule = self._rule()

        for missing_field in (
            'ai_score',
            'ai_category',
            'ai_confidence',
            'ai_reasons',
            'model_version',
        ):
            with self.subTest(missing_field=missing_field):
                ai_result = self._ai()
                del ai_result[missing_field]
                self.assertEqual(
                    service.fuse_risk(rule, ai_result),
                    service._rule_fallback(rule),
                )

    def test_invalid_weight_configuration_returns_rule_fallback(self):
        rule = self._rule()
        invalid_configs = (
            {'rule_weight': 0.50, 'ai_weight': 0.60},
            {'rule_weight': -0.10, 'ai_weight': 1.10},
            {'rule_weight': math.nan, 'ai_weight': 0.60},
            {'rule_weight': '0.40', 'ai_weight': 0.60},
        )

        for config in invalid_configs:
            with self.subTest(config=config):
                service = self._service(**config)
                self.assertEqual(
                    service.fuse_risk(rule, self._ai()),
                    service._rule_fallback(rule),
                )

    def test_fusion_result_uses_formal_range_level_and_source(self):
        service = self._service()
        result = service.fuse_risk(
            self._rule(score=0.05, level='safe'),
            self._ai(score=1.0, category='malicious', confidence=1.0),
        )

        self.assertEqual(set(result), {
            'final_score',
            'final_level',
            'final_reason',
            'detection_source',
        })
        self.assertGreaterEqual(result['final_score'], 0.0)
        self.assertLessEqual(result['final_score'], 1.0)
        self.assertIn(result['final_level'], self.FORMAL_LEVELS)
        self.assertEqual(result['detection_source'], 'rule+ai')


if __name__ == '__main__':
    unittest.main()
