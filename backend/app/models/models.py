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
    created_at: int = Field(default_factory=lambda: int(time.time() * 1000), sa_column=Column(BIGINT, nullable=False))
    updated_at: int = Field(default_factory=lambda: int(time.time() * 1000), sa_column=Column(BIGINT, nullable=False))

class WeightRecord(SQLModel, table=True):
    """体重记录表 - 关联私有家庭成员，用于体脂趋势分析"""
    __tablename__ = "weightrecord"
    __table_args__ = {"extend_existing": True}  # 防止元数据重复注册
    
    id: Optional[int] = Field(default=None, primary_key=True)  # 自增主键
    user_id: int = Field(index=True)  # 关联用户ID（数据归属用户）
    member_id: int = Field(index=True)  # 关联家庭成员ID（体脂计算使用的成员）
    weight: float
    impedance: Optional[int] = None
    bmi: Optional[float] = None
    body_fat: Optional[float] = None
    muscle: Optional[float] = None
    water: Optional[float] = None
    protein: Optional[float] = None  # 蛋白质率
    visceral_fat: Optional[float] = None
    bone_mass: Optional[float] = None
    bmr: Optional[float] = None
    timestamp: int = Field(default_factory=lambda: int(time.time() * 1000), sa_column=Column(BIGINT, nullable=False, index=True))
    xiaomi_pushed: bool = Field(default=False)
    xiaomi_push_time: Optional[int] = Field(default=None, sa_column=Column(BIGINT))
    created_at: int = Field(default_factory=lambda: int(time.time() * 1000), sa_column=Column(BIGINT, nullable=False))

class FamilyMember(SQLModel, table=True):
    """家庭成员表 - 私有成员，仅归属用户可见，用于体脂计算"""
    __tablename__ = "family_member"
    __table_args__ = {"extend_existing": True}
    
    id: Optional[int] = Field(default=None, primary_key=True)  # 自增主键
    user_id: int = Field(index=True)  # 关联用户ID（私有成员归属的用户）
    name: str = Field(max_length=50)  # 成员姓名
    gender: str = Field(default="", max_length=10)  # male/female/other
    age: int = Field(default=0)  # 年龄（体脂计算必需）
    height: float = Field(default=0)  # 身高cm（体脂计算必需）
    avatar_color: str = Field(default="", max_length=100)  # 头像渐变颜色
    relationship: str = Field(default="", max_length=20)  # self/spouse/child/parent/other
    sort_order: int = Field(default=0)  # 排序顺序
    is_active: bool = Field(default=True)  # 是否激活
    created_at: int = Field(default_factory=lambda: int(time.time() * 1000), sa_column=Column(BIGINT, nullable=False))
    updated_at: int = Field(default_factory=lambda: int(time.time() * 1000), sa_column=Column(BIGINT, nullable=False))

class SystemConfig(SQLModel, table=True):
    """系统配置表 - 支持多用户多设备，user_id=0为全局配置"""
    __tablename__ = "systemconfig"
    __table_args__ = {"extend_existing": True}  # 防止元数据重复注册
    
    id: Optional[int] = Field(default=None, primary_key=True)  # 自增主键
    user_id: int = Field(default=0, index=True)  # 关联用户ID（0表示全局配置）
    key: str = Field(max_length=50, index=True)  # 配置键（如：account, password, app_version）
    value: str  # 配置值（加密或明文）
    platform: Optional[str] = Field(default=None, max_length=50, index=True)  # 平台：petkit/xiaomi/cloudpets（设备配置专用）
    device_name: Optional[str] = Field(default=None, max_length=100)  # 设备名称（设备配置专用）
    is_encrypted: bool = Field(default=False)  # 标记是否加密存储
    is_active: bool = Field(default=True)  # 是否激活：False=已删除, True=正常
    updated_at: int = Field(default_factory=lambda: int(time.time() * 1000), sa_column=Column(BIGINT, nullable=False))  # 毫秒时间戳

