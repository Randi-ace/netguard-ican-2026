from flask import Blueprint, request, jsonify
from db import SessionLocal, database_available
from services.ai_service import ai_service
from services.risk_service import (
    RiskPersistenceError,
    RiskValidationError,
    risk_service,
)

ai_bp = Blueprint("ai", __name__)

# 演示页面风险映射
DEMO_PAGE_RISK = {
    'safe.html': {'risk': 'safe', 'score': 0.05, 'reason': '安全内容，无风险因素'},
    'low.html': {'risk': 'low', 'score': 0.25, 'reason': '检测到轻微营销推广内容'},
    'medium.html': {'risk': 'medium', 'score': 0.55, 'reason': '检测到金融投资相关内容，需谨慎'},
    'high.html': {'risk': 'high', 'score': 0.90, 'reason': '检测到诈骗风险内容'}
}


@ai_bp.route("/api/risk/check", methods=["POST"])
def risk_check():
    """v1alpha1 统一风险检测接口。"""
    try:
        result = risk_service.check_and_save(request.get_json(silent=True))
        return jsonify({
            "code": 0,
            "message": "风险检测完成",
            "data": {
                "risk_level": result["risk_level"],
                "score": result["score"],
                "reason": result["reason"]
            }
        }), 200
    except RiskValidationError as exc:
        return jsonify({
            "code": 40001,
            "message": str(exc),
            "data": None
        }), 400
    except RiskPersistenceError as exc:
        return jsonify({
            "code": 50301,
            "message": str(exc),
            "data": None
        }), 503
    except Exception as exc:
        print(f"❌ 风险检测异常: {str(exc)[:80]}")
        return jsonify({
            "code": 50001,
            "message": "风险检测服务暂时不可用",
            "data": None
        }), 500


@ai_bp.route("/ai/check", methods=["POST"])
def ai_check():
    db = None
    try:
        # 获取请求数据
        data = request.get_json()
        if not data:
            return jsonify({
                "risk": "safe",
                "score": 0.05,
                "reason": "请求数据为空"
            }), 400
        
        text = data.get("text", "")
        url = data.get("url", "")
        
        # 检查是否是演示页面
        for page, risk_info in DEMO_PAGE_RISK.items():
            if page in (url + text).lower():
                print(f"📋 检测到演示页面: {page}，返回预设风险: {risk_info['risk']}")
                
                # 演示页面也记录日志
                if database_available and SessionLocal:
                    try:
                        db = SessionLocal()
                        from models.models import DetectionRecord, SecurityLog
                        
                        record = DetectionRecord(
                            url=url[:500] if len(url) > 500 else url,
                            risk_level=risk_info['risk'],
                            risk_score=risk_info['score'],
                            check_type="ai",
                            user_id=None
                        )
                        db.add(record)
                        
                        # 记录AI检测日志到security_logs
                        security_log = SecurityLog(
                            type='ai_check',
                            risk_level=risk_info['risk'],
                            url=url,
                            reason=risk_info['reason']
                        )
                        db.add(security_log)
                        
                        db.commit()
                        print(f"[MySQL] AI检测日志写入成功: type=ai_check, risk={risk_info['risk']}, url={url[:50]}...")
                    except Exception as db_e:
                        print(f"⚠️ 数据库写入失败: {str(db_e)[:50]}")
                
                return jsonify(risk_info)
        
        # 文本长度限制
        if len(text) > 3000:
            text = text[:3000]
        
        # 调用AI服务分析
        result = ai_service.analyze_text(text)
        
        # 尝试写入数据库（如果数据库可用）
        if database_available and SessionLocal:
            try:
                db = SessionLocal()
                from models.models import DetectionRecord, SecurityLog
                
                record = DetectionRecord(
                    url=text[:500] if len(text) > 500 else text,
                    risk_level=result.get("risk", "safe"),
                    risk_score=result.get("score", 0.0),
                    check_type="ai",
                    user_id=None
                )
                db.add(record)
                
                # 记录AI检测日志到security_logs
                security_log = SecurityLog(
                    type='ai_check',
                    risk_level=result.get("risk", "safe"),
                    url=url,
                    reason=result.get("reason", "AI检测完成")
                )
                db.add(security_log)
                
                db.commit()
                print(f"[MySQL] AI检测日志写入成功: type=ai_check, risk={result.get('risk')}, url={url[:50]}...")
            except Exception as db_e:
                print(f"⚠️ 数据库写入失败: {str(db_e)[:50]}")
        
        # 返回结果
        return jsonify({
            "risk": result.get("risk", "safe"),
            "score": result.get("score", 0.0),
            "reason": result.get("reason", "未发现风险")
        })
    
    except Exception as e:
        print(f"❌ AI检测异常: {e}")
        return jsonify({
            "risk": "safe",
            "score": 0.05,
            "reason": "检测服务暂时不可用"
        }), 500
    
    finally:
        if db:
            try:
                db.close()
            except:
                pass
