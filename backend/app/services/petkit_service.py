# backend/app/services/petkit_service.py

import os
import ssl
import aiohttp
from pypetkitapi.client import PetKitClient
import logging
import asyncio
import json
import time
import re
from sqlmodel import Session, select
from ..models.db import engine
from ..models.models import SystemConfig
from typing import Optional, Dict, Any, List

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 常量定义
SESSION_EXPIRY_MS = 30 * 60 * 1000  # 30分钟
SESSION_REFRESH_THRESHOLD_MIN = 25  # 25分钟
DEVICE_CACHE_TTL = 30  # 设备数据缓存30秒
SUPPORTED_DEVICE_TYPES = {'T3', 'T4', 'T5'}
TOKEN_KEY = "petkit_session_data"

# 预编译正则表达式
RAW_STATE_PATTERN = re.compile(r'(\w+)=([\w\d\.\-]+)')
WIFI_PATTERN = re.compile(r'wifi=Wifi\(bssid=\'(.*?)\', rsq=(-?\d+)')

class PetKitService:
    def __init__(self, username=None, password=None, region="CN", timezone="Asia/Shanghai", user_id=None):
        self.username = username
        self.password = password
        self.user_id = user_id
        self.region = region
        self.timezone = timezone
        self.session = None
        self.client = None
        self._devices_last_refresh = 0
        self._devices_refresh_lock = asyncio.Lock()
        self._ssl_context = None
        self._initialized = False

        # 延迟初始化，避免在 __init__ 中执行阻塞操作
        if not self.username or not self.password:
            logger.warning("PetKit credentials not provided, service will not be available")

    async def _get_credentials(self):
        """异步获取凭证，避免阻塞 __init__"""
        if not self.username or not self.password:
            from ..utils.config_manager import get_config_from_db
            self.username = await get_config_from_db("account", user_id=self.user_id, platform="petkit")
            self.password = await get_config_from_db("password", user_id=self.user_id, platform="petkit")

    async def _init_ssl_context(self):
        """初始化 SSL 上下文，处理证书验证问题"""
        try:
            from ..utils.config_manager import get_config_from_db
            disable_ssl_str = await get_config_from_db("PETKIT_DISABLE_SSL_VERIFY")
            disable_ssl = disable_ssl_str.lower() == "true" if disable_ssl_str else False

            if disable_ssl:
                logger.warning("SSL verification disabled for PetKit (development mode only)")
                self._ssl_context = False
            else:
                self._ssl_context = ssl.create_default_context()
                logger.info("SSL context created with default verification")
        except Exception as e:
            logger.error(f"Failed to create SSL context: {e}")
            self._ssl_context = False

    async def initialize(self):
        """Initialize service: load session from DB, or login if missing"""
        if self._initialized:
            return True
        
        logger.info("Initializing PetKit Service...")
        
        # 异步获取凭证
        await self._get_credentials()
        
        if not self.username or not self.password:
            logger.error("PetKit credentials not configured")
            return False
        
        # 初始化 SSL 上下文
        await self._init_ssl_context()
        
        if not await self._load_session_from_db():
            logger.info("No valid session found, attempting initial login...")
            success = await self._login()
            if success:
                logger.info("Initial login successful")
            else:
                logger.error("Initial login failed")
            return success
        else:
            logger.info("PetKit session loaded from DB")
            self._initialized = True
            return True

    async def _load_session_from_db(self) -> bool:
        """Try to load the latest session data from database"""
        try:
            loop = asyncio.get_event_loop()
            
            def _load():
                with Session(engine) as session_db:
                    statement = select(SystemConfig).where(
                        SystemConfig.key == TOKEN_KEY,
                        SystemConfig.user_id == (self.user_id or 0),
                        SystemConfig.is_active == True  # 只查询未删除的配置
                    ).order_by(SystemConfig.id.desc())
                    config = session_db.exec(statement).first()
                    if config:
                        return config.value
                return None
            
            config_value = await loop.run_in_executor(None, _load)
            
            if config_value:
                session_data = json.loads(config_value)
                saved_time = session_data.get('timestamp', 0)
                current_time = int(time.time() * 1000)
                
                if current_time - saved_time > SESSION_EXPIRY_MS:
                    logger.info("PetKit session expired, need re-login")
                    return False
                
                restored = await self._restore_session(session_data)
                if restored:
                    self._initialized = True
                return restored
        except Exception as e:
            logger.warning(f"Could not load session from DB: {e}")
        return False

    async def _save_session_to_db(self):
        """Save current session data to database"""
        try:
            if not self.client or not self.session:
                return

            session_data = {
                'timestamp': int(time.time() * 1000),
                'region': self.region,
                'timezone': self.timezone,
                'username': self.username,
                'has_valid_session': True
            }

            try:
                if hasattr(self.client, 'req') and hasattr(self.client.req, 'session'):
                    cookies = self.client.req.session.cookie_jar.filter_cookies()
                    if cookies:
                        session_data['cookies'] = str(cookies)

                    if hasattr(self.client.req, 'headers'):
                        auth_headers = {}
                        for key in ['authorization', 'token', 'x-auth-token', 'session-id']:
                            if key in self.client.req.headers:
                                auth_headers[key] = self.client.req.headers[key]
                        if auth_headers:
                            session_data['auth_headers'] = auth_headers
            except Exception as e:
                logger.debug(f"Could not extract session details: {e}")

            loop = asyncio.get_event_loop()
            
            def _save():
                with Session(engine) as session_db:
                    statement = select(SystemConfig).where(
                        SystemConfig.key == TOKEN_KEY,
                        SystemConfig.user_id == (self.user_id or 0),
                        SystemConfig.is_active == True  # 只查询未删除的配置
                    )
                    config = session_db.exec(statement).first()

                    if not config:
                        config = SystemConfig(
                            user_id=self.user_id or 0,
                            key=TOKEN_KEY,
                            value=json.dumps(session_data),
                            is_active=True
                        )
                        session_db.add(config)
                    else:
                        config.value = json.dumps(session_data)
                        config.updated_at = int(time.time() * 1000)
                        session_db.add(config)
                    session_db.commit()
            
            await loop.run_in_executor(None, _save)
            logger.info("Saved PetKit session to database")
        except Exception as e:
            logger.error(f"Failed to save session to DB: {e}")

    async def _restore_session(self, session_data: dict) -> bool:
        """Restore session from stored data"""
        try:
            saved_time = session_data.get('timestamp', 0)
            current_time = int(time.time() * 1000)
            age_minutes = (current_time - saved_time) / (60 * 1000)

            if age_minutes > SESSION_REFRESH_THRESHOLD_MIN:
                logger.info(f"Session too old ({age_minutes:.1f}min), will re-login")
                return False

            # 先关闭旧会话（如果有）
            await self._close_session()

            connector = aiohttp.TCPConnector(ssl=self._ssl_context) if self._ssl_context is not None else None
            self.session = aiohttp.ClientSession(connector=connector)

            self.client = PetKitClient(
                username=self.username,
                password=self.password,
                region=session_data.get('region', self.region),
                timezone=session_data.get('timezone', self.timezone),
                session=self.session,
            )

            # 验证会话是否有效
            try:
                await self.client.get_devices_data()
                logger.info(f"PetKit session restored successfully. Found {len(self.client.petkit_entities)} devices.")
                self._devices_last_refresh = time.time()
                return True
            except Exception as e:
                logger.warning(f"Restored session invalid, need re-login: {e}")
                await self._close_session()
                return False

        except Exception as e:
            logger.error(f"Failed to restore session: {e}")
            await self._close_session()
            return False

    async def _close_session(self):
        """安全关闭会话"""
        if self.session:
            try:
                await self.session.close()
            except Exception as e:
                logger.debug(f"Error closing session: {e}")
            finally:
                self.session = None
                self.client = None

    async def _login(self) -> bool:
        """
        Login to get new session
        """
        try:
            await self._close_session()

            connector = aiohttp.TCPConnector(ssl=self._ssl_context) if self._ssl_context is not None else None
            self.session = aiohttp.ClientSession(connector=connector)

            self.client = PetKitClient(
                username=self.username,
                password=self.password,
                region=self.region,
                timezone=self.timezone,
                session=self.session,
            )

            await self.client.get_devices_data()
            logger.info(f"PetKit login successful. Found {len(self.client.petkit_entities)} devices.")
            self._devices_last_refresh = time.time()

            await self._save_session_to_db()
            self._initialized = True
            return True

        except Exception as e:
            error_msg = str(e)
            logger.error(f"PetKit login failed: {e}")

            # 如果是 SSL 证书错误，尝试禁用 SSL 验证重试
            if "SSL" in error_msg or "certificate" in error_msg.lower() or "CERTIFICATE_VERIFY_FAILED" in error_msg:
                logger.warning("SSL certificate error detected, retrying with SSL verification disabled...")
                try:
                    await self._close_session()

                    connector = aiohttp.TCPConnector(ssl=False)
                    self.session = aiohttp.ClientSession(connector=connector)
                    self.client = PetKitClient(
                        username=self.username,
                        password=self.password,
                        region=self.region,
                        timezone=self.timezone,
                        session=self.session,
                    )

                    await self.client.get_devices_data()
                    logger.warning("PetKit login successful (SSL verification disabled - development only)")
                    self._devices_last_refresh = time.time()
                    await self._save_session_to_db()
                    self._initialized = True
                    return True
                except Exception as retry_error:
                    logger.error(f"Retry with SSL disabled failed: {retry_error}")

            return False

    async def start(self):
        """Initialize the session and login - deprecated, use initialize() instead"""
        await self.initialize()

    async def close(self):
        """Close the session"""
        await self._close_session()
        self._initialized = False

    async def get_client_methods(self):
        if not self.client:
            await self.initialize()

        try:
            import pypetkitapi.command as cmd
            constants = {k: v for k, v in vars(cmd).items() if not k.startswith('_')}
        except ImportError:
            constants = {"error": "Could not import pypetkitapi.command"}

        return {"methods": [m for m in dir(self.client) if not m.startswith('_')], "constants": constants}

    async def _refresh_devices(self):
        """刷新设备数据"""
        try:
            await self.client.get_devices_data()
            self._devices_last_refresh = time.time()
            await self._save_session_to_db()
        except Exception as e:
            error_msg = str(e)
            is_ssl_error = "SSL" in error_msg or "certificate" in error_msg.lower() or "CERTIFICATE_VERIFY_FAILED" in error_msg

            if "Session expired" in error_msg or "401" in error_msg or is_ssl_error:
                logger.warning("Session expired, attempting re-login...")
                if await self._login():
                    await self.client.get_devices_data()
                    self._devices_last_refresh = time.time()
                else:
                    raise Exception("Re-login failed")
            else:
                raise e

    async def get_devices(self):
        """Get all devices"""
        if not self.client:
            await self.initialize()

        await self._refresh_devices_if_needed()

        devices = []
        for dev_id, entity in self.client.petkit_entities.items():
            if hasattr(entity, 'pet_id'):
                continue

            dev_type = self._get_device_type(entity)
            if dev_type not in SUPPORTED_DEVICE_TYPES:
                continue

            logger.info(f"Processing device: {getattr(entity, 'name', 'Unknown')} (Type: {dev_type}, ID: {entity.id})")
            
            dev_data = {
                "id": str(entity.id),
                "name": getattr(entity, 'name', 'Unknown'),
                "type": dev_type,
                "data": {}
            }

            if hasattr(entity, 'data') and entity.data:
                try:
                    raw_data = entity.data
                    if isinstance(raw_data, dict):
                        dev_data["data"] = {k: v for k, v in raw_data.items() if isinstance(v, (str, int, float, bool, type(None)))}
                    else:
                        dev_data["data"] = str(raw_data)
                except Exception:
                    dev_data["data"] = {}

            state_summary = {}
            if hasattr(entity, 'state'):
                state_obj = entity.state
                known_state_attrs = ['box_full', 'liquid_lack', 'box_state', 'work_state', 'error_state']
                for sattr in known_state_attrs:
                    if hasattr(state_obj, sattr):
                        state_summary[sattr] = getattr(state_obj, sattr)

                raw_state_str = str(state_obj)
                state_summary['raw_state'] = raw_state_str
                self._extract_info_from_raw_state(raw_state_str, state_summary)

            interesting_attrs = [
                'liquid', 'weight', 'times', 'battery', 'connection',
                'sand_percent', 'deodorant_left_days', 'used_times'
            ]
            for attr in interesting_attrs:
                val = None
                if hasattr(entity, attr):
                    val = getattr(entity, attr)
                elif hasattr(entity, 'data') and isinstance(entity.data, dict) and attr in entity.data:
                    val = entity.data[attr]

                if val is not None and isinstance(val, (str, int, float, bool)):
                    state_summary[attr] = val
                elif val is not None:
                    state_summary[attr] = str(val)

            if hasattr(entity, 'device_stats'):
                device_stats = entity.device_stats
                # 优先使用今日统计数据，如果没有则使用累计数据并标记警告
                today_times = getattr(device_stats, 'times', 0)
                state_summary['today_visits'] = today_times
                state_summary['avg_duration'] = getattr(device_stats, 'avg_time', 0)
                state_summary['total_duration'] = getattr(device_stats, 'total_time', 0)
                
                # 检查是否有更详细的统计信息来验证今日数据
                if hasattr(device_stats, 'statistic_info') and device_stats.statistic_info:
                    stat_info = device_stats.statistic_info
                    if stat_info and len(stat_info) > 0:
                        latest_record = stat_info[-1]
                        latest_weight = getattr(latest_record, 'pet_weight', 0)
                        if latest_weight > 0:
                            state_summary['last_pet_weight'] = latest_weight / 1000.0

            dev_data["state_summary"] = state_summary
            devices.append(dev_data)
        return devices

    async def clean_litterbox(self, device_id=None):
        """Trigger clean action for the first found or specified litterbox"""
        if not self.client:
            await self.initialize()

        target_id = None
        if not device_id:
            for dev_id, entity in self.client.petkit_entities.items():
                if self._is_supported_device(entity):
                    target_id = dev_id
                    break
        else:
            target_id = int(device_id) if str(device_id).isdigit() else device_id

        if not target_id:
            raise Exception("No litterbox found or invalid device ID")

        logger.info(f"Sending clean command to {target_id}")
        try:
            from pypetkitapi.command import DeviceCommand, DeviceAction, LBCommand
            await self.client.send_api_request(
                target_id,
                DeviceCommand.CONTROL_DEVICE,
                {DeviceAction.START: LBCommand.CLEANING}
            )
            await self._save_session_to_db()
            return {"status": "success", "device_id": str(target_id), "action": "clean"}
        except Exception as e:
            if "Session expired" in str(e) or "401" in str(e):
                logger.warning("Session expired during clean, re-logging in...")
                if await self._login():
                    await self.client.send_api_request(
                        target_id,
                        DeviceCommand.CONTROL_DEVICE,
                        {DeviceAction.START: LBCommand.CLEANING}
                    )
                    await self._save_session_to_db()
                    return {"status": "success", "device_id": str(target_id), "action": "clean"}
                else:
                    raise Exception("Re-login failed")
            raise e

    async def deodorize_litterbox(self, device_id=None):
        """Trigger deodorize (spray) for the first found or specified litterbox"""
        if not self.client:
            await self.initialize()

        target_id = None
        if not device_id:
            for dev_id, entity in self.client.petkit_entities.items():
                if self._is_supported_device(entity):
                    target_id = dev_id
                    break
        else:
            target_id = int(device_id) if str(device_id).isdigit() else device_id

        if not target_id:
            raise Exception("No litterbox found or invalid device ID")

        logger.info(f"Sending deodorize command to {target_id}")
        try:
            from pypetkitapi.command import LitterCommand, DeviceAction, LBCommand
            await self.client.send_api_request(
                target_id,
                LitterCommand.CONTROL_DEVICE,
                {DeviceAction.START: LBCommand.DESODORIZE}
            )
            await self._save_session_to_db()
            return {"status": "success", "device_id": str(target_id), "action": "deodorize"}
        except Exception as e:
            if "Session expired" in str(e) or "401" in str(e):
                logger.warning("Session expired during deodorize, re-logging in...")
                if await self._login():
                    await self.client.send_api_request(
                        target_id,
                        LitterCommand.CONTROL_DEVICE,
                        {DeviceAction.START: LBCommand.DESODORIZE}
                    )
                    await self._save_session_to_db()
                    return {"status": "success", "device_id": str(target_id), "action": "deodorize"}
                else:
                    raise Exception("Re-login failed")
            raise e

    def _get_device_type(self, entity) -> str:
        """获取设备类型"""
        target_type = 'Unknown'
        if hasattr(entity, 'device_nfo') and hasattr(entity.device_nfo, 'device_type'):
            target_type = entity.device_nfo.device_type.upper()
        else:
            target_type = getattr(entity, 'device_type', '').upper()

        if target_type == 'UNKNOWN' and hasattr(entity, 'name'):
            name = entity.name
            if 'MAX' in name or '猫厕所' in name:
                target_type = 'T4'

        return target_type
    
    def _is_supported_device(self, entity) -> bool:
        """检查是否为支持的設備类型"""
        dev_type = self._get_device_type(entity)
        return dev_type in SUPPORTED_DEVICE_TYPES
    
    async def _refresh_devices_if_needed(self):
        """根据缓存时间刷新设备数据"""
        current_time = time.time()
        if current_time - self._devices_last_refresh > DEVICE_CACHE_TTL:
            async with self._devices_refresh_lock:
                # 双重检查
                if time.time() - self._devices_last_refresh > DEVICE_CACHE_TTL:
                    await self._refresh_devices()

    def _extract_info_from_raw_state(self, raw_state: str, state_summary: dict):
        """从原始状态字符串中提取关键信息"""
        key_fields = [
            'deodorant_left_days', 'sand_percent', 'sand_weight',
            'used_times', 'frequent_restroom', 'liquid_lack',
            'box_full', 'sand_lack', 'power', 'ota'
        ]
    
        for match in RAW_STATE_PATTERN.finditer(raw_state):
            field = match.group(1)
            value = match.group(2)
                
            if field in key_fields:
                try:
                    if value.lower() in ['true', 'false']:
                        state_summary[field] = value.lower() == 'true'
                    elif '.' in value:
                        state_summary[field] = float(value)
                    elif value.isdigit() or (value.startswith('-') and value[1:].isdigit()):
                        state_summary[field] = int(value)
                    else:
                        state_summary[field] = value
                except Exception:
                    state_summary[field] = value
    
        wifi_match = WIFI_PATTERN.search(raw_state)
        if wifi_match:
            state_summary['wifi_bssid'] = wifi_match.group(1)
            state_summary['wifi_rsq'] = int(wifi_match.group(2))

    async def get_device_stats(self, device_id=None, days=7):
        """获取设备历史统计数据"""
        if not self.client:
            await self.initialize()

        await self._refresh_devices_if_needed()

        target_entity = None
        if device_id:
            target_entity = self.client.petkit_entities.get(int(device_id) if str(device_id).isdigit() else device_id)
        else:
            for entity in self.client.petkit_entities.values():
                if self._is_supported_device(entity):
                    target_entity = entity
                    break

        if not target_entity:
            return {"error": "Device not found"}

        try:
            stats_data = {}
            if hasattr(target_entity, 'stats') and target_entity.stats:
                stats = target_entity.stats
                stats_data.update({
                    'today_visits': getattr(stats, 'times', 0),
                    'avg_duration': getattr(stats, 'avg_time', 0),
                    'total_duration': getattr(stats, 'total_time', 0),
                    'statistic_time': getattr(stats, 'statistic_time', None),
                    'pet_ids': getattr(stats, 'pet_ids', [])
                })

            stats_data.update({
                'device_name': getattr(target_entity, 'name', 'Unknown'),
                'sand_percent': getattr(target_entity, 'sand_percent', 0),
                'deodorant_days': getattr(target_entity, 'deodorant_left_days', 0),
                'used_times': getattr(target_entity, 'used_times', 0),
                'last_pet_weight': getattr(target_entity, 'last_pet_weight', 0)
            })

            return stats_data
        except Exception as e:
            logger.warning(f"Failed to get stats: {e}")
            return {"error": f"Failed to get statistics: {str(e)}"}

    async def get_daily_stats(self, device_id=None):
        """获取今日数据"""
        if not self.client:
            await self.initialize()

        await self._refresh_devices_if_needed()

        target_entity = None
        if device_id:
            target_entity = self.client.petkit_entities.get(int(device_id) if str(device_id).isdigit() else device_id)
        else:
            for entity in self.client.petkit_entities.values():
                if self._is_supported_device(entity):
                    target_entity = entity
                    break

        if not target_entity:
            return {"today_visits": 0, "last_visit": "N/A", "error": "Device not found"}

        try:
            # 从多个数据源获取猫砂和除臭剂信息
            sand_percent = getattr(target_entity, 'sand_percent', None)
            deodorant_days = getattr(target_entity, 'deodorant_left_days', None)
            
            logger.info(f"Device {target_entity.name} - Initial sand_percent: {sand_percent}, deodorant_days: {deodorant_days}")
            
            # 如果实体属性中没有，尝试从 data 字典中获取
            if (sand_percent == 0 or sand_percent is None) and hasattr(target_entity, 'data') and isinstance(target_entity.data, dict):
                sand_percent = target_entity.data.get('sand_percent', 0)
            
            if (deodorant_days == 0 or deodorant_days is None) and hasattr(target_entity, 'data') and isinstance(target_entity.data, dict):
                deodorant_days = target_entity.data.get('deodorant_left_days', 0)
            
            # 如果还是没有，从 state 的 raw_state 字符串中提取
            if (sand_percent == 0 or sand_percent is None) and hasattr(target_entity, 'state'):
                state_obj = target_entity.state
                raw_state_str = str(state_obj)
                extracted = {}
                self._extract_info_from_raw_state(raw_state_str, extracted)
                if 'sand_percent' in extracted:
                    sand_percent = extracted['sand_percent']
                    logger.info(f"Device {target_entity.name} - Extracted sand_percent from raw_state: {sand_percent}")
                if 'deodorant_left_days' in extracted:
                    deodorant_days = extracted['deodorant_left_days']
                    logger.info(f"Device {target_entity.name} - Extracted deodorant_left_days from raw_state: {deodorant_days}")
            
            # 确保最终值不为 None
            sand_percent = sand_percent if sand_percent is not None else 0
            deodorant_days = deodorant_days if deodorant_days is not None else 0
            
            logger.info(f"Device {target_entity.name} - Final sand_percent: {sand_percent}, deodorant_days: {deodorant_days}")
            
            result = {
                "device_name": getattr(target_entity, 'name', 'Unknown'),
                "sand_percent": sand_percent,
                "deodorant_days": deodorant_days
            }

            if hasattr(target_entity, 'device_stats'):
                device_stats = target_entity.device_stats
                # 获取今日统计数据
                today_times = getattr(device_stats, 'times', 0)
                logger.info(f"Device {target_entity.name} - today_visits: {today_times}")
                result.update({
                    "today_visits": today_times,
                    "avg_duration": getattr(device_stats, 'avg_time', 0),
                    "total_duration": getattr(device_stats, 'total_time', 0),
                    "statistic_time": getattr(device_stats, 'statistic_time', None)
                })

                if hasattr(device_stats, 'statistic_info'):
                    stat_info = device_stats.statistic_info
                    if stat_info and len(stat_info) > 0:
                        latest_record = stat_info[-1]
                        result["last_visit"] = str(getattr(latest_record, 'statistic_date', 'N/A'))
                        latest_weight = getattr(latest_record, 'pet_weight', 0)
                        if latest_weight > 0:
                            result["last_pet_weight"] = latest_weight / 1000.0
                    else:
                        result["last_visit"] = "N/A"
                else:
                    result["last_visit"] = "N/A"

            elif hasattr(target_entity, 'stats') and target_entity.stats:
                stats = target_entity.stats
                result.update({
                    "today_visits": getattr(stats, 'times', 0),
                    "avg_duration": getattr(stats, 'avg_time', 0),
                    "total_duration": getattr(stats, 'total_time', 0),
                    "statistic_time": getattr(stats, 'statistic_time', None)
                })

                if hasattr(stats, 'statistic_info') and stats.statistic_info:
                    result["last_visit"] = "From statistics"
                else:
                    result["last_visit"] = "N/A"
            else:
                result.update({
                    "today_visits": getattr(target_entity, 'used_times', 0),
                    "last_visit": "N/A",
                    "warning": "Using cumulative data, may not be today's actual count"
                })
                logger.warning(f"Device {target_entity.name} lacks detailed stats, using cumulative data")

            return result
        except Exception as e:
            logger.error(f"Error processing stats: {e}")
            return {
                "today_visits": 0,
                "last_visit": "N/A",
                "error": f"Failed to process statistics: {str(e)}"
            }
