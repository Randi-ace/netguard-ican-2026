import logging
from datetime import timezone

from sqlalchemy import case, cast, func, literal, null, select, union_all
from sqlalchemy.dialects.mysql import CHAR

import db as database
from models.models import AdEvent, RiskEvent


logger = logging.getLogger(__name__)


class LogValidationError(ValueError):
    """日志查询参数不合法。"""


class LogPersistenceError(RuntimeError):
    """日志无法从数据库读取。"""


class LogService:
    """把风险事件和广告事件映射为统一日志格式。"""

    DEFAULT_PAGE_SIZE = 20
    MAX_PAGE_SIZE = 100
    UNION_CHARSET = 'utf8mb4'
    UNION_COLLATION = 'utf8mb4_unicode_ci'

    def get_risk_logs(self, page=1, page_size=DEFAULT_PAGE_SIZE):
        page = self._validate_positive_integer(page, 'page')
        page_size = self._validate_positive_integer(page_size, 'page_size')
        if page_size > self.MAX_PAGE_SIZE:
            raise LogValidationError(
                f'page_size不能超过{self.MAX_PAGE_SIZE}'
            )

        session = self._create_session()
        try:
            total = self._get_total(session)
            events = self._build_unified_events_query()
            statement = select(
                events.c.id,
                events.c.type,
                events.c.url,
                events.c.risk_level,
                events.c.reason,
                events.c.occurred_at,
            ).order_by(
                events.c.occurred_at.desc(),
                events.c.event_kind.asc(),
                events.c.id.desc(),
            ).offset(
                (page - 1) * page_size
            ).limit(page_size)

            rows = session.execute(statement).all()
            records = [self._serialize_row(row) for row in rows]
            return {
                'records': records,
                'pagination': {
                    'page': page,
                    'page_size': page_size,
                    'total': total,
                    'pages': (total + page_size - 1) // page_size,
                },
            }
        except LogValidationError:
            raise
        except Exception as exc:
            logger.exception('统一事件日志查询失败')
            raise LogPersistenceError('事件日志查询失败') from exc
        finally:
            session.close()

    @staticmethod
    def _build_unified_events_query():
        risk_type = case(
            (RiskEvent.check_type.in_(('ai', 'text')), 'AI检测'),
            else_='URL检测',
        )
        risk_events = select(
            RiskEvent.id.label('id'),
            LogService._union_text(risk_type, 32).label('type'),
            LogService._union_text(RiskEvent.url, 4096).label('url'),
            LogService._union_text(
                RiskEvent.risk_level,
                16,
            ).label('risk_level'),
            LogService._union_text(
                func.coalesce(RiskEvent.reason, ''),
                1000,
            ).label('reason'),
            RiskEvent.occurred_at.label('occurred_at'),
            LogService._union_text(
                literal('risk'),
                8,
            ).label('event_kind'),
        )

        ad_events = select(
            AdEvent.id.label('id'),
            LogService._union_text(
                literal('广告拦截'),
                32,
            ).label('type'),
            LogService._union_text(AdEvent.page_url, 4096).label('url'),
            LogService._union_text(
                null(),
                16,
            ).label('risk_level'),
            LogService._union_text(
                func.coalesce(
                    AdEvent.reason,
                    AdEvent.resource_type,
                    '',
                ),
                1000,
            ).label('reason'),
            AdEvent.occurred_at.label('occurred_at'),
            LogService._union_text(
                literal('ad'),
                8,
            ).label('event_kind'),
        )

        return union_all(risk_events, ad_events).subquery(
            'unified_event_logs'
        )

    @classmethod
    def _union_text(cls, expression, length):
        return cast(
            expression,
            CHAR(length, charset=cls.UNION_CHARSET),
        ).collate(cls.UNION_COLLATION)

    @staticmethod
    def _get_total(session):
        risk_total = session.query(func.count(RiskEvent.id)).scalar() or 0
        ad_total = session.query(func.count(AdEvent.id)).scalar() or 0
        return int(risk_total) + int(ad_total)

    @staticmethod
    def _serialize_row(row):
        values = row._mapping
        return {
            'id': values['id'],
            'type': values['type'],
            'url': values['url'] or '',
            'risk_level': values['risk_level'],
            'reason': values['reason'] or '',
            'time': LogService._format_utc(values['occurred_at']),
        }

    @staticmethod
    def _validate_positive_integer(value, field):
        try:
            parsed = int(value)
        except (TypeError, ValueError) as exc:
            raise LogValidationError(f'{field}必须为正整数') from exc

        if parsed < 1:
            raise LogValidationError(f'{field}必须为正整数')
        return parsed

    @staticmethod
    def _create_session():
        session_factory = database.SessionLocal
        if session_factory is None:
            raise LogPersistenceError('数据库不可用，无法查询事件日志')

        try:
            return session_factory()
        except Exception as exc:
            raise LogPersistenceError('数据库会话创建失败') from exc

    @staticmethod
    def _format_utc(value):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


log_service = LogService()
