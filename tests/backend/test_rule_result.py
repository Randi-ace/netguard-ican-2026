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

import services.risk_service as risk_service_module  # noqa: E402
from services.risk_service import RiskService  # noqa: E402


class StubAIService:
    def __init__(self):
        self.result = {
            'risk': 'safe',
            'score': 0.01,
            'reason': '文本为空',
        }

    def analyze_text(self, _content):
        return dict(self.result)


class StubBlacklistService:
    def __init__(self):
        self.result = None

    def check_url(self, _url):
        return self.result


class RuleResultTestCase(unittest.TestCase):
    FORMAL_LEVELS = {'safe', 'low', 'medium', 'high'}

    def setUp(self):
        self.original_ai_service = risk_service_module.ai_service
        self.original_blacklist_service = (
            risk_service_module.blacklist_service
        )
        self.ai_service = StubAIService()
        self.blacklist_service = StubBlacklistService()
        risk_service_module.ai_service = self.ai_service
        risk_service_module.blacklist_service = self.blacklist_service
        self.service = RiskService()

    def tearDown(self):
        risk_service_module.ai_service = self.original_ai_service
        risk_service_module.blacklist_service = (
            self.original_blacklist_service
        )

    def _set_content_result(self, level, score, reason):
        self.ai_service.result = {
            'risk': level,
            'score': score,
            'reason': reason,
        }

    def test_safe_result_is_normalized(self):
        result = self.service.detect_rule_result(
            'https://example.com',
            '',
        )

        self.assertEqual(result, {
            'rule_score': 0.05,
            'rule_level': 'safe',
            'rule_reasons': ['URL 未发现风险'],
            'strong_hit': False,
        })

    def test_low_result_is_normalized(self):
        self._set_content_result('low', 0.35, '检测到诱导点击内容')

        result = self.service.detect_rule_result(
            'https://example.com',
            '点击查看详情',
        )

        self.assertEqual(result['rule_level'], 'low')
        self.assertEqual(result['rule_score'], 0.35)
        self.assertEqual(result['rule_reasons'], ['检测到诱导点击内容'])
        self.assertFalse(result['strong_hit'])

    def test_medium_result_is_normalized(self):
        self._set_content_result('medium', 0.65, '检测到金融投资内容')

        result = self.service.detect_rule_result(
            'https://example.com',
            '投资理财内容',
        )

        self.assertEqual(result['rule_level'], 'medium')
        self.assertEqual(result['rule_score'], 0.65)
        self.assertEqual(result['rule_reasons'], ['检测到金融投资内容'])
        self.assertFalse(result['strong_hit'])

    def test_high_text_keyword_result_remains_non_strong(self):
        self._set_content_result('high', 0.95, '检测到诈骗相关内容')

        result = self.service.detect_rule_result(
            'https://example.com',
            '这是诈骗内容',
        )

        self.assertEqual(result['rule_level'], 'high')
        self.assertEqual(result['rule_score'], 0.95)
        self.assertEqual(result['rule_reasons'], ['检测到诈骗相关内容'])
        self.assertFalse(result['strong_hit'])

    def test_database_blacklist_is_strong(self):
        self.blacklist_service.result = {
            'check_type': 'rule',
            'risk_level': 'high',
            'score': 0.98,
            'reason': '命中后端域名黑名单',
        }

        result = self.service.detect_rule_result(
            'https://evil.example.com',
            '普通内容',
        )

        self.assertEqual(result['rule_level'], 'high')
        self.assertEqual(result['rule_score'], 0.98)
        self.assertEqual(result['rule_reasons'], ['命中后端域名黑名单'])
        self.assertTrue(result['strong_hit'])

    def test_high_risk_url_rule_is_strong(self):
        result = self.service.detect_rule_result(
            'https://casino.example.com',
            '普通内容',
        )

        self.assertEqual(result['rule_level'], 'high')
        self.assertEqual(result['rule_score'], 0.95)
        self.assertEqual(
            result['rule_reasons'],
            ['检测到高风险网址（赌博/色情类）'],
        )
        self.assertTrue(result['strong_hit'])

    def test_phishing_url_rule_remains_non_strong(self):
        result = self.service.detect_rule_result(
            'https://example.com/account/verify',
            '普通内容',
        )

        self.assertEqual(result['rule_level'], 'high')
        self.assertEqual(result['rule_score'], 0.90)
        self.assertEqual(result['rule_reasons'], ['检测到钓鱼网站特征'])
        self.assertFalse(result['strong_hit'])

    def test_multiple_rules_keep_existing_highest_risk_selection(self):
        self._set_content_result('high', 0.96, '检测到诈骗相关内容')

        result = self.service.detect_rule_result(
            'https://casino.example.com',
            '诈骗内容',
        )

        self.assertEqual(result['rule_level'], 'high')
        self.assertEqual(result['rule_score'], 0.96)
        self.assertEqual(result['rule_reasons'], ['检测到诈骗相关内容'])
        self.assertTrue(result['strong_hit'])

    def test_rule_result_contract_has_stable_keys_ranges_and_levels(self):
        inputs = (
            ('https://example.com', '', 'safe', 0.05),
            ('https://casino.example.com', '', 'high', 0.95),
        )

        for url, content, expected_level, expected_score in inputs:
            with self.subTest(url=url):
                result = self.service.detect_rule_result(url, content)
                self.assertEqual(set(result), {
                    'rule_score',
                    'rule_level',
                    'rule_reasons',
                    'strong_hit',
                })
                self.assertEqual(result['rule_level'], expected_level)
                self.assertEqual(result['rule_score'], expected_score)
                self.assertIn(result['rule_level'], self.FORMAL_LEVELS)
                self.assertGreaterEqual(result['rule_score'], 0.0)
                self.assertLessEqual(result['rule_score'], 1.0)
                self.assertIsInstance(result['rule_reasons'], list)
                self.assertEqual(len(result['rule_reasons']), 1)
                self.assertIsInstance(result['rule_reasons'][0], str)

    def test_detect_risk_keeps_first_phase_result_shape_and_values(self):
        cases = (
            (
                'https://example.com',
                '',
                {
                    'check_type': 'url',
                    'risk_level': 'safe',
                    'score': 0.05,
                    'reason': 'URL 未发现风险',
                },
            ),
            (
                'https://casino.example.com',
                '',
                {
                    'check_type': 'url',
                    'risk_level': 'high',
                    'score': 0.95,
                    'reason': '检测到高风险网址（赌博/色情类）',
                },
            ),
            (
                'https://example.com/account/verify',
                '',
                {
                    'check_type': 'url',
                    'risk_level': 'high',
                    'score': 0.90,
                    'reason': '检测到钓鱼网站特征',
                },
            ),
        )

        for url, content, expected in cases:
            with self.subTest(url=url):
                self.assertEqual(
                    self.service.detect_risk(url, content),
                    expected,
                )

    def test_detect_risk_keeps_content_winner_compatibility(self):
        self._set_content_result('high', 0.96, '测试环境检测到诈骗内容')

        result = self.service.detect_risk(
            'https://example.com/account/verify',
            '诈骗内容',
        )

        self.assertEqual(result, {
            'check_type': 'ai',
            'risk_level': 'high',
            'score': 0.96,
            'reason': '测试环境检测到诈骗内容',
        })

    def test_existing_tie_order_is_preserved(self):
        tied_url_result = {
            'check_type': 'url',
            'risk_level': 'medium',
            'score': 0.65,
            'reason': 'URL 同等级结果',
        }
        self._set_content_result('medium', 0.65, '内容同等级结果')

        with patch.object(
            self.service,
            '_detect_url',
            return_value=tied_url_result,
        ):
            result = self.service.detect_risk(
                'https://example.com',
                '投资内容',
            )

        self.assertEqual(result, {
            'check_type': 'url',
            'risk_level': 'medium',
            'score': 0.65,
            'reason': 'URL 同等级结果',
        })


if __name__ == '__main__':
    unittest.main()
