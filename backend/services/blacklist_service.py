import ipaddress
import logging

from sqlalchemy import func

import db as database
from models.models import (
    RISK_LEVELS,
    UrlBlacklist,
    normalize_blacklist_domain,
)


logger = logging.getLogger(__name__)


class BlacklistService:
    """查询后端域名黑名单；查询失败时不阻断既有风险检测。"""

    def __init__(self, session_factory=None):
        self._session_factory = session_factory

    @staticmethod
    def normalize_hostname(url):
        if not isinstance(url, str) or not url.strip():
            return ''

        try:
            return normalize_blacklist_domain(url)
        except ValueError:
            return ''

    @staticmethod
    def _candidate_domains(hostname):
        try:
            ipaddress.ip_address(hostname)
            return [hostname]
        except ValueError:
            labels = hostname.split('.')
            if len(labels) == 1:
                return labels
            return [
                '.'.join(labels[index:])
                for index in range(len(labels) - 1)
            ]

    def check_url(self, url):
        hostname = self.normalize_hostname(url)
        if not hostname:
            return None

        session_factory = self._session_factory or database.SessionLocal
        if session_factory is None:
            logger.warning('数据库不可用，跳过黑名单查询并继续现有风险检测')
            return None

        session = None
        try:
            session = session_factory()
            candidates = self._candidate_domains(hostname)
            matched_rule = (
                session.query(UrlBlacklist)
                .filter(
                    UrlBlacklist.enabled.is_(True),
                    UrlBlacklist.match_type == 'domain',
                    UrlBlacklist.domain.in_(candidates),
                )
                .order_by(func.length(UrlBlacklist.domain).desc())
                .first()
            )
            if matched_rule is None:
                return None

            risk_level = matched_rule.risk_level
            score = float(matched_rule.score)
            if risk_level not in RISK_LEVELS or not 0 <= score <= 1:
                logger.warning(
                    '忽略非法黑名单规则: domain=%s risk_level=%s score=%s',
                    matched_rule.domain,
                    risk_level,
                    score,
                )
                return None

            return {
                'check_type': 'rule',
                'risk_level': risk_level,
                'score': score,
                'reason': matched_rule.reason or (
                    f'命中后端域名黑名单: {matched_rule.domain}'
                ),
            }
        except Exception as exc:
            logger.warning(
                '黑名单查询失败，继续现有 URL 和内容检测: %s',
                exc,
            )
            return None
        finally:
            if session is not None:
                try:
                    session.close()
                except Exception as exc:
                    logger.warning('黑名单查询会话关闭失败: %s', exc)


blacklist_service = BlacklistService()
