import hashlib
import logging
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from uuid import UUID

from sqlalchemy.exc import IntegrityError

import db as database
from models.models import (
    AdEvent,
    CHECK_TYPES,
    MODES,
    RISK_LEVELS,
    SOURCES,
    RiskEvent,
)


logger = logging.getLogger(__name__)


class EventValidationError(ValueError):
    """事件上报请求参数不合法。"""


class EventPersistenceError(RuntimeError):
    """事件无法写入数据库。"""


class EventService:
    """统一校验并持久化插件上报的风险事件和广告事件。"""

    MAX_URL_LENGTH = 4096
    MAX_REASON_LENGTH = 1000
    MAX_RESOURCE_TYPE_LENGTH = 32

    def create_risk_event(self, payload):
        event_data = self._validate_risk_payload(payload)
        now_utc = self._utc_now()
        event = RiskEvent(
            event_uuid=event_data['event_uuid'],
            event_type='extension_risk',
            check_type=event_data.get('check_type', 'rule'),
            risk_level=event_data['risk_level'],
            risk_score=event_data['score'],
            url=event_data['url'],
            url_hash=self._hash_url(event_data['url']),
            reason=event_data['reason'],
            source=event_data['source'],
            occurred_at=now_utc,
            created_at=now_utc,
        )
        return self._save_event(RiskEvent, event)

    def create_ad_event(self, payload):
        logger.warning('[AD_EVENT_RECEIVED] payload=%s', payload)
        event_data = self._validate_ad_payload(payload)
        now_utc = self._utc_now()
        event = AdEvent(
            event_uuid=event_data['event_uuid'],
            action='blocked',
            mode=event_data['mode'],
            page_url=event_data['page_url'],
            url_hash=self._hash_url(event_data['page_url']),
            resource_type=event_data['resource_type'],
            blocked_count=event_data['blocked_count'],
            source='extension',
            occurred_at=now_utc,
            created_at=now_utc,
        )
        return self._save_event(AdEvent, event)

    def _save_event(self, model, event):
        session = self._create_session()
        try:
            existing = self._find_by_uuid(
                session,
                model,
                event.event_uuid,
            )
            if existing is not None:
                return self._event_result(existing, duplicate=True)

            session.add(event)
            session.commit()
            return self._event_result(event, duplicate=False)
        except IntegrityError as exc:
            session.rollback()
            existing = self._find_by_uuid(
                session,
                model,
                event.event_uuid,
            )
            if existing is not None:
                return self._event_result(existing, duplicate=True)

            logger.exception('事件唯一键冲突后未找到已有事件')
            raise EventPersistenceError('事件保存失败') from exc
        except EventPersistenceError:
            session.rollback()
            raise
        except Exception as exc:
            session.rollback()
            logger.exception('事件写入数据库失败')
            raise EventPersistenceError('事件保存失败') from exc
        finally:
            session.close()

    @staticmethod
    def _find_by_uuid(session, model, event_uuid):
        return session.query(model).filter(
            model.event_uuid == event_uuid
        ).first()

    @staticmethod
    def _event_result(event, duplicate):
        return {
            'duplicate': duplicate,
            'data': {
                'event_id': event.id,
                'event_uuid': event.event_uuid,
                'occurred_at': EventService._format_utc(event.occurred_at),
            },
        }

    @staticmethod
    def _create_session():
        session_factory = database.SessionLocal
        if session_factory is None:
            raise EventPersistenceError('数据库不可用，事件未保存')

        try:
            return session_factory()
        except Exception as exc:
            raise EventPersistenceError('数据库会话创建失败') from exc

    def _validate_risk_payload(self, payload):
        self._require_json_object(payload)
        event_uuid = self._validate_event_uuid(payload.get('event_uuid'))
        url = self._validate_required_string(
            payload.get('url'),
            'url',
            self.MAX_URL_LENGTH,
        )

        risk_level = payload.get('risk_level')
        if not isinstance(risk_level, str) or not risk_level.strip():
            raise EventValidationError('risk_level不能为空')
        risk_level = risk_level.strip()
        if risk_level not in RISK_LEVELS:
            raise EventValidationError(
                f"risk_level必须是以下值之一: {', '.join(RISK_LEVELS)}"
            )

        score = self._validate_score(payload.get('score'))
        reason = self._validate_required_string(
            payload.get('reason'),
            'reason',
            self.MAX_REASON_LENGTH,
        )

        source = payload.get('source')
        if not isinstance(source, str) or not source.strip():
            raise EventValidationError('source不能为空')
        source = source.strip()
        if source not in SOURCES:
            raise EventValidationError(
                f"source必须是以下值之一: {', '.join(SOURCES)}"
            )

        check_type = payload.get('check_type', 'rule')
        if not isinstance(check_type, str) or not check_type.strip():
            raise EventValidationError('check_type不能为空')
        check_type = check_type.strip()
        if check_type not in CHECK_TYPES:
            raise EventValidationError(
                f"check_type必须是以下值之一: {', '.join(CHECK_TYPES)}"
            )

        return {
            'event_uuid': event_uuid,
            'url': url,
            'risk_level': risk_level,
            'score': score,
            'reason': reason,
            'source': source,
            'check_type': check_type,
        }

    def _validate_ad_payload(self, payload):
        self._require_json_object(payload)
        event_uuid = self._validate_event_uuid(payload.get('event_uuid'))
        page_url = self._validate_required_string(
            payload.get('page_url'),
            'page_url',
            self.MAX_URL_LENGTH,
        )

        blocked_count = payload.get('blocked_count')
        if isinstance(blocked_count, bool) or not isinstance(
            blocked_count,
            int,
        ):
            raise EventValidationError('blocked_count必须为整数')
        if blocked_count < 0:
            raise EventValidationError('blocked_count必须大于或等于0')

        mode = payload.get('mode', 'normal')
        if not isinstance(mode, str) or mode not in MODES:
            raise EventValidationError(
                f"mode必须是以下值之一: {', '.join(MODES)}"
            )

        resource_type = self._validate_optional_string(
            payload.get('resource_type'),
            'resource_type',
            self.MAX_RESOURCE_TYPE_LENGTH,
        )

        return {
            'event_uuid': event_uuid,
            'page_url': page_url,
            'resource_type': resource_type,
            'blocked_count': blocked_count,
            'mode': mode,
        }

    @staticmethod
    def _require_json_object(payload):
        if not isinstance(payload, dict):
            raise EventValidationError('请求体必须是JSON对象')

    @staticmethod
    def _validate_event_uuid(value):
        if not isinstance(value, str) or not value.strip():
            raise EventValidationError('event_uuid不能为空')

        try:
            return str(UUID(value.strip()))
        except (ValueError, AttributeError) as exc:
            raise EventValidationError('event_uuid必须是有效的UUID') from exc

    @staticmethod
    def _validate_score(value):
        if isinstance(value, bool) or not isinstance(
            value,
            (int, float, Decimal),
        ):
            raise EventValidationError('score必须是0到1之间的数字')

        try:
            score = Decimal(str(value))
        except (InvalidOperation, ValueError) as exc:
            raise EventValidationError('score必须是0到1之间的数字') from exc

        if not score.is_finite() or score < 0 or score > 1:
            raise EventValidationError('score范围必须为0到1')
        return score

    @staticmethod
    def _validate_required_string(value, field, max_length):
        if not isinstance(value, str) or not value.strip():
            raise EventValidationError(f'{field}不能为空')

        value = value.strip()
        if len(value) > max_length:
            raise EventValidationError(
                f'{field}长度不能超过{max_length}个字符'
            )
        return value

    @staticmethod
    def _validate_optional_string(value, field, max_length):
        if value is None or value == '':
            return None
        if not isinstance(value, str):
            raise EventValidationError(f'{field}必须是字符串')

        value = value.strip()
        if len(value) > max_length:
            raise EventValidationError(
                f'{field}长度不能超过{max_length}个字符'
            )
        return value or None

    @staticmethod
    def _hash_url(url):
        return hashlib.sha256(url.encode('utf-8')).hexdigest()

    @staticmethod
    def _utc_now():
        return datetime.now(timezone.utc).replace(tzinfo=None)

    @staticmethod
    def _format_utc(value):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


event_service = EventService()
