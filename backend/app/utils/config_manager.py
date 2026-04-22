"""
配置管理工具 - 从数据库读取加密配置，支持设备管理
"""
import logging
import time
from typing import Optional, List, Dict, Any
from sqlmodel import Session, select
from ..models.db import engine
from ..models.models import SystemConfig
from .config_encryptor import ConfigEncryptor

logger = logging.getLogger(__name__)


def get_config_from_db(key: str, user_id: Optional[int] = None, platform: Optional[str] = None, default: Optional[str] = None) -> Optional[str]:
    """
    从数据库获取配置值（自动解密）
    :param key: 配置键（如：account, password, app_version）
    :param user_id: 用户ID（可选，不提供则查询全局配置）
    :param platform: 平台过滤（可选，用于设备配置）
    :param default: 默认值
    :return: 配置值或默认值
    """
    try:
        with Session(engine) as session:
            statement = select(SystemConfig).where(SystemConfig.key == key)
            
            if user_id:
                statement = statement.where(SystemConfig.user_id == user_id)
            else:
                # 未指定user_id，查询全局配置（user_id=0）
                statement = statement.where(SystemConfig.user_id == 0)
            
            if platform:
                statement = statement.where(SystemConfig.platform == platform)
            
            config = session.exec(statement.order_by(SystemConfig.id.desc())).first()
            
            if config:
                if config.is_encrypted:
                    return ConfigEncryptor.decrypt(config.value)
                return config.value
            return default
    except Exception as e:
        logger.warning(f"Failed to get config {key} from database: {e}")
        return default


def set_config_to_db(key: str, user_id: int, value: str, is_encrypted: bool = False, 
                     platform: Optional[str] = None, device_name: Optional[str] = None):
    """
    保存配置到数据库（自动加密）
    :param key: 配置键（如：account, password）
    :param user_id: 用户ID
    :param value: 配置值
    :param is_encrypted: 是否加密存储
    :param platform: 平台名称（设备配置专用）
    :param device_name: 设备名称（设备配置专用）
    """
    try:
        with Session(engine) as session:
            # 查找现有配置
            statement = select(SystemConfig).where(
                SystemConfig.user_id == user_id,
                SystemConfig.key == key
            )
            
            if platform:
                statement = statement.where(SystemConfig.platform == platform)
            if device_name:
                statement = statement.where(SystemConfig.device_name == device_name)
            
            config = session.exec(statement).first()
            
            if config:
                # 更新现有配置
                config.value = ConfigEncryptor.encrypt(value) if is_encrypted else value
                config.is_encrypted = is_encrypted
                config.updated_at = int(time.time() * 1000)
            else:
                # 创建新配置
                config = SystemConfig(
                    user_id=user_id,
                    key=key,
                    value=ConfigEncryptor.encrypt(value) if is_encrypted else value,
                    is_encrypted=is_encrypted,
                    platform=platform,
                    device_name=device_name,
                    updated_at=int(time.time() * 1000)
                )
                session.add(config)
            
            session.commit()
            logger.info(f"✓ Config {key} saved for user {user_id}")
    except Exception as e:
        logger.error(f"Failed to save config {key} for user {user_id}: {e}")
        raise


def get_user_devices(user_id: int, platform: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    获取用户的设备列表（从systemconfig表中查询）
    :param user_id: 用户ID
    :param platform: 平台过滤（可选）
    :return: 设备列表，每个设备包含 credentials（account/password）
    """
    try:
        with Session(engine) as session:
            statement = select(SystemConfig).where(
                SystemConfig.user_id == user_id,
                SystemConfig.platform.isnot(None)  # 只查询有platform的配置（即设备配置）
            )
            
            if platform:
                statement = statement.where(SystemConfig.platform == platform)
            
            configs = session.exec(statement).all()
            
            # 按 device_name 分组（同一个设备的account/password通过key区分）
            devices_dict = {}
            for config in configs:
                device_key = config.device_name or f"{config.platform}_unknown"
                
                if device_key not in devices_dict:
                    devices_dict[device_key] = {
                        'platform': config.platform,
                        'device_name': config.device_name,
                        'credentials': {}
                    }
                
                # 提取字段名（key就是account或password）
                field_name = config.key  # account 或 password
                if config.is_encrypted:
                    devices_dict[device_key]['credentials'][field_name] = ConfigEncryptor.decrypt(config.value)
                else:
                    devices_dict[device_key]['credentials'][field_name] = config.value
            
            return list(devices_dict.values())
    except Exception as e:
        logger.error(f"Failed to get devices for user {user_id}: {e}")
        return []


def add_device(user_id: int, platform: str, account: str, password: str, 
               device_name: Optional[str] = None) -> str:
    """
    添加设备到用户账户
    :param user_id: 用户ID
    :param platform: 平台名称
    :param account: 账号
    :param password: 密码
    :param device_name: 设备名称（可选，不传则用platform作为名称）
    :return: 设备标识符（device_name）
    """
    try:
        # 如果没有指定设备名称，使用平台名
        final_device_name = device_name or platform
        
        # 保存账号
        set_config_to_db(
            key="account",
            user_id=user_id,
            value=account,
            is_encrypted=True,
            platform=platform,
            device_name=final_device_name
        )
        
        # 保存密码
        set_config_to_db(
            key="password",
            user_id=user_id,
            value=password,
            is_encrypted=True,
            platform=platform,
            device_name=final_device_name
        )
        
        logger.info(f"✓ Device {final_device_name} ({platform}) added for user {user_id}")
        return final_device_name
    except Exception as e:
        logger.error(f"Failed to add device for user {user_id}: {e}")
        raise

