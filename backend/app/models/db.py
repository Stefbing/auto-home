from sqlmodel import SQLModel, create_engine, Session
import time
import logging

logger = logging.getLogger(__name__)

# 数据库配置 - 从环境变量读取
import os
from dotenv import load_dotenv

# 检测是否为开发环境（通过检查是否存在.env文件或特定环境变量）
if os.path.exists('.env'):
    load_dotenv()  # 加载.env文件
    logger.info("✓ 开发环境，已加载.env配置")
else:
    logger.info("✓ 生产环境，从系统环境变量读取配置")

# 从环境变量读取数据库配置（无默认值）
mysql_host = os.getenv("MYSQL_ADDRESS")
mysql_user = os.getenv("MYSQL_USERNAME")
mysql_password = os.getenv("MYSQL_PASSWORD")

if not all([mysql_host, mysql_user, mysql_password]):
    raise EnvironmentError(
        "必须配置 MYSQL_ADDRESS、MYSQL_USERNAME、MYSQL_PASSWORD 环境变量\n"
        "开发环境：创建.env文件并填写配置\n"
        "生产环境：在微信云托管控制台配置环境变量"
    )

database_url = f"mysql+pymysql://{mysql_user}:{mysql_password}@{mysql_host}/auto_home"

logger.info(f"Database URL: {database_url.split('://')[0]}://***")

# 确保连接使用 utf8mb4 字符集（支持中文）
if '?' not in database_url:
    database_url += '?charset=utf8mb4'
elif 'charset' not in database_url.lower():
    database_url += '&charset=utf8mb4'

logger.info("正在创建数据库引擎...")
engine_start = time.time()
engine = create_engine(
    database_url,
    echo=False,
    pool_size=5,  # 连接池大小
    max_overflow=10,  # 最大溢出连接数
    pool_timeout=30,  # 获取连接超时时间（秒）
    pool_recycle=3600,  # 连接回收时间（秒），避免MySQL断开空闲连接
    pool_pre_ping=True  # 使用前检测连接是否有效
)
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
