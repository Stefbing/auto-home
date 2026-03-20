import time
import json
from typing import Any, Optional
from sqlmodel import Session
from ..models.db import engine
from ..models.models import DeviceCache
import logging

logger = logging.getLogger(__name__)


class CacheManager:
    """混合缓存管理器：内存 + 数据库双写"""
    
    def __init__(self):
        self._cache = {}
        self._expiry = {}
    
    async def get(self, key: str) -> Optional[Any]:
        """获取缓存：优先内存，未命中查数据库"""
        # 1. 尝试内存缓存
        if key in self._expiry and time.time() < self._expiry[key]:
            return self._cache[key]
        
        # 2. 内存未命中，查询数据库
        try:
            with Session(engine) as session:
                # 假设 key 格式：device_type:device_id:cache_key
                parts = key.split(':')
                if len(parts) >= 3:
                    device_type = parts[0]
                    device_id = parts[1]
                    cache_key = ':'.join(parts[2:])
                    
                    db_cache = session.get(DeviceCache, device_id)
                    if db_cache and db_cache.cache_key == cache_key and db_cache.device_type == device_type:
                        if time.time() * 1000 < db_cache.expires_at:
                            # 加载到内存缓存
                            ttl_seconds = (db_cache.expires_at - time.time() * 1000) / 1000
                            # JSON 字符串转 dict
                            value = json.loads(db_cache.cache_value)
                            self.set(key, value, ttl=int(ttl_seconds))
                            return value
        except Exception as e:
            logger.debug(f"Database cache lookup failed: {e}")
        
        # 过期或不存在，清理
        self._cache.pop(key, None)
        self._expiry.pop(key, None)
        return None
    
    async def set(self, key: str, value: Any, ttl: int = 300):
        """设置缓存：双写到内存和数据库"""
        # 1. 写入内存缓存
        self._cache[key] = value
        self._expiry[key] = time.time() + ttl
        
        # 2. 异步写入数据库（不阻塞）
        try:
            # 解析 key 获取设备信息
            parts = key.split(':')
            if len(parts) >= 3:
                device_type = parts[0]
                device_id = parts[1]
                cache_key = ':'.join(parts[2:])
                
                with Session(engine) as session:
                    db_cache = session.get(DeviceCache, device_id)
                    expires_at_ms = int(time.time() * 1000) + ttl * 1000
                    
                    if not db_cache:
                        db_cache = DeviceCache(
                            device_id=device_id,
                            device_type=device_type,
                            cache_key=cache_key,
                            cache_value=json.dumps(value),  # dict 转 JSON 字符串
                            expires_at=expires_at_ms
                        )
                        session.add(db_cache)
                    else:
                        db_cache.cache_value = json.dumps(value)  # dict 转 JSON 字符串
                        db_cache.expires_at = expires_at_ms
                        db_cache.updated_at = int(time.time() * 1000)
                        session.add(db_cache)
                    
                    session.commit()
        except Exception as e:
            logger.debug(f"Database cache write failed: {e}")
    
    async def delete(self, key: str):
        """删除缓存：同时删除内存和数据库"""
        # 1. 删除内存缓存
        self._cache.pop(key, None)
        self._expiry.pop(key, None)
        
        # 2. 删除数据库缓存
        try:
            parts = key.split(':')
            if len(parts) >= 2:
                device_id = parts[1]
                
                with Session(engine) as session:
                    db_cache = session.get(DeviceCache, device_id)
                    if db_cache:
                        session.delete(db_cache)
                        session.commit()
        except Exception as e:
            logger.debug(f"Database cache delete failed: {e}")
    
    async def clear(self):
        """清空所有缓存"""
        self._cache.clear()
        self._expiry.clear()
        
        # 清空数据库缓存表
        try:
            with Session(engine) as session:
                session.query(DeviceCache).delete()
                session.commit()
        except Exception as e:
            logger.debug(f"Database cache clear failed: {e}")
    
    async def exists(self, key: str) -> bool:
        """检查键是否存在且未过期"""
        return await self.get(key) is not None
    
    async def size(self) -> int:
        """返回当前缓存大小（仅统计未过期）"""
        count = 0
        for key in list(self._cache.keys()):
            if await self.get(key) is not None:
                count += 1
        return count


# 全局缓存实例
cache_manager = CacheManager()
