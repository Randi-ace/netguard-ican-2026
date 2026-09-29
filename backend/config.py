import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _env_flag(name, default=False):
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {'1', 'true', 'yes', 'on'}


def _env_float(name, default):
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _env_project_path(name, default):
    configured_path = Path(os.getenv(name, default))
    if configured_path.is_absolute():
        return configured_path
    return (PROJECT_ROOT / configured_path).resolve()


class Config:
    SECRET_KEY = os.getenv(
    "SECRET_KEY"
    )
    if not SECRET_KEY:
        SECRET_KEY = "dev_only_net_guard_secret_change_me"
    
    # MySQL 配置 - phpStudy 默认配置
    MYSQL_HOST = os.getenv("MYSQL_HOST", "127.0.0.1")
    MYSQL_PORT = int(os.getenv("MYSQL_PORT", 3306))
    MYSQL_USER = os.getenv("MYSQL_USER", "root")
    MYSQL_PASSWORD = os.getenv("MYSQL_PASSWORD", "root")  # phpStudy 默认密码
    MYSQL_DB = os.getenv("MYSQL_DB", "net_guard")

    SQLALCHEMY_DATABASE_URI = (
        f"mysql+pymysql://{MYSQL_USER}:{MYSQL_PASSWORD}@"
        f"{MYSQL_HOST}:{MYSQL_PORT}/{MYSQL_DB}?charset=utf8mb4"
    )
    
    # 数据库连接配置
    MYSQL_CONNECT_TIMEOUT = 5
    MYSQL_READ_TIMEOUT = 10
    MYSQL_WRITE_TIMEOUT = 10

    # TextRiskModel 默认关闭；即使没有模型文件，应用也必须能正常启动。
    AI_TEXT_MODEL_ENABLED = _env_flag('AI_TEXT_MODEL_ENABLED', False)
    AI_TEXT_MODEL_PATH = _env_project_path(
        'AI_TEXT_MODEL_PATH',
        'models/ai/tfidf-logreg-v2-char.joblib',
    )
    AI_MODEL_VERSION = os.getenv(
        'AI_MODEL_VERSION',
        'tfidf-logreg-v2-char',
    )

    # Fusion v1 开发初始参数，后续必须依据 validation 数据校准。
    AI_RULE_WEIGHT = _env_float('AI_RULE_WEIGHT', 0.40)
    AI_WEIGHT = _env_float('AI_WEIGHT', 0.60)
    AI_MIN_CONFIDENCE = _env_float('AI_MIN_CONFIDENCE', 0.70)
