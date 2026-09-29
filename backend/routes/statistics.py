from flask import Blueprint, jsonify
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from models.models import CHECK_TYPES, RiskEvent, SecurityLog
from db import SessionLocal, database_available

statistics_bp = Blueprint('statistics', __name__)
RISK_EVENT_TYPE = 'extension_risk'
STATISTICS_TIMEZONE = ZoneInfo('Asia/Shanghai')

# 内存存储（当数据库不可用时使用）
memory_logs = []

@statistics_bp.route('/api/stats', methods=['GET'])
def get_stats():
    """获取统计数据"""
    db = None
    try:
        if database_available and SessionLocal:
            try:
                db = SessionLocal()

                today = datetime.now(STATISTICS_TIMEZONE).date()
                today_start, tomorrow_start = _local_date_range_to_utc(
                    today,
                    today + timedelta(days=1),
                )
                risk_events = db.query(RiskEvent).filter(
                    RiskEvent.event_type == RISK_EVENT_TYPE,
                    RiskEvent.check_type.in_(CHECK_TYPES),
                )
                
                # AI检测次数
                ai_count = risk_events.filter(
                    RiskEvent.check_type == 'ai'
                ).count()
                
                # URL检测次数
                url_count = risk_events.filter(
                    RiskEvent.check_type.in_(('url', 'rule'))
                ).count()
                
                # 高风险数量
                high_risk = risk_events.filter(
                    RiskEvent.risk_level == 'high'
                ).count()
                
                # 今日检测数量
                today_count = risk_events.filter(
                    RiskEvent.occurred_at >= today_start,
                    RiskEvent.occurred_at < tomorrow_start,
                ).count()
                
                # 广告拦截次数
                ad_block_count = db.query(SecurityLog).filter(SecurityLog.type == 'ad_block').count()
                
                # 儿童模式拦截次数
                child_mode_count = db.query(SecurityLog).filter(SecurityLog.type == 'child_mode').count()
                
                # 老人模式提醒次数
                elder_mode_count = db.query(SecurityLog).filter(SecurityLog.type == 'elder_mode').count()
                
                # 中风险数量
                medium_risk = risk_events.filter(
                    RiskEvent.risk_level == 'medium'
                ).count()
                
                # 低风险数量
                low_risk = risk_events.filter(
                    RiskEvent.risk_level == 'low'
                ).count()
                
                # 调试输出
                print(f"[Stats] ai_check={ai_count}, url_check={url_count}, ad_block={ad_block_count}")
                print(f"[Stats] child_mode={child_mode_count}, elder_mode={elder_mode_count}")
                print(f"[Stats] high_risk={high_risk}, medium_risk={medium_risk}, low_risk={low_risk}")
                print(f"[Stats] today_count={today_count}")
                
                # 近7天趋势数据
                trend_data = []
                for i in range(6, -1, -1):
                    date = today - timedelta(days=i)
                    start_at, end_at = _local_date_range_to_utc(
                        date,
                        date + timedelta(days=1),
                    )
                    count = risk_events.filter(
                        RiskEvent.occurred_at >= start_at,
                        RiskEvent.occurred_at < end_at,
                    ).count()
                    trend_data.append({
                        'date': date.strftime('%m-%d'),
                        'count': count
                    })
                
                # 其他统计
                strict_mode_count = db.query(SecurityLog).filter(SecurityLog.type == 'strict_mode').count()
                entertainment_block_count = db.query(SecurityLog).filter(SecurityLog.type == 'entertainment_block').count()
                game_block_count = db.query(SecurityLog).filter(SecurityLog.type == 'game_block').count()
                dangerous_block_count = db.query(SecurityLog).filter(SecurityLog.type == 'dangerous_block').count()
                
                # 调试输出
                print(f"[MySQL] Dashboard统计更新成功 - AI检测:{ai_count}, URL检测:{url_count}, 高风险:{high_risk}, 儿童模式:{child_mode_count}, 老人模式:{elder_mode_count}")
                
                return jsonify({
                    'status': 'success',
                    'data': {
                        'ai_count': ai_count,
                        'url_count': url_count,
                        'high_risk': high_risk,
                        'medium_risk': medium_risk,
                        'low_risk': low_risk,
                        'today_count': today_count,
                        'ad_block_count': ad_block_count,
                        'child_mode_count': child_mode_count,
                        'elder_mode_count': elder_mode_count,
                        'trend_data': trend_data,
                        'strict_mode_count': strict_mode_count,
                        'entertainment_block_count': entertainment_block_count,
                        'game_block_count': game_block_count,
                        'dangerous_block_count': dangerous_block_count
                    }
                })
            except Exception as db_error:
                print(f"[Stats] 数据库查询失败，降级到内存存储: {str(db_error)[:50]}")
                # 降级到内存存储
                return get_memory_stats()
        else:
            # 使用内存存储的统计
            return get_memory_stats()
            
    except Exception as e:
        print(f"[Stats] 查询失败: {str(e)[:80]}")
        # 统计失败不影响主功能，返回空数据
        return jsonify({
            'status': 'success',
            'data': {
                'ai_count': 0,
                'url_count': 0,
                'high_risk': 0,
                'medium_risk': 0,
                'low_risk': 0,
                'today_count': 0,
                'ad_block_count': 0,
                'child_mode_count': 0,
                'elder_mode_count': 0,
                'trend_data': [],
                'strict_mode_count': 0,
                'entertainment_block_count': 0,
                'game_block_count': 0,
                'dangerous_block_count': 0
            }
        }), 200
    finally:
        if db:
            try:
                db.close()
            except:
                pass

def get_memory_stats():
    """从内存存储获取统计数据"""
    risk_logs = [
        log for log in memory_logs
        if log.get('event_type') == RISK_EVENT_TYPE
        and log.get('check_type') in CHECK_TYPES
    ]
    ai_count = sum(1 for log in risk_logs if log.get('check_type') == 'ai')
    url_count = sum(
        1 for log in risk_logs
        if log.get('check_type') in ('url', 'rule')
    )
    high_risk = sum(
        1 for log in risk_logs if log.get('risk_level') == 'high'
    )
    today_count = len(risk_logs)
    child_mode_count = sum(
        1 for log in memory_logs if log.get('type') == 'child_mode'
    )
    elder_mode_count = sum(
        1 for log in memory_logs if log.get('type') == 'elder_mode'
    )
    ad_block_count = sum(
        1 for log in memory_logs if log.get('type') == 'ad_block'
    )
    medium_risk = sum(
        1 for log in risk_logs if log.get('risk_level') == 'medium'
    )
    low_risk = sum(
        1 for log in risk_logs if log.get('risk_level') == 'low'
    )
    
    print(f"[Memory] Dashboard统计更新成功 - AI检测:{ai_count}, URL检测:{url_count}, 高风险:{high_risk}")
    
    return jsonify({
        'status': 'success',
        'data': {
            'ai_count': ai_count,
            'url_count': url_count,
            'high_risk': high_risk,
            'medium_risk': medium_risk,
            'low_risk': low_risk,
            'today_count': today_count,
            'ad_block_count': ad_block_count,
            'child_mode_count': child_mode_count,
            'elder_mode_count': elder_mode_count,
            'trend_data': [],
            'strict_mode_count': 0,
            'entertainment_block_count': 0,
            'game_block_count': 0,
            'dangerous_block_count': 0
        }
    })


def _local_date_range_to_utc(start_date, end_date):
    local_start = datetime.combine(
        start_date,
        time.min,
        tzinfo=STATISTICS_TIMEZONE,
    )
    local_end = datetime.combine(
        end_date,
        time.min,
        tzinfo=STATISTICS_TIMEZONE,
    )
    return (
        local_start.astimezone(timezone.utc).replace(tzinfo=None),
        local_end.astimezone(timezone.utc).replace(tzinfo=None),
    )
