import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# 允许本文件独立运行；测试只使用内存 SQLite，不连接真实 MySQL。
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

from models.models import RiskEvent  # noqa: E402
import services.risk_service as risk_service_module  # noqa: E402
from services.risk_service import RiskService  # noqa: E402


class StubTextRiskModel:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def predict(self, url, title, text_content):
        self.calls.append((url, title, text_content))
        return dict(self.result)


class RiskDetailsTestCase(unittest.TestCase):
    SENSITIVE_TITLE = '仅用于隐私断言的唯一标题'
    SENSITIVE_META = '仅用于隐私断言的唯一页面描述'
    SENSITIVE_CONTENT = '仅用于隐私断言的唯一正文敏感字符串'

    def setUp(self):
        self.original_session_factory = risk_service_module.database.SessionLocal
        self.engine = create_engine('sqlite:///:memory:')
        with self.engine.begin() as connection:
            connection.execute(text('''
                CREATE TABLE risk_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_uuid CHAR(36) NOT NULL UNIQUE,
                    user_id BIGINT NULL,
                    event_type VARCHAR(32) NOT NULL,
                    check_type VARCHAR(20) NOT NULL,
                    risk_level VARCHAR(16) NOT NULL,
                    risk_score NUMERIC(5, 4) NOT NULL,
                    url TEXT NULL,
                    url_hash CHAR(64) NULL,
                    reason VARCHAR(1000) NULL,
                    source VARCHAR(20) NOT NULL,
                    details JSON NULL,
                    occurred_at DATETIME NOT NULL,
                    created_at DATETIME NOT NULL
                )
            '''))
        self.session_factory = sessionmaker(bind=self.engine)
        risk_service_module.database.SessionLocal = self.session_factory

    def tearDown(self):
        risk_service_module.database.SessionLocal = (
            self.original_session_factory
        )
        self.engine.dispose()

    @staticmethod
    def _rule(
        score=0.05,
        level='safe',
        reason='URL 未发现风险',
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
        available=True,
        score=0.90,
        category='scam',
        confidence=0.90,
        model_version='test-v1',
    ):
        if not available:
            return {'ai_available': False}
        return {
            'ai_available': True,
            'ai_score': score,
            'ai_category': category,
            'ai_confidence': confidence,
            'ai_reasons': [],
            'model_version': model_version,
        }

    @classmethod
    def _payload(cls):
        return {
            'url': 'https://example.com/private',
            'title': cls.SENSITIVE_TITLE,
            'meta_description': cls.SENSITIVE_META,
            'content': cls.SENSITIVE_CONTENT,
            'source': 'extension',
        }

    def _run_detection(self, rule_result, ai_result, check_type='url'):
        model = StubTextRiskModel(ai_result)
        service = RiskService(text_model=model)
        with patch.object(
            service,
            '_evaluate_rules',
            return_value=(rule_result, check_type),
        ) as rule_mock, patch.object(
            service,
            'fuse_risk',
            wraps=service.fuse_risk,
        ) as fusion_mock:
            public_result = service.check_and_save(self._payload())

        session = self.session_factory()
        try:
            event = session.query(RiskEvent).one()
            event_data = event.to_dict()
        finally:
            session.close()

        self.assertEqual(rule_mock.call_count, 1)
        self.assertEqual(fusion_mock.call_count, 1)
        self.assertEqual(len(model.calls), 1)
        return public_result, event_data

    def test_available_ai_persists_rule_ai_and_fusion_metadata(self):
        result, event = self._run_detection(
            self._rule(),
            self._ai(),
        )
        details = event['details']

        self.assertEqual(details['schema_version'], 'ai-risk-v1')
        self.assertEqual(details['rule'], {
            'score': 0.05,
            'level': 'safe',
            'reasons': ['URL 未发现风险'],
            'strong_hit': False,
        })
        self.assertEqual(details['ai'], {
            'available': True,
            'score': 0.90,
            'category': 'scam',
            'confidence': 0.90,
            'reasons': [],
            'model_version': 'test-v1',
        })
        self.assertEqual(details['fusion'], {
            'score': 0.56,
            'level': 'medium',
            'source': 'rule+ai',
            'changed': True,
            'rule_weight': 0.40,
            'ai_weight': 0.60,
            'min_confidence': 0.70,
        })
        self.assertEqual(result, {
            'risk_level': 'medium',
            'score': 0.56,
            'reason': 'AI文本模型识别为诈骗风险',
        })
        self.assertEqual(event['risk_score'], details['fusion']['score'])
        self.assertEqual(event['risk_level'], details['fusion']['level'])

    def test_unavailable_ai_persists_only_availability(self):
        result, event = self._run_detection(
            self._rule(
                score=0.65,
                level='medium',
                reason='检测到金融投资内容',
            ),
            self._ai(available=False),
            check_type='ai',
        )

        self.assertEqual(event['details']['ai'], {'available': False})
        self.assertEqual(event['details']['fusion']['source'], 'rule')
        self.assertFalse(event['details']['fusion']['changed'])
        self.assertNotIn('score', event['details']['ai'])
        self.assertNotIn('category', event['details']['ai'])
        self.assertNotIn('confidence', event['details']['ai'])
        self.assertEqual(result['score'], 0.65)
        self.assertEqual(result['risk_level'], 'medium')

    def test_v2_model_version_persists_without_changing_ai_contract(self):
        _result, event = self._run_detection(
            self._rule(),
            self._ai(model_version='tfidf-logreg-v2-char'),
        )

        ai_details = event['details']['ai']
        self.assertEqual(set(ai_details), {
            'available',
            'score',
            'category',
            'confidence',
            'reasons',
            'model_version',
        })
        self.assertEqual(
            ai_details['model_version'],
            'tfidf-logreg-v2-char',
        )

    def test_low_confidence_ai_is_recorded_but_rule_is_authoritative(self):
        result, event = self._run_detection(
            self._rule(
                score=0.65,
                level='medium',
                reason='检测到金融投资内容',
            ),
            self._ai(score=0.90, confidence=0.69),
            check_type='ai',
        )
        details = event['details']

        self.assertTrue(details['ai']['available'])
        self.assertEqual(details['ai']['confidence'], 0.69)
        self.assertEqual(details['fusion']['source'], 'rule')
        self.assertFalse(details['fusion']['changed'])
        self.assertEqual(details['fusion']['score'], 0.65)
        self.assertEqual(result['score'], 0.65)

    def test_strong_rule_metadata_and_authoritative_result_are_consistent(self):
        result, event = self._run_detection(
            self._rule(
                score=0.95,
                level='high',
                reason='检测到高风险网址（赌博/色情类）',
                strong=True,
            ),
            self._ai(
                score=0.05,
                category='normal',
                confidence=0.95,
            ),
        )
        details = event['details']

        self.assertTrue(details['rule']['strong_hit'])
        self.assertEqual(details['fusion']['source'], 'rule+ai')
        self.assertFalse(details['fusion']['changed'])
        self.assertEqual(details['fusion']['score'], 0.95)
        self.assertEqual(details['fusion']['level'], 'high')
        self.assertEqual(event['risk_score'], details['fusion']['score'])
        self.assertEqual(event['risk_level'], details['fusion']['level'])
        self.assertEqual(result['score'], 0.95)

    def test_ai_participation_without_numeric_change_sets_changed_false(self):
        _result, event = self._run_detection(
            self._rule(
                score=0.90,
                level='high',
                reason='检测到诈骗相关内容',
            ),
            self._ai(score=0.89999, category='scam', confidence=0.70),
            check_type='ai',
        )

        self.assertEqual(event['details']['fusion']['source'], 'rule+ai')
        self.assertEqual(event['details']['fusion']['score'], 0.90)
        self.assertFalse(event['details']['fusion']['changed'])

    def test_details_store_only_input_lengths_and_json_round_trips(self):
        _result, event = self._run_detection(
            self._rule(),
            self._ai(),
        )
        details = event['details']

        self.assertIsInstance(details, dict)
        self.assertEqual(details['input'], {
            'title_length': len(self.SENSITIVE_TITLE),
            'meta_description_length': len(self.SENSITIVE_META),
            'content_length': len(self.SENSITIVE_CONTENT),
        })
        serialized = json.dumps(details, ensure_ascii=False)
        self.assertNotIn(self.SENSITIVE_TITLE, serialized)
        self.assertNotIn(self.SENSITIVE_META, serialized)
        self.assertNotIn(self.SENSITIVE_CONTENT, serialized)
        self.assertNotIn('title', details['input'])
        self.assertNotIn('meta_description', details['input'])
        self.assertNotIn('content', details['input'])


if __name__ == '__main__':
    unittest.main()
