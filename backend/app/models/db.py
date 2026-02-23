from sqlmodel import SQLModel, create_engine, Session
import os
from dotenv import load_dotenv

load_dotenv()

# Vercel Postgres 使用 "POSTGRES_URL"
# Serverless 环境下如果未配置 Postgres，回退到内存数据库 (sqlite:///:memory:) 避免文件权限错误
# 本地开发默认使用 SQLite 文件 (sqlite:///./auto_home.db)

# 增强的 Serverless 环境检测
is_serverless = os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME") or os.getenv("R_LIBS_USER")

if is_serverless:
    print("Detected Serverless Environment.")
    database_url = os.getenv("POSTGRES_URL")
    if not database_url:
        print("No POSTGRES_URL found. Falling back to in-memory SQLite database.")
        database_url = "sqlite:///:memory:"
else:
    database_url = os.getenv("DATABASE_URL") or "sqlite:///./auto_home.db"

print(f"Database URL: {database_url.split('://')[0]}://***") # Mask password if any

# SQLAlchemy 需要 postgresql:// 协议头，Vercel 默认给的是 postgres://
if database_url and database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)

# SQLite 需要特殊参数 check_same_thread=False
connect_args = {"check_same_thread": False} if "sqlite" in database_url else {}

engine = create_engine(database_url, echo=False, connect_args=connect_args)

def init_db():
    SQLModel.metadata.create_all(engine)

def get_session():
    with Session(engine) as session:
        yield session
