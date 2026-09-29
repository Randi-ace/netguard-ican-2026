from flask import Flask
from flask_cors import CORS

from config import Config
from db import engine, Base, database_available

from routes.health import health_bp
from routes.ai_check import ai_bp
from routes.url_check import url_bp
from routes.statistics import statistics_bp
from routes.settings import settings_bp
from routes.security_logs import security_logs_bp
from routes.events import events_bp
from routes.dashboard import dashboard_bp
from routes.logs import logs_bp

app = Flask(__name__)
app.config.from_object(Config)

# 添加数据库状态到应用配置
app.config['DATABASE_AVAILABLE'] = database_available

# 配置 CORS - 允许 file://、127.0.0.1、localhost 跨域访问
CORS(app, 
     origins=["*", "file://*", "http://127.0.0.1", "http://localhost"],
     supports_credentials=True,
     allow_headers=["Content-Type", "Authorization"],
     methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
     expose_headers=["Content-Type"])

# 尝试初始化数据库表（如果数据库可用）
print("正在初始化数据库表...")
if database_available and engine:
    try:
        Base.metadata.create_all(bind=engine)
        print("[OK] 数据库表初始化完成")
    except Exception as e:
        print(f"[WARN] 数据库表初始化失败: {str(e)[:80]}")
else:
    print("[WARN] 数据库不可用，跳过表初始化")

# 注册路由
app.register_blueprint(health_bp)
app.register_blueprint(ai_bp)
app.register_blueprint(url_bp)
app.register_blueprint(statistics_bp)
app.register_blueprint(settings_bp)
app.register_blueprint(security_logs_bp)
app.register_blueprint(events_bp)
app.register_blueprint(dashboard_bp)
app.register_blueprint(logs_bp)

# 添加健康检查路由（直接在主文件中，确保最基本的检查可用）
@app.route('/health', methods=['GET'])
def health_check():
    return {
        "status": "healthy",
        "database": "available" if database_available else "unavailable",
        "message": "NetGuard Backend Service"
    }

if __name__ == "__main__":
    print("[INFO] Flask 启动中...")
    print(f"   地址: http://127.0.0.1:5000")
    print(f"   数据库状态: {'[OK] 可用' if database_available else '[WARN] 不可用'}")
    print(f"   调试模式: {'开启' if app.debug else '关闭'}")
    print("=" * 40)
    app.run(host="127.0.0.1", port=5000, debug=True)
