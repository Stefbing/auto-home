from sqlmodel import SQLModel, Field
from typing import Optional
import time

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    gender: str = "male"  # male/female
    age: int = 25
    height: int = 175    # cm

class WeightRecord(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: Optional[int] = Field(default=None, foreign_key="user.id")
    weight: float
    impedance: Optional[int] = None
    bmi: Optional[float] = None
    body_fat: Optional[float] = None
    muscle: Optional[float] = None
    water: Optional[float] = None
    visceral_fat: Optional[float] = None
    bone_mass: Optional[float] = None
    bmr: Optional[float] = None
    timestamp: int = Field(default_factory=lambda: int(time.time() * 1000))

class KnownDevice(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    device_id: str = Field(unique=True) # BLE MAC or UUID
    name: str
    type: str # 'scale', 'camera', etc.
    last_seen: int = Field(default_factory=lambda: int(time.time() * 1000))

class FeedingPlan(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    time: str
    amount: int
    enabled: bool = True
