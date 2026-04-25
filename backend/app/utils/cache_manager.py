"""
内存缓存管理器 - 高性能热点数据缓存
"""
import time
import asyncio
from typing import Any, Optional
import logging

logger = logging.getLogger(__name__)


class CacheManager:
    """纯内存缓存管理器（TTL 自动过期，线程安全）"""
    
    def __init__(self):
        self._cache = {}
        self._expiry = {}
        self._lock = asyncio.Lock()
    
    async def get(self, key: str) -> Optional[Any]:
        """获取缓存（自动检查过期并清理）"""
        async with self._lock:
            if key in self._cache:
                # 检查是否过期
                if key in self._expiry and time.time() < self._expiry[key]:
                    logger.debug(f"Cache hit: {key}")
                    return self._cache[key]
                else:
                    # 过期，清理
                    logger.debug(f"Cache expired: {key}")
                    self._cache.pop(key, None)
                    self._expiry.pop(key, None)
            else:
                logger.debug(f"Cache miss: {key}")
            return None
    
    async def set(self, key: str, value: Any, ttl: int = 300):
        """设置缓存（秒）"""
        if ttl <= 0:
            raise ValueError("TTL must be positive")
        
        async with self._lock:
            self._cache[key] = value
            self._expiry[key] = time.time() + ttl
            logger.debug(f"Cache set: {key} (TTL: {ttl}s)")
    
    async def delete(self, key: str):
        """删除缓存"""
        async with self._lock:
            removed = self._cache.pop(key, None) is not None
            self._expiry.pop(key, None)
            if removed:
                logger.debug(f"Cache deleted: {key}")
    
    async def clear(self):
        """清空所有缓存"""
        async with self._lock:
            count = len(self._cache)
            self._cache.clear()
            self._expiry.clear()
            logger.info(f"Cache cleared: {count} items removed")
    
    async def exists(self, key: str) -> bool:
        """检查键是否存在且未过期（不关心值是否为 None）"""
        async with self._lock:
            if key in self._cache:
                if key in self._expiry and time.time() < self._expiry[key]:
                    return True
                else:
                    # 过期，清理
                    self._cache.pop(key, None)
                    self._expiry.pop(key, None)
            return False
    
    async def size(self) -> int:
        """返回当前缓存大小（仅统计未过期，O(1) 优化）"""
        async with self._lock:
            current_time = time.time()
            # 惰性清理并计数
            expired_keys = [
                k for k, exp in self._expiry.items() 
                if current_time >= exp
            ]
            for k in expired_keys:
                self._cache.pop(k, None)
                self._expiry.pop(k, None)
            
            return len(self._cache)


# 全局缓存实例
cache_manager = CacheManager()
