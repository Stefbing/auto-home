import os
import uvicorn
import asyncio
from contextlib import asynccontextmanager
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from sqlmodel import Session, select

# 导入你现有的模块
from app.services.petkit_service import PetKitService
from app.services.ble_service import ble_service
from app.services.cloudpets_service import cloudpets_service, FeedingPlan as CloudPetsPlan
from app.models.models import User, WeightRecord, FeedingPlan, KnownDevice
from app.models.db import get_session, init_db

load_dotenv()

# --- 1. 生命周期管理 (Lifespan) ---
# 用于在应用生命周期内共享全局服务实例
class AppState:
    def __init__(self):
        self.petkit: Optional[PetKitService] = None

state = AppState()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """管理应用启动和关闭时的逻辑"""
    # 启动时：初始化数据库和长连接服务
    init_db()
    
    # 启动宿主机 BLE 扫描服务
    asyncio.create_task(ble_service.start())
    
    # CloudPets 不需要启动，它是 HTTP 客户端
    
    username = os.getenv("PETKIT_USERNAME")
    password = os.getenv("PETKIT_PASSWORD")
    
    if username and password:
        print(f"正在初始化 PetKit 服务: {username}...")
        state.petkit = PetKitService(username, password)
        try:
            await state.petkit.start()
            print("PetKit 服务连接成功")
        except Exception as e:
            print(f"PetKit 连接失败: {e}")
    else:
        print("警告: 未检测到 PETKIT 环境变量，相关 API 将不可用")

    yield  # 分隔符，上方是启动逻辑，下方是关闭逻辑

    # 关闭时：清理资源
    if state.petkit:
        print("正在关闭 PetKit 服务...")
        await state.petkit.close()
    
    await cloudpets_service.close()

# --- 2. 应用配置 ---
app = FastAPI(
    title="Smart Home Controller", 
    version="0.2.1",
    lifespan=lifespan
)

app.mount("/static", StaticFiles(directory="static"), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- 3. 依赖注入 ---
def get_petkit():
    """快速获取已登录的 PetKit 实例"""
    if not state.petkit:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    return state.petkit

# --- 4. 数据模型 (Schema) ---
# (使用 models.py 中的定义)

# --- 5. 路由实现 ---

@app.get("/")
async def root():
    return FileResponse('static/index.html')

@app.get("/litterbox")
async def litterbox_page():
    return FileResponse('static/litterbox.html')

@app.get("/feeder")
async def feeder_page():
    return FileResponse('static/feeder.html')

@app.get("/feeder/plans")
async def feeder_plans_page():
    return FileResponse('static/feeder_plans.html')

@app.get("/scale")
async def scale_page():
    return FileResponse('static/scale.html')

# --- PetKit 路由 ---
@app.get("/api/petkit/debug")
async def petkit_debug(service: PetKitService = Depends(get_petkit)):
    if not service:
         return {"error": "No service"}
    return await service.get_client_methods()

@app.get("/api/petkit/devices")
async def petkit_devices(service: PetKitService = Depends(get_petkit)):
    try:
        return await service.get_devices()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch devices: {str(e)}")

@app.post("/api/petkit/clean")
async def petkit_clean(device_id: Optional[str] = None, service: PetKitService = Depends(get_petkit)):
    try:
        return await service.clean_litterbox(device_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Action failed: {str(e)}")

@app.post("/api/petkit/deodorize")
async def petkit_deodorize(device_id: Optional[str] = None, service: PetKitService = Depends(get_petkit)):
    try:
        return await service.deodorize_litterbox(device_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- CloudPets (云宠智能) 路由 ---
@app.get("/api/cloudpets/servings_today")
async def cloudpets_servings_today():
    """获取今日已出粮份数"""
    return await cloudpets_service.get_servings_today()

@app.post("/api/cloudpets/feed")
async def cloudpets_manual_feed(amount: int = 1):
    """立即喂食"""
    return await cloudpets_service.manual_feed(amount)

@app.get("/api/cloudpets/plans", response_model=List[CloudPetsPlan])
async def cloudpets_get_plans():
    """获取喂食计划"""
    return await cloudpets_service.get_feeding_plans()

@app.post("/api/cloudpets/plans", response_model=CloudPetsPlan)
async def cloudpets_add_plan(plan: CloudPetsPlan):
    """添加喂食计划"""
    return await cloudpets_service.add_feeding_plan(plan)

@app.put("/api/cloudpets/plans/{plan_id}", response_model=CloudPetsPlan)
async def cloudpets_update_plan(plan_id: str, plan: CloudPetsPlan):
    """更新喂食计划"""
    return await cloudpets_service.update_feeding_plan(plan_id, plan)

@app.delete("/api/cloudpets/plans/{plan_id}")
async def cloudpets_delete_plan(plan_id: str):
    """删除喂食计划"""
    return await cloudpets_service.delete_feeding_plan(plan_id)

# --- PetWant (Placeholder - Deprecated) ---
@app.post("/api/petwant/feed")
async def petwant_feed():
    return {"status": "error", "message": "Use /api/cloudpets/feed instead."}

@app.get("/api/petwant/plans", response_model=List[FeedingPlan])
def get_plans(session: Session = Depends(get_session)):
    # Local plans for compatibility
    plans = session.exec(select(FeedingPlan)).all()
    return plans

# --- Scale & User 路由 ---
@app.get("/api/users", response_model=List[User])
def get_users(session: Session = Depends(get_session)):
    return session.exec(select(User)).all()

@app.post("/api/users", response_model=User)
def create_user(user: User, session: Session = Depends(get_session)):
    session.add(user)
    session.commit()
    session.refresh(user)
    return user

@app.get("/api/scale/history/{user_id}")
def get_weight_history(user_id: int, session: Session = Depends(get_session)):
    statement = select(WeightRecord).where(WeightRecord.user_id == user_id).order_by(WeightRecord.timestamp.desc()).limit(30)
    results = session.exec(statement).all()
    return results

def calculate_body_metrics(weight: float, impedance: int, user: User):
    """
    小米体脂秤 2 简化版计算算法
    参考开源算法: https://github.com/wiebeandriessen/misale
    """
    height = user.height / 100.0
    bmi = weight / (height * height)
    is_male = user.gender == "male"
    age = user.age

    # 1. 体脂率 (简化估算)
    if is_male:
        body_fat = 0.8 * bmi + 0.1 * age - 5.4
    else:
        body_fat = 0.8 * bmi + 0.1 * age + 4.1
    
    # 如果有阻抗值，进行修正 (这里使用阻抗比例修正)
    if impedance > 0:
        # 阻抗越高，体脂越高 (这是一个非常简化的线性比例)
        # 正常范围 400-800
        impedance_factor = (impedance - 500) / 100.0
        body_fat += impedance_factor

    # 限制范围
    body_fat = max(5.0, min(body_fat, 50.0))

    # 2. 肌肉量
    muscle = weight * (1 - body_fat / 100.0) * 0.75
    
    # 3. 水分
    water = (100 - body_fat) * 0.7
    
    # 4. 内脏脂肪 (基于 BMI 估算)
    visceral_fat = bmi - 13.0
    visceral_fat = max(1.0, min(visceral_fat, 20.0))

    # 5. 骨量
    bone_mass = weight * 0.04

    # 6. 基础代谢
    bmr = weight * 24.0 if is_male else weight * 22.0

    return {
        "bmi": round(bmi, 1),
        "body_fat": round(body_fat, 1),
        "muscle": round(muscle, 1),
        "water": round(water, 1),
        "visceral_fat": round(visceral_fat, 1),
        "bone_mass": round(bone_mass, 1),
        "bmr": round(bmr, 0)
    }

@app.post("/api/scale/record")
def record_weight(record: WeightRecord, session: Session = Depends(get_session)):
    # 如果有阻抗但没有详细指标，则在后端计算
    if record.impedance and not record.body_fat:
        user = session.get(User, record.user_id)
        if user:
            metrics = calculate_body_metrics(record.weight, record.impedance, user)
            record.bmi = metrics["bmi"]
            record.body_fat = metrics["body_fat"]
            record.muscle = metrics["muscle"]
            record.water = metrics["water"]
            record.visceral_fat = metrics["visceral_fat"]
            record.bone_mass = metrics["bone_mass"]
            record.bmr = metrics["bmr"]
    
    session.add(record)
    session.commit()
    session.refresh(record)
    return {"status": "success", "id": record.id}

@app.get("/api/scale/live")
async def get_live_scale():
    return ble_service.latest_data

# --- Known Devices 路由 ---
@app.get("/api/devices/known", response_model=List[KnownDevice])
def get_known_devices(session: Session = Depends(get_session)):
    return session.exec(select(KnownDevice)).all()

@app.post("/api/devices/bind")
def bind_device(device: KnownDevice, session: Session = Depends(get_session)):
    existing = session.exec(select(KnownDevice).where(KnownDevice.device_id == device.device_id)).first()
    if existing:
        existing.last_seen = int(time.time() * 1000)
        session.add(existing)
    else:
        session.add(device)
    session.commit()
    return {"status": "success"}

@app.delete("/api/devices/unbind/{device_id}")
def unbind_device(device_id: str, session: Session = Depends(get_session)):
    device = session.exec(select(KnownDevice).where(KnownDevice.device_id == device_id)).first()
    if device:
        session.delete(device)
        session.commit()
    return {"status": "success"}

if __name__ == "__main__":
    # 使用 "app.main:app" 字符串而不是直接传 app 对象，能避免很多路径问题
    # 并且在根目录下运行：python -m app.main
    uvicorn.run("app.main:app", host="0.0.0.0", port=8001, reload=True)