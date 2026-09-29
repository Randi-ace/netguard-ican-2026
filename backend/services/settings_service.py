import logging
import uuid

import db as database
from models.models import MODES, Setting, User


logger = logging.getLogger(__name__)


class SettingsValidationError(ValueError):
    """设置请求参数不合法。"""


class SettingsPersistenceError(RuntimeError):
    """设置无法从数据库读取或写入。"""


class SettingsService:
    """负责默认设置、设置读取和设置更新。"""

    DEFAULT_USERNAME = 'demo'
    DEFAULT_SETTINGS = {
        'mode': 'normal',
        'elder_mode': False,
        'child_mode': False,
        'paused': False,
    }

    def get_settings(self):
        """获取默认 Demo 用户的设置；不存在时自动创建。"""
        session = self._create_session()
        try:
            user = self._get_or_create_default_user(session)
            setting, _ = self._get_or_create_setting(session, user.id)
            session.commit()
            return self._serialize_setting(setting)
        except SettingsPersistenceError:
            session.rollback()
            raise
        except Exception as exc:
            session.rollback()
            logger.exception('获取设置失败')
            raise SettingsPersistenceError('获取设置失败') from exc
        finally:
            session.close()

    def update_settings(self, payload):
        """校验并更新默认 Demo 用户的设置。"""
        settings_data = self._validate_payload(payload)
        session = self._create_session()
        try:
            user = self._get_or_create_default_user(session)
            setting, created = self._get_or_create_setting(session, user.id)
            setting.mode = settings_data['mode']
            setting.preferences = {
                'elder_mode': settings_data['elder_mode'],
                'child_mode': settings_data['child_mode'],
                'paused': settings_data['paused'],
            }
            if not created:
                setting.version = (setting.version or 1) + 1

            session.commit()
            return self._serialize_setting(setting)
        except SettingsPersistenceError:
            session.rollback()
            raise
        except Exception as exc:
            session.rollback()
            logger.exception('更新设置失败')
            raise SettingsPersistenceError('更新设置失败') from exc
        finally:
            session.close()

    def _create_session(self):
        session_factory = database.SessionLocal
        if session_factory is None:
            raise SettingsPersistenceError('数据库不可用，无法访问设置')

        try:
            return session_factory()
        except Exception as exc:
            raise SettingsPersistenceError('数据库会话创建失败') from exc

    def _get_or_create_default_user(self, session):
        user = session.query(User).filter(
            User.username == self.DEFAULT_USERNAME
        ).first()
        if user is not None:
            return user

        user = User(
            public_id=str(uuid.uuid4()),
            username=self.DEFAULT_USERNAME,
            display_name='智盾演示用户',
            role='demo',
            status='active',
        )
        session.add(user)
        session.flush()
        return user

    def _get_or_create_setting(self, session, user_id):
        setting = session.query(Setting).filter(
            Setting.user_id == user_id
        ).first()
        if setting is not None:
            return setting, False

        setting = Setting(
            user_id=user_id,
            mode=self.DEFAULT_SETTINGS['mode'],
            preferences={
                'elder_mode': self.DEFAULT_SETTINGS['elder_mode'],
                'child_mode': self.DEFAULT_SETTINGS['child_mode'],
                'paused': self.DEFAULT_SETTINGS['paused'],
            },
            version=1,
        )
        session.add(setting)
        session.flush()
        return setting, True

    def _serialize_setting(self, setting):
        preferences = dict(setting.preferences or {})
        return {
            'mode': setting.mode or self.DEFAULT_SETTINGS['mode'],
            'elder_mode': bool(
                preferences.get(
                    'elder_mode',
                    self.DEFAULT_SETTINGS['elder_mode'],
                )
            ),
            'child_mode': bool(
                preferences.get(
                    'child_mode',
                    self.DEFAULT_SETTINGS['child_mode'],
                )
            ),
            'paused': bool(
                preferences.get(
                    'paused',
                    self.DEFAULT_SETTINGS['paused'],
                )
            ),
        }

    def _validate_payload(self, payload):
        if not isinstance(payload, dict):
            raise SettingsValidationError('请求体必须是 JSON 对象')

        required_fields = ('mode', 'elder_mode', 'child_mode', 'paused')
        missing_fields = [
            field for field in required_fields
            if field not in payload
        ]
        if missing_fields:
            raise SettingsValidationError(
                f"缺少必填字段: {', '.join(missing_fields)}"
            )

        mode = payload['mode']
        if not isinstance(mode, str) or mode not in MODES:
            raise SettingsValidationError(
                f"mode 必须是以下值之一: {', '.join(MODES)}"
            )

        for field in ('elder_mode', 'child_mode', 'paused'):
            if not isinstance(payload[field], bool):
                raise SettingsValidationError(f'{field} 必须是布尔值')

        return {
            'mode': mode,
            'elder_mode': payload['elder_mode'],
            'child_mode': payload['child_mode'],
            'paused': payload['paused'],
        }


settings_service = SettingsService()
