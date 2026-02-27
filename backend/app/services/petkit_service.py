# backend/app/services/petkit_service.py

import aiohttp
from pypetkitapi.client import PetKitClient
from pypetkitapi.command import LitterCommand, DeviceAction, LBCommand, DeviceCommand
from pypetkitapi.exceptions import PetkitSessionExpiredError
import logging
import asyncio
import json
import time
from sqlmodel import Session
from app.models.db import engine
from app.models.models import SystemConfig

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class PetKitService:
    def __init__(self, username, password, region="CN", timezone="Asia/Shanghai"):
        self.username = username
        self.password = password
        self.region = region
        self.timezone = timezone
        self.session = None
        self.client = None
        self.token_key = "petkit_session_data"  # 数据库存储键名

    async def initialize(self):
        """Initialize service: load session from DB, or login if missing"""
        logger.info("Initializing PetKit Service...")
        if not await self._load_session_from_db():
            logger.info("No session found in DB, attempting initial login...")
            if await self._login():
                logger.info("Initial login successful")
            else:
                logger.error("Initial login failed")
        else:
            logger.info("PetKit session loaded from DB")

    async def _load_session_from_db(self) -> bool:
        """Try to load the latest session data from database"""
        try:
            with Session(engine) as session_db:
                config = session_db.get(SystemConfig, self.token_key)
                if config:
                    # 解析存储的会话数据
                    session_data = json.loads(config.value)

                    # 检查是否过期（30分钟有效期）
                    saved_time = session_data.get('timestamp', 0)
                    current_time = int(time.time() * 1000)
                    if current_time - saved_time > 30 * 60 * 1000:  # 30分钟
                        logger.info("PetKit session expired (30min), need re-login")
                        return False

                    # 恢复会话
                    await self._restore_session(session_data)
                    logger.info("Loaded PetKit session from database")
                    return True
        except Exception as e:
            logger.warning(f"Could not load session from DB (might be first run): {e}")
        return False

    async def _save_session_to_db(self):
        """Save current session data to database"""
        try:
            if not self.client or not self.session:
                return

            # 获取会话相关信息
            session_data = {
                'timestamp': int(time.time() * 1000),
                'region': self.region,
                'timezone': self.timezone
            }

            # 尝试获取客户端的认证信息
            try:
                if hasattr(self.client, 'req') and hasattr(self.client.req, 'session'):
                    # 存储cookies或其他认证信息
                    cookies = self.client.req.session.cookie_jar.filter_cookies()
                    if cookies:
                        session_data['cookies'] = str(cookies)
            except Exception as e:
                logger.debug(f"Could not extract session cookies: {e}")

            with Session(engine) as session_db:
                config = session_db.get(SystemConfig, self.token_key)
                if not config:
                    config = SystemConfig(key=self.token_key, value=json.dumps(session_data))
                    session_db.add(config)
                else:
                    config.value = json.dumps(session_data)
                    config.updated_at = int(time.time() * 1000)
                    session_db.add(config)
                session_db.commit()
                logger.info("Saved PetKit session to database")
        except Exception as e:
            logger.error(f"Failed to save session to DB: {e}")

    async def _restore_session(self, session_data: dict):
        """Restore session from stored data"""
        try:
            # 创建新的会话
            self.session = aiohttp.ClientSession()
            self.client = PetKitClient(
                username=self.username,
                password=self.password,
                region=session_data.get('region', self.region),
                timezone=session_data.get('timezone', self.timezone),
                session=self.session,
            )

            # 尝试恢复认证状态
            # 注意：由于pypetkitapi的实现细节，这里可能需要重新登录
            # 但我们至少建立了会话连接
            logger.info("Session restored from database")
            return True
        except Exception as e:
            logger.error(f"Failed to restore session: {e}")
            return False

    async def _login(self) -> bool:
        """
        Login to get new session
        """
        try:
            # 清理旧会话
            if self.session:
                await self.session.close()

            # 创建新会话
            self.session = aiohttp.ClientSession()
            self.client = PetKitClient(
                username=self.username,
                password=self.password,
                region=self.region,
                timezone=self.timezone,
                session=self.session,
            )

            # 登录并获取设备列表
            await self.client.get_devices_data()
            logger.info(f"PetKit 登录成功。共发现 {len(self.client.petkit_entities)} 个设备/实体。")

            # 保存会话到数据库
            await self._save_session_to_db()
            return True

        except Exception as e:
            logger.error(f"PetKit 登录失败: {e}")
            return False

    async def start(self):
        """Initialize the session and login - deprecated, use initialize() instead"""
        await self.initialize()

    async def close(self):
        """Close the session"""
        if self.session:
            await self.session.close()
            self.session = None

    async def get_client_methods(self):
        if not self.client:
            await self.initialize()

        try:
            import pypetkitapi.command as cmd
            constants = {k: v for k, v in vars(cmd).items() if not k.startswith('_')}
        except ImportError:
            constants = {"error": "Could not import pypetkitapi.command"}

        return {"methods": [m for m in dir(self.client) if not m.startswith('_')], "constants": constants}

    async def get_devices(self):
        """Get all devices"""
        if not self.client:
            await self.initialize()

        try:
            # 刷新数据
            logger.info("正在刷新设备数据...")
            await self.client.get_devices_data()
            # 更新会话时间戳
            await self._save_session_to_db()
        except Exception as e:
            if "Session expired" in str(e) or "401" in str(e):
                logger.warning("Session expired, attempting re-login...")
                if await self._login():
                    await self.client.get_devices_data()
                else:
                    raise Exception("Re-login failed")
            else:
                raise e

        devices = []
        for dev_id, entity in self.client.petkit_entities.items():
            # 更准确的设备识别逻辑
            # 1. 排除宠物档案 (有 pet_id)
            if hasattr(entity, 'pet_id'):
                continue
            
            # 2. 通过 device_nfo 获取准确的设备类型
            dev_type = 'Unknown'
            if hasattr(entity, 'device_nfo') and hasattr(entity.device_nfo, 'device_type'):
                dev_type = entity.device_nfo.device_type
            else:
                # 回退到原来的 device_type
                dev_type = getattr(entity, 'device_type', 'Unknown')
            
            # 3. 标准化设备类型名称
            if dev_type.lower() == 't4':
                dev_type = 'T4'
            elif dev_type.lower() == 't3':
                dev_type = 'T3'
            elif dev_type.lower() == 't5':
                dev_type = 'T5'
            
            # 4. 只处理已知的设备类型
            if dev_type not in ['T3', 'T4', 'T5']:
                logger.info(f"跳过未知设备类型: {dev_type}")
                continue

            logger.info(f"处理实体: {getattr(entity, 'name', 'Unknown')} (类型: {dev_type}, ID: {entity.id})")
            dev_data = {
                "id": str(entity.id),
                "name": getattr(entity, 'name', 'Unknown'),
                "type": dev_type,
                "data": {}
            }

            # 尝试提取更多状态数据
            if hasattr(entity, 'data') and entity.data:
                # 确保 data 是字典，且值是基本类型
                try:
                    raw_data = entity.data
                    if isinstance(raw_data, dict):
                        # 简单过滤，防止包含复杂对象
                        dev_data["data"] = {k: v for k, v in raw_data.items() if isinstance(v, (str, int, float, bool, type(None)))}
                    else:
                        dev_data["data"] = str(raw_data)
                except:
                    dev_data["data"] = {}

            # 尝试提取具体属性作为扁平化状态，方便前端展示
            state_summary = {}
            if hasattr(entity, 'state'):
                state_obj = entity.state
                # 尝试解析 State 对象中的关键属性
                known_state_attrs = ['box_full', 'liquid_lack', 'box_state', 'work_state', 'error_state']
                for sattr in known_state_attrs:
                    if hasattr(state_obj, sattr):
                        state_summary[sattr] = getattr(state_obj, sattr)

                # 保留原始 string dump 作为 fallback
                raw_state_str = str(state_obj)
                state_summary['raw_state'] = raw_state_str

                # 从 raw_state 字符串中提取关键信息
                self._extract_info_from_raw_state(raw_state_str, state_summary)

            # 基于实际抓取到的属性
            interesting_attrs = [
                'liquid', 'weight', 'times', 'battery', 'connection',
                'sand_percent', 'deodorant_left_days', 'used_times'
            ]
            for attr in interesting_attrs:
                val = None
                # 优先从 entity 属性获取
                if hasattr(entity, attr):
                    val = getattr(entity, attr)
                # 其次从 data 字典获取
                elif hasattr(entity, 'data') and isinstance(entity.data, dict) and attr in entity.data:
                        val = entity.data[attr]

                # 确保值是基本类型
                if val is not None and isinstance(val, (str, int, float, bool)):
                    state_summary[attr] = val
                elif val is not None:
                    state_summary[attr] = str(val)
            
            # 添加准确的统计信息（从 device_stats 获取）
            if hasattr(entity, 'device_stats'):
                device_stats = entity.device_stats
                # 今日如厕次数
                state_summary['today_visits'] = getattr(device_stats, 'times', 0)
                # 平均时长
                state_summary['avg_duration'] = getattr(device_stats, 'avg_time', 0)
                # 总时长
                state_summary['total_duration'] = getattr(device_stats, 'total_time', 0)
                
                # 获取最新的猫咪体重
                if hasattr(device_stats, 'statistic_info') and device_stats.statistic_info:
                    stat_info = device_stats.statistic_info
                    if stat_info and len(stat_info) > 0:
                        latest_record = stat_info[-1]
                        latest_weight = getattr(latest_record, 'pet_weight', 0)
                        if latest_weight > 0:
                            state_summary['last_pet_weight'] = latest_weight / 1000.0  # 转换为kg

            dev_data["state_summary"] = state_summary
            devices.append(dev_data)
        return devices

    async def clean_litterbox(self, device_id=None):
        """Trigger clean action for the first found or specified litterbox"""
        if not self.client:
            await self.initialize()

        target_id = None
        # 如果未指定 ID，找第一个猫厕所 (T3/T4)
        if not device_id:
            for dev_id, entity in self.client.petkit_entities.items():
                # 使用改进的设备类型识别
                target_type = 'Unknown'
                if hasattr(entity, 'device_nfo') and hasattr(entity.device_nfo, 'device_type'):
                    target_type = entity.device_nfo.device_type.upper()
                else:
                    target_type = getattr(entity, 'device_type', '').upper()
                
                # 兼容之前的逻辑
                if target_type == 'UNKNOWN' and hasattr(entity, 'name') and ('MAX' in entity.name or '猫厕所' in entity.name):
                    target_type = 'T4'

                if target_type in ['T3', 'T4', 'T5']:
                    target_id = dev_id
                    break
        else:
            target_id = int(device_id) if str(device_id).isdigit() else device_id

        if target_id:
            logger.info(f"Sending clean command to {target_id}")
            try:
                from pypetkitapi.command import DeviceCommand, DeviceAction, LBCommand
                await self.client.send_api_request(
                    target_id,
                    DeviceCommand.CONTROL_DEVICE,
                    {DeviceAction.START: LBCommand.CLEANING}
                )
                # 更新会话时间戳
                await self._save_session_to_db()
                return {"status": "success", "device_id": str(target_id), "action": "clean"}
            except Exception as e:
                if "Session expired" in str(e) or "401" in str(e):
                    logger.warning("Session expired during clean, re-logging in...")
                    if await self._login():
                        # Retry once
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

        raise Exception("No litterbox found or invalid device ID")

    async def deodorize_litterbox(self, device_id=None):
        """Trigger deodorize (spray) for the first found or specified litterbox"""
        if not self.client:
            await self.initialize()

        target_id = None

        # 如果未指定 ID，找第一个猫厕所 (T3/T4)
        if not device_id:
            for dev_id, entity in self.client.petkit_entities.items():
                # 使用改进的设备类型识别
                target_type = 'Unknown'
                if hasattr(entity, 'device_nfo') and hasattr(entity.device_nfo, 'device_type'):
                    target_type = entity.device_nfo.device_type.upper()
                else:
                    target_type = getattr(entity, 'device_type', '').upper()
                
                # 兼容之前的逻辑
                if target_type == 'UNKNOWN' and hasattr(entity, 'name') and ('MAX' in entity.name or '猫厕所' in entity.name):
                    target_type = 'T4'

                if target_type in ['T3', 'T4', 'T5']:
                    target_id = dev_id
                    break
        else:
            target_id = int(device_id) if str(device_id).isdigit() else device_id

        if target_id:
            logger.info(f"Sending deodorize command to {target_id}")
            try:
                from pypetkitapi.command import LitterCommand, DeviceAction, LBCommand
                # 发送除臭指令 (DESODORIZE / SPRAY)
                await self.client.send_api_request(
                    target_id,
                    LitterCommand.CONTROL_DEVICE,
                    {DeviceAction.START: LBCommand.DESODORIZE}
                )
                # 更新会话时间戳
                await self._save_session_to_db()
                return {"status": "success", "device_id": str(target_id), "action": "deodorize"}
            except Exception as e:
                if "Session expired" in str(e) or "401" in str(e):
                    logger.warning("Session expired during deodorize, re-logging in...")
                    if await self._login():
                        # Retry once
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

        raise Exception("No litterbox found or invalid device ID")

    def _extract_info_from_raw_state(self, raw_state: str, state_summary: dict):
        """从原始状态字符串中提取关键信息"""
        # 定义要提取的关键字段
        key_fields = [
            'deodorant_left_days', 'sand_percent', 'sand_weight',
            'used_times', 'frequent_restroom', 'liquid_lack',
            'box_full', 'sand_lack', 'power', 'ota'
        ]

        # 使用正则表达式提取字段值
        import re
        for field in key_fields:
            # 匹配 pattern: field=value 或 field=value,
            pattern = rf'{field}=([\w\d\.-]+)'
            match = re.search(pattern, raw_state)
            if match:
                value = match.group(1)
                # 尝试转换为适当的类型
                try:
                    if value.lower() in ['true', 'false']:
                        state_summary[field] = value.lower() == 'true'
                    elif '.' in value:
                        state_summary[field] = float(value)
                    elif value.isdigit() or (value.startswith('-') and value[1:].isdigit()):
                        state_summary[field] = int(value)
                    else:
                        state_summary[field] = value
                except:
                    state_summary[field] = value

        # 特殊处理wifi信息
        wifi_match = re.search(r'wifi=Wifi\(bssid=\'(.*?)\', rsq=(-?\d+)', raw_state)
        if wifi_match:
            state_summary['wifi_bssid'] = wifi_match.group(1)
            state_summary['wifi_rsq'] = int(wifi_match.group(2))

    async def get_device_stats(self, device_id=None, days=7):
        """获取设备历史统计数据（使用 pypetkitapi 原生方法）"""
        if not self.client:
            await self.initialize()

        # 刷新设备数据，这会自动调用统计任务
        await self.client.get_devices_data()
        
        target_entity = None
        
        if device_id:
            target_entity = self.client.petkit_entities.get(int(device_id))
        else:
            # 找第一个猫厕所
            for entity in self.client.petkit_entities.values():
                # 使用改进的设备类型识别
                dev_type = 'Unknown'
                if hasattr(entity, 'device_nfo') and hasattr(entity.device_nfo, 'device_type'):
                    dev_type = entity.device_nfo.device_type.upper()
                else:
                    dev_type = getattr(entity, 'device_type', '').upper()
                
                if dev_type in ['T3', 'T4', 'T5']:
                    target_entity = entity
                    break

        if not target_entity:
            return {"error": "未找到设备"}

        try:
            # 使用原生的统计属性
            stats_data = {}
            
            # 从 LitterStats 获取统计信息
            if hasattr(target_entity, 'stats') and target_entity.stats:
                stats = target_entity.stats
                stats_data.update({
                    'today_visits': getattr(stats, 'times', 0),
                    'avg_duration': getattr(stats, 'avg_time', 0),
                    'total_duration': getattr(stats, 'total_time', 0),
                    'statistic_time': getattr(stats, 'statistic_time', None),
                    'pet_ids': getattr(stats, 'pet_ids', [])
                })
            
            # 从设备基本属性获取其他信息
            stats_data.update({
                'device_name': getattr(target_entity, 'name', 'Unknown'),
                'sand_percent': getattr(target_entity, 'sand_percent', 0),
                'deodorant_days': getattr(target_entity, 'deodorant_left_days', 0),
                'used_times': getattr(target_entity, 'used_times', 0),
                'last_pet_weight': getattr(target_entity, 'last_pet_weight', 0)
            })
            
            return stats_data
            
        except Exception as e:
            logger.warning(f"获取统计信息失败: {e}")
            return {"error": f"无法获取统计数据: {str(e)}"}

    async def get_daily_stats(self, device_id=None):
        """获取今日数据（使用 pypetkitapi 原生统计方法）"""
        if not self.client:
            await self.initialize()

        # 刷新设备数据，确保统计信息是最新的
        await self.client.get_devices_data()
        
        target_entity = None
        
        if device_id:
            target_entity = self.client.petkit_entities.get(int(device_id))
        else:
            # 找第一个猫厕所
            for entity in self.client.petkit_entities.values():
                # 使用改进的设备类型识别
                dev_type = 'Unknown'
                if hasattr(entity, 'device_nfo') and hasattr(entity.device_nfo, 'device_type'):
                    dev_type = entity.device_nfo.device_type.upper()
                else:
                    dev_type = getattr(entity, 'device_type', '').upper()
                
                if dev_type in ['T3', 'T4', 'T5']:
                    target_entity = entity
                    break

        if target_entity:
            try:
                # 使用 pypetkitapi 原生的统计信息
                result = {
                    "device_name": getattr(target_entity, 'name', 'Unknown'),
                    "sand_percent": getattr(target_entity, 'sand_percent', 0),
                    "deodorant_days": getattr(target_entity, 'deodorant_left_days', 0)
                }
                
                # 优先从 device_stats 获取今日统计（更准确）
                if hasattr(target_entity, 'device_stats'):
                    device_stats = target_entity.device_stats
                    result.update({
                        "today_visits": getattr(device_stats, 'times', 0),
                        "avg_duration": getattr(device_stats, 'avg_time', 0),
                        "total_duration": getattr(device_stats, 'total_time', 0),
                        "statistic_time": getattr(device_stats, 'statistic_time', None)
                    })
                    
                    # 获取详细的宠物统计信息
                    if hasattr(device_stats, 'statistic_info'):
                        stat_info = device_stats.statistic_info
                        if stat_info and len(stat_info) > 0:
                            # 获取最新的记录
                            latest_record = stat_info[-1]
                            result["last_visit"] = str(getattr(latest_record, 'statistic_date', 'N/A'))
                            # 获取最新的猫咪体重
                            latest_weight = getattr(latest_record, 'pet_weight', 0)
                            if latest_weight > 0:
                                result["last_pet_weight"] = latest_weight / 1000.0  # 转换为kg
                        else:
                            result["last_visit"] = "N/A"
                    else:
                        result["last_visit"] = "N/A"
                
                # 回退到 LitterStats
                elif hasattr(target_entity, 'stats') and target_entity.stats:
                    stats = target_entity.stats
                    result.update({
                        "today_visits": getattr(stats, 'times', 0),
                        "avg_duration": getattr(stats, 'avg_time', 0),
                        "total_duration": getattr(stats, 'total_time', 0),
                        "statistic_time": getattr(stats, 'statistic_time', None)
                    })
                    
                    # 尝试获取最后一次使用时间
                    if hasattr(stats, 'statistic_info') and stats.statistic_info:
                        result["last_visit"] = "从统计信息获取"
                    else:
                        result["last_visit"] = "N/A"
                else:
                    # 如果没有统计信息，使用基本属性作为回退
                    result.update({
                        "today_visits": getattr(target_entity, 'used_times', 0),
                        "last_visit": "N/A",
                        "warning": "使用累计数据，可能非今日实际次数"
                    })
                    logger.warning(f"设备 {target_entity.name} 缺少详细统计信息，使用累计数据")
                
                return result
                
            except Exception as e:
                logger.error(f"处理统计信息时出错: {e}")
                return {
                    "today_visits": 0, 
                    "last_visit": "N/A", 
                    "error": f"处理统计信息失败: {str(e)}"
                }

        return {"today_visits": 0, "last_visit": "N/A", "error": "未找到设备"}
