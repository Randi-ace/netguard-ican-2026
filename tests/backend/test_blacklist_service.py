import sys
import types
import unittest
from decimal import Decimal
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.pool import StaticPool


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# 本测试使用独立内存 SQLite，不连接或修改开发者的真实 MySQL。
fake_db = types.ModuleType('db')
fake_db.Base = declarative_base()
fake_db.SessionLocal = None
fake_db.engine = None
fake_db.database_available = False
sys.modules['db'] = fake_db

from models.models import UrlBlacklist  # noqa: E402
from services.blacklist_service import BlacklistService  # noqa: E402


class BlacklistServiceTestCase(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            'sqlite:///:memory:',
            connect_args={'check_same_thread': False},
            poolclass=StaticPool,
        )
        # 生产模型使用 MySQL 5.7 的 CURRENT_TIMESTAMP(6)。SQLite 不支持
        # 该默认值语法，因此只在隔离测试库建立字段等价的 SQLite 表。
        with self.engine.begin() as connection:
            connection.exec_driver_sql('''
                CREATE TABLE url_blacklist (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    domain VARCHAR(253) NOT NULL UNIQUE,
                    match_type VARCHAR(16) NOT NULL DEFAULT 'domain',
                    risk_level VARCHAR(16) NOT NULL DEFAULT 'high',
                    score NUMERIC(5, 4) NOT NULL DEFAULT 0.9500,
                    reason VARCHAR(500) NOT NULL,
                    enabled BOOLEAN NOT NULL DEFAULT 1,
                    source VARCHAR(32) NOT NULL DEFAULT 'manual',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT ck_url_blacklist_score_range
                        CHECK (score >= 0 AND score <= 1)
                )
            ''')
        self.session_factory = sessionmaker(bind=self.engine)
        self.service = BlacklistService(self.session_factory)

    def tearDown(self):
        self.engine.dispose()

    def _add_rule(
        self,
        domain='evil-example.com',
        enabled=True,
        risk_level='high',
        score=Decimal('0.9800'),
        reason='命中后端域名黑名单',
    ):
        session = self.session_factory()
        try:
            session.add(UrlBlacklist(
                id=1,
                domain=domain,
                match_type='domain',
                risk_level=risk_level,
                score=score,
                reason=reason,
                enabled=enabled,
                source='manual',
            ))
            session.commit()
        finally:
            session.close()

    def assertBlacklistHit(self, url):
        result = self.service.check_url(url)
        self.assertIsNotNone(result)
        self.assertEqual(result['check_type'], 'rule')
        self.assertEqual(result['risk_level'], 'high')
        self.assertEqual(result['score'], 0.98)
        self.assertEqual(result['reason'], '命中后端域名黑名单')

    def test_exact_domain_matches(self):
        self._add_rule()
        self.assertBlacklistHit('https://evil-example.com')

    def test_www_domain_matches(self):
        self._add_rule()
        self.assertBlacklistHit('https://www.evil-example.com')

    def test_subdomain_matches(self):
        self._add_rule()
        self.assertBlacklistHit('https://sub.evil-example.com')

    def test_uppercase_url_is_normalized(self):
        self._add_rule(domain='WWW.EVIL-EXAMPLE.COM')
        self.assertBlacklistHit('HTTPS://WWW.EVIL-EXAMPLE.COM')

        session = self.session_factory()
        try:
            stored_rule = session.query(UrlBlacklist).one()
            self.assertEqual(stored_rule.domain, 'evil-example.com')
        finally:
            session.close()

    def test_path_query_and_fragment_do_not_affect_match(self):
        self._add_rule()
        self.assertBlacklistHit(
            'https://evil-example.com/path?a=1#section'
        )

    def test_port_does_not_affect_match(self):
        self._add_rule()
        self.assertBlacklistHit(
            'https://www.evil-example.com:443/path'
        )

    def test_similar_domains_do_not_match(self):
        self._add_rule()
        for url in (
            'https://not-evil-example.com',
            'https://evil-example.com.example.org',
        ):
            with self.subTest(url=url):
                self.assertIsNone(self.service.check_url(url))

    def test_disabled_rule_does_not_match(self):
        self._add_rule(enabled=False)
        self.assertIsNone(
            self.service.check_url('https://evil-example.com')
        )

    def test_model_rejects_score_outside_zero_to_one(self):
        for score in (-0.01, 1.01):
            with self.subTest(score=score), self.assertRaises(ValueError):
                UrlBlacklist(
                    domain='evil-example.com',
                    match_type='domain',
                    risk_level='high',
                    score=score,
                    reason='非法分数规则',
                    enabled=True,
                    source='manual',
                )

    def test_query_exception_returns_no_match(self):
        def failing_session_factory():
            raise RuntimeError('simulated blacklist database failure')

        service = BlacklistService(failing_session_factory)
        with self.assertLogs(
            'services.blacklist_service',
            level='WARNING',
        ):
            result = service.check_url('https://evil-example.com')

        self.assertIsNone(result)


if __name__ == '__main__':
    unittest.main()
