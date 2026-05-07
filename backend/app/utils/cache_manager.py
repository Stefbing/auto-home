"""
内存缓存管理器 - 高性能热点数据缓存（批量操作优化版）
"""
import time
import asyncio
from typing import Any, Optional, Dict, List
import logging

logger = logging.getLogger(__name__)


class CacheManager:
    """纯内存缓存管理器（TTL 自动过期，线程安全，批量操作优化）"""
    
    def __init__(self):
        self._cache: Dict[str, Any] = {}
        self._expiry: Dict[str, float] = {}
        self._lock = asyncio.Lock()
        self._hit_count = 0
        self._miss_count = 0
    
    async def get(self, key: str) -> Optional[Any]:
        """获取缓存（自动检查过期并清理）"""
        async with self._lock:
            if key in self._cache:
                # 检查是否过期
                if key in self._expiry and time.time() < self._expiry[key]:
                    self._hit_count += 1
                    return self._cache[key]
                else:
                    # 过期，清理
                    self._cache.pop(key, None)
                    self._expiry.pop(key, None)
            self._miss_count += 1
            return None
    
    async def mget(self, keys: List[str]) -> Dict[str, Any]:
        """批量获取缓存（减少锁竞争）"""
        result = {}
        async with self._lock:
            current_time = time.time()
            for key in keys:
                if key in self._cache:
                    if current_time < self._expiry.get(key, 0):
                        result[key] = self._cache[key]
                        self._hit_count += 1
                    else:
                        # 过期清理
                        self._cache.pop(key, None)
                        self._expiry.pop(key, None)
                        self._miss_count += 1
                else:
                    self._miss_count += 1
        return result
    
    async def set(self, key: str, value: Any, ttl: int = 300):
        """设置缓存（秒）"""
        if ttl <= 0:
            raise ValueError("TTL must be positive")
        
        async with self._lock:
            self._cache[key] = value
            self._expiry[key] = time.time() + ttl
    
    async def mset(self, items: Dict[str, tuple], default_ttl: int = 300):
        """批量设置缓存 {key: (value, ttl)}"""
        async with self._lock:
            current_time = time.time()
            for key, (value, ttl) in items.items():
                if ttl <= 0:
                    ttl = default_ttl
                self._cache[key] = value
                self._expiry[key] = current_time + ttl
    
    async def delete(self, key: str):
        """删除缓存"""
        async with self._lock:
            self._cache.pop(key, None)
            self._expiry.pop(key, None)
    
    async def mdelete(self, keys: List[str]):
        """批量删除缓存"""
        async with self._lock:
            for key in keys:
                self._cache.pop(key, None)
                self._expiry.pop(key, None)
    
    async def clear(self):
        """清空所有缓存"""
        async with self._lock:
            count = len(self._cache)
            self._cache.clear()
            self._expiry.clear()
            logger.info(f"Cache cleared: {count} items removed")
    
    async def exists(self, key: str) -> bool:
        """检查键是否存在且未过期"""
        async with self._lock:
            if key in self._cache:
                if key in self._expiry and time.time() < self._expiry[key]:
                    return True
                else:
                    self._cache.pop(key, None)
                    self._expiry.pop(key, None)
            return False
    
    async def size(self) -> int:
        """返回当前缓存大小（仅统计未过期）"""
        async with self._lock:
            current_time = time.time()
            expired_keys = [
                k for k, exp in self._expiry.items() 
                if current_time >= exp
            ]
            for k in expired_keys:
                self._cache.pop(k, None)
                self._expiry.pop(k, None)
            
            return len(self._cache)
    
    async def cleanup_expired(self):
        """清理所有过期缓存项"""
        async with self._lock:
            current_time = time.time()
            expired_keys = [
                k for k, exp in self._expiry.items() 
                if current_time >= exp
            ]
            for k in expired_keys:
                self._cache.pop(k, None)
                self._expiry.pop(k, None)
    
    def get_stats(self) -> Dict[str, int]:
        """获取缓存统计信息"""
        total = self._hit_count + self._miss_count
        hit_rate = (self._hit_count / total * 100) if total > 0 else 0
        return {
            'hits': self._hit_count,
            'misses': self._miss_count,
            'hit_rate': round(hit_rate, 2),
            'size': len(self._cache)
        }


# 全局缓存实例
cache_manager = CacheManager()
