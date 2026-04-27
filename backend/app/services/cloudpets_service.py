import os
import httpx
import logging
import asyncio
from typing import Dict, Any, List, Optional
from pydantic import BaseModel
from sqlmodel import Session, select
from ..models.db import engine
from ..models.models import SystemConfig
import time

logger = logging.getLogger(__name__)

# 常量定义
DEFAULT_BASE_URL = "https://cn.cloudpets.net"
DEFAULT_DEVICE_ID = "336704"
DEFAULT_DEVICE_TYPE = "66"
DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]
LOGIN_MAX_RETRIES = 3
REQUEST_TIMEOUT = 10.0
COMMAND_PROCESS_DELAY = 1.0

# 延迟导入，避免模块加载时的依赖问题
from ..utils.config_manager import get_config_from_db

DEFAULT_HEADERS = {
    "lang": "zh_CN",
    "platform": "Android",
    "x-cp-client": "1",
    "Content-Type": "application/x-www-form-urlencoded"
}

class FeedingPlan(BaseModel):
    id: Optional[str] = None
    time: str  # HH:mm
    amount: int  # servings (对应 serving)
    enabled: bool = True # (对应 enable)
    weekdays: Optional[List[int]] = None # [1,2,3,4,5,6,7] (对应 daysOfWeek)
    remark: Optional[str] = ""

class CloudPetsService:
    def __init__(self, user_id: Optional[int] = None):
        self.user_id = user_id
        self.account = None  # 保存账号密码用于重试登录
        self.password = None
        self._client = None  # 延迟初始化客户端
        self._base_url = None
        self._device_id = None

    @property
    def client(self) -> httpx.AsyncClient:
        """懒加载 httpx 客户端"""
        if self._client is None:
            raise RuntimeError("CloudPetsService not initialized. Call initialize() first.")
        return self._client
    
    @property
    def device_id(self) -> str:
        """获取设备ID"""
        return self._device_id or DEFAULT_DEVICE_ID
    
    async def _ensure_client(self):
        """确保客户端已初始化"""
        if self._client is None:
            self._base_url = await self._get_config("base_url") or DEFAULT_BASE_URL
            self._device_id = await self._get_config("device_id") or DEFAULT_DEVICE_ID
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                headers=DEFAULT_HEADERS.copy(),
                timeout=REQUEST_TIMEOUT
            )

    async def initialize(self, user_id: Optional[int] = None) -> bool:
        """Initialize service: load token from DB, or login if credentials available"""
        # 使用传入的user_id或实例的user_id
        uid = user_id or self.user_id
        
        logger.info(f"Initializing CloudPets Service (user_id={uid})...")
        
        # 确保客户端已初始化
        await self._ensure_client()
        
        # Try to load existing token from database
        if await self._load_token_from_db():
            logger.info("CloudPets token loaded from DB")
            return True
        
        # No token in DB, check if credentials are configured for this user
        account = await self._get_config("account", user_id=uid)
        password = await self._get_config("password", user_id=uid)
        
        if not account or not password:
            logger.info(f"No CloudPets credentials configured for user {uid}, skipping initialization")
            return False
        
        # Save credentials for retry login
        self.account = account
        self.password = password
        
        # Process account (remove 86- prefix)
        processed_account = self._normalize_account(account)
        
        # Credentials available, attempt login
        logger.info(f"No token found in DB, attempting initial login for user {uid}...")
        if await self._login(processed_account, password):
            logger.info("Initial login successful")
            return True
        else:
            logger.error("Initial login failed")
            return False

    async def _get_config(self, key: str, user_id: Optional[int] = None) -> Optional[str]:
        """异步获取配置项"""
        uid = user_id or self.user_id
        try:
            # 直接调用异步函数
            config_value = await get_config_from_db(key, user_id=uid, platform="cloudpets")
            return config_value
        except Exception as e:
            logger.warning(f"Failed to get config {key}: {e}")
            return None
    
    @staticmethod
    def _normalize_account(account: str) -> str:
        """标准化账号格式，去除国家代码前缀"""
        if not account:
            return account
        if account.startswith("86-"):
            return account[3:]
        elif account.startswith("+86"):
            return account[3:]
        return account

    async def _load_token_from_db(self) -> bool:
        """Try to load the latest token from database"""
        try:
            loop = asyncio.get_event_loop()
            
            def _load_token():
                with Session(engine) as session:
                    statement = select(SystemConfig).where(
                        SystemConfig.key == "cloudpets_token",
                        SystemConfig.user_id == (self.user_id or 0),
                        SystemConfig.is_active == True  # 只查询未删除的配置
                    ).order_by(SystemConfig.id.desc())
                    config = session.exec(statement).first()
                    if config:
                        return config.value
                return None
            
            token = await loop.run_in_executor(None, _load_token)
            if token:
                self.client.headers["authorization"] = token
                logger.info("Loaded CloudPets token from database")
                return True
        except Exception as e:
            logger.warning(f"Could not load token from DB (might be first run): {e}")
        return False

    async def _save_token_to_db(self, token: str):
        """Save new token to database"""
        try:
            loop = asyncio.get_event_loop()
            
            def _save_token():
                with Session(engine) as session:
                    statement = select(SystemConfig).where(
                        SystemConfig.key == "cloudpets_token",
                        SystemConfig.user_id == (self.user_id or 0),
                        SystemConfig.is_active == True  # 只查询未删除的配置
                    )
                    config = session.exec(statement).first()
                    
                    if not config:
                        config = SystemConfig(
                            user_id=self.user_id or 0,
                            key="cloudpets_token",
                            value=token,
                            is_active=True
                        )
                        session.add(config)
                    else:
                        config.value = token
                        config.updated_at = int(time.time() * 1000)
                        session.add(config)
                    session.commit()
            
            await loop.run_in_executor(None, _save_token)
            logger.info("Saved new CloudPets token to database")
        except Exception as e:
            logger.error(f"Failed to save token to DB: {e}")

    async def _login(self, account: str, password: str, retry_count: int = 0) -> bool:
        """
        Login to get new token
        Path: /app/terminal/user/login
        Method: POST
        """
        try:
            logger.info(f"Attempting to login to CloudPets with account {account}")
            payload = {
                "account": account,
                "pwd": password,
                "userType": "1"
            }
            # Login endpoint might need clean headers without old auth
            login_headers = {
                "Content-Type": "application/x-www-form-urlencoded",
                "lang": "zh_CN",
                "platform": "Android",
                "x-cp-client": "1"
            }

            resp = await self.client.post("/app/terminal/user/login", data=payload, headers=login_headers)
            resp.raise_for_status()
            data = resp.json()

            new_token = None
            if "authorization" in data:
                new_token = data["authorization"]
            elif "result" in data:
                if isinstance(data["result"], dict) and "authorization" in data["result"]:
                    new_token = data["result"]["authorization"]
                elif isinstance(data["result"], str):
                    # Sometimes result IS the token
                    new_token = data["result"]

            # Sometimes it's just in the header of the response
            if not new_token and "authorization" in resp.headers:
                new_token = resp.headers["authorization"]

            if new_token:
                self.client.headers["authorization"] = new_token
                await self._save_token_to_db(new_token)
                return True
            else:
                logger.error(f"Could not find token in login response: {data}")
                return False

        except httpx.HTTPStatusError as e:
            # HTTP 错误，尝试重试
            if retry_count < LOGIN_MAX_RETRIES:
                logger.warning(f"Login failed with status {e.response.status_code}, retrying ({retry_count + 1}/{LOGIN_MAX_RETRIES})...")
                await asyncio.sleep(1 * (retry_count + 1))  # 指数退避
                return await self._login(account, password, retry_count + 1)
            logger.error(f"Login failed after {LOGIN_MAX_RETRIES} retries: {e}")
            return False
        except Exception as e:
            logger.error(f"Login failed: {e}")
            return False

    async def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        """
        Wrapper for HTTP requests with auto-login on 401 or specific business errors
        """
        max_retries = 2
        for attempt in range(max_retries):
            try:
                resp = await self.client.request(method, url, **kwargs)

                # Check for HTTP 401
                should_retry = resp.status_code == 401

                # Also check for business logic 401 (sometimes APIs return 200 OK but with error code in body)
                if not should_retry and resp.status_code == 200:
                    try:
                        data = resp.json()
                        # Example: {"code": 401, "message": "Unauthorized"}
                        if isinstance(data, dict) and str(data.get("code")) == "401":
                            should_retry = True
                            logger.warning(f"Detected business logic 401: {data}")
                    except Exception:
                        pass

                if should_retry and attempt < max_retries - 1:
                    logger.warning(f"Received 401 from CloudPets (attempt {attempt + 1}), attempting to re-login...")
                    if self.account and self.password and await self._login(self.account, self.password):
                        # Update authorization header in kwargs if it was passed explicitly
                        if "headers" in kwargs:
                            kwargs["headers"]["authorization"] = self.client.headers["authorization"]
                        logger.info("Re-login successful, retrying request...")
                        continue
                    else:
                        logger.error("Re-login failed, cannot retry request")
                        return resp
                
                return resp
            
            except httpx.TimeoutException as e:
                logger.warning(f"Request timeout (attempt {attempt + 1}): {e}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(1 * (attempt + 1))
                    continue
                raise
            except httpx.ConnectError as e:
                logger.warning(f"Connection error (attempt {attempt + 1}): {e}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(1 * (attempt + 1))
                    continue
                raise
            except Exception as e:
                logger.error(f"Request failed: {e}")
                raise
        
        # Should not reach here, but just in case
        raise RuntimeError("Request failed after all retries")

    async def close(self):
        """关闭客户端连接"""
        if self._client:
            await self._client.aclose()
            self._client = None

    async def get_servings_today(self) -> Dict[str, Any]:
        """
        获取今日已出粮份数
        Path: /app/terminal/feeder/servingsToday
        Method: POST
        Payload: deviceId={device_id}
        """
        try:
            payload = {"deviceId": self.device_id}
            resp = await self._request("POST", "/app/terminal/feeder/servingsToday", data=payload)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to get servings today: {e}")
            raise

    async def manual_feed(self, amount: int = 1) -> Dict[str, Any]:
        """
        立即喂食
        Path: /app/terminal/feeder/manualFeed
        Method: POST
        Payload: deviceId={device_id}&unit={amount}
        """
        try:
            if amount < 1:
                raise ValueError("Feeding amount must be at least 1")
            
            payload = {"deviceId": self.device_id, "unit": str(amount)}
            resp = await self._request("POST", "/app/terminal/feeder/manualFeed", data=payload)

            if resp.status_code != 200:
                logger.error(f"Manual feed failed with status {resp.status_code}: {resp.text}")

            resp.raise_for_status()
            return resp.json()
        except ValueError:
            raise
        except Exception as e:
            logger.error(f"Manual feed failed: {e}")
            raise

    @staticmethod
    def _format_weekdays(weekdays: Any) -> str:
        """格式化星期数据为逗号分隔的字符串"""
        if isinstance(weekdays, list):
            if not weekdays:
                weekdays = DEFAULT_WEEKDAYS
            return ",".join(map(str, weekdays))
        elif isinstance(weekdays, str):
            return weekdays if weekdays else ",".join(map(str, DEFAULT_WEEKDAYS))
        else:
            return ",".join(map(str, DEFAULT_WEEKDAYS))
    
    @staticmethod
    def _parse_time(time_str: str) -> tuple:
        """解析时间字符串，返回 (hour, minute) 元组"""
        if not time_str or ':' not in time_str:
            raise ValueError(f"Invalid time format: {time_str}, expected HH:mm")
        
        parts = time_str.split(':')
        if len(parts) != 2:
            raise ValueError(f"Invalid time format: {time_str}, expected HH:mm")
        
        try:
            hour = int(parts[0])
            minute = int(parts[1])
        except ValueError:
            raise ValueError(f"Invalid time format: {time_str}, hour and minute must be integers")
        
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError(f"Invalid time values: hour={hour}, minute={minute}")
        
        return hour, minute

    async def get_feeding_plans(self) -> List[Dict[str, Any]]:
        """
        获取喂食计划列表
        Path: /app/terminal/feeder/planList/{device_id}
        Method: GET
        Params: deviceType={device_type}&pageNum=1&pageSize=1000
        """
        try:
            headers = self.client.headers.copy()
            headers.pop("Content-Type", None)

            url = f"/app/terminal/feeder/planList/{self.device_id}"
            params = {
                "deviceType": DEFAULT_DEVICE_TYPE,
                "pageNum": "1",
                "pageSize": "1000"
            }

            resp = await self._request("GET", url, params=params, headers=headers)
            resp.raise_for_status()
            data = resp.json()

            raw_list = []
            if "rows" in data:
                raw_list = data["rows"]
            elif "result" in data:
                if isinstance(data["result"], list):
                    raw_list = data["result"]
                elif isinstance(data["result"], dict) and "list" in data["result"]:
                    raw_list = data["result"]["list"]

            # Transform to FeedingPlan model
            plans = []
            for item in raw_list:
                try:
                    # Construct time HH:mm
                    hour = item.get("hour", 0)
                    minute = item.get("minute", 0)
                    time_str = f"{int(hour):02d}:{int(minute):02d}"

                    plan = {
                        "id": str(item.get("id")),
                        "time": time_str,
                        "amount": item.get("serving", 1),
                        "enabled": item.get("enable", True),
                        "weekdays": item.get("daysOfWeek", []),
                        "remark": item.get("remark", "")
                    }
                    plans.append(plan)
                except Exception as e:
                    logger.error(f"Error parsing plan item: {e}")
                    continue

            return plans
        except Exception as e:
            logger.error(f"Failed to get feeding plans: {e}")
            return []

    async def add_feeding_plan(self, plan: FeedingPlan) -> Dict[str, Any]:
        """
        新增喂食计划
        Path: /app/terminal/feeder/feedPlan
        Method: POST
        """
        try:
            # Parse and validate time HH:mm
            hour, minute = self._parse_time(plan.time)

            # Format weekdays
            weekdays_val = self._format_weekdays(plan.weekdays)

            payload = {
                "deviceId": self.device_id,
                "daysOfWeek": weekdays_val,
                "enable": str(plan.enabled).lower(),
                "hour": str(hour),
                "minute": str(minute),
                "serving": str(plan.amount),
                "remark": plan.remark or ""
            }

            headers = self.client.headers.copy()

            resp = await self._request("POST", "/app/terminal/feeder/feedPlan", data=payload, headers=headers)
            logger.info(f"CloudPets ADD Plan Resp: {resp.status_code} {resp.text}")
            resp.raise_for_status()

            # CloudPets returns {"code": 200, "result": "id_string"} or just success message
            data = resp.json()
            new_id = None
            if "result" in data:
                 new_id = str(data["result"])

            # 等待设备处理指令后再返回
            await asyncio.sleep(COMMAND_PROCESS_DELAY)

            # Return the plan object with the new ID (or original if failed to parse)
            return {
                "id": new_id,
                "time": plan.time,
                "amount": plan.amount,
                "enabled": plan.enabled,
                "weekdays": plan.weekdays,
                "remark": plan.remark
            }
        except ValueError:
            raise
        except Exception as e:
            logger.error(f"Failed to add feeding plan: {e}")
            raise

    async def update_feeding_plan(self, plan_id: str, plan: FeedingPlan) -> Dict[str, Any]:
        """
        修改喂食计划
        Path: /app/terminal/feeder/feedPlan
        Method: PUT
        """
        try:
            # Parse and validate time
            hour, minute = self._parse_time(plan.time)

            # Format weekdays
            weekdays_val = self._format_weekdays(plan.weekdays)

            # CloudPets expects boolean string "true"/"false" for enable
            enable_str = "true" if plan.enabled else "false"

            payload = {
                "id": plan_id,
                "deviceId": self.device_id,
                "daysOfWeek": weekdays_val,
                "enable": enable_str,
                "hour": str(hour),
                "minute": str(minute),
                "serving": str(plan.amount),
                "remark": plan.remark or ""
            }

            headers = self.client.headers.copy()

            # Log payload
            logger.debug(f"CloudPets UPDATE Payload: {payload}")

            resp = await self._request("PUT", "/app/terminal/feeder/feedPlan", data=payload, headers=headers)
            logger.debug(f"CloudPets UPDATE Plan Resp: {resp.status_code} {resp.text}")

            resp.raise_for_status()

            # Return the updated plan object to satisfy response_model=FeedingPlan
            # CloudPets API response is likely just {"code": 200, "message": "success"}
            return {
                "id": plan_id,
                "time": plan.time,
                "amount": plan.amount,
                "enabled": plan.enabled,
                "weekdays": plan.weekdays,
                "remark": plan.remark
            }
        except ValueError:
            raise
        except Exception as e:
            logger.error(f"Failed to update feeding plan: {e}")
            raise

    async def delete_feeding_plan(self, plan_id: str) -> Dict[str, Any]:
        """
        删除喂食计划
        Path: /app/terminal/feeder/plan/{plan_id}
        Method: DELETE
        """
        try:
            headers = self.client.headers.copy()
            headers.pop("Content-Type", None)

            url = f"/app/terminal/feeder/plan/{plan_id}"
            resp = await self._request("DELETE", url, headers=headers)

            resp.raise_for_status()
            # DELETE response might be empty or json
            if resp.content:
                result = resp.json()
            else:
                result = {"code": 200, "message": "Deleted"}

            # 等待设备处理指令后再返回
            await asyncio.sleep(COMMAND_PROCESS_DELAY)

            return result
        except Exception as e:
            logger.error(f"Failed to delete feeding plan: {e}")
            raise

    async def get_feeder_status(self) -> Dict[str, Any]:
        """
        获取喂食器实时状态
        Path: /app/terminal/feeder/status
        Method: POST
        Payload: deviceId={device_id}
        """
        try:
            payload = {"deviceId": self.device_id}
            resp = await self._request("POST", "/app/terminal/feeder/status", data=payload)
            if resp.status_code == 200:
                return resp.json()
            else:
                return {"error": f"HTTP {resp.status_code}"}
        except Exception as e:
            logger.error(f"Failed to get feeder status: {e}")
            return {"error": str(e)}


# 全局单例实例（延迟初始化）
cloudpets_service = CloudPetsService()
