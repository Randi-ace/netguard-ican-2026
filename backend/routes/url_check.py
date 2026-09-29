from flask import Blueprint, request, jsonify
from db import SessionLocal
from models.models import SecurityLog

url_bp = Blueprint("url", __name__)

HIGH_RISK = [
    "bet",
    "casino",
    "gambling",
    "porn",
    "gambling-demo",
    "porn-demo"
]

PHISHING_KEYWORDS = [
    "phishing",
    "bank",
    "login",
    "verify",
    "account"
]

@url_bp.route("/url/check", methods=["POST"])
def url_check():
    db = SessionLocal()
    try:
        data = request.get_json()
        
        if not data:
            print("[URL检测] 错误: 请求数据为空")
            return jsonify({
                "success": False,
                "message": "检测失败",
                "error": "请求数据为空"
            }), 400
        
        url = data.get("url", "").lower()
        
        if not url:
            print("[URL检测] 错误: URL为空")
            return jsonify({
                "success": False,
                "message": "检测失败",
                "error": "URL不能为空"
            }), 400
        
        is_high_risk = any(word in url for word in HIGH_RISK)
        is_phishing = any(word in url for word in PHISHING_KEYWORDS)
        
        if is_high_risk:
            risk = "high"
            reason = "检测到高风险网址（赌博/色情类）"
            score = 0.95
        elif is_phishing:
            risk = "high"
            reason = "检测到钓鱼网站特征"
            score = 0.90
        else:
            risk = "safe"
            reason = "未发现风险，网站安全可信"
            score = 0.05
        
        # 记录URL检测日志到security_logs（统计所需）
        try:
            security_log = SecurityLog(
                type='url_check',
                risk_level=risk,
                url=url,
                reason=reason
            )
            db.add(security_log)
            db.commit()
            print(f"[MySQL] URL检测日志写入成功: type=url_check, risk={risk}, url={url[:50]}...")
        except Exception as db_error:
            db.rollback()
            print(f"[MySQL] URL检测日志写入失败: {str(db_error)[:80]}")
        
        return jsonify({
            "success": True,
            "risk": risk,
            "reason": reason,
            "score": score
        })
    
    except Exception as e:
        print(f"[URL检测] 服务器错误: {str(e)}")
        return jsonify({
            "success": False,
            "message": "检测失败",
            "error": str(e)[:100]
        }), 500
    
    finally:
        db.close()