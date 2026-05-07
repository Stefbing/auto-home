"""
配置管理工具 - 从数据库读取加密配置，支持设备管理（性能优化版）
"""
import logging
import time
import asyncio
from typing import Optional, List, Dict, Any, Callable, TypeVar, Tuple
from sqlmodel import Session, select
from ..models.db import engine
from ..models.models import SystemConfig
from .config_encryptor import ConfigEncryptor

logger = logging.getLogger(__name__)

T = TypeVar('T')

# 全局线程池执行器（复用，避免频繁创建）
_executor = None


def _get_executor():
    """获取或创建线程池执行器"""
    global _executor
    if _executor is None:
        _executor = asyncio.get_event_loop().run_in_executor
    return _executor


def _get_timestamp_ms() -> int:
    """获取当前时间戳（毫秒）"""
    return int(time.time() * 1000)


async def _run_db_operation(func: Callable[[], T]) -> T:
    """
    在线程池中运行同步数据库操作，避免阻塞事件循环
    :param func: 同步数据库操作函数
    :return: 操作结果
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, func)


async def get_config_from_db(key: str, user_id: Optional[int] = None, platform: Optional[str] = None, default: Optional[str] = None) -> Optional[str]:
    """
    从数据库获取配置值（自动解密）
    :param key: 配置键（如：account, password, app_version）
    :param user_id: 用户ID（可选，不提供则查询全局配置）
    :param platform: 平台过滤（可选，用于设备配置）
    :param default: 默认值
    :return: 配置值或默认值
    """
    def _get() -> Optional[str]:
        with Session(engine) as session:
            statement = select(SystemConfig).where(
                SystemConfig.key == key,
                SystemConfig.is_active == True
            )
            
            if user_id is not None:
                statement = statement.where(SystemConfig.user_id == user_id)
            else:
                statement = statement.where(SystemConfig.user_id == 0)
            
            if platform:
                statement = statement.where(SystemConfig.platform == platform)
            
            config = session.exec(statement.order_by(SystemConfig.id.desc())).first()
            
            if config:
                if config.is_encrypted:
                    return ConfigEncryptor.decrypt(config.value)
                return config.value
            return default

    try:
        return await _run_db_operation(_get)
    except Exception as e:
        logger.warning(f"Failed to get config {key} from database: {e}")
        return default


async def get_configs_batch(keys_users: List[Tuple[str, Optional[int], Optional[str]]]) -> Dict[str, Optional[str]]:
    """
    批量获取配置（减少数据库查询次数）
    :param keys_users: [(key, user_id, platform), ...]
    :return: {f"{key}_{user_id}_{platform}": value}
    """
    def _batch_get() -> Dict[str, Optional[str]]:
        results = {}
        with Session(engine) as session:
            for key, user_id, platform in keys_users:
                statement = select(SystemConfig).where(
                    SystemConfig.key == key,
                    SystemConfig.is_active == True
                )
                
                if user_id is not None:
                    statement = statement.where(SystemConfig.user_id == user_id)
                else:
                    statement = statement.where(SystemConfig.user_id == 0)
                
                if platform:
                    statement = statement.where(SystemConfig.platform == platform)
                
                config = session.exec(statement.order_by(SystemConfig.id.desc())).first()
                
                cache_key = f"{key}_{user_id or 0}_{platform or 'global'}"
                if config:
                    results[cache_key] = ConfigEncryptor.decrypt(config.value) if config.is_encrypted else config.value
                else:
                    results[cache_key] = None
        return results

    try:
        return await _run_db_operation(_batch_get)
    except Exception as e:
        logger.error(f"Failed to batch get configs: {e}")
        return {}


async def set_config_to_db(key: str, user_id: int, value: str, is_encrypted: bool = False, 
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
    def _set():
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
            
            processed_value = ConfigEncryptor.encrypt(value) if is_encrypted else value
            timestamp = _get_timestamp_ms()
            
            if config:
                # 更新现有配置
                config.value = processed_value
                config.is_encrypted = is_encrypted
                config.updated_at = timestamp
            else:
                # 创建新配置
                config = SystemConfig(
                    user_id=user_id,
                    key=key,
                    value=processed_value,
                    is_encrypted=is_encrypted,
                    platform=platform,
                    device_name=device_name,
                    updated_at=timestamp
                )
                session.add(config)
            
            session.commit()
            logger.info(f"Config {key} saved for user {user_id}")

    try:
        await _run_db_operation(_set)
    except Exception as e:
        logger.error(f"Failed to save config {key} for user {user_id}: {e}")
        raise


async def get_user_devices(user_id: int, platform: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    获取用户的设备列表（从systemconfig表中查询）
    :param user_id: 用户ID
    :param platform: 平台过滤（可选）
    :return: 设备列表，每个设备包含 credentials（account/password）
    """
    def _get_devices() -> List[Dict[str, Any]]:
        with Session(engine) as session:
            statement = select(SystemConfig).where(
                SystemConfig.user_id == user_id,
                SystemConfig.platform.isnot(None),  # 只查询有platform的配置（即设备配置）
                SystemConfig.is_active == True  # 只查询未删除的配置
            )
            
            if platform:
                statement = statement.where(SystemConfig.platform == platform)
            
            configs = session.exec(statement).all()
            
            # 按 (platform, device_name) 分组，避免不同平台同名设备冲突
            devices_dict = {}
            for config in configs:
                # 使用元组作为唯一键，确保不同平台的同名设备不会合并
                device_key = (config.platform, config.device_name or "unknown")
                
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

    try:
        return await _run_db_operation(_get_devices)
    except Exception as e:
        logger.error(f"Failed to get devices for user {user_id}: {e}")
        return []


async def add_device(user_id: int, platform: str, account: str, password: str, 
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
    def _add_device() -> str:
        final_device_name = device_name or platform
        timestamp = _get_timestamp_ms()
        
        with Session(engine) as session:
            try:
                # 准备数据
                encrypted_account = ConfigEncryptor.encrypt(account)
                encrypted_password = ConfigEncryptor.encrypt(password)
                
                # 辅助函数：保存或更新配置
                def upsert_config(key: str, val: str):
                    stmt = select(SystemConfig).where(
                        SystemConfig.user_id == user_id,
                        SystemConfig.key == key,
                        SystemConfig.platform == platform,
                        SystemConfig.device_name == final_device_name
                    )
                    cfg = session.exec(stmt).first()
                    
                    if cfg:
                        # 如果配置存在（包括已删除的），更新它
                        cfg.value = val
                        cfg.is_encrypted = True
                        cfg.is_active = True  # 恢复激活状态
                        cfg.updated_at = timestamp
                    else:
                        cfg = SystemConfig(
                            user_id=user_id,
                            key=key,
                            value=val,
                            is_encrypted=True,
                            platform=platform,
                            device_name=final_device_name,
                            is_active=True,
                            updated_at=timestamp
                        )
                        session.add(cfg)

                # 在同一个事务中保存 account 和 password
                upsert_config("account", encrypted_account)
                upsert_config("password", encrypted_password)
                
                session.commit()
                logger.info(f"Device {final_device_name} ({platform}) added for user {user_id}")
                return final_device_name
            except Exception:
                session.rollback()
                raise

    try:
        return await _run_db_operation(_add_device)
    except Exception as e:
        logger.error(f"Failed to add device for user {user_id}: {e}")
        raise


async def delete_device(user_id: int, device_key: str) -> bool:
    """
    删除用户的设备（软删除，设置is_active=False）
    :param user_id: 用户ID
    :param device_key: 设备标识符（格式：platform_device_name）
    :return: 是否删除成功
    """
    def _delete_device() -> bool:
        # 解析 device_key: "cloudpets_cloudpets"
        parts = device_key.split('_', 1)
        if len(parts) != 2:
            raise ValueError(f"Invalid device_key format: {device_key}")
        
        platform, device_name = parts
        
        with Session(engine) as session:
            try:
                # 查询该设备的所有配置（account、password等）
                stmt = select(SystemConfig).where(
                    SystemConfig.user_id == user_id,
                    SystemConfig.platform == platform,
                    SystemConfig.device_name == device_name,
                    SystemConfig.is_active == True  # 只查询未删除的配置
                )
                configs = session.exec(stmt).all()
                
                if not configs:
                    logger.warning(f"Device {device_key} not found for user {user_id}")
                    return False
                
                # 软删除：设置is_active=False
                timestamp = _get_timestamp_ms()
                for config in configs:
                    config.is_active = False
                    config.updated_at = timestamp
                
                session.commit()
                logger.info(f"Device {device_key} soft-deleted for user {user_id} ({len(configs)} configs marked as inactive)")
                return True
            except Exception:
                session.rollback()
                raise

    try:
        return await _run_db_operation(_delete_device)
    except Exception as e:
        logger.error(f"Failed to delete device {device_key} for user {user_id}: {e}")
        raise

