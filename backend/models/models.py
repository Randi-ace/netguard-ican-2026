from urllib.parse import urlsplit

from sqlalchemy import (
    JSON,
    Boolean,
    CHAR,
    CheckConstraint,
    Column,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.mysql import BIGINT, DATETIME, INTEGER as MYSQL_INTEGER
from sqlalchemy.orm import relationship, validates
from sqlalchemy.sql import func
from db import Base

# 定义类型枚举
LOG_TYPES = (
    'ai_check',
    'url_check', 
    'ad_block',
    'child_mode',
    'elder_mode',
    'strict_mode',
    'entertainment_block',
    'game_block',
    'dangerous_block'
)

# 定义风险等级枚举
RISK_LEVELS = (
    'safe',
    'low',
    'medium',
    'high'
)

# v1alpha1 团队接口契约使用的固定值。
# 数据库存储使用 VARCHAR，具体合法性由后端接口统一校验。
CHECK_TYPES = ('ai', 'url', 'rule')
SOURCES = ('extension', 'ui', 'demo', 'backend')
MODES = ('normal', 'strict', 'elder', 'child')
AD_ACTIONS = ('blocked', 'hidden', 'allowed')
BLACKLIST_MATCH_TYPES = ('domain',)


def normalize_blacklist_domain(value):
    """把黑名单写入值规范化为不含 www. 的小写 hostname。"""
    if not isinstance(value, str) or not value.strip():
        raise ValueError('domain 必须是非空字符串')

    try:
        raw_value = value.strip()
        parsed = urlsplit(
            raw_value if '://' in raw_value else f'//{raw_value}'
        )
        hostname = (parsed.hostname or '').lower().rstrip('.')
        if hostname.startswith('www.'):
            hostname = hostname[4:]
        hostname = hostname.encode('idna').decode('ascii')
    except (UnicodeError, ValueError) as exc:
        raise ValueError('domain 不是有效域名') from exc

    if not hostname or len(hostname) > 253:
        raise ValueError('domain 不是有效域名')

    return hostname


# ==================== 旧版模型（兼容保留） ====================
# 这些模型仍被现有路由使用，第一阶段不能删除或修改表结构。
# 新功能不应继续依赖它们；待数据迁移和接口切换完成后再移除。

class SecurityLog(Base):
    """DEPRECATED：旧版混合安全日志，兼容现有接口保留。"""

    __tablename__ = 'security_logs'
    __deprecated__ = True
    __deprecation_reason__ = '由 risk_events 和 ad_events 分别接管'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    type = Column(Enum(*LOG_TYPES), nullable=False)
    risk_level = Column(Enum(*RISK_LEVELS), nullable=False)
    url = Column(String(500), nullable=False)
    reason = Column(String(1000), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    def to_dict(self):
        return {
            'id': self.id,
            'type': self.type,
            'risk_level': self.risk_level,
            'url': self.url,
            'reason': self.reason,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S') if self.created_at else None
        }

class DetectionRecord(Base):
    """DEPRECATED：旧版检测记录，兼容现有接口保留。"""

    __tablename__ = 'detection_records'
    __deprecated__ = True
    __deprecation_reason__ = '由 risk_events 统一接管'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    url = Column(String(500), nullable=False)
    is_high_risk = Column(Boolean, default=False)
    is_phishing = Column(Boolean, default=False)
    risk_level = Column(String(20), default='safe')
    risk_score = Column(Float, default=0.0)
    check_type = Column(String(20), default='unknown')
    user_id = Column(Integer, nullable=True)
    reason = Column(String(500), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    def to_dict(self):
        return {
            'id': self.id,
            'url': self.url,
            'is_high_risk': self.is_high_risk,
            'is_phishing': self.is_phishing,
            'risk_level': self.risk_level,
            'risk_score': self.risk_score,
            'check_type': self.check_type,
            'user_id': self.user_id,
            'reason': self.reason,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S') if self.created_at else None
        }

class UserSetting(Base):
    """DEPRECATED：旧版键值设置，兼容现有接口保留。"""

    __tablename__ = 'user_settings'
    __deprecated__ = True
    __deprecation_reason__ = '由 settings 的用户级设置结构接管'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    setting_key = Column(String(100), unique=True, nullable=False)
    setting_value = Column(String(500), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    def to_dict(self):
        return {
            'id': self.id,
            'setting_key': self.setting_key,
            'setting_value': self.setting_value,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S') if self.created_at else None,
            'updated_at': self.updated_at.strftime('%Y-%m-%d %H:%M:%S') if self.updated_at else None
        }


# ==================== v1alpha1 团队开发模型 ====================

class User(Base):
    """最小用户身份，用于关联事件和设置。"""

    __tablename__ = 'users'
    __table_args__ = (
        UniqueConstraint('public_id', name='uq_users_public_id'),
        UniqueConstraint('username', name='uq_users_username'),
        Index('ix_users_status_created_at', 'status', 'created_at'),
        {
            'mysql_engine': 'InnoDB',
            'mysql_charset': 'utf8mb4',
            'mysql_collate': 'utf8mb4_unicode_ci',
        },
    )

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    public_id = Column(CHAR(36), nullable=False)
    username = Column(String(64), nullable=True)
    display_name = Column(
        String(100),
        nullable=False,
        default='智盾用户',
        server_default='智盾用户',
    )
    role = Column(String(32), nullable=False, default='user', server_default='user')
    status = Column(String(16), nullable=False, default='active', server_default='active')
    created_at = Column(
        DATETIME(fsp=6),
        nullable=False,
        server_default=text('CURRENT_TIMESTAMP(6)'),
    )
    updated_at = Column(
        DATETIME(fsp=6),
        nullable=False,
        server_default=text('CURRENT_TIMESTAMP(6)'),
        onupdate=text('CURRENT_TIMESTAMP(6)'),
    )

    risk_events = relationship(
        'RiskEvent',
        back_populates='user',
        passive_deletes=True,
    )
    ad_events = relationship(
        'AdEvent',
        back_populates='user',
        passive_deletes=True,
    )
    settings = relationship(
        'Setting',
        back_populates='user',
        uselist=False,
        cascade='all, delete-orphan',
        passive_deletes=True,
    )

    def to_dict(self):
        return {
            'id': self.id,
            'public_id': self.public_id,
            'username': self.username,
            'display_name': self.display_name,
            'role': self.role,
            'status': self.status,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }


class UrlBlacklist(Base):
    """后端权威 URL 域名黑名单。"""

    __tablename__ = 'url_blacklist'
    __table_args__ = (
        UniqueConstraint('domain', name='uq_url_blacklist_domain'),
        Index('ix_url_blacklist_enabled_domain', 'enabled', 'domain'),
        CheckConstraint(
            'score >= 0 AND score <= 1',
            name='ck_url_blacklist_score_range',
        ),
        {
            'mysql_engine': 'InnoDB',
            'mysql_charset': 'utf8mb4',
            'mysql_collate': 'utf8mb4_unicode_ci',
        },
    )

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    domain = Column(String(253), nullable=False)
    match_type = Column(
        String(16),
        nullable=False,
        default='domain',
        server_default='domain',
    )
    risk_level = Column(
        String(16),
        nullable=False,
        default='high',
        server_default='high',
    )
    score = Column(
        Numeric(5, 4),
        nullable=False,
        default=0.95,
        server_default='0.9500',
    )
    reason = Column(String(500), nullable=False)
    enabled = Column(
        Boolean,
        nullable=False,
        default=True,
        server_default=text('1'),
    )
    source = Column(
        String(32),
        nullable=False,
        default='manual',
        server_default='manual',
    )
    created_at = Column(
        DATETIME(fsp=6),
        nullable=False,
        server_default=text('CURRENT_TIMESTAMP(6)'),
    )
    updated_at = Column(
        DATETIME(fsp=6),
        nullable=False,
        server_default=text('CURRENT_TIMESTAMP(6)'),
        onupdate=text('CURRENT_TIMESTAMP(6)'),
    )

    @validates('domain')
    def validate_domain(self, _key, value):
        return normalize_blacklist_domain(value)

    @validates('match_type')
    def validate_match_type(self, _key, value):
        if value not in BLACKLIST_MATCH_TYPES:
            raise ValueError(
                f"match_type 必须是以下值之一: {', '.join(BLACKLIST_MATCH_TYPES)}"
            )
        return value

    @validates('risk_level')
    def validate_risk_level(self, _key, value):
        if value not in RISK_LEVELS:
            raise ValueError(
                f"risk_level 必须是以下值之一: {', '.join(RISK_LEVELS)}"
            )
        return value

    @validates('score')
    def validate_score(self, _key, value):
        score = float(value)
        if not 0 <= score <= 1:
            raise ValueError('score 必须在 0 到 1 之间')
        return value

    @validates('source')
    def validate_source(self, _key, value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError('source 必须是非空字符串')
        return value.strip().lower()

    def to_dict(self):
        return {
            'id': self.id,
            'domain': self.domain,
            'match_type': self.match_type,
            'risk_level': self.risk_level,
            'score': float(self.score),
            'reason': self.reason,
            'enabled': self.enabled,
            'source': self.source,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }


class RiskEvent(Base):
    """AI、URL 和插件本地规则产生的统一风险事件。"""

    __tablename__ = 'risk_events'
    __table_args__ = (
        UniqueConstraint('event_uuid', name='uq_risk_events_event_uuid'),
        Index('ix_risk_events_user_occurred', 'user_id', 'occurred_at'),
        Index('ix_risk_events_level_occurred', 'risk_level', 'occurred_at'),
        Index('ix_risk_events_type_occurred', 'event_type', 'occurred_at'),
        Index('ix_risk_events_url_hash', 'url_hash'),
        {
            'mysql_engine': 'InnoDB',
            'mysql_charset': 'utf8mb4',
            'mysql_collate': 'utf8mb4_unicode_ci',
        },
    )

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    event_uuid = Column(CHAR(36), nullable=False)
    user_id = Column(
        BIGINT(unsigned=True),
        ForeignKey('users.id', ondelete='SET NULL'),
        nullable=True,
    )
    event_type = Column(String(32), nullable=False)
    check_type = Column(String(20), nullable=False)
    risk_level = Column(String(16), nullable=False)
    risk_score = Column(
        Numeric(5, 4),
        nullable=False,
        default=0,
        server_default='0.0000',
    )
    url = Column(Text, nullable=True)
    url_hash = Column(CHAR(64), nullable=True)
    reason = Column(String(1000), nullable=True)
    source = Column(
        String(20),
        nullable=False,
        default='backend',
        server_default='backend',
    )
    details = Column(JSON, nullable=True)
    occurred_at = Column(
        DATETIME(fsp=6),
        nullable=False,
        server_default=text('CURRENT_TIMESTAMP(6)'),
    )
    created_at = Column(
        DATETIME(fsp=6),
        nullable=False,
        server_default=text('CURRENT_TIMESTAMP(6)'),
    )

    user = relationship('User', back_populates='risk_events')

    def to_dict(self):
        return {
            'id': self.id,
            'event_uuid': self.event_uuid,
            'user_id': self.user_id,
            'event_type': self.event_type,
            'check_type': self.check_type,
            'risk_level': self.risk_level,
            'risk_score': float(self.risk_score) if self.risk_score is not None else None,
            'url': self.url,
            'url_hash': self.url_hash,
            'reason': self.reason,
            'source': self.source,
            'details': self.details,
            'occurred_at': self.occurred_at.isoformat() if self.occurred_at else None,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }


class AdEvent(Base):
    """广告拦截、隐藏和放行事件。"""

    __tablename__ = 'ad_events'
    __table_args__ = (
        UniqueConstraint('event_uuid', name='uq_ad_events_event_uuid'),
        Index('ix_ad_events_user_occurred', 'user_id', 'occurred_at'),
        Index('ix_ad_events_action_occurred', 'action', 'occurred_at'),
        Index('ix_ad_events_mode_occurred', 'mode', 'occurred_at'),
        Index('ix_ad_events_url_hash', 'url_hash'),
        {
            'mysql_engine': 'InnoDB',
            'mysql_charset': 'utf8mb4',
            'mysql_collate': 'utf8mb4_unicode_ci',
        },
    )

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    event_uuid = Column(CHAR(36), nullable=False)
    user_id = Column(
        BIGINT(unsigned=True),
        ForeignKey('users.id', ondelete='SET NULL'),
        nullable=True,
    )
    action = Column(String(16), nullable=False)
    mode = Column(String(16), nullable=False, default='normal', server_default='normal')
    page_url = Column(Text, nullable=True)
    url_hash = Column(CHAR(64), nullable=True)
    resource_type = Column(String(32), nullable=True)
    rule_id = Column(String(100), nullable=True)
    blocked_count = Column(
        MYSQL_INTEGER(unsigned=True),
        nullable=False,
        default=1,
        server_default='1',
    )
    reason = Column(String(500), nullable=True)
    source = Column(
        String(20),
        nullable=False,
        default='extension',
        server_default='extension',
    )
    details = Column(JSON, nullable=True)
    occurred_at = Column(
        DATETIME(fsp=6),
        nullable=False,
        server_default=text('CURRENT_TIMESTAMP(6)'),
    )
    created_at = Column(
        DATETIME(fsp=6),
        nullable=False,
        server_default=text('CURRENT_TIMESTAMP(6)'),
    )

    user = relationship('User', back_populates='ad_events')

    def to_dict(self):
        return {
            'id': self.id,
            'event_uuid': self.event_uuid,
            'user_id': self.user_id,
            'action': self.action,
            'mode': self.mode,
            'page_url': self.page_url,
            'url_hash': self.url_hash,
            'resource_type': self.resource_type,
            'rule_id': self.rule_id,
            'blocked_count': self.blocked_count,
            'reason': self.reason,
            'source': self.source,
            'details': self.details,
            'occurred_at': self.occurred_at.isoformat() if self.occurred_at else None,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }


class Setting(Base):
    """每个用户唯一的一份当前设置。"""

    __tablename__ = 'settings'
    __table_args__ = (
        UniqueConstraint('user_id', name='uq_settings_user_id'),
        Index('ix_settings_mode_updated_at', 'mode', 'updated_at'),
        {
            'mysql_engine': 'InnoDB',
            'mysql_charset': 'utf8mb4',
            'mysql_collate': 'utf8mb4_unicode_ci',
        },
    )

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    user_id = Column(
        BIGINT(unsigned=True),
        ForeignKey('users.id', ondelete='CASCADE'),
        nullable=False,
    )
    mode = Column(String(16), nullable=False, default='normal', server_default='normal')
    # MySQL 5.7 不允许 JSON 列使用对象字面量作为服务端默认值。
    # 使用 Python 可调用默认值，建表 DDL 不生成 JSON DEFAULT 子句。
    preferences = Column(JSON, nullable=False, default=dict)
    version = Column(
        MYSQL_INTEGER(unsigned=True),
        nullable=False,
        default=1,
        server_default='1',
    )
    created_at = Column(
        DATETIME(fsp=6),
        nullable=False,
        server_default=text('CURRENT_TIMESTAMP(6)'),
    )
    updated_at = Column(
        DATETIME(fsp=6),
        nullable=False,
        server_default=text('CURRENT_TIMESTAMP(6)'),
        onupdate=text('CURRENT_TIMESTAMP(6)'),
    )

    user = relationship('User', back_populates='settings')

    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'mode': self.mode,
            'preferences': self.preferences,
            'version': self.version,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }
