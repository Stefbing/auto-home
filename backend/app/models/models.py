from sqlmodel import SQLModel, Field
from typing import Optional
import time
import uuid
from sqlalchemy import BIGINT, Column

class User(SQLModel, table=True):
    """用户表 - 存储小程序用户信息"""
    __tablename__ = "user"
    __table_args__ = {"extend_existing": True}  # 防止元数据重复注册
    
    id: Optional[int] = Field(default=None, primary_key=True)  # 自增主键
    phone_number: str = Field(max_length=20, unique=True, index=True)  # 手机号（唯一标识）
    nickname: Optional[str] = Field(default=None, max_length=100)  # 昵称
    gender: str = Field(default="male", max_length=10)  # male/female
    age: int = Field(default=25)
    height: int = Field(default=175)  # cm

class WeightRecord(SQLModel, table=True):
    """体重记录表"""
    __tablename__ = "weightrecord"
    __table_args__ = {"extend_existing": True}  # 防止元数据重复注册
    
    id: Optional[int] = Field(default=None, primary_key=True)  # 自增主键
    user_id: int = Field(foreign_key="user.id", index=True)  # 关联用户ID
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
    """系统配置表 - 简化版，支持多用户多设备"""
    __tablename__ = "systemconfig"
    __table_args__ = {"extend_existing": True}  # 防止元数据重复注册
    
    id: Optional[int] = Field(default=None, primary_key=True)  # 自增主键
    user_id: int = Field(default=0, foreign_key="user.id", index=True)  # 关联用户ID（0表示全局配置）
    key: str = Field(max_length=50, index=True)  # 配置键（如：account, password, app_version）
    value: str  # 配置值（加密或明文）
    platform: Optional[str] = Field(default=None, max_length=50, index=True)  # 平台：petkit/xiaomi/cloudpets（设备配置专用）
    device_name: Optional[str] = Field(default=None, max_length=100)  # 设备名称（设备配置专用）
    is_encrypted: bool = Field(default=False)  # 标记是否加密存储
    updated_at: int = Field(default_factory=lambda: int(time.time() * 1000), sa_column=Column(BIGINT, nullable=False))  # 毫秒时间戳

