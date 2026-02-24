import os
import httpx
import logging
from typing import Dict, Any, List, Optional
from pydantic import BaseModel
from sqlmodel import select, Session
from app.models.db import engine
from app.models.models import SystemConfig
import time

logger = logging.getLogger(__name__)

# Base URL from user provided endpoint
BASE_URL = "https://cn.cloudpets.net"

# Configuration from Environment Variables
CLOUDPETS_TOKEN = os.getenv("CLOUDPETS_TOKEN", "nzEB8WppwujQqsYkrmxZRU1//JbOIbOx")
CLOUDPETS_FAMILY_ID = os.getenv("CLOUDPETS_FAMILY_ID", "572807")
DEVICE_ID = os.getenv("CLOUDPETS_DEVICE_ID", "336704")
# 统一账号密码配置 (ACCOUNT/PASSWORD)
# CloudPets 需要去除 "86-" 或 "+86" 前缀
ACCOUNT = os.getenv("ACCOUNT", "86-17757577548")
PASSWORD = os.getenv("PASSWORD", "15050514533")

CLOUDPETS_ACCOUNT = ACCOUNT
if CLOUDPETS_ACCOUNT:
    if CLOUDPETS_ACCOUNT.startswith("86-"):
        CLOUDPETS_ACCOUNT = CLOUDPETS_ACCOUNT[3:]
    elif CLOUDPETS_ACCOUNT.startswith("+86"):
        CLOUDPETS_ACCOUNT = CLOUDPETS_ACCOUNT[3:]

CLOUDPETS_PASSWORD = PASSWORD

DEFAULT_HEADERS = {
    "authorization": CLOUDPETS_TOKEN,
    "lang": "zh_CN",
    "platform": "Android",
    "x-cp-familyid": CLOUDPETS_FAMILY_ID,
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
    def __init__(self):
        self.client = httpx.AsyncClient(base_url=BASE_URL, headers=DEFAULT_HEADERS, timeout=10.0)
        self._load_token_from_db()

    def _load_token_from_db(self):
        """Try to load the latest token from database"""
        try:
            with Session(engine) as session:
                config = session.get(SystemConfig, "cloudpets_token")
                if config:
                    self.client.headers["authorization"] = config.value
                    logger.info("Loaded CloudPets token from database")
        except Exception as e:
            logger.warning(f"Could not load token from DB (might be first run): {e}")

    async def _save_token_to_db(self, token: str):
        """Save new token to database"""
        try:
            with Session(engine) as session:
                config = session.get(SystemConfig, "cloudpets_token")
                if not config:
                    config = SystemConfig(key="cloudpets_token", value=token)
                    session.add(config)
                else:
                    config.value = token
                    config.updated_at = int(time.time() * 1000)
                    session.add(config)
                session.commit()
                logger.info("Saved new CloudPets token to database")
        except Exception as e:
            logger.error(f"Failed to save token to DB: {e}")

    async def _login(self) -> bool:
        """
        Login to get new token
        Path: /app/terminal/user/login
        Method: POST
        """
        if not CLOUDPETS_ACCOUNT or not CLOUDPETS_PASSWORD:
            logger.error("Missing CloudPets credentials (CLOUDPETS_ACCOUNT/PASSWORD)")
            return False

        try:
            logger.info(f"Attempting to login to CloudPets with account {CLOUDPETS_ACCOUNT}")
            payload = {
                "account": CLOUDPETS_ACCOUNT,
                "pwd": CLOUDPETS_PASSWORD,
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
            
            # Assuming the token is in the response, e.g., data['authorization'] or data['token']
            # Based on standard OAuth/API patterns. 
            # User didn't specify response format, but typically it's in the body or headers.
            # However, prompt says "根据返回更新token".
            # Let's assume standard response like {"authorization": "..."} or {"result": {"authorization": "..."}}
            # We will look for 'authorization' in the response.
            
            new_token = None
            if "authorization" in data:
                new_token = data["authorization"]
            elif "result" in data and isinstance(data["result"], dict) and "authorization" in data["result"]:
                new_token = data["result"]["authorization"]
            # Sometimes it's just in the header of the response
            elif "authorization" in resp.headers:
                new_token = resp.headers["authorization"]
            
            if new_token:
                self.client.headers["authorization"] = new_token
                await self._save_token_to_db(new_token)
                return True
            else:
                logger.error(f"Could not find token in login response: {data}")
                return False
                
        except Exception as e:
            logger.error(f"Login failed: {e}")
            return False

    async def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        """
        Wrapper for HTTP requests with auto-login on 401
        """
        try:
            resp = await self.client.request(method, url, **kwargs)
            
            if resp.status_code == 401:
                logger.warning("Received 401 from CloudPets, attempting to re-login...")
                if await self._login():
                    # Retry the request with new token
                    # Update authorization header in kwargs if it was passed explicitly (rare)
                    if "headers" in kwargs:
                        kwargs["headers"]["authorization"] = self.client.headers["authorization"]
                    
                    logger.info("Retrying request with new token")
                    resp = await self.client.request(method, url, **kwargs)
                else:
                    logger.error("Re-login failed, cannot retry request")
            
            return resp
        except Exception as e:
            raise e

    async def close(self):
        await self.client.aclose()

    # ... (get_servings_today, manual_feed, get_feeding_plans 保持不变) ...

    async def get_servings_today(self) -> Dict[str, Any]:
        """
        获取今日已出粮份数
        Path: /app/terminal/feeder/servingsToday
        Method: POST
        Payload: deviceId=336704
        """
        try:
            payload = {"deviceId": DEVICE_ID}
            resp = await self._request("POST", "/app/terminal/feeder/servingsToday", data=payload)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to get servings today: {e}")
            raise e

    async def manual_feed(self, amount: int = 1) -> Dict[str, Any]:
        """
        立即喂食
        Path: /app/terminal/feeder/manualFeed
        Method: POST
        Payload: deviceId=336704&unit=1
        """
        try:
            payload = {"deviceId": DEVICE_ID, "unit": str(amount)}
            resp = await self._request("POST", "/app/terminal/feeder/manualFeed", data=payload)
            
            if resp.status_code != 200:
                logger.error(f"Manual feed failed with status {resp.status_code}: {resp.text}")
            
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Manual feed failed: {e}")
            raise e

    async def get_feeding_plans(self) -> List[Dict[str, Any]]:
        """
        获取喂食计划列表
        Path: /app/terminal/feeder/planList/{deviceId}
        Method: GET
        Params: deviceType=66&pageNum=1&pageSize=1000
        """
        try:
            headers = self.client.headers.copy()
            if "Content-Type" in headers:
                del headers["Content-Type"]
            
            url = f"/app/terminal/feeder/planList/{DEVICE_ID}"
            params = {
                "deviceType": "66",
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
        Method: POST (User says '新增如下：url: .../feedPlan')
        Body: daysOfWeek=1,2,3,4,5,6,7&deviceId=336704&enable=true&hour=01&minute=03&serving=2&remark=
        """
        try:
            # Parse time HH:mm
            hour, minute = plan.time.split(':')
            
            # Format weekdays: ensure "1,2,3" format
            weekdays_val = plan.weekdays
            if isinstance(weekdays_val, list):
                weekdays_val = ",".join(map(str, weekdays_val))
            elif isinstance(weekdays_val, str):
                # If it's already a string, use it (or validate it)
                pass
            else:
                weekdays_val = "1,2,3,4,5,6,7"

            payload = {
                "deviceId": DEVICE_ID,
                "daysOfWeek": weekdays_val,
                "enable": str(plan.enabled).lower(), # true/false
                "hour": hour,
                "minute": minute,
                "serving": plan.amount,
                "remark": plan.remark or ""
            }
            
            headers = self.client.headers.copy()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            
            resp = await self._request("POST", "/app/terminal/feeder/feedPlan", data=payload, headers=headers)
            logger.info(f"CloudPets ADD Plan Resp: {resp.status_code} {resp.text}")
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to add feeding plan: {e}")
            raise e

    async def update_feeding_plan(self, plan_id: str, plan: FeedingPlan) -> Dict[str, Any]:
        """
        修改喂食计划
        Path: /app/terminal/feeder/feedPlan
        Method: PUT
        """
        try:
            hour, minute = plan.time.split(':')
            
            # Format weekdays
            weekdays_val = plan.weekdays
            if isinstance(weekdays_val, list):
                weekdays_val = ",".join(map(str, weekdays_val))
            elif isinstance(weekdays_val, str):
                pass
            else:
                weekdays_val = "1,2,3,4,5,6,7"

            # CloudPets expects boolean string "true"/"false" for enable
            enable_str = "true" if plan.enabled else "false"

            payload = {
                "id": plan_id, # Ensure ID is passed
                "deviceId": DEVICE_ID,
                "daysOfWeek": weekdays_val,
                "enable": enable_str,
                "hour": hour,
                "minute": minute,
                "serving": str(plan.amount), # Ensure string
                "remark": plan.remark or ""
            }
            
            headers = self.client.headers.copy()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            
            # Log payload for debugging
            logger.info(f"CloudPets UPDATE Payload: {payload}")

            resp = await self._request("PUT", "/app/terminal/feeder/feedPlan", data=payload, headers=headers)
            logger.info(f"CloudPets UPDATE Plan Resp: {resp.status_code} {resp.text}")
            
            # Allow 200 even if code!=200, caller handles logic
            if resp.status_code != 200:
                logger.error(f"CloudPets UPDATE Failed Status: {resp.status_code}")
            
            return resp.json()
        except Exception as e:
            logger.error(f"Failed to update feeding plan: {e}")
            raise e

    async def delete_feeding_plan(self, plan_id: str) -> Dict[str, Any]:
        """
        删除喂食计划
        Path: /app/terminal/feeder/plan/{planId}
        Method: DELETE
        """
        try:
            headers = self.client.headers.copy()
            if "Content-Type" in headers:
                del headers["Content-Type"]

            url = f"/app/terminal/feeder/plan/{plan_id}"
            resp = await self._request("DELETE", url, headers=headers)
            
            resp.raise_for_status()
            # DELETE response might be empty or json
            if resp.content:
                return resp.json()
            return {"code": 200, "message": "Deleted"}
        except Exception as e:
            logger.error(f"Failed to delete feeding plan: {e}")
            raise e

cloudpets_service = CloudPetsService()
