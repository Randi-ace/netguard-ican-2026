from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.exc import OperationalError
from config import Config
import pymysql
import time
import warnings

print("[INFO] 正在初始化数据库连接...")
print(f"   主机: {Config.MYSQL_HOST}:{Config.MYSQL_PORT}")
print(f"   数据库: {Config.MYSQL_DB}")
print(f"   用户: {Config.MYSQL_USER}")

# 全局变量：数据库连接状态
database_available = False
engine = None
SessionLocal = None
Base = declarative_base()

def create_database_if_not_exists():
    """自动创建数据库（如果不存在）"""
    try:
        # 先连接到 MySQL 服务器（不指定数据库）
        connection = pymysql.connect(
            host=Config.MYSQL_HOST,
            port=Config.MYSQL_PORT,
            user=Config.MYSQL_USER,
            password=Config.MYSQL_PASSWORD,
            connect_timeout=Config.MYSQL_CONNECT_TIMEOUT
        )
        
        cursor = connection.cursor()
        
        # 检查数据库是否存在
        cursor.execute(f"SHOW DATABASES LIKE '{Config.MYSQL_DB}'")
        result = cursor.fetchone()
        
        if not result:
            print(f"   创建数据库 {Config.MYSQL_DB}...")
            cursor.execute(f"CREATE DATABASE IF NOT EXISTS {Config.MYSQL_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
            print(f"[OK] 数据库 {Config.MYSQL_DB} 创建成功")
        else:
            print(f"[OK] 数据库 {Config.MYSQL_DB} 已存在")
        
        cursor.close()
        connection.close()
        return True
        
    except Exception as e:
        print(f"[ERROR] 创建数据库失败: {str(e)[:80]}")
        return False

try:
    # 1. 先尝试创建数据库（如果不存在）
    db_created = create_database_if_not_exists()
    
    # 2. 创建引擎
    engine = create_engine(
        Config.SQLALCHEMY_DATABASE_URI,
        echo=False,
        pool_pre_ping=True,
        pool_recycle=3600,
        connect_args={
            'connect_timeout': Config.MYSQL_CONNECT_TIMEOUT,
            'read_timeout': Config.MYSQL_READ_TIMEOUT,
            'write_timeout': Config.MYSQL_WRITE_TIMEOUT
        }
    )

    # 3. 测试连接
    max_retries = 2
    retry_delay = 1
    
    for attempt in range(max_retries):
        try:
            print(f"   测试连接 ({attempt + 1}/{max_retries})...")
            with engine.connect() as conn:
                print("[OK] 数据库连接成功!")
                database_available = True
                break
        except OperationalError as e:
            print(f"[ERROR] 连接失败 (尝试 {attempt + 1}): {str(e)[:80]}")
            if attempt < max_retries - 1:
                time.sleep(retry_delay)
    
    if not database_available:
        print("[WARN] 数据库连接不可用，将使用内存存储模式")
        engine = None
        
except Exception as e:
    print(f"[WARN] 数据库初始化异常: {str(e)[:80]}")
    print("[WARN] 将使用内存存储模式")
    engine = None
    database_available = False

# 创建 Session（即使数据库不可用也创建一个空的）
if engine:
    SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
else:
    SessionLocal = None

print("[INFO] SQLAlchemy 初始化完成")

def get_db():
    """获取数据库会话"""
    if SessionLocal:
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()
    else:
        yield None
