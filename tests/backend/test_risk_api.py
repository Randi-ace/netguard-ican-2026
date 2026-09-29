import sys
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from flask import Flask
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import declarative_base


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# 正式风险接口测试使用假会话，禁止连接或修改开发者的真实 MySQL。
fake_db = types.ModuleType('db')
fake_db.Base = declarative_base()
fake_db.SessionLocal = None
fake_db.engine = None
fake_db.database_available = False
sys.modules['db'] = fake_db


class StubAIService:
    def __init__(self):
        self.received_contents = []

    def reset(self):
        self.received_contents.clear()

    def analyze_text(self, content):
        self.received_contents.append(content)
        if '诈骗' in content:
            return {
                'risk': 'high',
                'score': 0.96,
                'reason': '测试环境检测到诈骗内容',
            }
        return {
            'risk': 'safe',
            'score': 0.01,
            'reason': '测试环境内容安全',
        }


stub_ai_service = StubAIService()


class StubBlacklistService:
    def __init__(self):
        self.result = None

    def reset(self):
        self.result = None

    def check_url(self, _url):
        return self.result


stub_blacklist_service = StubBlacklistService()
fake_ai_service = types.ModuleType('services.ai_service')
fake_ai_service.ai_service = stub_ai_service
sys.modules['services.ai_service'] = fake_ai_service

from models.models import RiskEvent  # noqa: E402
from routes.ai_check import ai_bp  # noqa: E402
from routes.events import events_bp  # noqa: E402
import routes.ai_check as ai_check_module  # noqa: E402
import services.event_service as event_service_module  # noqa: E402
from services.blacklist_service import BlacklistService  # noqa: E402
import services.risk_service as risk_service_module  # noqa: E402
from services.text_risk_model import TextRiskModel  # noqa: E402


real_blacklist_service = risk_service_module.blacklist_service
real_text_risk_model = risk_service_module.risk_service.text_model


class FakeQuery:
    def __init__(self, store):
        self._store = store
        self._event_uuid = None

    def filter(self, expression):
        self._event_uuid = expression.right.value
        return self

    def first(self):
        return next(
            (
                event for event in self._store
                if event.event_uuid == self._event_uuid
            ),
            None,
        )


class FakeSession:
    def __init__(self, store):
        self._store = store
        self._pending = []

    def add(self, event):
        event.id = len(self._store) + len(self._pending) + 1
        self._pending.append(event)

    def query(self, _model):
        return FakeQuery(self._store)

    def commit(self):
        self._store.extend(self._pending)
        self._pending.clear()

    def rollback(self):
        self._pending.clear()

    def close(self):
        pass


class ConcurrentConflictSession(FakeSession):
    def __init__(self, store, existing_event):
        super().__init__(store)
        self._existing_event = existing_event

    def commit(self):
        self._store.append(self._existing_event)
        raise IntegrityError(
            'INSERT INTO risk_events ...',
            {},
            RuntimeError('simulated duplicate event_uuid'),
        )


class RiskApiTestCase(unittest.TestCase):
    FORMAL_RISK_LEVELS = {'safe', 'low', 'medium', 'high'}

    def setUp(self):
        self.store = []
        self.text_model_loader_calls = []
        stub_ai_service.reset()
        stub_blacklist_service.reset()
        risk_service_module.ai_service = stub_ai_service
        risk_service_module.blacklist_service = stub_blacklist_service
        risk_service_module.risk_service.text_model = TextRiskModel(
            enabled=False,
            model_path='unused-test-model.joblib',
            loader=lambda path: self.text_model_loader_calls.append(path),
        )
        risk_service_module.database.SessionLocal = (
            lambda: FakeSession(self.store)
        )
        event_service_module.database.SessionLocal = (
            lambda: FakeSession(self.store)
        )

        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.app.register_blueprint(ai_bp)
        self.app.register_blueprint(events_bp)
        self.client = self.app.test_client()

    def tearDown(self):
        risk_service_module.blacklist_service = real_blacklist_service
        risk_service_module.risk_service.text_model = real_text_risk_model
        risk_service_module.database.SessionLocal = None
        event_service_module.database.SessionLocal = None

    @staticmethod
    def _payload(url='https://example.com', content='普通网页内容'):
        return {
            'url': url,
            'content': content,
            'source': 'extension',
        }

    def _post_success(self, payload):
        response = self.client.post('/api/risk/check', json=payload)
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body['code'], 0)
        self.assertIsNotNone(body['data'])
        return body['data']

    def test_safe_url_returns_safe_result(self):
        data = self._post_success(self._payload(content=''))

        self.assertEqual(data['risk_level'], 'safe')
        self.assertEqual(len(self.store), 1)
        self.assertEqual(self.store[0].check_type, 'url')

    def test_ai_disabled_keeps_representative_public_results_compatible(self):
        cases = (
            (
                self._payload(content=''),
                {
                    'risk_level': 'safe',
                    'score': 0.05,
                    'reason': 'URL 未发现风险',
                },
            ),
            (
                self._payload(
                    url='https://casino.example.com',
                    content='',
                ),
                {
                    'risk_level': 'high',
                    'score': 0.95,
                    'reason': '检测到高风险网址（赌博/色情类）',
                },
            ),
            (
                self._payload(content='这是诈骗内容'),
                {
                    'risk_level': 'high',
                    'score': 0.96,
                    'reason': '测试环境检测到诈骗内容',
                },
            ),
        )

        for payload, expected in cases:
            with self.subTest(payload=payload):
                data = self._post_success(payload)
                self.assertEqual(data, expected)

        self.assertEqual(self.text_model_loader_calls, [])

    def test_ai_fusion_keeps_public_response_to_three_fields(self):
        class AvailableTextModel:
            @staticmethod
            def predict(_url, _title, _text):
                return {
                    'ai_available': True,
                    'ai_score': 0.90,
                    'ai_category': 'scam',
                    'ai_confidence': 0.90,
                    'ai_reasons': [],
                    'model_version': 'test-v1',
                }

        risk_service_module.risk_service.text_model = AvailableTextModel()

        data = self._post_success(self._payload(content='普通网页内容'))

        self.assertEqual(set(data), {'risk_level', 'score', 'reason'})
        self.assertEqual(data['risk_level'], 'medium')
        self.assertAlmostEqual(data['score'], 0.56)
        self.assertEqual(data['reason'], 'AI文本模型识别为诈骗风险')
        self.assertEqual(self.store[0].check_type, 'ai')

    def test_canonical_fusion_score_and_level_match_at_threshold(self):
        class BoundaryTextModel:
            @staticmethod
            def predict(_url, _title, _text):
                return {
                    'ai_available': True,
                    'ai_score': 0.9666,
                    'ai_category': 'scam',
                    'ai_confidence': 0.90,
                    'ai_reasons': [],
                    'model_version': 'test-v1',
                }

        risk_service_module.risk_service.text_model = BoundaryTextModel()

        data = self._post_success(self._payload(content='普通网页内容'))
        event = self.store[0]

        self.assertEqual(data['score'], 0.6000)
        self.assertEqual(data['risk_level'], 'high')
        self.assertEqual(float(event.risk_score), 0.6000)
        self.assertEqual(event.risk_level, 'high')
        self.assertEqual(event.details['fusion']['score'], 0.6000)
        self.assertEqual(event.details['fusion']['level'], 'high')

    def test_event_uuid_is_optional_for_existing_clients(self):
        payload = self._payload(content='')

        data = self._post_success(payload)

        self.assertNotIn('event_uuid', payload)
        self.assertEqual(data['risk_level'], 'safe')
        self.assertEqual(len(self.store), 1)
        self.assertEqual(len(self.store[0].event_uuid), 36)

    def test_valid_event_uuid_is_saved_without_replacement(self):
        event_uuid = str(uuid.uuid4())
        payload = self._payload(content='')
        payload['event_uuid'] = event_uuid

        self._post_success(payload)

        self.assertEqual(len(self.store), 1)
        self.assertEqual(self.store[0].event_uuid, event_uuid)

    def test_invalid_event_uuid_returns_bad_request(self):
        payload = self._payload()
        payload['event_uuid'] = 'not-a-uuid'

        response = self.client.post('/api/risk/check', json=payload)

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()['code'], 40001)
        self.assertIsNone(response.get_json()['data'])
        self.assertEqual(self.store, [])

    def test_repeated_event_uuid_saves_only_one_risk_event(self):
        payload = self._payload(
            url='https://casino.example.com',
            content='',
        )
        payload['event_uuid'] = str(uuid.uuid4())

        first_data = self._post_success(payload)
        second_data = self._post_success(payload)

        self.assertEqual(first_data, second_data)
        self.assertEqual(len(self.store), 1)

    def test_duplicate_event_uuid_returns_persisted_event_data(self):
        event_uuid = str(uuid.uuid4())
        first_payload = self._payload(content='诈骗内容')
        first_payload['event_uuid'] = event_uuid
        first_data = self._post_success(first_payload)
        stub_ai_service.reset()

        second_payload = self._payload(content='普通内容')
        second_payload['event_uuid'] = event_uuid
        second_data = self._post_success(second_payload)

        self.assertEqual(first_data['risk_level'], 'high')
        self.assertEqual(second_data, first_data)
        self.assertEqual(stub_ai_service.received_contents, [])
        self.assertEqual(len(self.store), 1)

    def test_risk_check_then_event_api_is_cross_endpoint_idempotent(self):
        event_uuid = str(uuid.uuid4())
        risk_payload = self._payload(content='诈骗内容')
        risk_payload['event_uuid'] = event_uuid
        self._post_success(risk_payload)

        event_response = self.client.post('/api/events/risk', json={
            'event_uuid': event_uuid,
            'url': risk_payload['url'],
            'risk_level': 'high',
            'score': 0.96,
            'reason': '本地降级结果不应重复写入',
            'source': 'extension',
            'check_type': 'ai',
        })

        self.assertEqual(event_response.status_code, 200)
        self.assertEqual(event_response.get_json()['code'], 1)
        self.assertEqual(len(self.store), 1)

    def test_event_api_then_risk_check_returns_existing_event(self):
        event_uuid = str(uuid.uuid4())
        event_response = self.client.post('/api/events/risk', json={
            'event_uuid': event_uuid,
            'url': 'https://example.com/local-first',
            'risk_level': 'medium',
            'score': 0.67,
            'reason': '已持久化的本地降级结果',
            'source': 'extension',
            'check_type': 'ai',
        })
        risk_payload = self._payload(content='诈骗内容')
        risk_payload['event_uuid'] = event_uuid

        risk_data = self._post_success(risk_payload)

        self.assertEqual(event_response.status_code, 201)
        self.assertEqual(risk_data, {
            'risk_level': 'medium',
            'score': 0.67,
            'reason': '已持久化的本地降级结果',
        })
        self.assertEqual(stub_ai_service.received_contents, [])
        self.assertEqual(len(self.store), 1)

    def test_unique_event_uuid_conflict_recovers_as_success(self):
        event_uuid = str(uuid.uuid4())
        existing_event = RiskEvent(
            id=42,
            event_uuid=event_uuid,
            event_type='extension_risk',
            check_type='rule',
            risk_level='medium',
            risk_score=0.73,
            url='https://example.com/concurrent',
            reason='并发请求已经保存的结果',
            source='extension',
        )
        session_count = 0

        def session_factory():
            nonlocal session_count
            session_count += 1
            if session_count == 2:
                return ConcurrentConflictSession(
                    self.store,
                    existing_event,
                )
            return FakeSession(self.store)

        risk_service_module.database.SessionLocal = session_factory
        payload = self._payload(content='诈骗内容')
        payload['event_uuid'] = event_uuid

        data = self._post_success(payload)

        self.assertEqual(data, {
            'risk_level': 'medium',
            'score': 0.73,
            'reason': '并发请求已经保存的结果',
        })
        self.assertEqual(len(self.store), 1)

    def test_risky_url_returns_high_result(self):
        data = self._post_success(self._payload(
            url='https://casino.example.com',
            content='',
        ))

        self.assertEqual(data['risk_level'], 'high')
        self.assertEqual(data['score'], 0.95)
        self.assertIn('高风险网址', data['reason'])

    def test_normal_content_is_analyzed(self):
        content = '这是一段正常的学习资料'
        data = self._post_success(self._payload(content=content))

        self.assertEqual(data['risk_level'], 'safe')
        self.assertEqual(stub_ai_service.received_contents, [content])

    def test_risky_content_returns_high_result(self):
        data = self._post_success(self._payload(
            content='这是诈骗内容，请立即转账',
        ))

        self.assertEqual(data['risk_level'], 'high')
        self.assertEqual(data['score'], 0.96)
        self.assertEqual(data['reason'], '测试环境检测到诈骗内容')
        self.assertEqual(self.store[0].check_type, 'ai')

    def test_url_and_content_use_the_higher_risk_result(self):
        data = self._post_success(self._payload(
            url='https://example.com/account/verify',
            content='页面含有诈骗信息',
        ))

        self.assertEqual(data['risk_level'], 'high')
        self.assertEqual(data['score'], 0.96)
        self.assertEqual(data['reason'], '测试环境检测到诈骗内容')
        self.assertEqual(self.store[0].check_type, 'ai')

    def test_blacklist_result_uses_existing_response_and_event_contract(self):
        stub_blacklist_service.result = {
            'check_type': 'rule',
            'risk_level': 'high',
            'score': 0.98,
            'reason': '命中后端域名黑名单',
        }

        data = self._post_success(self._payload(
            url='https://sub.evil-example.com/path',
            content='普通内容',
        ))

        self.assertEqual(
            set(data),
            {'risk_level', 'score', 'reason'},
        )
        self.assertEqual(data['risk_level'], 'high')
        self.assertEqual(data['score'], 0.98)
        self.assertEqual(data['reason'], '命中后端域名黑名单')
        self.assertEqual(len(self.store), 1)
        self.assertIsInstance(self.store[0], RiskEvent)
        self.assertEqual(self.store[0].event_type, 'extension_risk')
        self.assertEqual(self.store[0].check_type, 'rule')
        self.assertEqual(self.store[0].risk_level, 'high')
        self.assertEqual(self.store[0].source, 'extension')
        self.assertEqual(len(self.store[0].event_uuid), 36)
        self.assertEqual(len(self.store[0].url_hash), 64)

    def test_blacklist_miss_continues_existing_url_detection(self):
        data = self._post_success(self._payload(
            url='https://casino.example.com',
            content='',
        ))

        self.assertEqual(data['risk_level'], 'high')
        self.assertEqual(data['score'], 0.95)
        self.assertIn('高风险网址', data['reason'])
        self.assertEqual(self.store[0].check_type, 'url')

    def test_blacklist_miss_continues_existing_content_detection(self):
        data = self._post_success(self._payload(
            url='https://example.com',
            content='这是诈骗内容',
        ))

        self.assertEqual(data['risk_level'], 'high')
        self.assertEqual(data['score'], 0.96)
        self.assertEqual(self.store[0].check_type, 'ai')

    def test_blacklist_high_result_overrides_lower_rule_results(self):
        stub_blacklist_service.result = {
            'check_type': 'rule',
            'risk_level': 'high',
            'score': 0.98,
            'reason': '命中后端域名黑名单',
        }
        medium_url_result = {
            'check_type': 'url',
            'risk_level': 'medium',
            'score': 0.70,
            'reason': '较低 URL 规则结果',
        }
        low_content_result = {
            'check_type': 'ai',
            'risk_level': 'low',
            'score': 0.30,
            'reason': '较低内容结果',
        }

        with patch.object(
            risk_service_module.risk_service,
            '_detect_url',
            return_value=medium_url_result,
        ), patch.object(
            risk_service_module.risk_service,
            '_detect_content',
            return_value=low_content_result,
        ):
            data = self._post_success(self._payload())

        self.assertEqual(data['risk_level'], 'high')
        self.assertEqual(data['score'], 0.98)
        self.assertEqual(data['reason'], '命中后端域名黑名单')
        self.assertEqual(self.store[0].check_type, 'rule')

    def test_blacklist_query_failure_continues_existing_detection(self):
        def failing_session_factory():
            raise RuntimeError('simulated blacklist query failure')

        risk_service_module.blacklist_service = BlacklistService(
            failing_session_factory
        )

        with self.assertLogs(
            'services.blacklist_service',
            level='WARNING',
        ):
            data = self._post_success(self._payload(
                url='https://casino.example.com',
                content='',
            ))

        self.assertEqual(data['risk_level'], 'high')
        self.assertEqual(data['score'], 0.95)
        self.assertEqual(self.store[0].check_type, 'url')

    def test_missing_required_parameters_returns_bad_request(self):
        payload = self._payload()

        for missing_field in ('url', 'content', 'source'):
            with self.subTest(missing_field=missing_field):
                invalid_payload = dict(payload)
                del invalid_payload[missing_field]
                response = self.client.post(
                    '/api/risk/check',
                    json=invalid_payload,
                )

                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.get_json()['code'], 40001)
                self.assertIsNone(response.get_json()['data'])

        self.assertEqual(self.store, [])

    def test_invalid_source_returns_bad_request(self):
        payload = self._payload()
        payload['source'] = 'unknown-client'

        response = self.client.post('/api/risk/check', json=payload)

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()['code'], 40001)
        self.assertIsNone(response.get_json()['data'])
        self.assertEqual(self.store, [])

    def test_score_is_always_between_zero_and_one(self):
        payloads = (
            self._payload(content=''),
            self._payload(url='https://bet.example.com', content=''),
            self._payload(content='诈骗内容'),
        )

        for payload in payloads:
            with self.subTest(payload=payload):
                data = self._post_success(payload)
                self.assertGreaterEqual(data['score'], 0)
                self.assertLessEqual(data['score'], 1)

    def test_risk_level_always_uses_formal_enum(self):
        payloads = (
            self._payload(),
            self._payload(url='https://gambling.example.com'),
            self._payload(content='诈骗内容'),
        )

        for payload in payloads:
            with self.subTest(payload=payload):
                data = self._post_success(payload)
                self.assertIn(
                    data['risk_level'],
                    self.FORMAL_RISK_LEVELS,
                )

    def test_reason_is_returned_as_non_empty_string(self):
        data = self._post_success(self._payload(content='诈骗内容'))

        self.assertIsInstance(data['reason'], str)
        self.assertTrue(data['reason'].strip())

    def test_database_unavailable_returns_service_unavailable(self):
        risk_service_module.database.SessionLocal = None

        response = self.client.post(
            '/api/risk/check',
            json=self._payload(),
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()['code'], 50301)
        self.assertIsNone(response.get_json()['data'])
        self.assertEqual(self.store, [])

    def test_formal_endpoint_does_not_call_legacy_routes(self):
        self.assertNotIn(
            '/url/check',
            {rule.rule for rule in self.app.url_map.iter_rules()},
        )

        with patch.object(
            ai_check_module,
            'ai_check',
            side_effect=AssertionError('正式接口不应调用旧 /ai/check'),
        ):
            data = self._post_success(self._payload())

        self.assertEqual(data['risk_level'], 'safe')
        self.assertIsInstance(self.store[0], RiskEvent)


if __name__ == '__main__':
    unittest.main()
