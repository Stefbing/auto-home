from sqlmodel import SQLModel, create_engine, Session
import time
import logging

logger = logging.getLogger(__name__)

# 数据库配置 - 硬编码连接字符串（因为需要先连接数据库才能读取配置）
# 部署时请在 Vercel/服务器环境变量中设置 DATABASE_URL
import os
database_url = os.getenv("DATABASE_URL")

# 如果没有环境变量，使用默认配置（适用于本地开发）
if not database_url:
    # 本地开发默认配置
    database_url = "mysql+pymysql://stef:%26YLQW84TFdX%26uat@rm-bp1dm2990215o3n4kko.mysql.rds.aliyuncs.com:3306/auto_home"
    logger.info("⚠️  未检测到 DATABASE_URL 环境变量，使用默认配置（仅开发环境）")
else:
    logger.info("✓ 使用环境变量中的 DATABASE_URL")

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
