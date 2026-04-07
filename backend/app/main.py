import os
import uvicorn
import asyncio
import time
import logging
from contextlib import asynccontextmanager
from typing import Optional, List

logger = logging.getLogger(__name__)

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
from .services.xiaomi_service import xiaomi_service
from .models.models import User, WeightRecord, FeedingPlan
from .models.db import get_session, init_db
from .utils.cache_manager import cache_manager
from .scheduler.task_scheduler import scheduler, create_data_refresh_task

load_dotenv()

# --- 1. 生命周期管理 (Lifespan) ---
# 用于在应用生命周期内共享全局服务实例
class AppState:
    def __init__(self):
        self.petkit: Optional[PetKitService] = None
        self.data_refresh_task = None
        self.xiaomi_initialized: bool = False

state = AppState()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """管理应用启动和关闭时的逻辑"""
    import time
    start_time = time.time()
    
    # 启动时：初始化数据库和长连接服务
    logger.info("=== 开始初始化应用 ===")
    db_start = time.time()
    init_db()
    logger.info(f"✓ 数据库初始化完成，耗时：{time.time() - db_start:.2f}秒")

    # 初始化 CloudPets 服务 (从数据库加载 Token 或自动登录)
    logger.info("正在初始化 CloudPets 服务...")
    cloudpets_start = time.time()
    await cloudpets_service.initialize()
    logger.info(f"✓ CloudPets 服务初始化完成，耗时：{time.time() - cloudpets_start:.2f}秒")

    # 初始化 Xiaomi Cloud 服务
    logger.info("正在初始化 Xiaomi Cloud 服务...")
    xiaomi_start = time.time()
    xiaomi_success = await xiaomi_service.initialize()
    if xiaomi_success:
        state.xiaomi_initialized = True
        logger.info(f"✓ Xiaomi Cloud 服务初始化成功，耗时：{time.time() - xiaomi_start:.2f}秒")
    else:
        logger.warning("✗ Xiaomi Cloud 服务初始化失败，体重推送功能将不可用")

    # 统一环境变量 ACCOUNT 和 PASSWORD
    # 注意：PetKit 通常需要带区号 (如 86-)，而 CloudPets 会自动去除
    username = os.getenv("ACCOUNT")
    password = os.getenv("PASSWORD")

    if username and password:
        logger.info(f"正在初始化 PetKit 服务：{username}...")
        petkit_start = time.time()
        state.petkit = PetKitService(username, password)
        try:
            await state.petkit.initialize()
            logger.info(f"✓ PetKit 服务连接成功，耗时：{time.time() - petkit_start:.2f}秒")
        except Exception as e:
            logger.error(f"PetKit 连接失败：{e}")
            logger.error(f"✗ PetKit 初始化失败，耗时：{time.time() - petkit_start:.2f}秒")
    else:
        logger.warning("警告：未检测到 PETKIT 环境变量，相关 API 将不可用")
    
    # 初始化数据刷新任务
    logger.info("正在初始化数据刷新任务...")
    task_start = time.time()
    state.data_refresh_task = create_data_refresh_task(
        state.petkit, 
        cloudpets_service, 
        cache_manager
    )
    logger.info(f"✓ 数据刷新任务初始化完成，耗时：{time.time() - task_start:.2f}秒")
    
    # 添加定时任务
    logger.info("正在添加定时任务...")
    scheduler_start = time.time()
    await scheduler.add_task(
        'dashboard_refresh', 
        state.data_refresh_task.refresh_combined_dashboard_data,
        interval=60,  # 每分钟刷新一次
        immediate=True
    )
        
    await scheduler.add_task(
        'petkit_refresh',
        state.data_refresh_task.refresh_petkit_data,
        interval=180,  # 每 3 分钟刷新 PetKit 数据
        immediate=False
    )
        
    await scheduler.add_task(
        'cloudpets_refresh',
        state.data_refresh_task.refresh_cloudpets_data,
        interval=120,  # 每 2 分钟刷新 CloudPets 数据
        immediate=False
    )
    logger.info(f"✓ 定时任务添加完成，耗时：{time.time() - scheduler_start:.2f}秒")
        
    # 启动调度器
    logger.info("正在启动调度器...")
    await scheduler.start()
    logger.info(f"✓ 调度器启动完成")
        
    total_time = time.time() - start_time
    logger.info(f"=== 应用初始化完成，总耗时：{total_time:.2f}秒 ===")

    yield  # 分隔符，上方是启动逻辑，下方是关闭逻辑

    # 关闭时：清理资源
    logger.info("正在关闭调度器...")
    await scheduler.stop()
    
    if state.petkit:
        logger.info("正在关闭 PetKit 服务...")
        await state.petkit.close()

    await cloudpets_service.close()

    if state.xiaomi_initialized:
        logger.info("Xiaomi Cloud service will be closed")

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
    logger.warning(f"Warning: Static directory not found at {STATIC_DIR}")

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
        "size": await cache_manager.size(),
        "last_refresh": await cache_manager.get('dashboard_last_refresh')
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
        cached_data = await cache_manager.get('dashboard_combined_data')
        if cached_data:
            return cached_data
        
        # 缓存未命中，实时获取数据
        dashboard_data = {}
        
        # 获取 PetKit 设备数据
        petkit_devices = await cache_manager.get('petkit_devices')
        if not petkit_devices and state.petkit:
            petkit_devices = await state.petkit.get_devices()
            await cache_manager.set('petkit_devices', petkit_devices, ttl=300)
        
        dashboard_data['petkit_devices'] = petkit_devices or []
        
        # 获取猫厕所统计数据
        litterbox_stats = {}
        if petkit_devices:
            for device in petkit_devices:
                if hasattr(device, 'id'):
                    cache_key = f'petkit_stats_{device.id}'
                    stats = await cache_manager.get(cache_key)
                    if not stats and state.petkit:
                        stats = await state.petkit.get_daily_stats(device.id)
                        await cache_manager.set(cache_key, stats, ttl=180)
                    litterbox_stats[device.id] = stats or {}
        
        dashboard_data['litterbox_stats'] = litterbox_stats
        
        # 获取 CloudPets 数据
        cloudpets_servings = await cache_manager.get('cloudpets_servings')
        if not cloudpets_servings:
            cloudpets_servings = await cloudpets_service.get_servings_today()
            await cache_manager.set('cloudpets_servings', cloudpets_servings, ttl=120)
        
        dashboard_data['cloudpets_servings'] = cloudpets_servings
        
        cloudpets_plans = await cache_manager.get('cloudpets_plans')
        if not cloudpets_plans:
            cloudpets_plans = await cloudpets_service.get_feeding_plans()
            await cache_manager.set('cloudpets_plans', cloudpets_plans, ttl=300)
        
        dashboard_data['cloudpets_plans'] = cloudpets_plans or []
        
        # 缓存聚合数据
        await cache_manager.set('dashboard_combined_data', dashboard_data, ttl=60)
        
        return dashboard_data
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取仪表板数据失败：{str(e)}")



@app.get("/api/petkit/devices")
async def petkit_devices(service: PetKitService = Depends(get_petkit)):
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        # 优先从缓存获取
        cached_devices = await cache_manager.get('petkit_devices')
        if cached_devices:
            return cached_devices
        
        # 缓存未命中，从服务获取
        devices = await service.get_devices()
        # 缓存 5 分钟
        await cache_manager.set('petkit_devices', devices, ttl=300)
        return devices
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch devices: {str(e)}")

@app.post("/api/petkit/clean")
async def petkit_clean(service: PetKitService = Depends(get_petkit)):
    """清理猫厕所（自动选择第一个设备）"""
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        return await service.clean_litterbox(None)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Action failed: {str(e)}")

@app.post("/api/petkit/deodorize")
async def petkit_deodorize(service: PetKitService = Depends(get_petkit)):
    """除臭猫厕所（自动选择第一个设备）"""
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        return await service.deodorize_litterbox(None)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/petkit/stats")
async def petkit_daily_stats(device_id: Optional[str] = None, service: PetKitService = Depends(get_petkit)):
    """获取今日统计数据（修复后的准确数据）"""
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        # 处理 device_id 为字符串 "null" 的情况
        if device_id == "null" or device_id == "":
            device_id = None
        
        # 构建缓存键
        cache_key = f'petkit_stats_{device_id or "default"}'
        
        # 优先从缓存获取
        cached_stats = await cache_manager.get(cache_key)
        if cached_stats:
            return cached_stats
        
        # 缓存未命中，从服务获取
        stats = await service.get_daily_stats(device_id)
        # 缓存 3 分钟
        await cache_manager.set(cache_key, stats, ttl=180)
        return stats
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取统计数据失败：{str(e)}")

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
    """合并获取设备列表和统计数据的接口（带缓存）- 与 Web端一致"""
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    
    try:
        # 优先从缓存获取完整数据
        cached_data = await cache_manager.get('petkit_devices_with_stats')
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
                stats = await cache_manager.get(stats_cache_key)
                if not stats:
                    stats = await service.get_daily_stats(device_id)
                    # 缓存统计信息 3 分钟
                    await cache_manager.set(stats_cache_key, stats, ttl=180)
                
                device_dict = device if isinstance(device, dict) else {
                    "id": device_id,
                    "name": getattr(device, 'name', 'Unknown'),
                    "type": getattr(device, 'type', 'Unknown'),
                    "data": getattr(device, 'data', {})
                }
                
                # 将统计数据放入 state_summary 字段（与 Web端一致）
                device_dict['state_summary'] = stats if isinstance(stats, dict) else {}
                
                result.append(device_dict)
            else:
                result.append(device)
        
        # 缓存完整结果 2 分钟
        await cache_manager.set('petkit_devices_with_stats', result, ttl=120)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取设备和统计数据失败：{str(e)}")

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

@app.get("/api/cloudpets/feeder/status")
async def cloudpets_feeder_status():
    """获取喂食器实时状态"""
    return await cloudpets_service.get_feeder_status()

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

# --- Xiaomi Cloud 路由 ---
@app.get("/api/xiaomi/status")
async def xiaomi_status():
    """获取小米云服务状态"""
    return {
        "initialized": state.xiaomi_initialized,
        "user_id": xiaomi_service.userId if state.xiaomi_initialized else None,
        "has_token": bool(xiaomi_service._serviceToken) if state.xiaomi_initialized else False
    }

@app.post("/api/xiaomi/login")
async def xiaomi_login():
    """手动触发小米云登录"""
    try:
        success = await xiaomi_service.login()
        if success:
            state.xiaomi_initialized = True
            return {"status": "success", "message": "Login successful"}
        else:
            raise HTTPException(status_code=500, detail="Login failed")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Login error: {str(e)}")

@app.post("/api/xiaomi/push-weight")
async def push_weight_to_xiaomi(
    weight: float,
    body_fat: Optional[float] = None,
    bmi: Optional[float] = None,
    muscle: Optional[float] = None,
    water: Optional[float] = None,
    visceral_fat: Optional[float] = None,
    bone_mass: Optional[float] = None,
    bmr: Optional[float] = None,
    impedance: Optional[int] = None,
    user_id: Optional[int] = None
):
    """手动推送体重数据到小米云"""
    if not state.xiaomi_initialized:
        raise HTTPException(status_code=503, detail="Xiaomi service not initialized")
    
    try:
        user_data = {
            "weight": weight,
            "impedance": impedance or 0,
            "user_id": user_id or 0
        }
        
        # 如果提供了详细数据
        if body_fat is not None:
            user_data.update({
                "body_fat": body_fat,
                "bmi": bmi,
                "muscle": muscle,
                "water": water,
                "visceral_fat": visceral_fat,
                "bone_mass": bone_mass,
                "bmr": bmr
            })
        
        success = await xiaomi_service.push_weight_data(user_data)
        if success:
            return {"status": "success", "message": "Data pushed to Xiaomi"}
        else:
            raise HTTPException(status_code=500, detail="Failed to push data")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Push error: {str(e)}")

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
    result = {"status": "success", "id": record.id}
    
    # 异步推送到小米云（不阻塞响应）
    if state.xiaomi_initialized:
        import asyncio
        asyncio.create_task(push_to_xiaomi(record, user if record.impedance else None))
    
    return result

async def push_to_xiaomi(record: WeightRecord, user: Optional[User] = None):
    """异步推送体重数据到小米云"""
    try:
        user_data = {
            "weight": record.weight,
            "impedance": record.impedance or 0,
            "user_id": record.user_id or 0
        }
        
        # 如果有详细体脂数据，使用这些数据
        if record.body_fat:
            user_data.update({
                "body_fat": record.body_fat,
                "bmi": record.bmi,
                "muscle": record.muscle,
                "water": record.water,
                "visceral_fat": record.visceral_fat,
                "bone_mass": record.bone_mass,
                "bmr": record.bmr
            })
        elif user:
            # 如果没有，使用用户信息计算
            metrics = calculate_body_metrics(record.weight, record.impedance or 0, user)
            user_data.update(metrics)
        
        success = await xiaomi_service.push_weight_data(user_data)
        if success:
            logger.info(f"Successfully pushed weight data to Xiaomi for user {record.user_id}")
        else:
            logger.error(f"Failed to push weight data to Xiaomi for user {record.user_id}")
    except Exception as e:
        logger.error(f"Error pushing to Xiaomi: {e}")


# Deleted: # --- Known Devices 路由 ---
# Deleted: @app.get("/api/devices/known", response_model=List[KnownDevice])
# Deleted: def get_known_devices(session: Session = Depends(get_session)):
# Deleted:     return session.exec(select(KnownDevice)).all()

# Deleted: @app.post("/api/devices/bind")
# Deleted: def bind_device(device: KnownDevice, session: Session = Depends(get_session)):
# Deleted:     existing = session.exec(select(KnownDevice).where(KnownDevice.device_id == device.device_id)).first()
# Deleted:     if existing:
# Deleted:         existing.last_seen = int(time.time() * 1000)
# Deleted:         session.add(existing)
# Deleted:     else:
# Deleted:         session.add(device)
# Deleted:     session.commit()
# Deleted:     return {"status": "success"}

# Deleted: @app.delete("/api/devices/unbind/{device_id}")
# Deleted: def unbind_device(device_id: str, session: Session = Depends(get_session)):
# Deleted:     device = session.exec(select(KnownDevice).where(KnownDevice.device_id == device_id)).first()
# Deleted:     if device:
# Deleted:         session.delete(device)
# Deleted:         session.commit()
# Deleted:     return {"status": "success"}
