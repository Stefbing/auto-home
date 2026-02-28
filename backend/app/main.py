import os
import uvicorn
import asyncio
import time
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
from .services.petkit_service import PetKitService
from .services.cloudpets_service import cloudpets_service, FeedingPlan as CloudPetsPlan
from .models.models import User, WeightRecord, FeedingPlan, KnownDevice
from .models.db import get_session, init_db
from .utils.cache_manager import async_cache_manager
from .scheduler.task_scheduler import scheduler, create_data_refresh_task

load_dotenv()

# --- 1. 生命周期管理 (Lifespan) ---
# 用于在应用生命周期内共享全局服务实例
class AppState:
    def __init__(self):
        self.petkit: Optional[PetKitService] = None
        self.data_refresh_task = None

state = AppState()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """管理应用启动和关闭时的逻辑"""
    # 启动时：初始化数据库和长连接服务
    init_db()

    # 初始化 CloudPets 服务 (从数据库加载 Token 或自动登录)
    await cloudpets_service.initialize()

    # 统一环境变量 ACCOUNT 和 PASSWORD
    # 注意：PetKit 通常需要带区号 (如 86-)，而 CloudPets 会自动去除
    username = os.getenv("ACCOUNT")
    password = os.getenv("PASSWORD")

    if username and password:
        print(f"正在初始化 PetKit 服务: {username}...")
        state.petkit = PetKitService(username, password)
        try:
            await state.petkit.initialize()
            print("PetKit 服务连接成功")
        except Exception as e:
            print(f"PetKit 连接失败: {e}")
    else:
        print("警告: 未检测到 PETKIT 环境变量，相关 API 将不可用")
    
    # 初始化数据刷新任务
    state.data_refresh_task = create_data_refresh_task(
        state.petkit, 
        cloudpets_service, 
        async_cache_manager
    )
    
    # 添加定时任务
    await scheduler.add_task(
        'dashboard_refresh', 
        state.data_refresh_task.refresh_combined_dashboard_data,
        interval=60,  # 每分钟刷新一次
        immediate=True
    )
    
    await scheduler.add_task(
        'petkit_refresh',
        state.data_refresh_task.refresh_petkit_data,
        interval=180,  # 每3分钟刷新PetKit数据
        immediate=False
    )
    
    await scheduler.add_task(
        'cloudpets_refresh',
        state.data_refresh_task.refresh_cloudpets_data,
        interval=120,  # 每2分钟刷新CloudPets数据
        immediate=False
    )
    
    # 启动调度器
    await scheduler.start()

    yield  # 分隔符，上方是启动逻辑，下方是关闭逻辑

    # 关闭时：清理资源
    print("正在关闭调度器...")
    await scheduler.stop()
    
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

# 使用绝对路径定位 static 目录，适配 Vercel 环境
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# backend/app/main.py -> backend/static
STATIC_DIR = os.path.join(os.path.dirname(BASE_DIR), "static")

if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
else:
    print(f"Warning: Static directory not found at {STATIC_DIR}")

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
    return FileResponse(os.path.join(STATIC_DIR, 'index.html'))

@app.get("/litterbox")
async def litterbox_page():
    return FileResponse(os.path.join(STATIC_DIR, 'litterbox.html'))

@app.get("/feeder")
async def feeder_page():
    return FileResponse(os.path.join(STATIC_DIR, 'feeder.html'))

@app.get("/feeder/plans")
async def feeder_plans_page():
    return FileResponse(os.path.join(STATIC_DIR, 'feeder_plans.html'))

@app.get("/scale")
async def scale_page():
    return FileResponse(os.path.join(STATIC_DIR, 'scale.html'))

@app.get("/api/cache/status")
async def cache_status():
    """获取缓存状态"""
    return {
        "size": await async_cache_manager.size(),
        "last_refresh": await async_cache_manager.get('dashboard_last_refresh')
    }

@app.post("/api/cache/refresh")
async def force_refresh_cache():
    """强制刷新所有缓存数据"""
    try:
        if state.data_refresh_task:
            await state.data_refresh_task.refresh_combined_dashboard_data()
            return {"status": "success", "message": "数据已强制刷新"}
        else:
            return {"status": "error", "message": "刷新任务未初始化"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"刷新失败: {str(e)}")

@app.get("/api/dashboard/data")
async def get_dashboard_data():
    """获取首页聚合数据（优先从缓存获取）"""
    try:
        # 尝试从缓存获取数据
        cached_data = await async_cache_manager.get('dashboard_combined_data')
        if cached_data:
            return cached_data
        
        # 缓存未命中，实时获取数据
        dashboard_data = {}
        
        # 获取PetKit设备数据
        petkit_devices = await async_cache_manager.get('petkit_devices')
        if not petkit_devices and state.petkit:
            petkit_devices = await state.petkit.get_devices()
            await async_cache_manager.set('petkit_devices', petkit_devices, ttl=300)
        
        dashboard_data['petkit_devices'] = petkit_devices or []
        
        # 获取猫厕所统计数据
        litterbox_stats = {}
        if petkit_devices:
            for device in petkit_devices:
                if hasattr(device, 'id'):
                    cache_key = f'petkit_stats_{device.id}'
                    stats = await async_cache_manager.get(cache_key)
                    if not stats and state.petkit:
                        stats = await state.petkit.get_daily_stats(device.id)
                        await async_cache_manager.set(cache_key, stats, ttl=180)
                    litterbox_stats[device.id] = stats or {}
        
        dashboard_data['litterbox_stats'] = litterbox_stats
        
        # 获取CloudPets数据
        cloudpets_servings = await async_cache_manager.get('cloudpets_servings')
        if not cloudpets_servings:
            cloudpets_servings = await cloudpets_service.get_servings_today()
            await async_cache_manager.set('cloudpets_servings', cloudpets_servings, ttl=120)
        
        dashboard_data['cloudpets_servings'] = cloudpets_servings
        
        cloudpets_plans = await async_cache_manager.get('cloudpets_plans')
        if not cloudpets_plans:
            cloudpets_plans = await cloudpets_service.get_feeding_plans()
            await async_cache_manager.set('cloudpets_plans', cloudpets_plans, ttl=300)
        
        dashboard_data['cloudpets_plans'] = cloudpets_plans or []
        
        # 缓存聚合数据
        await async_cache_manager.set('dashboard_combined_data', dashboard_data, ttl=60)
        
        return dashboard_data
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取仪表板数据失败: {str(e)}")

@app.get("/api/petkit/debug")
async def petkit_debug(service: PetKitService = Depends(get_petkit)):
    if not service:
         return {"error": "No service"}
    return await service.get_client_methods()

@app.get("/api/petkit/devices")
async def petkit_devices(service: PetKitService = Depends(get_petkit)):
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        # 优先从缓存获取
        cached_devices = await async_cache_manager.get('petkit_devices')
        if cached_devices:
            return cached_devices
        
        # 缓存未命中，从服务获取
        devices = await service.get_devices()
        # 缓存5分钟
        await async_cache_manager.set('petkit_devices', devices, ttl=300)
        return devices
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch devices: {str(e)}")

@app.post("/api/petkit/clean")
async def petkit_clean(device_id: Optional[str] = None, service: PetKitService = Depends(get_petkit)):
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        return await service.clean_litterbox(device_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Action failed: {str(e)}")

@app.post("/api/petkit/deodorize")
async def petkit_deodorize(device_id: Optional[str] = None, service: PetKitService = Depends(get_petkit)):
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        return await service.deodorize_litterbox(device_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/petkit/stats")
async def petkit_daily_stats(device_id: Optional[str] = None, service: PetKitService = Depends(get_petkit)):
    """获取今日统计数据（修复后的准确数据）"""
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        # 构建缓存键
        cache_key = f'petkit_stats_{device_id or "default"}'
        
        # 优先从缓存获取
        cached_stats = await async_cache_manager.get(cache_key)
        if cached_stats:
            return cached_stats
        
        # 缓存未命中，从服务获取
        stats = await service.get_daily_stats(device_id)
        # 缓存3分钟
        await async_cache_manager.set(cache_key, stats, ttl=180)
        return stats
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取统计数据失败: {str(e)}")

@app.get("/api/petkit/history")
async def petkit_history_stats(device_id: Optional[str] = None, days: int = 7, service: PetKitService = Depends(get_petkit)):
    """获取历史统计数据"""
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        return await service.get_device_stats(device_id, days)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取历史统计失败: {str(e)}")

@app.get("/api/petkit/devices-stats")
async def petkit_devices_with_stats(service: PetKitService = Depends(get_petkit)):
    """合并获取设备列表和统计数据的接口（带缓存）"""
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    
    try:
        # 优先从缓存获取完整数据
        cached_data = await async_cache_manager.get('petkit_devices_with_stats')
        if cached_data:
            return cached_data
        
        # 缓存未命中，获取设备列表
        devices = await service.get_devices()
        
        # 为每个设备获取统计信息
        result = []
        for device in devices:
            device_id = getattr(device, 'id', '') if hasattr(device, 'id') else ''
            if device_id:
                # 优先从缓存获取统计信息
                stats_cache_key = f'petkit_stats_{device_id}'
                stats = await async_cache_manager.get(stats_cache_key)
                if not stats:
                    stats = await service.get_daily_stats(device_id)
                    # 缓存统计信息3分钟
                    await async_cache_manager.set(stats_cache_key, stats, ttl=180)
                
                device_dict = device if isinstance(device, dict) else {
                    "id": device_id,
                    "name": getattr(device, 'name', 'Unknown'),
                    "type": getattr(device, 'type', 'Unknown'),
                    "data": getattr(device, 'data', {})
                }
                device_dict['stats'] = stats
                result.append(device_dict)
            else:
                result.append(device)
        
        # 缓存完整结果2分钟
        await async_cache_manager.set('petkit_devices_with_stats', result, ttl=120)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取设备和统计数据失败: {str(e)}")

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
