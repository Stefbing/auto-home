from sqlmodel import SQLModel, Field
from typing import Optional
import time
import uuid
from sqlalchemy import BIGINT, Column

class User(SQLModel, table=True):
    """用户表 - 存储小程序用户信息"""
    __tablename__ = "user"
    __table_args__ = {"extend_existing": True}  # 防止元数据重复注册
    
    id: str = Field(default_factory=lambda: uuid.uuid4().hex, primary_key=True, max_length=32)  # UUID without hyphens
    phone_number: str = Field(max_length=20, unique=True, index=True)  # 手机号（唯一标识）
    nickname: Optional[str] = Field(default=None, max_length=100)  # 昵称
    gender: str = Field(default="male", max_length=10)  # male/female
    age: int = Field(default=25)
    height: int = Field(default=175)  # cm

class WeightRecord(SQLModel, table=True):
    """体重记录表"""
    __tablename__ = "weightrecord"
    __table_args__ = {"extend_existing": True}  # 防止元数据重复注册
    
    id: str = Field(default_factory=lambda: uuid.uuid4().hex, primary_key=True, max_length=32)  # UUID without hyphens
    user_id: str = Field(foreign_key="user.id", index=True, max_length=32)  # 关联用户 UUID
    weight: float
    impedance: Optional[int] = None
    bmi: Optional[float] = None
    body_fat: Optional[float] = None
    muscle: Optional[float] = None
    water: Optional[float] = None
    visceral_fat: Optional[float] = None
    bone_mass: Optional[float] = None
    bmr: Optional[float] = None
    timestamp: int = Field(default_factory=lambda: int(time.time() * 1000), sa_column=Column(BIGINT, nullable=False, index=True))
    xiaomi_pushed: bool = Field(default=False)
    xiaomi_push_time: Optional[int] = Field(default=None, sa_column=Column(BIGINT))

class SystemConfig(SQLModel, table=True):
    """系统配置表 - 加密存储敏感信息"""
    __tablename__ = "systemconfig"
    __table_args__ = {"extend_existing": True}  # 防止元数据重复注册
    
    key: str = Field(primary_key=True, max_length=100)
    value: str
    is_encrypted: bool = Field(default=False)  # 标记是否加密存储
    updated_at: int = Field(default_factory=lambda: int(time.time() * 1000), sa_column=Column(BIGINT, nullable=False))  # 毫秒时间戳
