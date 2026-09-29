import sys
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from flask import Flask
from sqlalchemy.orm import declarative_base


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# 事件接口测试不应连接或修改开发者的真实 MySQL。
fake_db = types.ModuleType('db')
fake_db.Base = declarative_base()
fake_db.SessionLocal = None
fake_db.engine = None
fake_db.database_available = False
sys.modules['db'] = fake_db

fake_ai_service = types.ModuleType('services.ai_service')
fake_ai_service.ai_service = types.SimpleNamespace(
    analyze_text=lambda _content: {
        'risk': 'safe',
        'score': 0.05,
        'reason': '测试环境 AI 检测结果',
    }
)
sys.modules['services.ai_service'] = fake_ai_service

from models.models import AdEvent, RiskEvent  # noqa: E402
from routes.events import events_bp  # noqa: E402
import services.event_service as event_service_module  # noqa: E402
import services.risk_service as risk_service_module  # noqa: E402


class FakeQuery:
    def __init__(self, store, model):
        self._items = store.setdefault(model, [])
        self._event_uuid = None

    def filter(self, expression):
        self._event_uuid = expression.right.value
        return self

    def first(self):
        return next(
            (
                item for item in self._items
                if item.event_uuid == self._event_uuid
            ),
            None,
        )


class FakeSession:
    def __init__(self, store):
        self._store = store
        self._pending = []

    def query(self, model):
        return FakeQuery(self._store, model)

    def add(self, event):
        items = self._store.setdefault(type(event), [])
        event.id = len(items) + len(self._pending) + 1
        self._pending.append(event)

    def commit(self):
        for event in self._pending:
            self._store.setdefault(type(event), []).append(event)
        self._pending.clear()

    def rollback(self):
        self._pending.clear()

    def close(self):
        pass


class EventApiTestCase(unittest.TestCase):
    def setUp(self):
        self.store = {}
        session_factory = lambda: FakeSession(self.store)
        event_service_module.database.SessionLocal = session_factory
        risk_service_module.database.SessionLocal = session_factory
        app = Flask(__name__)
        app.register_blueprint(events_bp)
        app.config['TESTING'] = True
        self.client = app.test_client()

    def tearDown(self):
        event_service_module.database.SessionLocal = None
        risk_service_module.database.SessionLocal = None

    @staticmethod
    def _risk_payload(event_uuid=None):
        return {
            'event_uuid': event_uuid or str(uuid.uuid4()),
            'url': 'https://example.com/risk',
            'risk_level': 'high',
            'score': 0.91,
            'reason': '命中插件本地风险规则',
            'source': 'extension',
        }

    @staticmethod
    def _ad_payload(event_uuid=None):
        return {
            'event_uuid': event_uuid or str(uuid.uuid4()),
            'page_url': 'https://example.com',
            'resource_type': 'iframe',
            'blocked_count': 3,
            'mode': 'normal',
        }

    def test_risk_event_without_check_type_defaults_to_rule(self):
        response = self.client.post(
            '/api/events/risk',
            json=self._risk_payload(),
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()['code'], 0)
        self.assertEqual(len(self.store[RiskEvent]), 1)
        event = self.store[RiskEvent][0]
        self.assertEqual(event.event_type, 'extension_risk')
        self.assertEqual(event.check_type, 'rule')
        self.assertEqual(event.source, 'extension')

    def test_ai_risk_event_saves_payload_check_type(self):
        payload = self._risk_payload()
        payload['check_type'] = 'ai'

        response = self.client.post('/api/events/risk', json=payload)

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()['code'], 0)
        self.assertEqual(len(self.store[RiskEvent]), 1)
        event = self.store[RiskEvent][0]
        self.assertEqual(event.event_type, 'extension_risk')
        self.assertEqual(event.check_type, 'ai')

    def test_risk_service_uses_unified_event_type(self):
        risk_service_module.risk_service.save_risk_event(
            url='https://example.com/backend-check',
            source='backend',
            result={
                'check_type': 'url',
                'risk_level': 'medium',
                'score': 0.62,
                'reason': '后端 URL 检测命中风险特征',
            },
        )

        self.assertEqual(len(self.store[RiskEvent]), 1)
        event = self.store[RiskEvent][0]
        self.assertEqual(event.event_type, 'extension_risk')
        self.assertEqual(event.check_type, 'url')

    def test_risk_service_rejects_unknown_check_type(self):
        with self.assertRaises(
            risk_service_module.RiskPersistenceError
        ):
            risk_service_module.risk_service.save_risk_event(
                url='https://example.com/invalid-check-type',
                source='backend',
                result={
                    'check_type': 'text',
                    'risk_level': 'medium',
                    'score': 0.62,
                    'reason': '非法检测类型不应写入数据库',
                },
            )

        self.assertEqual(self.store.get(RiskEvent, []), [])

    def test_risk_event_is_idempotent(self):
        event_uuid = str(uuid.uuid4())
        payload = self._risk_payload(event_uuid)

        first_response = self.client.post('/api/events/risk', json=payload)
        second_response = self.client.post('/api/events/risk', json=payload)

        self.assertEqual(first_response.status_code, 201)
        self.assertEqual(second_response.status_code, 200)
        self.assertEqual(second_response.get_json()['code'], 1)
        self.assertEqual(second_response.get_json()['message'], 'duplicate')
        self.assertEqual(len(self.store[RiskEvent]), 1)

    def test_risk_score_must_be_between_zero_and_one(self):
        payload = self._risk_payload()
        payload['score'] = 1.1

        response = self.client.post('/api/events/risk', json=payload)

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()['code'], 400)
        self.assertIsNone(response.get_json()['data'])

    def test_create_ad_event(self):
        with self.assertLogs(
            'services.event_service',
            level='WARNING',
        ) as captured_logs:
            response = self.client.post(
                '/api/events/ad',
                json=self._ad_payload(),
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()['code'], 0)
        self.assertTrue(any(
            '[AD_EVENT_RECEIVED]' in message
            for message in captured_logs.output
        ))
        self.assertEqual(len(self.store[AdEvent]), 1)
        event = self.store[AdEvent][0]
        self.assertEqual(event.action, 'blocked')
        self.assertEqual(event.blocked_count, 3)
        self.assertEqual(event.source, 'extension')

    def test_ad_blocked_count_must_be_non_negative_integer(self):
        for invalid_value in (-1, 1.5, True, '1'):
            with self.subTest(invalid_value=invalid_value):
                payload = self._ad_payload()
                payload['blocked_count'] = invalid_value

                response = self.client.post('/api/events/ad', json=payload)

                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.get_json()['code'], 400)

    def test_database_unavailable_returns_service_unavailable(self):
        event_service_module.database.SessionLocal = None

        requests = (
            ('/api/events/risk', self._risk_payload()),
            ('/api/events/ad', self._ad_payload()),
        )

        for path, payload in requests:
            with self.subTest(path=path):
                response = self.client.post(path, json=payload)

                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.get_json()['code'], 503)
                self.assertIsNone(response.get_json()['data'])

    def test_unexpected_service_error_returns_internal_error(self):
        requests = (
            (
                '/api/events/risk',
                self._risk_payload(),
                'create_risk_event',
            ),
            (
                '/api/events/ad',
                self._ad_payload(),
                'create_ad_event',
            ),
        )

        for path, payload, method_name in requests:
            with self.subTest(path=path), patch.object(
                event_service_module.event_service,
                method_name,
                side_effect=RuntimeError('unexpected test failure'),
            ):
                response = self.client.post(path, json=payload)

                self.assertEqual(response.status_code, 500)
                self.assertEqual(response.get_json()['code'], 500)
                self.assertIsNone(response.get_json()['data'])


if __name__ == '__main__':
    unittest.main()
