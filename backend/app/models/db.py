from sqlmodel import SQLModel, create_engine, Session
import os
import time
from dotenv import load_dotenv
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

# 获取 MySQL 数据库连接地址
database_url = os.getenv("DATABASE_URL")
if not database_url:
    raise EnvironmentError(
        "DATABASE_URL environment variable is required. "
        "Please set it in .env file or system environment. "
        "Example: mysql+pymysql://user:password@host:3306/database"
    )

logger.info(f"Database URL: {database_url.split('://')[0]}://***")

# 确保连接使用 utf8mb4 字符集（支持中文）
if '?' not in database_url:
    database_url += '?charset=utf8mb4'
elif 'charset' not in database_url.lower():
    database_url += '&charset=utf8mb4'

logger.info("正在创建数据库引擎...")
engine_start = time.time()
engine = create_engine(database_url, echo=False)
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
