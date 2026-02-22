import asyncio
import logging
import aiohttp
from pypetkitapi.client import PetKitClient
from pypetkitapi.command import LitterCommand, DeviceAction, LBCommand, DeviceCommand
from pypetkitapi.exceptions import PetkitSessionExpiredError
import logging
import asyncio

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

    async def start(self):
        """Initialize the session and login"""
        if not self.session:
            self.session = aiohttp.ClientSession()
            self.client = PetKitClient(
                username=self.username,
                password=self.password,
                region=self.region,
                timezone=self.timezone,
                session=self.session,
            )
            # 登录并获取设备列表
            try:
                await self.client.get_devices_data()
                logger.info(f"PetKit 登录成功。共发现 {len(self.client.petkit_entities)} 个设备/实体。")
                for dev_id, entity in self.client.petkit_entities.items():
                    logger.info(f"发现实体: ID={dev_id}, 类型={getattr(entity, 'device_type', '未知')}, 名称={getattr(entity, 'name', '未知')}")
            except Exception as e:
                logger.error(f"PetKit 登录失败: {e}")
                raise e

    async def close(self):
        """Close the session"""
        if self.session:
            await self.session.close()
            self.session = None

    async def get_client_methods(self):
        if not self.client:
            await self.start()
        
        try:
            import pypetkitapi.command as cmd
            constants = {k: v for k, v in vars(cmd).items() if not k.startswith('_')}
        except ImportError:
            constants = {"error": "Could not import pypetkitapi.command"}
            
        return {"methods": [m for m in dir(self.client) if not m.startswith('_')], "constants": constants}

    async def get_devices(self):
        """Get all devices"""
        if not self.client:
            await self.start()
        
        try:
            # 刷新数据
            logger.info("正在刷新设备数据...")
            await self.client.get_devices_data()
        except Exception as e:
            if "Session expired" in str(e) or "401" in str(e):
                logger.warning("Session expired, attempting re-login...")
                self.session = None # Reset session
                await self.start()
                await self.client.get_devices_data()
            else:
                raise e
        
        devices = []
        for dev_id, entity in self.client.petkit_entities.items():
            # 宽松检查：如果有 device_type 或者是硬件设备 (有 sn/hardware)
            # 排除纯宠物档案 (通常有 pet_id)
            if hasattr(entity, 'pet_id'):
                continue

            dev_type = getattr(entity, 'device_type', 'Unknown')
            # 只要不是明确的非设备，都尝试处理
            
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
                state_summary['raw_state'] = str(state_obj)
            
            # --- 增强数据提取 (MAX2 专用) ---
            logger.info(f"--- Data Debug for {getattr(entity, 'name', 'Unknown')} ---")
            
            # 1. 除臭液
            if hasattr(entity, 'deodorant_left_days'):
                 state_summary['deodorant_left_days'] = entity.deodorant_left_days
                 logger.info(f"Liquid(entity): {entity.deodorant_left_days}")
            elif hasattr(entity, 'deodorant_tip') and hasattr(entity.deodorant_tip, 'days'):
                 state_summary['deodorant_left_days'] = entity.deodorant_tip.days
                 logger.info(f"Liquid(tip): {entity.deodorant_tip.days}")
            
            # 2. 猫砂余量
            if hasattr(entity, 'sand_percent'):
                 state_summary['sand_percent'] = entity.sand_percent
                 logger.info(f"Sand(entity): {entity.sand_percent}")
            elif hasattr(entity, 'device_stats') and hasattr(entity.device_stats, 'sand_percent'):
                 state_summary['sand_percent'] = entity.device_stats.sand_percent
                 logger.info(f"Sand(stats): {entity.device_stats.sand_percent}")
            
            # 3. 重量 (猫砂盆总重或猫砂重)
            if hasattr(entity, 'sand_weight'):
                 state_summary['sand_weight'] = entity.sand_weight
                 # 如果没有通用 weight，用 sand_weight 填充
                 if 'weight' not in state_summary:
                     state_summary['weight'] = entity.sand_weight
                 logger.info(f"SandWeight(entity): {entity.sand_weight}")
            
            # 4. 从 device_stats 提取健康数据
            if hasattr(entity, 'device_stats') and entity.device_stats:
                 stats = entity.device_stats
                 # 平均如厕时长 (秒)
                 if hasattr(stats, 'avg_time'):
                     state_summary['avg_duration'] = stats.avg_time
                     logger.info(f"AvgDuration(stats): {stats.avg_time}s")
                 
                 if hasattr(stats, 'statistic_info') and stats.statistic_info:
                     # 找最近的一个有体重的记录
                     last_info = stats.statistic_info[-1]
                     if hasattr(last_info, 'pet_weight') and last_info.pet_weight:
                         state_summary['last_pet_weight'] = last_info.pet_weight
                         logger.info(f"LastPetWeight(stats): {last_info.pet_weight}")

            # 5. 今日次数 (used_times) 和 频繁如厕
            if hasattr(entity, 'state') and hasattr(entity.state, 'frequent_restroom'):
                 state_summary['frequent_restroom'] = entity.state.frequent_restroom
                 logger.info(f"FrequentRestroom(state): {entity.state.frequent_restroom}")

            if hasattr(entity, 'device_stats') and hasattr(entity.device_stats, 'times'):
                 state_summary['used_times'] = entity.device_stats.times
            elif hasattr(entity, 'used_times'):
                 state_summary['used_times'] = entity.used_times

            # 6. 尝试打印 raw state 以发现更多线索
            if hasattr(entity, 'state'):
                # 再次确认 state 对象内部
                s_obj = entity.state
                # 针对 MAX2，某些字段可能在 state 对象的属性中
                for key in ['sand_weight', 'weight', 'used_times', 'sand_percent', 'deodorant_left_days', 'frequent_restroom']:
                    if hasattr(s_obj, key):
                        val = getattr(s_obj, key)
                        # 如果是从 stats 拿到的次数已经准了，就不要被 state.used_times 覆盖
                        if key == 'used_times' and 'used_times' in state_summary and state_summary['used_times'] < 10:
                            continue
                        state_summary[key] = val
                
                logger.info(f"Raw State Obj: {vars(entity.state) if hasattr(entity.state, '__dict__') else entity.state}")
            
            # --------------------------------

            # 修复设备类型识别：如果 device_type 未知，尝试从名称或 data_type 推断
            if (not dev_data["type"] or dev_data["type"] == 'Unknown') and hasattr(entity, 'name'):
                name = getattr(entity, 'name', '')
                if 'MAX' in name or '猫厕所' in name:
                        # 映射为前端可识别的类型 (T4 Pura MAX)
                        dev_data["type"] = 'T4 Pura MAX'
                        logger.info(f"已修正设备类型: {name} -> T4 Pura MAX")
            
            # 针对 Pura MAX (T4) / MAX 2 的特定状态
            # Debug: 打印潜在的有用属性
            try:
                if 'MAX' in getattr(entity, 'name', ''):
                    logger.info(f"--- Debug MAX2 Data ---")
                    logger.info(f"device_stats: {getattr(entity, 'device_stats', 'N/A')}")
                    logger.info(f"deodorant_tip: {getattr(entity, 'deodorant_tip', 'N/A')}")
                    logger.info(f"settings: {getattr(entity, 'settings', 'N/A')}")
                    if hasattr(entity, 'state'):
                         logger.info(f"state object vars: {vars(entity.state)}")
            except Exception as e:
                logger.error(f"Debug log error: {e}")

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
            
            dev_data["state_summary"] = state_summary
            devices.append(dev_data)
        return devices

    async def clean_litterbox(self, device_id=None):
        """Trigger clean action for the first found or specified litterbox"""
        if not self.client:
            await self.start()
        
        target_id = None
        # 如果未指定 ID，找第一个猫厕所 (T3/T4)
        if not device_id:
            for dev_id, entity in self.client.petkit_entities.items():
                target_type = getattr(entity, 'device_type', '')
                # 兼容之前的逻辑
                if not target_type and hasattr(entity, 'name') and ('MAX' in entity.name or '猫厕所' in entity.name):
                    target_type = 'T4 Pura MAX'
                
                if target_type in ['T3', 'T4', 'T4 Pura MAX', 'T5']:
                    target_id = dev_id
                    break
        else:
            target_id = int(device_id) if str(device_id).isdigit() else device_id

        if target_id:
            logger.info(f"Sending clean command to {target_id}")
            
            # 定义执行策略的内部函数，方便重试
            async def _execute_strategies():
                errors = []
                # 策略 1: 标准 CONTROL_DEVICE (T3/T4) - 使用 DeviceCommand
                try:
                    await self.client.send_api_request(
                        target_id, 
                        DeviceCommand.CONTROL_DEVICE, 
                        {DeviceAction.START: LBCommand.CLEANING}
                    )
                    return {"status": "success", "device_id": str(target_id), "action": "clean (strategy 1)"}
                except Exception as e1:
                    errors.append(f"Strategy 1: {e1}")
                    # 如果是 Session expired，直接抛出，让外层捕获重试
                    if "Session expired" in str(e1) or "401" in str(e1):
                        raise e1
                    
                    # 策略 2: 针对 MAX2 的 manager_device
                    try:
                        if hasattr(self.client, 'control_device'):
                            await self.client.control_device(target_id, 'start', 'clean')
                            return {"status": "success", "device_id": str(target_id), "action": "clean (strategy 2)"}
                    except Exception as e2:
                        errors.append(f"Strategy 2: {e2}")
                    
                    # 策略 3: 尝试 manager_device 原生调用
                    try:
                        await self.client.send_api_request(target_id, 'manager_device', {'start': 'clean'})
                        return {"status": "success", "device_id": str(target_id), "action": "clean (strategy 3)"}
                    except Exception as e3:
                        errors.append(f"Strategy 3: {e3}")

                    # 策略 4: 尝试 manager_device type=1 (Pura X/MAX 常见)
                    try:
                        await self.client.send_api_request(target_id, 'manager_device', {'type': 1})
                        return {"status": "success", "device_id": str(target_id), "action": "clean (strategy 4)"}
                    except Exception as e4:
                        errors.append(f"Strategy 4: {e4}")

                    # 策略 5: 尝试 manager_device type='1'
                    try:
                        await self.client.send_api_request(target_id, 'manager_device', {'type': '1'})
                        return {"status": "success", "device_id": str(target_id), "action": "clean (strategy 5)"}
                    except Exception as e5:
                        errors.append(f"Strategy 5: {e5}")

                    # 策略 6: 尝试 update_status (部分设备)
                    try:
                        await self.client.send_api_request(target_id, 'update_status', {'key': 'action', 'value': 'clean'})
                        return {"status": "success", "device_id": str(target_id), "action": "clean (strategy 6)"}
                    except Exception as e6:
                        errors.append(f"Strategy 6: {e6}")

                    # 策略 7: 尝试 start_action (常见通用接口)
                    try:
                        await self.client.send_api_request(target_id, 'start_action', {'type': 'clean'})
                        return {"status": "success", "device_id": str(target_id), "action": "clean (strategy 7)"}
                    except Exception as e7:
                        errors.append(f"Strategy 7: {e7}")
                    
                    # 策略 8: 尝试 daily_clean
                    try:
                        await self.client.send_api_request(target_id, 'daily_clean', {})
                        return {"status": "success", "device_id": str(target_id), "action": "clean (strategy 8)"}
                    except Exception as e8:
                        errors.append(f"Strategy 8: {e8}")

                    # 策略 9: 尝试 start_clean
                    try:
                        await self.client.send_api_request(target_id, 'start_clean', {})
                        return {"status": "success", "device_id": str(target_id), "action": "clean (strategy 9)"}
                    except Exception as e9:
                        errors.append(f"Strategy 9: {e9}")

                    # 策略 10: 终极大招 - 绕过库验证，直接发送原始请求
                    try:
                        entity = self.client.petkit_entities.get(int(target_id))
                        real_type = 'T4'
                        if entity and hasattr(entity, 'device_nfo') and entity.device_nfo:
                            real_type = entity.device_nfo.device_type
                        
                        logger.info(f"Strategy 10: Sending raw request to {real_type}/manager_device")
                        
                        # 尝试 Payload A: {'start': 'clean'}
                        try:
                            await self.client.req.request(
                                'POST', 
                                f"{real_type}/manager_device", 
                                data={'start': 'clean'},
                                headers=await self.client.get_session_id()
                            )
                            return {"status": "success", "device_id": str(target_id), "action": "clean (strategy 10-A)"}
                        except Exception as e10a:
                            errors.append(f"Strategy 10-A: {e10a}")

                        # 尝试 Payload B: {'type': 1} (MAX 常用)
                        try:
                            await self.client.req.request(
                                'POST', 
                                f"{real_type}/manager_device", 
                                data={'type': 1},
                                headers=await self.client.get_session_id()
                            )
                            return {"status": "success", "device_id": str(target_id), "action": "clean (strategy 10-B)"}
                        except Exception as e10b:
                            errors.append(f"Strategy 10-B: {e10b}")

                    except Exception as e10:
                        errors.append(f"Strategy 10 (General): {e10}")

                    raise Exception(f"All strategies failed. Errors: {'; '.join(errors)}")

            # 执行并处理 Session expired
            try:
                return await _execute_strategies()
            except Exception as e:
                if "Session expired" in str(e) or "401" in str(e):
                    logger.warning("Session expired during clean, re-logging in...")
                    self.session = None
                    await self.start()
                    # Retry once
                    return await _execute_strategies()
                raise e
        
        raise Exception("No litterbox found or invalid device ID")

    async def deodorize_litterbox(self, device_id=None):
        """Trigger deodorize (spray) for the first found or specified litterbox"""
        if not self.client:
            await self.start()
        
        target_id = None
        
        # 如果未指定 ID，找第一个猫厕所 (T3/T4)
        if not device_id:
            for dev_id, entity in self.client.petkit_entities.items():
                # 注意：T4 Pura MAX 是我们自己修正的类型
                target_type = getattr(entity, 'device_type', '')
                if not target_type and hasattr(entity, 'name') and ('MAX' in entity.name or '猫厕所' in entity.name):
                    target_type = 'T4 Pura MAX'
                
                if target_type in ['T3', 'T4', 'T4 Pura MAX', 'T5']:
                    target_id = dev_id
                    break
        else:
            target_id = int(device_id) if str(device_id).isdigit() else device_id

        if target_id:
            logger.info(f"Sending deodorize command to {target_id}")
            # 发送除臭指令 (DESODORIZE / SPRAY)
            # T4 MAX 通常支持这个
            await self.client.send_api_request(
                target_id, 
                LitterCommand.CONTROL_DEVICE, 
                {DeviceAction.START: LBCommand.DESODORIZE}
            )
            return {"status": "success", "device_id": str(target_id), "action": "deodorize"}
        
        raise Exception("No litterbox found or invalid device ID")

    async def get_daily_stats(self, device_id=None):
        """获取今日数据（模拟或从设备属性提取）"""
        if not self.client:
            await self.start()
            
        target = None
        if device_id:
             target = self.client.petkit_entities.get(int(device_id))
        else:
             # 找第一个猫厕所
             for dev_id, entity in self.client.petkit_entities.items():
                if hasattr(entity, 'device_type') and entity.device_type in ['T3', 'T4', 'T4 Pura MAX', 'T5']:
                    target = entity
                    break
        
        if target:
            # 尝试从 data 中提取今日次数等
            visits = 0
            last_time = "N/A"
            
            # 从实际数据中提取 used_times (累计次数，可能不是今日)
            # 或者从 data 里的 today_times
            if hasattr(target, 'used_times'):
                 visits = getattr(target, 'used_times')
            elif hasattr(target, 'data') and isinstance(target.data, dict):
                visits = target.data.get('used_times', target.data.get('today_times', 0))
            
            return {
                "today_visits": visits, # 注意：used_times 可能是累计
                "last_visit": last_time,
                "device_name": target.name,
                "sand_percent": getattr(target, 'sand_percent', 0),
                "deodorant_days": getattr(target, 'deodorant_left_days', 0)
            }
            
        return {"today_visits": 0, "last_visit": "N/A"}
