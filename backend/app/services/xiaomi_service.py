import os
import json
import hashlib
import base64
import time
import logging
from typing import Optional, Dict, Any
from sqlmodel import Session, select
import requests
from ..models.db import engine
from ..models.models import SystemConfig

logger = logging.getLogger(__name__)

class XiaomiCloudService:
    """小米云服务 - 用于获取 Token 和推送数据到小米运动"""

    def __init__(self):
        # 优先从数据库获取，其次从环境变量
        self.username = None
        self.password = None
        self._session = requests.session()
        self._ssecurity = None
        self.userId = None
        self._serviceToken = None
        self._token_key = "xiaomi_cloud_token"

        # 初始化设备 ID 和代理
        self._device_id = self._generate_device_id()
        self._agent = self._generate_agent()

    def _generate_device_id(self) -> str:
        """生成随机设备 ID"""
        import random
        return "".join([chr(random.randint(97, 122)) for _ in range(6)])

    def _generate_agent(self) -> str:
        """生成随机 User-Agent"""
        import random
        agent_id = "".join([chr(random.randint(65, 69)) for _ in range(13)])
        random_text = "".join([chr(random.randint(97, 122)) for _ in range(18)])
        return f"{random_text}-{agent_id} APP/com.xiaomi.mihome APPV/10.5.201"

    async def initialize(self) -> bool:
        """初始化服务：从数据库加载 Token 或登录"""
        logger.info("Initializing Xiaomi Cloud Service...")

        # 从数据库加载凭证
        if not self.username or not self.password:
            from ..utils.config_manager import get_config_from_db
            self.username = await get_config_from_db("XIAOMI_ACCOUNT")
            self.password = await get_config_from_db("XIAOMI_PASSWORD")

        if not await self._load_token_from_db():
            logger.info("No token found in DB, attempting login...")
            if await self.login():
                logger.info("Login successful")
                return True
            else:
                logger.error("Login failed")
                return False
        else:
            logger.info("Xiaomi Cloud token loaded from DB")
            return True

    async def _load_token_from_db(self) -> bool:
        """从数据库加载 Token"""
        try:
            with Session(engine) as session:
                statement = select(SystemConfig).where(
                    SystemConfig.key == self._token_key,
                    SystemConfig.is_active == True  # 只查询未删除的配置
                ).order_by(SystemConfig.id.desc())
                config = session.exec(statement).first()
                
                if config:
                    token_data = json.loads(config.value)
                    self._ssecurity = token_data.get('ssecurity')
                    self.userId = token_data.get('userId')
                    self._serviceToken = token_data.get('serviceToken')

                    # 检查是否过期（24 小时）
                    saved_time = token_data.get('timestamp', 0)
                    current_time = int(time.time() * 1000)
                    if current_time - saved_time > 24 * 60 * 60 * 1000:
                        logger.info("Xiaomi token expired (24h), need re-login")
                        return False

                    logger.info("Loaded Xiaomi Cloud token from database")
                    return True
        except Exception as e:
            logger.warning(f"Could not load token from DB: {e}")
        return False

    async def _save_token_to_db(self):
        """保存 Token 到数据库"""
        try:
            token_data = {
                'timestamp': int(time.time() * 1000),
                'ssecurity': self._ssecurity,
                'userId': str(self.userId),
                'serviceToken': self._serviceToken
            }

            with Session(engine) as session:
                statement = select(SystemConfig).where(
                    SystemConfig.key == self._token_key,
                    SystemConfig.is_active == True  # 只查询未删除的配置
                )
                config = session.exec(statement).first()
                
                if not config:
                    config = SystemConfig(key=self._token_key, value=json.dumps(token_data), is_active=True)
                    session.add(config)
                else:
                    config.value = json.dumps(token_data)
                    config.updated_at = int(time.time() * 1000)
                    session.add(config)
                session.commit()
                logger.info("Saved Xiaomi Cloud token to database")
        except Exception as e:
            logger.error(f"Failed to save token to DB: {e}")

    async def login(self) -> bool:
        """登录小米云获取 Token"""
        if not self.username or not self.password:
            logger.warning("Missing Xiaomi credentials (XIAOMI_ACCOUNT/XIAOMI_PASSWORD). Weight push feature will be disabled.")
            return False

        try:
            logger.info(f"Attempting to login to Xiaomi Cloud with account {self.username}")

            # Step 1: 获取 _sign
            if not await self._login_step_1():
                logger.error("Login step 1 failed")
                return False

            # Step 2: 认证获取 ssecurity
            if not await self._login_step_2():
                logger.error("Login step 2 failed")
                return False

            # Step 3: 获取 serviceToken
            if not await self._login_step_3():
                logger.error("Login step 3 failed")
                return False

            # 保存 Token 到数据库
            await self._save_token_to_db()
            return True

        except Exception as e:
            logger.error(f"Login failed: {e}")
            return False

    async def _login_step_1(self) -> bool:
        """Step 1: 获取 _sign"""
        url = "https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true"
        headers = {
            "User-Agent": self._agent,
            "Content-Type": "application/x-www-form-urlencoded"
        }
        cookies = {"userId": self.username}

        response = self._session.get(url, headers=headers, cookies=cookies)
        if response.status_code != 200:
            logger.error(f"Step 1 failed: HTTP {response.status_code}")
            return False

        try:
            json_resp = self._to_json(response.text)
            if "_sign" in json_resp:
                self._sign = json_resp["_sign"]
                logger.debug("Step 1: Got _sign")
                return True
            elif "ssecurity" in json_resp:
                # 直接返回了 ssecurity
                self._ssecurity = json_resp["ssecurity"]
                self.userId = json_resp["userId"]
                logger.debug("Step 1: Got ssecurity directly")
                return True
        except Exception as e:
            logger.error(f"Step 1 parse error: {e}")

        return False

    async def _login_step_2(self) -> bool:
        """Step 2: 认证获取 ssecurity"""
        url = "https://account.xiaomi.com/pass/serviceLoginAuth2"
        headers = {
            "User-Agent": self._agent,
            "Content-Type": "application/x-www-form-urlencoded"
        }
    
        # 去除可能的 +86 或 86- 前缀
        clean_username = self.username
        if clean_username.startswith("+86"):
            clean_username = clean_username[3:]
        elif clean_username.startswith("86-"):
            clean_username = clean_username[3:]
            
        fields = {
            "sid": "xiaomiio",
            "hash": hashlib.md5(self.password.encode()).hexdigest().upper(),
            "callback": "https://sts.api.io.mi.com/sts",
            "qs": "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
            "user": clean_username,
            "_sign": self._sign,
            "_json": "true"
        }
    
        response = self._session.post(url, headers=headers, params=fields, allow_redirects=False)
        if response.status_code != 200:
            logger.error(f"Step 2 failed: HTTP {response.status_code}")
            return False
    
        try:
            json_resp = self._to_json(response.text)
            logger.debug(f"Step 2 response: {json.dumps(json_resp, indent=2)[:500]}")
                
            if "ssecurity" in json_resp:
                self._ssecurity = json_resp["ssecurity"]
                self.userId = json_resp.get("userId")
                self._cUserId = json_resp.get("cUserId")
                self._passToken = json_resp.get("passToken")
                self._location = json_resp.get("location")
                self._code = json_resp.get("code")
                logger.info("Step 2: Got ssecurity and location")
                return True
            elif "notificationUrl" in json_resp:
                # 需要 2FA 验证
                logger.warning("Step 2: 2FA required")
                verify_url = json_resp["notificationUrl"]
                logger.info(f"2FA URL: {verify_url}")
                return False
            else:
                logger.error(f"Step 2: No ssecurity in response. Code: {json_resp.get('code')}, Message: {json_resp.get('message')}")
                return False
        except Exception as e:
            logger.error(f"Step 2 parse error: {e}")
            logger.error(f"Response text: {response.text[:500]}")
            
        return False

    async def _login_step_3(self) -> bool:
        """Step 3: 获取 serviceToken"""
        if not hasattr(self, '_location') or not self._location:
            logger.error("No location found for step 3")
            return False

        headers = {
            "User-Agent": self._agent,
            "Content-Type": "application/x-www-form-urlencoded"
        }

        response = self._session.get(self._location, headers=headers)
        if response.status_code != 200:
            logger.error(f"Step 3 failed: HTTP {response.status_code}")
            return False

        self._serviceToken = response.cookies.get("serviceToken")
        if not self._serviceToken:
            logger.error("No serviceToken in cookies")
            return False

        logger.debug("Step 3: Got serviceToken")
        return True

    @staticmethod
    def _to_json(text: str) -> dict:
        """解析小米 API 返回的 JSON"""
        return json.loads(text.replace("&&&START&&&", ""))

    def _signed_nonce(self, nonce: str) -> str:
        """生成 signed nonce"""
        hash_object = hashlib.sha256(
            base64.b64decode(self._ssecurity) + base64.b64decode(nonce)
        )
        return base64.b64encode(hash_object.digest()).decode("utf-8")

    @staticmethod
    def _generate_nonce(millis: int) -> str:
        """生成 nonce"""
        import os
        nonce_bytes = os.urandom(8) + (int(millis / 60000)).to_bytes(4, byteorder="big")
        return base64.b64encode(nonce_bytes).decode()

    @staticmethod
    def _generate_enc_signature(url: str, method: str, signed_nonce: str, params: dict) -> str:
        """生成加密签名"""
        signature_params = [str(method).upper(), url.split("com")[1].replace("/app/", "/")]
        for k, v in params.items():
            signature_params.append(f"{k}={v}")
        signature_params.append(signed_nonce)
        signature_string = "&".join(signature_params)
        return base64.b64encode(hashlib.sha1(signature_string.encode("utf-8")).digest()).decode()

    def _generate_enc_params(self, url: str, method: str, signed_nonce: str, nonce: str,
                            params: dict, ssecurity: str) -> dict:
        """生成加密参数"""
        from Crypto.Cipher import ARC4

        def encrypt_rc4(password: str, payload: str) -> str:
            r = ARC4.new(base64.b64decode(password))
            r.encrypt(bytes(1024))
            return base64.b64encode(r.encrypt(payload.encode())).decode()

        params["rc4_hash__"] = self._generate_enc_signature(url, method, signed_nonce, params)
        for k, v in params.items():
            params[k] = encrypt_rc4(signed_nonce, v)
        params.update({
            "signature": self._generate_enc_signature(url, method, signed_nonce, params),
            "ssecurity": ssecurity,
            "_nonce": nonce,
        })
        return params

    async def push_weight_data(self, user_data: dict) -> bool:
        """
        推送体重数据到小米运动
        user_data: {
            "weight": float,        # 体重 (kg)
            "body_fat": float,      # 体脂率 (%)
            "bmi": float,           # BMI
            "muscle": float,        # 肌肉量 (kg)
            "water": float,         # 水分 (%)
            "visceral_fat": float,  # 内脏脂肪等级
            "bone_mass": float,     # 骨量 (kg)
            "bmr": float,           # 基础代谢 (kcal)
            "impedance": int,       # 阻抗值
            "user_id": int          # 用户 ID
        }
        """
        try:
            # 确保已登录
            if not self._serviceToken or not self._ssecurity:
                logger.info("Token expired, attempting re-login...")
                if not await self.login():
                    logger.error("Re-login failed")
                    return False

            # 构建体重数据
            weight_info = {
                "weigh_scale": {
                    "weight": round(user_data.get("weight", 0) * 100),  # 转换为克
                    "fat": round(user_data.get("body_fat", 0) * 100),   # 体脂率 * 100
                    "bmi": round(user_data.get("bmi", 0) * 10),         # BMI * 10
                    "muscle": round(user_data.get("muscle", 0) * 100),  # 肌肉量 * 100
                    "water": round(user_data.get("water", 0) * 10),     # 水分 * 10
                    "visceral_fat": round(user_data.get("visceral_fat", 0) * 10),
                    "bone_mass": round(user_data.get("bone_mass", 0) * 100),
                    "bmr": round(user_data.get("bmr", 0)),
                    "impedance": user_data.get("impedance", 0),
                    "user_id": str(user_data.get("user_id", "")),
                    "measure_time": int(time.time())
                }
            }

            # 推送到小米云
            country = "cn"
            url = f"https://{country}.api.io.mi.com/app/v2/device/ble_weight_upload"

            millis = round(time.time() * 1000)
            nonce = self._generate_nonce(millis)
            signed_nonce = self._signed_nonce(nonce)

            params = {
                "data": json.dumps(weight_info)
            }

            fields = self._generate_enc_params(url, "POST", signed_nonce, nonce, params, self._ssecurity)

            headers = {
                "Accept-Encoding": "identity",
                "User-Agent": self._agent,
                "Content-Type": "application/x-www-form-urlencoded",
                "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
                "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4",
            }

            cookies = {
                "userId": str(self.userId),
                "yetAnotherServiceToken": self._serviceToken,
                "serviceToken": self._serviceToken,
                "locale": "zh_CN",
                "timezone": "Asia/Shanghai",
            }

            response = self._session.post(url, headers=headers, cookies=cookies, params=fields)

            if response.status_code == 200:
                # 解密响应
                decrypted = self._decrypt_rc4(signed_nonce, response.text)
                result = json.loads(decrypted)

                if result.get("code") == 0 or result.get("result") is not None:
                    logger.info(f"Successfully pushed weight data to Xiaomi: {user_data.get('weight')}kg")
                    return True
                else:
                    logger.error(f"Xiaomi API returned error: {result}")
                    return False
            else:
                logger.error(f"Failed to push weight data: HTTP {response.status_code}")
                return False

        except Exception as e:
            logger.error(f"Error pushing weight data: {e}")
            return False

    @staticmethod
    def _decrypt_rc4(password: str, payload: str) -> str:
        """解密 RC4 加密的响应"""
        from Crypto.Cipher import ARC4
        r = ARC4.new(base64.b64decode(password))
        r.encrypt(bytes(1024))
        return r.encrypt(base64.b64decode(payload))

    async def get_user_devices(self, country: str = "cn") -> list:
        """获取用户设备列表"""
        try:
            if not self._serviceToken:
                logger.error("Not authenticated")
                return []

            url = f"https://{country}.api.io.mi.com/app/v2/user/get_device_cnt"

            millis = round(time.time() * 1000)
            nonce = self._generate_nonce(millis)
            signed_nonce = self._signed_nonce(nonce)

            params = {
                "data": '{ "fetch_own": true, "fetch_share": true}'
            }

            fields = self._generate_enc_params(url, "POST", signed_nonce, nonce, params, self._ssecurity)

            headers = {
                "Accept-Encoding": "identity",
                "User-Agent": self._agent,
                "Content-Type": "application/x-www-form-urlencoded",
                "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
                "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4",
            }

            cookies = {
                "userId": str(self.userId),
                "yetAnotherServiceToken": self._serviceToken,
                "serviceToken": self._serviceToken,
            }

            response = self._session.post(url, headers=headers, cookies=cookies, params=fields)

            if response.status_code == 200:
                decrypted = self._decrypt_rc4(signed_nonce, response.text)
                result = json.loads(decrypted)
                return result.get("result", {}).get("own", [])

            return []

        except Exception as e:
            logger.error(f"Error getting devices: {e}")
            return []


# 单例
xiaomi_service = XiaomiCloudService()
