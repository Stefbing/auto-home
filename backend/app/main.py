"""Smart Home Controller API - Main Application"""
import os, uvicorn, asyncio, time, logging
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

from .services.petkit_service import PetKitService
from .services.cloudpets_service import cloudpets_service, FeedingPlan as CloudPetsPlan
from .services.xiaomi_service import xiaomi_service
from .models.models import User, WeightRecord, SystemConfig
from .models.db import get_session, init_db
from .utils.cache_manager import cache_manager
from .utils.config_encryptor import ConfigEncryptor
from .scheduler.task_scheduler import scheduler, create_data_refresh_task

load_dotenv()

# --- AppState & Helpers ---
class AppState:
    def __init__(self):
        self.petkit: Optional[PetKitService] = None
        self.cloudpets = None
        self.data_refresh_task = None
        self.xiaomi_initialized: bool = False

state = AppState()

async def _init_service_for_user(platform: str, user_id: int, account: str, password: str) -> bool:
    """Unified service initialization helper"""
    try:
        logger.info(f"Initializing {platform} service for user {user_id}...")
        if platform == "petkit":
            state.petkit = PetKitService(account, password, user_id=user_id)
            success = await state.petkit.initialize()
            logger.info(f"{'✓' if success else '⚠'} PetKit init {'success' if success else 'failed'}")
            return success
        elif platform == "cloudpets":
            from .utils.config_manager import set_config_to_db
            await set_config_to_db("account", user_id, account, is_encrypted=True, platform="cloudpets")
            await set_config_to_db("password", user_id, password, is_encrypted=True, platform="cloudpets")
            import backend.app.services.cloudpets_service as cp_module
            state.cloudpets = cp_module.CloudPetsService(user_id=user_id)
            success = await state.cloudpets.initialize()
            logger.info(f"{'✓' if success else '⚠'} CloudPets init {'success' if success else 'failed'}")
            return success
        elif platform == "xiaomi":
            from .utils.config_manager import set_config_to_db
            await set_config_to_db("account", user_id, account, is_encrypted=True, platform="xiaomi")
            await set_config_to_db("password", user_id, password, is_encrypted=True, platform="xiaomi")
            success = await xiaomi_service.initialize()
            if success:
                state.xiaomi_initialized = True
            logger.info(f"{'✓' if success else '⚠'} Xiaomi init {'success' if success else 'failed'}")
            return success
        else:
            logger.warning(f"Unknown platform: {platform}")
            return False
    except Exception as e:
        logger.error(f"{platform} init failed: {e}")
        return False

async def _get_first_user_with_platform(platform: str) -> Optional[int]:
    """Query first user ID with specified platform config"""
    try:
        from sqlmodel import Session, select
        from .models.models import SystemConfig
        from .models.db import engine
        loop = asyncio.get_running_loop()
        def _query():
            with Session(engine) as session:
                stmt = select(SystemConfig.user_id).where(
                    SystemConfig.platform == platform, SystemConfig.key == "account"
                ).distinct()
                ids = session.exec(stmt).all()
                return ids[0] if ids else None
        return await loop.run_in_executor(None, _query)
    except Exception as e:
        logger.warning(f"Query {platform} user failed: {e}")
        return None

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage app startup and shutdown"""
    start_time = time.time()
    logger.info("=== Starting application ===")
    
    init_db()
    logger.info(f"✓ DB initialized in {time.time() - start_time:.2f}s")

    # Initialize CloudPets
    logger.info("Initializing CloudPets...")
    cp_start = time.time()
    first_user_id = await _get_first_user_with_platform("cloudpets")
    if first_user_id:
        from .utils.config_manager import get_config_from_db
        account = await get_config_from_db("account", user_id=first_user_id, platform="cloudpets")
        password = await get_config_from_db("password", user_id=first_user_id, platform="cloudpets")
        if account and password:
            success = await _init_service_for_user("cloudpets", first_user_id, account, password)
            if not success:
                state.cloudpets = None
        else:
            logger.warning(f"User {first_user_id} CloudPets config incomplete")
            state.cloudpets = None
    else:
        await cloudpets_service.initialize()
        state.cloudpets = cloudpets_service
        logger.info(f"✓ CloudPets initialized (global) in {time.time() - cp_start:.2f}s")

    # Initialize Xiaomi
    logger.info("Initializing Xiaomi...")
    xm_start = time.time()
    xm_success = await xiaomi_service.initialize()
    if xm_success:
        state.xiaomi_initialized = True
        logger.info(f"✓ Xiaomi initialized in {time.time() - xm_start:.2f}s")
    else:
        logger.warning("✗ Xiaomi init failed")

    # Initialize PetKit
    logger.info("Initializing PetKit...")
    pk_start = time.time()
    petkit_user_id = await _get_first_user_with_platform("petkit")
    if petkit_user_id:
        from .utils.config_manager import get_config_from_db
        username = await get_config_from_db("account", user_id=petkit_user_id, platform="petkit")
        password = await get_config_from_db("password", user_id=petkit_user_id, platform="petkit")
        if username and password:
            state.petkit = PetKitService(username, password, user_id=petkit_user_id)
            try:
                await state.petkit.initialize()
                logger.info(f"✓ PetKit connected (user {petkit_user_id}) in {time.time() - pk_start:.2f}s")
            except Exception as e:
                logger.error(f"PetKit connection failed: {e}")
                state.petkit = None
        else:
            logger.warning(f"User {petkit_user_id} PetKit config incomplete")
            state.petkit = None
    else:
        from .utils.config_manager import get_config_from_db
        username = await get_config_from_db("ACCOUNT")
        password = await get_config_from_db("PASSWORD")
        if username and password:
            state.petkit = PetKitService(username, password)
            try:
                await state.petkit.initialize()
                logger.info(f"✓ PetKit connected (global) in {time.time() - pk_start:.2f}s")
            except Exception as e:
                logger.error(f"PetKit connection failed: {e}")
                state.petkit = None
        else:
            logger.warning("No PetKit config detected")
            state.petkit = None
    
    # Init data refresh task
    logger.info("Initializing data refresh task...")
    task_start = time.time()
    state.data_refresh_task = create_data_refresh_task(
        state.petkit, state.cloudpets or cloudpets_service, cache_manager
    )
    logger.info(f"✓ Task initialized in {time.time() - task_start:.2f}s")
    
    # Add scheduled tasks
    logger.info("Adding scheduled tasks...")
    sched_start = time.time()
    await scheduler.add_task('dashboard_refresh', state.data_refresh_task.refresh_combined_dashboard_data, interval=60, immediate=True)
    await scheduler.add_task('petkit_refresh', state.data_refresh_task.refresh_petkit_data, interval=180, immediate=False)
    await scheduler.add_task('cloudpets_refresh', state.data_refresh_task.refresh_cloudpets_data, interval=120, immediate=False)
    logger.info(f"✓ Tasks added in {time.time() - sched_start:.2f}s")
    
    await scheduler.start()
    logger.info(f"=== App initialized in {time.time() - start_time:.2f}s ===")

    yield

    # Shutdown
    logger.info("Shutting down...")
    await scheduler.stop()
    if state.petkit:
        logger.info("Closing PetKit...")
        await state.petkit.close()
    if state.cloudpets:
        logger.info("Closing CloudPets...")
        await state.cloudpets.close()
    if state.xiaomi_initialized:
        logger.info("Xiaomi service closed")

# --- App Config ---
app = FastAPI(title="Smart Home Controller", version="0.3.0", lifespan=lifespan)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(os.path.dirname(BASE_DIR), "static")

if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
else:
    logger.warning(f"Static directory not found: {STATIC_DIR}")

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

def get_petkit():
    """Get logged-in PetKit instance"""
    if not state.petkit:
        raise HTTPException(status_code=503, detail="PetKit service not initialized")
    return state.petkit

# --- Static Routes ---
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

@app.get("/config")
async def config_page():
    return FileResponse(os.path.join(STATIC_DIR, 'config.html'))

# --- Cache & Dashboard APIs ---
@app.get("/api/cache/status")
async def cache_status():
    return {"size": await cache_manager.size(), "last_refresh": await cache_manager.get('dashboard_last_refresh')}

@app.post("/api/cache/refresh")
async def force_refresh_cache():
    try:
        if state.data_refresh_task:
            await state.data_refresh_task.refresh_combined_dashboard_data()
            return {"status": "success", "message": "数据已强制刷新"}
        return {"status": "error", "message": "刷新任务未初始化"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"刷新失败: {str(e)}")

@app.get("/api/dashboard/data")
async def get_dashboard_data():
    """Get aggregated dashboard data (cached)"""
    try:
        cached_data = await cache_manager.get('dashboard_combined_data')
        if cached_data:
            return cached_data
        
        dashboard_data = {}
        petkit_devices = await cache_manager.get('petkit_devices')
        if not petkit_devices and state.petkit:
            petkit_devices = await state.petkit.get_devices()
            await cache_manager.set('petkit_devices', petkit_devices, ttl=300)
        dashboard_data['petkit_devices'] = petkit_devices or []
        
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
        
        cloudpets_servings = await cache_manager.get('cloudpets_servings')
        if not cloudpets_servings and state.cloudpets:
            cloudpets_servings = await state.cloudpets.get_servings_today()
            await cache_manager.set('cloudpets_servings', cloudpets_servings, ttl=120)
        dashboard_data['cloudpets_servings'] = cloudpets_servings or {}
        
        cloudpets_plans = await cache_manager.get('cloudpets_plans')
        if not cloudpets_plans and state.cloudpets:
            cloudpets_plans = await state.cloudpets.get_feeding_plans()
            await cache_manager.set('cloudpets_plans', cloudpets_plans, ttl=300)
        dashboard_data['cloudpets_plans'] = cloudpets_plans or []
        
        await cache_manager.set('dashboard_combined_data', dashboard_data, ttl=60)
        return dashboard_data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取仪表板数据失败：{str(e)}")
# --- PetKit APIs ---
@app.get("/api/petkit/devices")
async def petkit_devices(service: PetKitService = Depends(get_petkit)):
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        cached_devices = await cache_manager.get('petkit_devices')
        if cached_devices:
            return cached_devices
        devices = await service.get_devices()
        await cache_manager.set('petkit_devices', devices, ttl=300)
        return devices
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch devices: {str(e)}")

@app.post("/api/petkit/clean")
async def petkit_clean(service: PetKitService = Depends(get_petkit)):
    """Clean litterbox (auto-select first device)"""
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        return await service.clean_litterbox(None)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Action failed: {str(e)}")

@app.post("/api/petkit/deodorize")
async def petkit_deodorize(service: PetKitService = Depends(get_petkit)):
    """Deodorize litterbox (auto-select first device)"""
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        return await service.deodorize_litterbox(None)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/petkit/stats")
async def petkit_daily_stats(device_id: Optional[str] = None, service: PetKitService = Depends(get_petkit)):
    """Get daily stats (accurate data)"""
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        if device_id == "null" or device_id == "":
            device_id = None
        cache_key = f'petkit_stats_{device_id or "default"}'
        cached_stats = await cache_manager.get(cache_key)
        if cached_stats:
            return cached_stats
        stats = await service.get_daily_stats(device_id)
        await cache_manager.set(cache_key, stats, ttl=180)
        return stats
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取统计数据失败：{str(e)}")

@app.get("/api/petkit/history")
async def petkit_history_stats(device_id: Optional[str] = None, days: int = 7, service: PetKitService = Depends(get_petkit)):
    """Get historical stats"""
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        return await service.get_device_stats(device_id, days)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取历史统计失败: {str(e)}")

@app.get("/api/petkit/devices-stats")
async def petkit_devices_with_stats(service: PetKitService = Depends(get_petkit)):
    """Get devices with stats (cached) - consistent with Web"""
    if not service or not service.username or not service.password:
        raise HTTPException(status_code=503, detail="PetKit service not initialized or credentials missing")
    try:
        cached_data = await cache_manager.get('petkit_devices_with_stats')
        if cached_data:
            return cached_data
        devices = await service.get_devices()
        result = []
        for device in devices:
            device_id = getattr(device, 'id', '') if hasattr(device, 'id') else ''
            if device_id:
                stats_cache_key = f'petkit_stats_{device_id}'
                stats = await cache_manager.get(stats_cache_key)
                if not stats:
                    stats = await service.get_daily_stats(device_id)
                    await cache_manager.set(stats_cache_key, stats, ttl=180)
                device_dict = device if isinstance(device, dict) else {
                    "id": device_id, "name": getattr(device, 'name', 'Unknown'),
                    "type": getattr(device, 'type', 'Unknown'), "data": getattr(device, 'data', {})
                }
                device_dict['state_summary'] = stats if isinstance(stats, dict) else {}
                result.append(device_dict)
            else:
                result.append(device)
        await cache_manager.set('petkit_devices_with_stats', result, ttl=120)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取设备和统计数据失败：{str(e)}")

# --- CloudPets APIs ---
@app.get("/api/cloudpets/servings_today")
async def cloudpets_servings_today():
    if not state.cloudpets:
        raise HTTPException(status_code=503, detail="CloudPets service not initialized")
    return await state.cloudpets.get_servings_today()

@app.post("/api/cloudpets/feed")
async def cloudpets_manual_feed(amount: int = 1):
    if not state.cloudpets:
        raise HTTPException(status_code=503, detail="CloudPets service not initialized")
    return await state.cloudpets.manual_feed(amount)

@app.get("/api/cloudpets/plans", response_model=List[CloudPetsPlan])
async def cloudpets_get_plans():
    if not state.cloudpets:
        raise HTTPException(status_code=503, detail="CloudPets service not initialized")
    return await state.cloudpets.get_feeding_plans()

@app.post("/api/cloudpets/plans", response_model=CloudPetsPlan)
async def cloudpets_add_plan(plan: CloudPetsPlan):
    if not state.cloudpets:
        raise HTTPException(status_code=503, detail="CloudPets service not initialized")
    return await state.cloudpets.add_feeding_plan(plan)

@app.put("/api/cloudpets/plans/{plan_id}", response_model=CloudPetsPlan)
async def cloudpets_update_plan(plan_id: str, plan: CloudPetsPlan):
    if not state.cloudpets:
        raise HTTPException(status_code=503, detail="CloudPets service not initialized")
    return await state.cloudpets.update_feeding_plan(plan_id, plan)

@app.delete("/api/cloudpets/plans/{plan_id}")
async def cloudpets_delete_plan(plan_id: str):
    if not state.cloudpets:
        raise HTTPException(status_code=503, detail="CloudPets service not initialized")
    return await state.cloudpets.delete_feeding_plan(plan_id)

@app.get("/api/cloudpets/feeder/status")
async def cloudpets_feeder_status():
    if not state.cloudpets:
        raise HTTPException(status_code=503, detail="CloudPets service not initialized")
    return await state.cloudpets.get_feeder_status()

@app.post("/api/petwant/feed")
async def petwant_feed():
    return {"status": "error", "message": "Use /api/cloudpets/feed instead."}

# --- Scale & User APIs ---
@app.get("/api/users", response_model=List[User])
def get_users(session: Session = Depends(get_session)):
    return session.exec(select(User)).all()

@app.post("/api/users", response_model=User)
def create_user(user: User, session: Session = Depends(get_session)):
    session.add(user)
    session.commit()
    session.refresh(user)
    return user

# --- Xiaomi Cloud APIs ---
@app.get("/api/xiaomi/status")
async def xiaomi_status():
    return {"initialized": state.xiaomi_initialized, "user_id": xiaomi_service.userId if state.xiaomi_initialized else None,
            "has_token": bool(xiaomi_service._serviceToken) if state.xiaomi_initialized else False}

@app.post("/api/xiaomi/login")
async def xiaomi_login():
    try:
        success = await xiaomi_service.login()
        if success:
            state.xiaomi_initialized = True
            return {"status": "success", "message": "Login successful"}
        raise HTTPException(status_code=500, detail="Login failed")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Login error: {str(e)}")

@app.post("/api/xiaomi/push-weight")
async def push_weight_to_xiaomi(weight: float, body_fat: Optional[float] = None, bmi: Optional[float] = None,
                                 muscle: Optional[float] = None, water: Optional[float] = None,
                                 visceral_fat: Optional[float] = None, bone_mass: Optional[float] = None,
                                 bmr: Optional[float] = None, impedance: Optional[int] = None, user_id: Optional[int] = None):
    """Manually push weight data to Xiaomi Cloud"""
    if not state.xiaomi_initialized:
        raise HTTPException(status_code=503, detail="Xiaomi service not initialized")
    try:
        user_data = {"weight": weight, "impedance": impedance or 0, "user_id": user_id or 0}
        if body_fat is not None:
            user_data.update({"body_fat": body_fat, "bmi": bmi, "muscle": muscle, "water": water,
                              "visceral_fat": visceral_fat, "bone_mass": bone_mass, "bmr": bmr})
        success = await xiaomi_service.push_weight_data(user_data)
        if success:
            return {"status": "success", "message": "Data pushed to Xiaomi"}
        raise HTTPException(status_code=500, detail="Failed to push data")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Push error: {str(e)}")

@app.get("/api/scale/history/{user_id}")
def get_weight_history(user_id: int, session: Session = Depends(get_session)):
    stmt = select(WeightRecord).where(WeightRecord.user_id == user_id).order_by(WeightRecord.timestamp.desc()).limit(30)
    return session.exec(stmt).all()

def calculate_body_metrics(weight: float, impedance: int, user: User):
    """Simplified body metrics calculation (Xiaomi Scale 2)"""
    height = user.height / 100.0
    bmi = weight / (height * height)
    is_male = user.gender == "male"
    age = user.age
    body_fat = (0.8 * bmi + 0.1 * age - 5.4) if is_male else (0.8 * bmi + 0.1 * age + 4.1)
    if impedance > 0:
        body_fat += (impedance - 500) / 100.0
    body_fat = max(5.0, min(body_fat, 50.0))
    muscle = weight * (1 - body_fat / 100.0) * 0.75
    water = (100 - body_fat) * 0.7
    visceral_fat = max(1.0, min(bmi - 13.0, 20.0))
    bone_mass = weight * 0.04
    bmr = weight * 24.0 if is_male else weight * 22.0
    return {"bmi": round(bmi, 1), "body_fat": round(body_fat, 1), "muscle": round(muscle, 1),
            "water": round(water, 1), "visceral_fat": round(visceral_fat, 1),
            "bone_mass": round(bone_mass, 1), "bmr": round(bmr, 0)}

@app.post("/api/scale/record")
def record_weight(record: WeightRecord, session: Session = Depends(get_session)):
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
    if state.xiaomi_initialized:
        asyncio.create_task(_safe_create_push_task(record, user if record.impedance else None))
    return result

# --- Auth APIs ---
class UserLoginRequest(BaseModel):
    phone_number: str
    nickname: Optional[str] = None
    gender: str = "male"
    age: int = 25
    height: int = 175

class UserLoginResponse(BaseModel):
    user_id: str
    phone_number: str
    nickname: Optional[str] = None
    has_configured: bool

@app.post("/api/auth/login")
async def user_login(request: UserLoginRequest, session: Session = Depends(get_session)):
    """Mini-program phone login/register with auto service init"""
    try:
        if not request.phone_number or len(request.phone_number) != 11 or not request.phone_number.isdigit():
            raise HTTPException(status_code=400, detail="请输入正确的11位手机号")
        
        user = session.exec(select(User).where(User.phone_number == request.phone_number)).first()
        is_new_user = False
        if not user:
            user = User(phone_number=request.phone_number, nickname=request.nickname or f"用户{request.phone_number[-4:]}",
                        gender=request.gender, age=request.age, height=request.height)
            session.add(user)
            session.commit()
            session.refresh(user)
            logger.info(f"New user registered: {request.phone_number}, ID: {user.id}")
            is_new_user = True
        else:
            if request.nickname: user.nickname = request.nickname
            if request.gender != user.gender: user.gender = request.gender
            if request.age != user.age: user.age = request.age
            if request.height != user.height: user.height = request.height
            session.add(user)
            session.commit()
        
        from .utils.config_manager import get_user_devices
        user_devices = await get_user_devices(user.id)
        has_devices = len(user_devices) > 0
        
        if has_devices:
            logger.info(f"User {request.phone_number} has {len(user_devices)} devices, initializing services...")
            try:
                platforms = {}
                for device in user_devices:
                    platform = device['platform']
                    if platform not in platforms:
                        platforms[platform] = []
                    platforms[platform].append(device)
                for platform, devices in platforms.items():
                    if not devices: continue
                    first_device = devices[0]
                    credentials = first_device.get('credentials', {})
                    account = credentials.get('account')
                    password = credentials.get('password')
                    if not account or not password:
                        logger.warning(f"⚠ {platform} missing credentials")
                        continue
                    await _init_service_for_user(platform, user.id, account, password)
                logger.info("Auto-init completed")
            except Exception as e:
                logger.error(f"Auto-init failed: {e}")
                import traceback
                logger.error(traceback.format_exc())
        
        return UserLoginResponse(user_id=str(user.id), phone_number=user.phone_number,
                                 nickname=user.nickname, has_configured=has_devices)
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"登录失败: {str(e)}")

@app.get("/api/auth/check-config")
async def check_user_config(user_id: str):
    """Check if user has devices configured"""
    try:
        uid = int(user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的user_id")
    try:
        from .utils.config_manager import get_user_devices
        user_devices = await get_user_devices(uid)
        has_devices = len(user_devices) > 0
        return {"has_configured": has_devices, "device_count": len(user_devices),
                "message": f"已添加 {len(user_devices)} 个设备" if has_devices else "请先添加设备"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"检查配置失败: {str(e)}")

@app.post("/api/auth/reinit-services")
async def reinit_services():
    """Reinitialize services after user configures accounts"""
    try:
        from backend.app.utils.config_manager import get_config_from_db
        import importlib
        import backend.app.services.cloudpets_service as cp_module
        import backend.app.services.xiaomi_service as xm_module
        importlib.reload(cp_module)
        importlib.reload(xm_module)
        logger.info("Re-initializing CloudPets service...")
        cp_success = await cloudpets_service.initialize()
        logger.info("Re-initializing Xiaomi service...")
        xm_success = await xiaomi_service.initialize()
        if xm_success:
            state.xiaomi_initialized = True
        return {"status": "success", "cloudpets_initialized": cp_success,
                "xiaomi_initialized": xm_success, "message": "服务重新初始化完成"}
    except Exception as e:
        logger.error(f"Failed to reinitialize services: {e}")
        raise HTTPException(status_code=500, detail=f"重新初始化失败: {str(e)}")

# --- System Config APIs ---
class ConfigItem(BaseModel):
    key: str
    value: str
    is_encrypted: bool = False

class ConfigListResponse(BaseModel):
    configs: list[dict]
    has_required_configs: bool

@app.get("/api/config/list")
def get_config_list(session: Session = Depends(get_session)):
    """Get all config items (encrypted fields return empty string)"""
    try:
        configs = session.exec(select(SystemConfig)).all()
        config_list = []
        for config in configs:
            config_list.append({"key": config.key, "value": config.value if not config.is_encrypted else "",
                                "is_encrypted": config.is_encrypted, "updated_at": config.updated_at})
        return ConfigListResponse(configs=config_list, has_required_configs=len(configs) > 0)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取配置列表失败: {str(e)}")

@app.get("/api/config/{key}")
def get_config_value(key: str, session: Session = Depends(get_session)):
    """Get single config value (auto-decrypt)"""
    try:
        stmt = select(SystemConfig).where(SystemConfig.key == key).order_by(SystemConfig.id.desc())
        config = session.exec(stmt).first()
        if not config:
            raise HTTPException(status_code=404, detail=f"配置项 {key} 不存在")
        value = config.value
        if config.is_encrypted:
            value = ConfigEncryptor.decrypt(value)
        return {"key": key, "value": value, "is_encrypted": config.is_encrypted}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取配置失败: {str(e)}")

@app.post("/api/config")
def save_config(config_item: ConfigItem, session: Session = Depends(get_session)):
    """Save config item (auto-encrypt sensitive info)"""
    try:
        sensitive_keys = ["ACCOUNT", "PASSWORD", "XIAOMI_ACCOUNT", "XIAOMI_PASSWORD"]
        should_encrypt = config_item.key in sensitive_keys or config_item.is_encrypted
        value_to_store = ConfigEncryptor.encrypt(config_item.value) if should_encrypt and config_item.value else config_item.value
        stmt = select(SystemConfig).where(SystemConfig.key == config_item.key)
        existing_config = session.exec(stmt).first()
        if existing_config:
            existing_config.value = value_to_store
            existing_config.is_encrypted = should_encrypt
            existing_config.updated_at = int(time.time() * 1000)
        else:
            new_config = SystemConfig(key=config_item.key, value=value_to_store,
                                      is_encrypted=should_encrypt, updated_at=int(time.time() * 1000))
            session.add(new_config)
        session.commit()
        logger.info(f"Config saved: {config_item.key} (encrypted={should_encrypt})")
        return {"status": "success", "message": f"配置 {config_item.key} 已保存"}
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"保存配置失败: {str(e)}")

@app.delete("/api/config/{key}")
def delete_config(key: str, session: Session = Depends(get_session)):
    """Delete config item"""
    try:
        stmt = select(SystemConfig).where(SystemConfig.key == key)
        config = session.exec(stmt).first()
        if not config:
            raise HTTPException(status_code=404, detail=f"配置项 {key} 不存在")
        session.delete(config)
        session.commit()
        return {"status": "success", "message": f"配置 {key} 已删除"}
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"删除配置失败: {str(e)}")

async def push_to_xiaomi(record: WeightRecord, user: Optional[User] = None):
    """Async push weight data to Xiaomi Cloud"""
    try:
        user_data = {"weight": record.weight, "impedance": record.impedance or 0, "user_id": record.user_id or 0}
        if record.body_fat:
            user_data.update({"body_fat": record.body_fat, "bmi": record.bmi, "muscle": record.muscle,
                              "water": record.water, "visceral_fat": record.visceral_fat,
                              "bone_mass": record.bone_mass, "bmr": record.bmr})
        elif user:
            metrics = calculate_body_metrics(record.weight, record.impedance or 0, user)
            user_data.update(metrics)
        success = await xiaomi_service.push_weight_data(user_data)
        if success:
            logger.info(f"Successfully pushed weight data to Xiaomi for user {record.user_id}")
        else:
            logger.error(f"Failed to push weight data to Xiaomi for user {record.user_id}")
    except Exception as e:
        logger.error(f"Error pushing to Xiaomi: {e}")
        import traceback
        logger.error(traceback.format_exc())

async def _safe_create_push_task(record: WeightRecord, user: Optional[User] = None):
    """Safely create background task with error handling"""
    try:
        await push_to_xiaomi(record, user)
    except Exception as e:
        logger.error(f"Background push task failed: {e}")
# --- Device Management APIs ---
from .utils.config_manager import get_user_devices, add_device as add_device_to_db

class AddDeviceRequest(BaseModel):
    device_type: str
    device_name: Optional[str] = None
    platform: str
    account: str
    password: str

class DeviceResponse(BaseModel):
    device_key: str
    device_type: str
    device_name: Optional[str]
    platform: str
    status: str

@app.post("/api/devices/add", response_model=DeviceResponse)
async def add_device_api(request: AddDeviceRequest, user_id: str):
    """Add device to user account with auto-login and token caching"""
    try:
        uid = int(user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的user_id")
    try:
        device_key = await add_device_to_db(user_id=uid, platform=request.platform, account=request.account,
                                            password=request.password, device_name=request.device_name)
        await _init_service_for_user(request.platform, uid, request.account, request.password)
        return DeviceResponse(device_key=device_key, device_type=request.device_type,
                              device_name=request.device_name or f"{request.platform}_device",
                              platform=request.platform, status="active")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"添加设备失败：{str(e)}")

# --- System Config APIs ---
from .utils.config_manager import get_config_from_db, set_config_to_db

class SystemConfigRequest(BaseModel):
    platform: str
    account: str
    password: str

class SystemConfigResponse(BaseModel):
    cloudpets_account: Optional[str] = None
    cloudpets_password: Optional[str] = None
    petkit_account: Optional[str] = None
    petkit_password: Optional[str] = None
    xiaomi_account: Optional[str] = None
    xiaomi_password: Optional[str] = None

@app.get("/api/system/config", response_model=SystemConfigResponse)
async def get_system_config():
    """Get system configuration (passwords masked)"""
    try:
        # Get first user ID for each platform
        cp_user = await _get_first_user_with_platform("cloudpets")
        pk_user = await _get_first_user_with_platform("petkit")
        xm_user = await _get_first_user_with_platform("xiaomi")
        
        config = SystemConfigResponse()
        
        if cp_user:
            config.cloudpets_account = await get_config_from_db("account", user_id=cp_user, platform="cloudpets")
            has_pwd = await get_config_from_db("password", user_id=cp_user, platform="cloudpets")
            config.cloudpets_password = "********" if has_pwd else None
        
        if pk_user:
            config.petkit_account = await get_config_from_db("account", user_id=pk_user, platform="petkit")
            has_pwd = await get_config_from_db("password", user_id=pk_user, platform="petkit")
            config.petkit_password = "********" if has_pwd else None
        
        if xm_user:
            config.xiaomi_account = await get_config_from_db("account", user_id=xm_user, platform="xiaomi")
            has_pwd = await get_config_from_db("password", user_id=xm_user, platform="xiaomi")
            config.xiaomi_password = "********" if has_pwd else None
        
        return config
    except Exception as e:
        logger.error(f"Failed to get config: {e}")
        raise HTTPException(status_code=500, detail=f"获取配置失败：{str(e)}")

@app.post("/api/system/config")
async def save_system_config(request: SystemConfigRequest):
    """Save system configuration for a platform"""
    try:
        # Find or create user for this platform
        user_id = await _get_first_user_with_platform(request.platform)
        if not user_id:
            # Create a default user if none exists
            from .models.models import User
            from .models.db import engine
            from sqlmodel import Session
            loop = asyncio.get_running_loop()
            def _create_user():
                with Session(engine) as session:
                    user = User(phone_number="00000000000", nickname="系统用户")
                    session.add(user)
                    session.commit()
                    session.refresh(user)
                    return user.id
            user_id = await loop.run_in_executor(None, _create_user)
        
        # Save config
        await set_config_to_db("account", user_id, request.account, is_encrypted=True, platform=request.platform)
        await set_config_to_db("password", user_id, request.password, is_encrypted=True, platform=request.platform)
        
        # Re-initialize service
        await _init_service_for_user(request.platform, user_id, request.account, request.password)
        
        return {"message": "配置保存成功", "platform": request.platform}
    except Exception as e:
        logger.error(f"Failed to save config: {e}")
        raise HTTPException(status_code=500, detail=f"保存配置失败：{str(e)}")

