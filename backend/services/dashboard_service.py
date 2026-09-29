import logging
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import and_, case, func

import db as database
from models.models import AdEvent, CHECK_TYPES, RISK_LEVELS, RiskEvent


logger = logging.getLogger(__name__)


class DashboardValidationError(ValueError):
    """Dashboard 查询参数不合法。"""


class DashboardPersistenceError(RuntimeError):
    """Dashboard 数据无法从数据库读取。"""


class DashboardService:
    """统一提供风险和广告事件的 Dashboard 聚合统计。"""

    SUPPORTED_TREND_DAYS = (7, 30, 90)
    DASHBOARD_TIMEZONE = ZoneInfo('Asia/Shanghai')
    RISK_EVENT_TYPE = 'extension_risk'

    def get_overview(self):
        session = self._create_session()
        today_start, tomorrow_start = self._today_range()
        try:
            risk_stats = session.query(
                func.coalesce(func.sum(case(
                    (RiskEvent.check_type == 'ai', 1),
                    else_=0,
                )), 0).label('ai_check_count'),
                func.coalesce(func.sum(case(
                    (RiskEvent.check_type.in_(('url', 'rule')), 1),
                    else_=0,
                )), 0).label('url_check_count'),
                func.coalesce(func.sum(case(
                    (RiskEvent.risk_level == 'high', 1),
                    else_=0,
                )), 0).label('high_risk_count'),
                func.coalesce(func.sum(case(
                    (
                        and_(
                            RiskEvent.occurred_at >= today_start,
                            RiskEvent.occurred_at < tomorrow_start,
                        ),
                        1,
                    ),
                    else_=0,
                )), 0).label('today_risk_count'),
            ).filter(
                RiskEvent.event_type == self.RISK_EVENT_TYPE,
                RiskEvent.check_type.in_(CHECK_TYPES),
            ).one()

            ad_stats = session.query(
                func.coalesce(
                    func.sum(AdEvent.blocked_count),
                    0,
                ).label('ad_block_count'),
                func.coalesce(func.sum(case(
                    (AdEvent.mode == 'child', 1),
                    else_=0,
                )), 0).label('child_mode_count'),
                func.coalesce(func.sum(case(
                    (AdEvent.mode == 'elder', 1),
                    else_=0,
                )), 0).label('elder_mode_count'),
                func.coalesce(func.sum(case(
                    (
                        and_(
                            AdEvent.occurred_at >= today_start,
                            AdEvent.occurred_at < tomorrow_start,
                        ),
                        AdEvent.blocked_count,
                    ),
                    else_=0,
                )), 0).label('today_ad_count'),
            ).one()

            return {
                'ai_check_count': self._to_int(
                    risk_stats.ai_check_count
                ),
                'url_check_count': self._to_int(
                    risk_stats.url_check_count
                ),
                'high_risk_count': self._to_int(
                    risk_stats.high_risk_count
                ),
                'ad_block_count': self._to_int(
                    ad_stats.ad_block_count
                ),
                'child_mode_count': self._to_int(
                    ad_stats.child_mode_count
                ),
                'elder_mode_count': self._to_int(
                    ad_stats.elder_mode_count
                ),
                'today_risk_count': self._to_int(
                    risk_stats.today_risk_count
                ),
                'today_ad_count': self._to_int(
                    ad_stats.today_ad_count
                ),
            }
        except Exception as exc:
            logger.exception('Dashboard 总览统计查询失败')
            raise DashboardPersistenceError('Dashboard统计查询失败') from exc
        finally:
            session.close()

    def get_trend(self, days):
        days = self._validate_days(days)
        end_date = self._shanghai_today()
        start_date = end_date - timedelta(days=days - 1)
        start_at, end_at = self._local_date_range_to_utc(
            start_date,
            end_date + timedelta(days=1),
        )
        session = self._create_session()

        try:
            risk_rows = session.query(
                RiskEvent.occurred_at.label('occurred_at'),
            ).filter(
                RiskEvent.event_type == self.RISK_EVENT_TYPE,
                RiskEvent.check_type.in_(CHECK_TYPES),
                RiskEvent.occurred_at >= start_at,
                RiskEvent.occurred_at < end_at,
            ).all()

            ad_rows = session.query(
                AdEvent.occurred_at.label('occurred_at'),
                AdEvent.blocked_count.label('blocked_count'),
            ).filter(
                AdEvent.occurred_at >= start_at,
                AdEvent.occurred_at < end_at,
            ).all()

            risk_by_date = self._group_risk_rows_by_local_date(risk_rows)
            ad_by_date = self._group_ad_rows_by_local_date(ad_rows)
            dates = [
                start_date + timedelta(days=offset)
                for offset in range(days)
            ]

            return {
                'dates': [date.isoformat() for date in dates],
                'risk_counts': [
                    risk_by_date.get(date.isoformat(), 0)
                    for date in dates
                ],
                'ad_counts': [
                    ad_by_date.get(date.isoformat(), 0)
                    for date in dates
                ],
            }
        except Exception as exc:
            logger.exception('Dashboard 趋势统计查询失败')
            raise DashboardPersistenceError('Dashboard趋势查询失败') from exc
        finally:
            session.close()

    def get_risk_distribution(self):
        session = self._create_session()
        try:
            rows = session.query(
                RiskEvent.risk_level,
                func.count(RiskEvent.id).label('event_count'),
            ).filter(
                RiskEvent.event_type == self.RISK_EVENT_TYPE,
                RiskEvent.check_type.in_(CHECK_TYPES),
            ).group_by(
                RiskEvent.risk_level
            ).all()

            distribution = {level: 0 for level in RISK_LEVELS}
            for risk_level, event_count in rows:
                if risk_level in distribution:
                    distribution[risk_level] = self._to_int(event_count)
            return distribution
        except Exception as exc:
            logger.exception('风险等级分布查询失败')
            raise DashboardPersistenceError('风险等级统计查询失败') from exc
        finally:
            session.close()

    @classmethod
    def _validate_days(cls, days):
        try:
            days = int(days)
        except (TypeError, ValueError) as exc:
            raise DashboardValidationError('days必须是7、30或90') from exc

        if days not in cls.SUPPORTED_TREND_DAYS:
            raise DashboardValidationError('days必须是7、30或90')
        return days

    @staticmethod
    def _create_session():
        session_factory = database.SessionLocal
        if session_factory is None:
            raise DashboardPersistenceError('数据库不可用，无法查询Dashboard')

        try:
            return session_factory()
        except Exception as exc:
            raise DashboardPersistenceError('数据库会话创建失败') from exc

    @classmethod
    def _today_range(cls):
        today = cls._shanghai_today()
        return cls._local_date_range_to_utc(
            today,
            today + timedelta(days=1),
        )

    @classmethod
    def _shanghai_today(cls):
        return datetime.now(cls.DASHBOARD_TIMEZONE).date()

    @classmethod
    def _local_date_range_to_utc(cls, start_date, end_date):
        local_start = datetime.combine(
            start_date,
            time.min,
            tzinfo=cls.DASHBOARD_TIMEZONE,
        )
        local_end = datetime.combine(
            end_date,
            time.min,
            tzinfo=cls.DASHBOARD_TIMEZONE,
        )
        return (
            local_start.astimezone(timezone.utc).replace(tzinfo=None),
            local_end.astimezone(timezone.utc).replace(tzinfo=None),
        )

    @classmethod
    def _group_risk_rows_by_local_date(cls, rows):
        counts = {}
        for row in rows:
            date_key = cls._to_local_date_key(row.occurred_at)
            counts[date_key] = counts.get(date_key, 0) + 1
        return counts

    @classmethod
    def _group_ad_rows_by_local_date(cls, rows):
        counts = {}
        for row in rows:
            date_key = cls._to_local_date_key(row.occurred_at)
            counts[date_key] = (
                counts.get(date_key, 0)
                + cls._to_int(row.blocked_count)
            )
        return counts

    @classmethod
    def _to_local_date_key(cls, value):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        else:
            value = value.astimezone(timezone.utc)
        return value.astimezone(cls.DASHBOARD_TIMEZONE).date().isoformat()

    @staticmethod
    def _to_int(value):
        return int(value or 0)


dashboard_service = DashboardService()
