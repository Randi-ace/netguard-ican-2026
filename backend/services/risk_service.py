import hashlib
import logging
import math
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, ROUND_CEILING
from numbers import Real
from typing import List, TypedDict

from sqlalchemy.exc import IntegrityError

import db as database
from config import Config
from models.models import CHECK_TYPES, RiskEvent, SOURCES
from services.ai_service import ai_service
from services.blacklist_service import blacklist_service
from services.text_risk_model import text_risk_model


logger = logging.getLogger(__name__)


class RuleResult(TypedDict):
    """现有规则引擎的统一内部结果。"""

    rule_score: float
    rule_level: str
    rule_reasons: List[str]
    strong_hit: bool


class FusionResult(TypedDict):
    """Rule + AI Fusion v1 的内部结果。"""

    final_score: float
    final_level: str
    final_reason: str
    detection_source: str


class RiskValidationError(ValueError):
    """风险检测请求参数不合法。"""


class RiskPersistenceError(RuntimeError):
    """风险检测结果无法写入数据库。"""


class RiskService:
    """统一完成风险检测和 risk_events 持久化。"""

    HIGH_RISK_URL_KEYWORDS = (
        'bet',
        'casino',
        'gambling',
        'porn',
        'gambling-demo',
        'porn-demo',
    )
    PHISHING_URL_KEYWORDS = (
        'phishing',
        'bank',
        'login',
        'verify',
        'account',
    )
    HIGH_RISK_URL_REASON = '检测到高风险网址（赌博/色情类）'
    AI_CATEGORIES = {
        'normal',
        'phishing',
        'scam',
        'gambling',
        'adult',
        'malicious',
    }
    AI_CATEGORY_REASONS = {
        'normal': 'AI文本模型未识别到明显风险',
        'phishing': 'AI文本模型识别为钓鱼风险',
        'scam': 'AI文本模型识别为诈骗风险',
        'gambling': 'AI文本模型识别为赌博风险',
        'adult': 'AI文本模型识别为色情风险',
        'malicious': 'AI文本模型识别为恶意内容风险',
    }
    RISK_LEVEL_PRIORITY = {
        'safe': 0,
        'low': 1,
        'medium': 2,
        'high': 3,
    }
    AI_RESULT_EPSILON = 1e-6
    # Fusion v1 provisional policy. Not claimed as validation-optimal.
    # Will be calibrated using validation data.
    FUSION_LEVEL_BANDS = (
        (0.20, 'safe'),
        (0.40, 'low'),
        (0.60, 'medium'),
    )
    MAX_CONTENT_LENGTH = 3000
    MAX_META_DESCRIPTION_LENGTH = 300
    MAX_TITLE_LENGTH = 200
    MAX_URL_LENGTH = 4096
    FUSION_CHANGED_EPSILON = 1e-9
    SCORE_QUANTUM = Decimal('0.0001')

    def __init__(
        self,
        text_model=None,
        rule_weight=None,
        ai_weight=None,
        min_confidence=None,
    ):
        self.text_model = (
            text_risk_model if text_model is None else text_model
        )
        self.rule_weight = (
            Config.AI_RULE_WEIGHT
            if rule_weight is None
            else rule_weight
        )
        self.ai_weight = (
            Config.AI_WEIGHT
            if ai_weight is None
            else ai_weight
        )
        self.min_confidence = (
            Config.AI_MIN_CONFIDENCE
            if min_confidence is None
            else min_confidence
        )

    def check_and_save(self, payload):
        """校验请求、执行检测，并在成功后写入一条风险事件。"""
        request_data = self._validate_payload(payload)
        event_uuid = request_data['event_uuid']

        if event_uuid is not None:
            existing_result = self._find_existing_event_result(event_uuid)
            if existing_result is not None:
                return existing_result

        analysis = self._analyze_risk(
            url=request_data['url'],
            content=request_data['content'],
            title=request_data['title'],
        )
        details = self._build_details(request_data, analysis)
        return self.save_risk_event(
            url=request_data['url'],
            source=request_data['source'],
            result=analysis['result'],
            event_uuid=event_uuid,
            details=details,
        )

    def detect_risk(self, url, content, title=''):
        """执行规则检测与安全降级的 Rule + AI Fusion。"""
        return self._analyze_risk(url, content, title)['result']

    def _analyze_risk(self, url, content, title=''):
        """只执行一次 Rule、AI 与 Fusion，并保留持久化快照。"""
        rule_result, check_type = self._evaluate_rules(url, content)
        raw_ai_result = self._predict_ai(url, title, content)
        ai_result = self._normalize_ai_result(raw_ai_result)
        fusion_result = self.fuse_risk(
            rule_result,
            ai_result or {'ai_available': False},
        )

        if self._fusion_changed_rule(rule_result, fusion_result):
            check_type = 'ai'

        result = {
            'check_type': check_type,
            'risk_level': fusion_result['final_level'],
            'score': fusion_result['final_score'],
            'reason': fusion_result['final_reason'],
        }
        return {
            'result': result,
            'rule_result': rule_result,
            'ai_result': ai_result,
            'fusion_result': fusion_result,
        }

    def detect_rule_result(self, url, content):
        """标准化黑名单、URL 与旧关键词规则的内部结果。"""
        rule_result, _check_type = self._evaluate_rules(url, content)
        return rule_result

    def fuse_risk(self, rule_result, ai_result):
        """融合有效的高置信 AI 结果，否则完整回退规则结果。"""
        fallback = self._rule_fallback(rule_result)
        normalized_ai = self._normalize_ai_result(ai_result)
        config = self._validated_fusion_config()
        if normalized_ai is None or config is None:
            return fallback

        rule_weight, ai_weight, min_confidence = config
        if normalized_ai['ai_confidence'] < min_confidence:
            return fallback

        weighted_score = (
            rule_weight * rule_result['rule_score']
            + ai_weight * normalized_ai['ai_score']
        )
        weighted_score = min(1.0, max(0.0, weighted_score))

        final_score = weighted_score
        if rule_result['strong_hit']:
            final_score = max(rule_result['rule_score'], final_score)

        final_score = self._canonical_score(final_score)
        if (
            rule_result['strong_hit']
            and final_score < rule_result['rule_score']
        ):
            # 当前 Rule score 使用固定公开精度；保留防御性下限，避免
            # 四位小数规范化在未来规则扩展时削弱 strong evidence。
            final_score = float(
                Decimal(str(rule_result['rule_score'])).quantize(
                    self.SCORE_QUANTUM,
                    rounding=ROUND_CEILING,
                )
            )

        final_level = self._level_from_score(final_score)
        if rule_result['strong_hit']:
            final_level = self._higher_level(
                rule_result['rule_level'],
                final_level,
            )

        final_reason = rule_result['rule_reasons'][0]
        if final_level != rule_result['rule_level']:
            final_reason = self.AI_CATEGORY_REASONS[
                normalized_ai['ai_category']
            ]

        return FusionResult(
            final_score=final_score,
            final_level=final_level,
            final_reason=final_reason,
            detection_source='rule+ai',
        )

    def _predict_ai(self, url, title, content):
        try:
            return self.text_model.predict(url, title, content)
        except Exception as exc:
            logger.warning(
                'TextRiskModel 调用失败，回退规则结果（%s）',
                type(exc).__name__,
            )
            return {'ai_available': False}

    @classmethod
    def _level_from_score(cls, score):
        """使用 Fusion v1 临时工程策略统一映射最终分数。"""
        for upper_bound, level in cls.FUSION_LEVEL_BANDS:
            if score < upper_bound:
                return level
        return 'high'

    @classmethod
    def _canonical_score(cls, score):
        """按 risk_events.risk_score 的四位小数精度规范化分数。"""
        return float(Decimal(str(score)).quantize(cls.SCORE_QUANTUM))

    def _higher_level(self, first, second):
        return max(
            (first, second),
            key=self.RISK_LEVEL_PRIORITY.__getitem__,
        )

    def _build_details(self, request_data, analysis):
        rule_result = analysis['rule_result']
        ai_result = analysis['ai_result']
        fusion_result = analysis['fusion_result']

        ai_details = {'available': False}
        if ai_result is not None:
            ai_details = {
                'available': True,
                'score': ai_result['ai_score'],
                'category': ai_result['ai_category'],
                'confidence': ai_result['ai_confidence'],
                'reasons': list(ai_result['ai_reasons']),
                'model_version': ai_result['model_version'],
            }

        return {
            'schema_version': 'ai-risk-v1',
            'input': {
                'title_length': len(request_data['title']),
                'meta_description_length': len(
                    request_data['meta_description']
                ),
                'content_length': len(request_data['content']),
            },
            'rule': {
                'score': rule_result['rule_score'],
                'level': rule_result['rule_level'],
                'reasons': list(rule_result['rule_reasons']),
                'strong_hit': rule_result['strong_hit'],
            },
            'ai': ai_details,
            'fusion': {
                'score': fusion_result['final_score'],
                'level': fusion_result['final_level'],
                'source': fusion_result['detection_source'],
                'changed': self._fusion_values_changed(
                    rule_result,
                    fusion_result,
                ),
                'rule_weight': self._metadata_number(self.rule_weight),
                'ai_weight': self._metadata_number(self.ai_weight),
                'min_confidence': self._metadata_number(
                    self.min_confidence
                ),
            },
        }

    def _fusion_values_changed(self, rule_result, fusion_result):
        return (
            not math.isclose(
                fusion_result['final_score'],
                rule_result['rule_score'],
                rel_tol=0.0,
                abs_tol=self.FUSION_CHANGED_EPSILON,
            )
            or fusion_result['final_level'] != rule_result['rule_level']
        )

    @staticmethod
    def _metadata_number(value):
        if isinstance(value, bool) or not isinstance(value, Real):
            return None
        number = float(value)
        return number if math.isfinite(number) else None

    @staticmethod
    def _rule_fallback(rule_result):
        return FusionResult(
            final_score=rule_result['rule_score'],
            final_level=rule_result['rule_level'],
            final_reason=rule_result['rule_reasons'][0],
            detection_source='rule',
        )

    @staticmethod
    def _fusion_changed_rule(rule_result, fusion_result):
        return (
            fusion_result['detection_source'] == 'rule+ai'
            and (
                fusion_result['final_score'] != rule_result['rule_score']
                or fusion_result['final_level'] != rule_result['rule_level']
                or fusion_result['final_reason']
                != rule_result['rule_reasons'][0]
            )
        )

    def _normalize_ai_result(self, result):
        if not isinstance(result, dict):
            return None
        if result.get('ai_available') is not True:
            return None

        score = self._validated_unit_float(result.get('ai_score'))
        confidence = self._validated_unit_float(
            result.get('ai_confidence')
        )
        category = result.get('ai_category')
        reasons = result.get('ai_reasons')
        model_version = result.get('model_version')
        if score is None or confidence is None:
            return None
        if category not in self.AI_CATEGORIES:
            return None
        if category == 'normal':
            if not math.isclose(
                confidence,
                1.0 - score,
                rel_tol=0.0,
                abs_tol=self.AI_RESULT_EPSILON,
            ):
                return None
        elif confidence > score + self.AI_RESULT_EPSILON:
            return None
        if (
            not isinstance(reasons, list)
            or len(reasons) > 3
            or any(
                not isinstance(reason, str) or len(reason) > 120
                for reason in reasons
            )
        ):
            return None
        if not isinstance(model_version, str) or not model_version:
            return None

        return {
            'ai_available': True,
            'ai_score': score,
            'ai_category': category,
            'ai_confidence': confidence,
            'ai_reasons': list(reasons),
            'model_version': model_version,
        }

    def _validated_fusion_config(self):
        rule_weight = self._validated_unit_float(self.rule_weight)
        ai_weight = self._validated_unit_float(self.ai_weight)
        min_confidence = self._validated_unit_float(
            self.min_confidence
        )
        if (
            rule_weight is None
            or ai_weight is None
            or min_confidence is None
            or not math.isclose(
                rule_weight + ai_weight,
                1.0,
                rel_tol=1e-9,
                abs_tol=1e-9,
            )
        ):
            return None
        return rule_weight, ai_weight, min_confidence

    @staticmethod
    def _validated_unit_float(value):
        if isinstance(value, bool) or not isinstance(value, Real):
            return None
        number = float(value)
        if not math.isfinite(number) or not 0.0 <= number <= 1.0:
            return None
        return number

    def _evaluate_rules(self, url, content):
        """按第一阶段的等级/分数顺序选择规则结果。"""
        blacklist_result = blacklist_service.check_url(url)
        url_result = self._detect_url(url)
        content_result = self._detect_content(content)

        candidates = []
        if blacklist_result is not None:
            candidates.append((
                self._normalize_rule_result(
                    blacklist_result,
                    strong_hit=True,
                ),
                blacklist_result['check_type'],
            ))
        candidates.extend((
            (
                self._normalize_rule_result(
                    url_result,
                    strong_hit=self._is_strong_url_result(url_result),
                ),
                url_result['check_type'],
            ),
            (
                self._normalize_rule_result(
                    content_result,
                    strong_hit=False,
                ),
                content_result['check_type'],
            ),
        ))

        selected_result, check_type = max(
            candidates,
            key=lambda item: (
                self.RISK_LEVEL_PRIORITY.get(
                    item[0]['rule_level'],
                    0,
                ),
                item[0]['rule_score'],
            ),
        )
        return RuleResult(
            rule_score=selected_result['rule_score'],
            rule_level=selected_result['rule_level'],
            rule_reasons=list(selected_result['rule_reasons']),
            strong_hit=any(
                item[0]['strong_hit'] for item in candidates
            ),
        ), check_type

    @staticmethod
    def _normalize_rule_result(result, strong_hit):
        return RuleResult(
            rule_score=result['score'],
            rule_level=result['risk_level'],
            rule_reasons=[result['reason']],
            strong_hit=strong_hit,
        )

    def _is_strong_url_result(self, result):
        """仅固定当前最明确的 0.95 高危 URL 规则为 strong。"""
        return (
            result.get('check_type') == 'url'
            and result.get('risk_level') == 'high'
            and result.get('score') == 0.95
            and result.get('reason') == self.HIGH_RISK_URL_REASON
        )

    def save_risk_event(
        self,
        url,
        source,
        result,
        event_uuid=None,
        details=None,
    ):
        """把一次成功检测保存到 risk_events。"""
        check_type = result.get('check_type')
        if check_type not in CHECK_TYPES:
            raise RiskPersistenceError(
                f"check_type必须是以下值之一: {', '.join(CHECK_TYPES)}"
            )

        session_factory = database.SessionLocal
        if session_factory is None:
            raise RiskPersistenceError('数据库不可用，风险事件未保存')

        persisted_score = Decimal(str(result['score'])).quantize(
            self.SCORE_QUANTUM
        )
        persisted_details = deepcopy(details)
        if persisted_details is not None:
            persisted_details['fusion']['score'] = float(persisted_score)

        now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
        event = RiskEvent(
            event_uuid=event_uuid or str(uuid.uuid4()),
            event_type='extension_risk',
            check_type=check_type,
            risk_level=result['risk_level'],
            risk_score=persisted_score,
            url=url,
            url_hash=hashlib.sha256(url.encode('utf-8')).hexdigest(),
            reason=result['reason'],
            source=source,
            details=persisted_details,
            occurred_at=now_utc,
            created_at=now_utc,
        )

        session = None
        try:
            session = session_factory()
            if event_uuid is not None:
                existing = self._find_by_uuid(session, event_uuid)
                if existing is not None:
                    return self._event_result(existing)

            session.add(event)
            session.commit()
            return self._event_result(event)
        except IntegrityError as exc:
            if session is not None:
                session.rollback()
                existing = self._find_by_uuid(session, event.event_uuid)
                if existing is not None:
                    return self._event_result(existing)

            logger.exception('风险事件唯一键冲突后未找到已有事件')
            raise RiskPersistenceError('风险事件保存失败') from exc
        except Exception as exc:
            if session is not None:
                session.rollback()
            logger.exception('风险事件写入 risk_events 失败')
            raise RiskPersistenceError('风险事件保存失败') from exc
        finally:
            if session is not None:
                session.close()

    def _find_existing_event_result(self, event_uuid):
        session_factory = database.SessionLocal
        if session_factory is None:
            raise RiskPersistenceError('数据库不可用，风险事件未保存')

        session = None
        try:
            session = session_factory()
            existing = self._find_by_uuid(session, event_uuid)
            return (
                self._event_result(existing)
                if existing is not None
                else None
            )
        except Exception as exc:
            logger.exception('查询已有风险事件失败')
            raise RiskPersistenceError('风险事件查询失败') from exc
        finally:
            if session is not None:
                session.close()

    @staticmethod
    def _find_by_uuid(session, event_uuid):
        return session.query(RiskEvent).filter(
            RiskEvent.event_uuid == event_uuid
        ).first()

    @staticmethod
    def _event_result(event):
        return {
            'risk_level': event.risk_level,
            'score': float(event.risk_score),
            'reason': event.reason,
        }

    def _validate_payload(self, payload):
        if not isinstance(payload, dict):
            raise RiskValidationError('请求体必须是 JSON 对象')

        missing_fields = [
            field for field in ('url', 'content', 'source')
            if field not in payload
        ]
        if missing_fields:
            raise RiskValidationError(
                f"缺少必填字段: {', '.join(missing_fields)}"
            )

        url = payload['url']
        content = payload['content']
        title = payload.get('title', '')
        meta_description = payload.get('meta_description', '')
        source = payload['source']
        event_uuid = payload.get('event_uuid')

        if not isinstance(url, str) or not url.strip():
            raise RiskValidationError('url 必须是非空字符串')
        if len(url) > self.MAX_URL_LENGTH:
            raise RiskValidationError(
                f'url 长度不能超过 {self.MAX_URL_LENGTH} 个字符'
            )
        if not isinstance(content, str):
            raise RiskValidationError('content 必须是字符串')
        if title is None:
            title = ''
        if not isinstance(title, str):
            raise RiskValidationError('title 必须是字符串')
        if meta_description is None:
            meta_description = ''
        if not isinstance(meta_description, str):
            raise RiskValidationError('meta_description 必须是字符串')
        if not isinstance(source, str) or source not in SOURCES:
            raise RiskValidationError(
                f"source 必须是以下值之一: {', '.join(SOURCES)}"
            )
        if 'event_uuid' in payload:
            if not isinstance(event_uuid, str) or not event_uuid.strip():
                raise RiskValidationError('event_uuid 必须是有效的 UUID')
            try:
                event_uuid = str(uuid.UUID(event_uuid.strip()))
            except (ValueError, AttributeError) as exc:
                raise RiskValidationError(
                    'event_uuid 必须是有效的 UUID'
                ) from exc

        return {
            'url': url.strip(),
            'title': title[:self.MAX_TITLE_LENGTH],
            'meta_description': meta_description[
                :self.MAX_META_DESCRIPTION_LENGTH
            ],
            'content': content[:self.MAX_CONTENT_LENGTH],
            'source': source,
            'event_uuid': event_uuid,
        }

    def _detect_url(self, url):
        normalized_url = url.lower()
        if any(
            keyword in normalized_url
            for keyword in self.HIGH_RISK_URL_KEYWORDS
        ):
            return {
                'check_type': 'url',
                'risk_level': 'high',
                'score': 0.95,
                'reason': self.HIGH_RISK_URL_REASON,
            }

        if any(
            keyword in normalized_url
            for keyword in self.PHISHING_URL_KEYWORDS
        ):
            return {
                'check_type': 'url',
                'risk_level': 'high',
                'score': 0.90,
                'reason': '检测到钓鱼网站特征',
            }

        return {
            'check_type': 'url',
            'risk_level': 'safe',
            'score': 0.05,
            'reason': 'URL 未发现风险',
        }

    @staticmethod
    def _detect_content(content):
        ai_result = ai_service.analyze_text(content)
        return {
            'check_type': 'ai',
            'risk_level': ai_result.get('risk', 'safe'),
            'score': float(ai_result.get('score', 0.05)),
            'reason': ai_result.get('reason', '未发现风险内容'),
        }


risk_service = RiskService()
