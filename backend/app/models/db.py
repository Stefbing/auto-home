from sqlmodel import SQLModel, create_engine, Session
import os
from dotenv import load_dotenv

load_dotenv()

# Vercel Postgres 使用 "POSTGRES_URL"
# 本地开发默认使用 SQLite
database_url = os.getenv("POSTGRES_URL") or os.getenv("DATABASE_URL") or "sqlite:///./auto_home.db"

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
