"""
配置管理工具 - 从数据库读取加密配置
"""
import logging
from typing import Optional
from sqlmodel import Session
from ..models.db import engine
from ..models.models import SystemConfig
from .config_encryptor import ConfigEncryptor

logger = logging.getLogger(__name__)


def get_config_from_db(key: str, default: Optional[str] = None) -> Optional[str]:
    """
    从数据库获取配置值（自动解密）
    :param key: 配置键
    :param default: 默认值
    :return: 配置值或默认值
    """
    try:
        with Session(engine) as session:
            config = session.get(SystemConfig, key)
            if config:
                if config.is_encrypted:
                    return ConfigEncryptor.decrypt(config.value)
                return config.value
            return default
    except Exception as e:
        logger.warning(f"Failed to get config {key} from database: {e}")
        return default
