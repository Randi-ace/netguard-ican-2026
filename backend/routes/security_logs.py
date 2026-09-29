from flask import Blueprint, request, jsonify
from sqlalchemy import func
from models.models import SecurityLog, LOG_TYPES, RISK_LEVELS
from db import SessionLocal, database_available

security_logs_bp = Blueprint('security_logs', __name__)

# 内存存储（当数据库不可用时使用）
memory_logs = []

@security_logs_bp.route('/api/log', methods=['POST'])
def add_log():
    """添加安全日志 - 统一日志入口"""
    db = None
    try:
        data = request.get_json()
        
        # 验证必填字段
        if not data or 'type' not in data or 'risk_level' not in data or 'url' not in data:
            print(f"[Log] 参数错误: {data}")
            return jsonify({'status': 'success', 'message': '参数错误，日志已跳过'}), 200
        
        # 验证类型
        if data['type'] not in LOG_TYPES:
            print(f"[Log] 无效类型: {data['type']}，有效类型: {LOG_TYPES}")
            return jsonify({'status': 'success', 'message': '无效类型，日志已跳过'}), 200
        
        # 验证风险等级
        if data['risk_level'] not in RISK_LEVELS:
            print(f"[Log] 无效风险等级: {data['risk_level']}")
            return jsonify({'status': 'success', 'message': '无效风险等级，日志已跳过'}), 200
        
        if database_available and SessionLocal:
            try:
                db = SessionLocal()
                new_log = SecurityLog(
                    type=data['type'],
                    risk_level=data['risk_level'],
                    url=data['url'],
                    reason=data.get('reason', '')
                )
                db.add(new_log)
                db.commit()
                db.refresh(new_log)
                
                # 调试输出 - 详细日志
                print(f"[Log] type={data['type']}, risk={data['risk_level']}, url={data['url'][:50]}... 写入成功")
                
                return jsonify({'status': 'success', 'id': new_log.id}), 201
            except Exception as db_error:
                print(f"[Log] 数据库写入失败，降级到内存存储: {str(db_error)[:50]}")
                # 降级到内存存储
                log_id = len(memory_logs) + 1
                memory_logs.append({
                    'id': log_id,
                    'type': data['type'],
                    'risk_level': data['risk_level'],
                    'url': data['url'],
                    'reason': data.get('reason', ''),
                    'created_at': 'N/A'
                })
                return jsonify({'status': 'success', 'id': log_id, 'message': '降级到内存存储'}), 201
        else:
            # 使用内存存储
            log_id = len(memory_logs) + 1
            memory_logs.append({
                'id': log_id,
                'type': data['type'],
                'risk_level': data['risk_level'],
                'url': data['url'],
                'reason': data.get('reason', ''),
                'created_at': 'N/A'
            })
            print(f"[Log] type={data['type']}, risk={data['risk_level']} (内存存储)")
            return jsonify({'status': 'success', 'id': log_id}), 201
            
    except Exception as e:
        # 日志失败不影响主功能，返回200
        print(f"[Log] 写入失败: {str(e)[:80]}")
        return jsonify({'status': 'success', 'message': '日志系统异常，已降级处理'}), 200
    finally:
        if db:
            try:
                db.close()
            except:
                pass

@security_logs_bp.route('/api/logs', methods=['GET'])
def get_logs():
    """获取最近20条风险日志"""
    db = None
    try:
        if database_available and SessionLocal:
            db = SessionLocal()
            logs = db.query(SecurityLog).order_by(SecurityLog.created_at.desc()).limit(20).all()
            result = [log.to_dict() for log in logs]
        else:
            # 使用内存存储
            result = sorted(memory_logs, key=lambda x: x.get('id', 0), reverse=True)[:20]
        
        return jsonify({'status': 'success', 'data': result})
        
    except Exception as e:
        return jsonify({'error': str(e)[:100]}), 500
    finally:
        if db:
            try:
                db.close()
            except:
                pass