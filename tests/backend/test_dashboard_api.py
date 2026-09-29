import sys
import types
import unittest
import uuid
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from flask import Flask
from sqlalchemy import create_engine, event, select
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import declarative_base, sessionmaker


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# 使用隔离的 SQLite 表验证查询，不连接或修改开发者的真实 MySQL。
fake_db = types.ModuleType('db')
fake_db.Base = declarative_base()
fake_db.SessionLocal = None
fake_db.engine = None
fake_db.database_available = False
sys.modules['db'] = fake_db

from models.models import AdEvent, RiskEvent  # noqa: E402
from routes.dashboard import (  # noqa: E402
    _error_response as dashboard_error_response,
    dashboard_bp,
)
from routes.logs import (  # noqa: E402
    _error_response as logs_error_response,
    logs_bp,
)
from routes.statistics import statistics_bp  # noqa: E402
import routes.statistics as statistics_module  # noqa: E402
import services.dashboard_service as dashboard_service_module  # noqa: E402
import services.log_service as log_service_module  # noqa: E402


RISK_EVENTS_SQL = """
CREATE TABLE risk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uuid CHAR(36) NOT NULL UNIQUE,
    user_id BIGINT NULL,
    event_type VARCHAR(32) NOT NULL,
    check_type VARCHAR(20) NOT NULL,
    risk_level VARCHAR(16) NOT NULL,
    risk_score NUMERIC(5, 4) NOT NULL DEFAULT 0,
    url TEXT NULL,
    url_hash CHAR(64) NULL,
    reason VARCHAR(1000) NULL,
    source VARCHAR(20) NOT NULL,
    details JSON NULL,
    occurred_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL
)
"""

AD_EVENTS_SQL = """
CREATE TABLE ad_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uuid CHAR(36) NOT NULL UNIQUE,
    user_id BIGINT NULL,
    action VARCHAR(16) NOT NULL,
    mode VARCHAR(16) NOT NULL,
    page_url TEXT NULL,
    url_hash CHAR(64) NULL,
    resource_type VARCHAR(32) NULL,
    rule_id VARCHAR(100) NULL,
    blocked_count INTEGER NOT NULL DEFAULT 1,
    reason VARCHAR(500) NULL,
    source VARCHAR(20) NOT NULL,
    details JSON NULL,
    occurred_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL
)
"""

SECURITY_LOGS_SQL = """
CREATE TABLE security_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type VARCHAR(32) NOT NULL,
    risk_level VARCHAR(16) NOT NULL,
    url VARCHAR(500) NOT NULL,
    reason VARCHAR(1000) NULL,
    created_at DATETIME NULL
)
"""


class DashboardApiTestCase(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')

        @event.listens_for(self.engine, 'connect')
        def register_mysql_compatible_collation(connection, _record):
            connection.create_collation(
                'utf8mb4_unicode_ci',
                self._compare_unicode_text,
            )

        with self.engine.begin() as connection:
            connection.exec_driver_sql(RISK_EVENTS_SQL)
            connection.exec_driver_sql(AD_EVENTS_SQL)
            connection.exec_driver_sql(SECURITY_LOGS_SQL)

        self.session_factory = sessionmaker(
            bind=self.engine,
            autocommit=False,
            autoflush=False,
        )
        dashboard_service_module.database.SessionLocal = self.session_factory
        log_service_module.database.SessionLocal = self.session_factory
        statistics_module.SessionLocal = self.session_factory
        statistics_module.database_available = True
        statistics_module.memory_logs.clear()

        app = Flask(__name__)
        app.config['TESTING'] = True
        app.register_blueprint(dashboard_bp)
        app.register_blueprint(logs_bp)
        app.register_blueprint(statistics_bp)
        self.client = app.test_client()
        self.shanghai_timezone = ZoneInfo('Asia/Shanghai')
        self.today = datetime.now(self.shanghai_timezone).date()
        self.today_start_utc = datetime.combine(
            self.today,
            time.min,
            tzinfo=self.shanghai_timezone,
        ).astimezone(timezone.utc).replace(tzinfo=None)

    def tearDown(self):
        dashboard_service_module.database.SessionLocal = None
        log_service_module.database.SessionLocal = None
        statistics_module.SessionLocal = None
        statistics_module.database_available = False
        statistics_module.memory_logs.clear()
        self.engine.dispose()

    def _add_risk(
        self,
        check_type='rule',
        risk_level='high',
        occurred_at=None,
        created_at=None,
        event_type='extension_risk',
        reason='风险事件',
        details=None,
    ):
        occurred_at = occurred_at or datetime.combine(
            self.today,
            time(hour=12),
        )
        created_at = created_at or occurred_at
        event = RiskEvent(
            event_uuid=str(uuid.uuid4()),
            event_type=event_type,
            check_type=check_type,
            risk_level=risk_level,
            risk_score=Decimal('0.8000'),
            url='https://example.com/risk',
            reason=reason,
            source='extension',
            details=details,
            occurred_at=occurred_at,
            created_at=created_at,
        )
        session = self.session_factory()
        try:
            session.add(event)
            session.commit()
        finally:
            session.close()

    def _add_ad(
        self,
        blocked_count=1,
        mode='normal',
        occurred_at=None,
        resource_type='iframe',
    ):
        occurred_at = occurred_at or datetime.combine(
            self.today,
            time(hour=13),
        )
        event = AdEvent(
            event_uuid=str(uuid.uuid4()),
            action='blocked',
            mode=mode,
            page_url='https://example.com',
            resource_type=resource_type,
            blocked_count=blocked_count,
            source='extension',
            occurred_at=occurred_at,
            created_at=occurred_at,
        )
        session = self.session_factory()
        try:
            session.add(event)
            session.commit()
        finally:
            session.close()

    @staticmethod
    def _compare_unicode_text(left, right):
        normalized_left = str(left or '').casefold()
        normalized_right = str(right or '').casefold()
        return (
            (normalized_left > normalized_right)
            - (normalized_left < normalized_right)
        )

    def test_empty_database_returns_zero_statistics(self):
        overview_response = self.client.get('/api/dashboard/overview')
        trend_response = self.client.get('/api/dashboard/trend?days=7')
        distribution_response = self.client.get(
            '/api/dashboard/risk-distribution'
        )

        self.assertEqual(overview_response.status_code, 200)
        self.assertTrue(all(
            value == 0
            for value in overview_response.get_json()['data'].values()
        ))
        self.assertEqual(trend_response.get_json()['data']['risk_counts'], [0] * 7)
        self.assertEqual(trend_response.get_json()['data']['ad_counts'], [0] * 7)
        self.assertEqual(
            distribution_response.get_json()['data'],
            {'safe': 0, 'low': 0, 'medium': 0, 'high': 0},
        )

    def test_error_helpers_keep_http_status_and_body_code_aligned(self):
        with self.client.application.app_context():
            for helper_name, helper in (
                ('dashboard', dashboard_error_response),
                ('logs', logs_error_response),
            ):
                for expected_status in (400, 500, 503):
                    with self.subTest(
                        helper=helper_name,
                        status=expected_status,
                    ):
                        response, status_code = helper(
                            '测试错误',
                            expected_status,
                        )
                        self.assertEqual(status_code, expected_status)
                        self.assertEqual(
                            response.get_json()['code'],
                            expected_status,
                        )

    def test_overview_500_and_503_error_contract(self):
        cases = (
            (RuntimeError('未预期异常'), 500),
            (
                dashboard_service_module.DashboardPersistenceError(
                    '数据库不可用'
                ),
                503,
            ),
        )

        for error, expected_status in cases:
            with self.subTest(status=expected_status):
                with patch.object(
                    dashboard_service_module.dashboard_service,
                    'get_overview',
                    side_effect=error,
                ):
                    response = self.client.get('/api/dashboard/overview')

                self.assertEqual(response.status_code, expected_status)
                self.assertEqual(response.get_json()['code'], expected_status)

    def test_trend_400_500_and_503_error_contract(self):
        cases = (
            (
                dashboard_service_module.DashboardValidationError(
                    'days参数无效'
                ),
                400,
            ),
            (RuntimeError('未预期异常'), 500),
            (
                dashboard_service_module.DashboardPersistenceError(
                    '数据库不可用'
                ),
                503,
            ),
        )

        for error, expected_status in cases:
            with self.subTest(status=expected_status):
                with patch.object(
                    dashboard_service_module.dashboard_service,
                    'get_trend',
                    side_effect=error,
                ):
                    response = self.client.get('/api/dashboard/trend?days=7')

                self.assertEqual(response.status_code, expected_status)
                self.assertEqual(response.get_json()['code'], expected_status)

    def test_risk_distribution_500_and_503_error_contract(self):
        cases = (
            (RuntimeError('未预期异常'), 500),
            (
                dashboard_service_module.DashboardPersistenceError(
                    '数据库不可用'
                ),
                503,
            ),
        )

        for error, expected_status in cases:
            with self.subTest(status=expected_status):
                with patch.object(
                    dashboard_service_module.dashboard_service,
                    'get_risk_distribution',
                    side_effect=error,
                ):
                    response = self.client.get(
                        '/api/dashboard/risk-distribution'
                    )

                self.assertEqual(response.status_code, expected_status)
                self.assertEqual(response.get_json()['code'], expected_status)

    def test_risk_logs_400_500_and_503_error_contract(self):
        cases = (
            (
                log_service_module.LogValidationError('分页参数无效'),
                400,
            ),
            (RuntimeError('未预期异常'), 500),
            (
                log_service_module.LogPersistenceError('数据库不可用'),
                503,
            ),
        )

        for error, expected_status in cases:
            with self.subTest(status=expected_status):
                with patch.object(
                    log_service_module.log_service,
                    'get_risk_logs',
                    side_effect=error,
                ):
                    response = self.client.get(
                        '/api/logs/risk?page=1&page_size=20'
                    )

                self.assertEqual(response.status_code, expected_status)
                self.assertEqual(response.get_json()['code'], expected_status)

    def test_overview_counts_ai_url_and_rule_check_types(self):
        self._add_risk(check_type='ai', risk_level='high')
        self._add_risk(check_type='url', risk_level='medium')
        self._add_risk(check_type='rule', risk_level='medium')

        response = self.client.get('/api/dashboard/overview')
        data = response.get_json()['data']

        self.assertEqual(response.status_code, 200)
        self.assertEqual(data['ai_check_count'], 1)
        self.assertEqual(data['url_check_count'], 2)
        self.assertEqual(data['high_risk_count'], 1)
        self.assertEqual(data['today_risk_count'], 3)

    def test_dashboard_excludes_noncanonical_risk_events(self):
        self._add_risk(check_type='ai', risk_level='high')
        self._add_risk(
            event_type='ai_check',
            check_type='ai',
            risk_level='high',
        )
        self._add_risk(check_type='ai_check', risk_level='high')

        overview = self.client.get('/api/dashboard/overview').get_json()['data']
        trend = self.client.get('/api/dashboard/trend?days=7').get_json()['data']
        distribution = self.client.get(
            '/api/dashboard/risk-distribution'
        ).get_json()['data']
        today_index = trend['dates'].index(self.today.isoformat())

        self.assertEqual(overview['ai_check_count'], 1)
        self.assertEqual(overview['today_risk_count'], 1)
        self.assertEqual(trend['risk_counts'][today_index], 1)
        self.assertEqual(distribution['high'], 1)

    def test_normalized_legacy_risk_events_feed_all_dashboard_views(self):
        base_time = datetime.combine(self.today, time(hour=9))
        self._add_risk(
            check_type='ai',
            risk_level='high',
            occurred_at=base_time,
            reason='迁移 AI 风险',
            details={
                'legacy_table': 'security_logs',
                'legacy_id': 1,
                'legacy_type': 'ai_check',
            },
        )
        self._add_risk(
            check_type='url',
            risk_level='medium',
            occurred_at=base_time + timedelta(minutes=1),
            reason='迁移 URL 风险',
            details={
                'legacy_table': 'security_logs',
                'legacy_id': 2,
                'legacy_type': 'url_check',
            },
        )
        self._add_risk(
            check_type='rule',
            risk_level='low',
            occurred_at=base_time + timedelta(minutes=2),
            reason='迁移规则风险',
            details={
                'legacy_table': 'detection_records',
                'legacy_id': 3,
                'legacy_check_type': 'rule',
            },
        )

        overview = self.client.get('/api/dashboard/overview').get_json()['data']
        trend = self.client.get('/api/dashboard/trend?days=7').get_json()['data']
        distribution = self.client.get(
            '/api/dashboard/risk-distribution'
        ).get_json()['data']
        logs = self.client.get(
            '/api/logs/risk?page=1&page_size=20'
        ).get_json()['data']
        today_index = trend['dates'].index(self.today.isoformat())

        self.assertEqual(overview['ai_check_count'], 1)
        self.assertEqual(overview['url_check_count'], 2)
        self.assertEqual(overview['high_risk_count'], 1)
        self.assertEqual(overview['today_risk_count'], 3)
        self.assertEqual(trend['risk_counts'][today_index], 3)
        self.assertEqual(
            distribution,
            {'safe': 0, 'low': 1, 'medium': 1, 'high': 1},
        )
        self.assertEqual(logs['pagination']['total'], 3)
        self.assertEqual(
            {record['reason'] for record in logs['records']},
            {'迁移 AI 风险', '迁移 URL 风险', '迁移规则风险'},
        )

    def test_stats_uses_risk_event_fields_without_changing_response(self):
        today_at = datetime.combine(self.today, time(hour=12))
        yesterday_at = today_at - timedelta(days=1)
        self._add_risk(
            check_type='ai',
            risk_level='high',
            occurred_at=today_at,
            created_at=yesterday_at,
        )
        self._add_risk(
            check_type='rule',
            risk_level='medium',
            occurred_at=yesterday_at,
            created_at=today_at,
        )
        self._add_risk(
            event_type='url_check',
            check_type='url',
            risk_level='low',
            occurred_at=today_at,
        )

        response = self.client.get('/api/stats')
        data = response.get_json()['data']
        trend_by_date = {
            item['date']: item['count'] for item in data['trend_data']
        }

        self.assertEqual(response.status_code, 200)
        self.assertEqual(data['ai_count'], 1)
        self.assertEqual(data['url_count'], 1)
        self.assertEqual(data['high_risk'], 1)
        self.assertEqual(data['medium_risk'], 1)
        self.assertEqual(data['low_risk'], 0)
        self.assertEqual(data['today_count'], 1)
        self.assertEqual(trend_by_date[self.today.strftime('%m-%d')], 1)
        self.assertEqual(
            trend_by_date[(self.today - timedelta(days=1)).strftime('%m-%d')],
            1,
        )
        self.assertEqual(
            set(data),
            {
                'ai_count',
                'url_count',
                'high_risk',
                'medium_risk',
                'low_risk',
                'today_count',
                'ad_block_count',
                'child_mode_count',
                'elder_mode_count',
                'trend_data',
                'strict_mode_count',
                'entertainment_block_count',
                'game_block_count',
                'dangerous_block_count',
            },
        )

    def test_stats_memory_fallback_uses_canonical_risk_fields(self):
        statistics_module.database_available = False
        statistics_module.memory_logs.extend([
            {
                'event_type': 'extension_risk',
                'check_type': 'ai',
                'risk_level': 'high',
            },
            {
                'event_type': 'extension_risk',
                'check_type': 'rule',
                'risk_level': 'medium',
            },
            {
                'event_type': 'ai_check',
                'check_type': 'ai',
                'risk_level': 'high',
            },
        ])

        data = self.client.get('/api/stats').get_json()['data']

        self.assertEqual(data['ai_count'], 1)
        self.assertEqual(data['url_count'], 1)
        self.assertEqual(data['high_risk'], 1)
        self.assertEqual(data['medium_risk'], 1)
        self.assertEqual(data['today_count'], 2)

    def test_beijing_early_morning_events_belong_to_today(self):
        early_today_utc = self.today_start_utc + timedelta(minutes=30)
        late_yesterday_utc = self.today_start_utc - timedelta(minutes=30)
        self._add_risk(occurred_at=early_today_utc)
        self._add_risk(occurred_at=late_yesterday_utc)
        self._add_ad(blocked_count=3, occurred_at=early_today_utc)
        self._add_ad(blocked_count=5, occurred_at=late_yesterday_utc)

        overview = self.client.get('/api/dashboard/overview').get_json()['data']
        trend = self.client.get('/api/dashboard/trend?days=7').get_json()['data']
        today_index = trend['dates'].index(self.today.isoformat())
        yesterday_index = trend['dates'].index(
            (self.today - timedelta(days=1)).isoformat()
        )

        self.assertEqual(early_today_utc.date(), self.today - timedelta(days=1))
        self.assertEqual(overview['today_risk_count'], 1)
        self.assertEqual(overview['today_ad_count'], 3)
        self.assertEqual(trend['risk_counts'][today_index], 1)
        self.assertEqual(trend['risk_counts'][yesterday_index], 1)
        self.assertEqual(trend['ad_counts'][today_index], 3)
        self.assertEqual(trend['ad_counts'][yesterday_index], 5)

    def test_overview_sums_ad_blocked_count(self):
        self._add_ad(blocked_count=2, mode='normal')
        self._add_ad(blocked_count=5, mode='child')
        yesterday = datetime.combine(
            self.today - timedelta(days=1),
            time(hour=13),
        )
        self._add_ad(blocked_count=4, mode='elder', occurred_at=yesterday)

        response = self.client.get('/api/dashboard/overview')
        data = response.get_json()['data']

        self.assertEqual(data['ad_block_count'], 11)
        self.assertEqual(data['today_ad_count'], 7)
        self.assertEqual(data['child_mode_count'], 1)
        self.assertEqual(data['elder_mode_count'], 1)

    def test_trend_groups_events_by_date(self):
        yesterday = self.today - timedelta(days=1)
        yesterday_at = datetime.combine(yesterday, time(hour=10))
        today_at = datetime.combine(self.today, time(hour=10))
        self._add_risk(occurred_at=yesterday_at)
        self._add_risk(occurred_at=yesterday_at + timedelta(hours=1))
        self._add_risk(occurred_at=today_at)
        self._add_ad(blocked_count=4, occurred_at=yesterday_at)
        self._add_ad(blocked_count=6, occurred_at=today_at)

        response = self.client.get('/api/dashboard/trend?days=7')
        data = response.get_json()['data']
        yesterday_index = data['dates'].index(yesterday.isoformat())
        today_index = data['dates'].index(self.today.isoformat())

        self.assertEqual(data['risk_counts'][yesterday_index], 2)
        self.assertEqual(data['risk_counts'][today_index], 1)
        self.assertEqual(data['ad_counts'][yesterday_index], 4)
        self.assertEqual(data['ad_counts'][today_index], 6)

    def test_risk_distribution_counts_all_levels(self):
        for risk_level in ('safe', 'low', 'medium', 'high'):
            self._add_risk(risk_level=risk_level)
        self._add_risk(risk_level='high')

        response = self.client.get('/api/dashboard/risk-distribution')

        self.assertEqual(
            response.get_json()['data'],
            {'safe': 1, 'low': 1, 'medium': 1, 'high': 2},
        )

    def test_unified_logs_support_pagination(self):
        base_time = datetime.combine(self.today, time(hour=8))
        self._add_risk(
            check_type='ai',
            occurred_at=base_time,
            reason='AI风险',
        )
        self._add_risk(
            check_type='rule',
            occurred_at=base_time + timedelta(minutes=1),
            reason='URL风险',
        )
        self._add_ad(
            blocked_count=2,
            occurred_at=base_time + timedelta(minutes=2),
            resource_type='script',
        )

        first_page = self.client.get('/api/logs/risk?page=1&page_size=2')
        second_page = self.client.get('/api/logs/risk?page=2&page_size=2')
        first_data = first_page.get_json()['data']
        second_data = second_page.get_json()['data']

        self.assertEqual(first_data['pagination']['total'], 3)
        self.assertEqual(first_data['pagination']['pages'], 2)
        self.assertEqual(len(first_data['records']), 2)
        self.assertEqual(len(second_data['records']), 1)
        self.assertEqual(first_data['records'][0]['type'], '广告拦截')
        self.assertEqual(first_data['records'][1]['type'], 'URL检测')
        self.assertEqual(second_data['records'][0]['type'], 'AI检测')

    def test_unified_logs_merge_risk_and_ad_with_null_risk_level(self):
        base_time = datetime.combine(self.today, time(hour=8))
        self._add_risk(
            check_type='ai',
            occurred_at=base_time,
            reason='风险事件',
        )
        self._add_ad(
            blocked_count=2,
            occurred_at=base_time + timedelta(minutes=1),
            resource_type='iframe',
        )

        first_page = self.client.get('/api/logs/risk?page=1&page_size=1')
        second_page = self.client.get('/api/logs/risk?page=2&page_size=1')
        first_data = first_page.get_json()['data']
        second_data = second_page.get_json()['data']

        self.assertEqual(first_page.status_code, 200)
        self.assertEqual(second_page.status_code, 200)
        self.assertEqual(first_data['pagination'], {
            'page': 1,
            'page_size': 1,
            'total': 2,
            'pages': 2,
        })
        self.assertEqual(second_data['pagination']['page'], 2)
        self.assertEqual(first_data['records'][0]['type'], '广告拦截')
        self.assertIsNone(first_data['records'][0]['risk_level'])
        self.assertEqual(second_data['records'][0]['type'], 'AI检测')
        self.assertEqual(second_data['records'][0]['risk_level'], 'high')

    def test_unified_logs_mysql_sql_normalizes_union_collations(self):
        events = log_service_module.log_service._build_unified_events_query()
        statement = select(events)
        sql = str(statement.compile(
            dialect=mysql.dialect(),
            compile_kwargs={'literal_binds': True},
        ))

        self.assertIn('UNION ALL', sql)
        self.assertEqual(sql.count('CHARACTER SET utf8mb4'), 10)
        self.assertEqual(sql.count('COLLATE utf8mb4_unicode_ci'), 10)


if __name__ == '__main__':
    unittest.main()
