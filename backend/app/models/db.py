from sqlmodel import SQLModel, create_engine, Session
from sqlalchemy.pool import StaticPool
import os
import time
from dotenv import load_dotenv
import tempfile
import logging

logger = logging.getLogger(__name__)

# 尝试从项目根目录加载环境变量
import pathlib
root_dir = pathlib.Path(__file__).parent.parent.parent
env_path = root_dir / '.env'

if env_path.exists():
    load_dotenv(env_path)
    logger.info(f"Loaded .env from: {env_path}")
else:
    # 如果根目录没有.env，则尝试当前目录
    load_dotenv()
    logger.info("Loaded .env from current directory")

# 优先使用 SQLite，除非明确配置了 PostgreSQL
# 检测逻辑：如果没有 DATABASE_URL 或 VERCEL 环境，默认使用 SQLite
is_serverless = os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME") or os.getenv("R_LIBS_USER")

if is_serverless:
    logger.info("Detected Serverless Environment.")
    database_url = os.getenv("POSTGRES_URL")
    if not database_url:
        logger.warning("No POSTGRES_URL found. Falling back to in-memory SQLite database.")
        database_url = "sqlite:///:memory:"
else:
    # 本地开发默认使用 SQLite 文件数据库
    database_url = os.getenv("DATABASE_URL") or "sqlite:///./auto_home.db"
    logger.info(f"Using SQLite database: {database_url}")

logger.info(f"Database URL: {database_url.split('://')[0]}://***")  # Mask password if any

# SQLAlchemy 需要 postgresql:// 协议头，Vercel 默认给的是 postgres://
if database_url and database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)

# SQLite 需要特殊参数 check_same_thread=False
connect_args = {"check_same_thread": False} if "sqlite" in database_url else {}

# 如果是 SQLite 内存数据库，必须使用 StaticPool 保持连接不关闭，否则数据会丢失
poolclass = None
if "sqlite" in database_url and ":memory:" in database_url:
    poolclass = StaticPool
    logger.info("Using StaticPool for in-memory SQLite database.")

logger.info("正在创建数据库引擎...")
engine_start = time.time()
engine = create_engine(database_url, echo=False, connect_args=connect_args, poolclass=poolclass)
logger.info(f"✓ 数据库引擎创建完成，耗时：{time.time() - engine_start:.2f}秒")

def init_db():
    """初始化数据库表结构，检测无表时自动创建"""
    logger.info("正在检查数据库表结构...")
    
    # 检查是否已有表
    from sqlmodel import SQLModel
    from sqlalchemy import inspect
    
    inspector = inspect(engine)
    existing_tables = inspector.get_table_names()
    expected_tables = list(SQLModel.metadata.tables.keys())
    
    if not existing_tables:
        logger.info("📊 检测到空数据库，开始自动创建表结构...")
        logger.info(f"📋 计划创建的表：{', '.join(expected_tables)}")
        table_start = time.time()
        SQLModel.metadata.create_all(engine)
        elapsed = time.time() - table_start
        logger.info(f"✅ 数据库表结构创建完成！耗时：{elapsed:.2f}秒")
        logger.info(f"📝 已创建的表：{', '.join(existing_tables + expected_tables)}")
    else:
        missing_tables = [t for t in expected_tables if t not in existing_tables]
        if missing_tables:
            logger.info(f"⚠️  检测到部分表缺失：{', '.join(missing_tables)}")
            logger.info(f"🔧 开始补建缺失的表...")
            table_start = time.time()
            SQLModel.metadata.create_all(engine)
            elapsed = time.time() - table_start
            logger.info(f"✅ 缺失表补建完成！耗时：{elapsed:.2f}秒")
            logger.info(f"📝 当前所有表：{', '.join(existing_tables + missing_tables)}")
        else:
            logger.info(f"✅ 数据库表结构完整，共发现 {len(existing_tables)} 个表")
            logger.info(f"📝 表列表：{', '.join(existing_tables)}")

def get_session():
    with Session(engine) as session:
        yield session
