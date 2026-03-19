import asyncio
import time
from typing import Any, Dict, Optional, Union
from collections import OrderedDict


class CacheManager:
    """简单的内存缓存管理器，支持过期时间和LRU淘汰"""
    
    def __init__(self, max_size: int = 1000):
        self._cache: Dict[str, tuple] = {}  # key -> (value, expire_time, access_time)
        self._max_size = max_size
        self._access_order = OrderedDict()  # 用于LRU
    
    def _cleanup_expired(self):
        """清理过期的缓存项"""
        current_time = time.time()
        expired_keys = []
        
        for key, (value, expire_time, access_time) in self._cache.items():
            if expire_time and current_time > expire_time:
                expired_keys.append(key)
        
        for key in expired_keys:
            del self._cache[key]
            if key in self._access_order:
                del self._access_order[key]
    
    def _evict_lru(self):
        """LRU淘汰策略"""
        if len(self._cache) >= self._max_size:
            # 移除最久未访问的项
            lru_key = self._access_order.popitem(last=False)[0]
            del self._cache[lru_key]
    
    def set(self, key: str, value: Any, ttl: Optional[int] = None):
        """设置缓存项
        
        Args:
            key: 缓存键
            value: 缓存值
            ttl: 过期时间（秒），None表示永不过期
        """
        current_time = time.time()
        expire_time = current_time + ttl if ttl else None
        
        # 如果已经存在，更新访问顺序
        if key in self._cache:
            del self._access_order[key]
        
        # LRU淘汰
        self._evict_lru()
        
        self._cache[key] = (value, expire_time, current_time)
        self._access_order[key] = current_time
    
    def get(self, key: str) -> Optional[Any]:
        """获取缓存项"""
        self._cleanup_expired()
        
        if key in self._cache:
            value, expire_time, access_time = self._cache[key]
            current_time = time.time()
            
            # 更新访问时间
            self._access_order.move_to_end(key)
            self._cache[key] = (value, expire_time, current_time)
            
            return value
        return None
    
    def delete(self, key: str):
        """删除缓存项"""
        if key in self._cache:
            del self._cache[key]
        if key in self._access_order:
            del self._access_order[key]
    
    def clear(self):
        """清空所有缓存"""
        self._cache.clear()
        self._access_order.clear()
    
    def exists(self, key: str) -> bool:
        """检查键是否存在且未过期"""
        self._cleanup_expired()
        return key in self._cache
    
    def size(self) -> int:
        """返回当前缓存大小"""
        self._cleanup_expired()
        return len(self._cache)


# 全局缓存实例
cache_manager = CacheManager(max_size=1000)


class AsyncCacheManager:
    """异步版本的缓存管理器"""
    
    def __init__(self, max_size: int = 1000):
        self._cache: Dict[str, tuple] = {}
        self._max_size = max_size
        self._access_order = OrderedDict()
        self._lock = asyncio.Lock()
    
    async def _cleanup_expired(self):
        """异步清理过期项（不在锁内执行）"""
        current_time = time.time()
        expired_keys = []
        
        # 先收集过期的键（不需要锁）
        for key, (value, expire_time, access_time) in self._cache.items():
            if expire_time and current_time > expire_time:
                expired_keys.append(key)
        
        # 然后在锁内删除
        if expired_keys:
            async with self._lock:
                for key in expired_keys:
                    if key in self._cache:
                        del self._cache[key]
                    if key in self._access_order:
                        del self._access_order[key]
    
    async def _evict_lru(self):
        """异步LRU淘汰（不在锁内判断）"""
        if len(self._cache) >= self._max_size:
            async with self._lock:
                # 再次检查，因为可能在等待锁期间已经有变化
                if len(self._cache) >= self._max_size and self._access_order:
                    lru_key = self._access_order.popitem(last=False)[0]
                    if lru_key in self._cache:
                        del self._cache[lru_key]
    
    async def set(self, key: str, value: Any, ttl: Optional[int] = None):
        """异步设置缓存"""
        await self._cleanup_expired()
        async with self._lock:
            current_time = time.time()
            expire_time = current_time + ttl if ttl else None
            
            if key in self._cache:
                del self._access_order[key]
            
            await self._evict_lru()
            
            self._cache[key] = (value, expire_time, current_time)
            self._access_order[key] = current_time
    
    async def get(self, key: str) -> Optional[Any]:
        """异步获取缓存"""
        await self._cleanup_expired()
        async with self._lock:
            if key in self._cache:
                value, expire_time, access_time = self._cache[key]
                current_time = time.time()
                
                self._access_order.move_to_end(key)
                self._cache[key] = (value, expire_time, current_time)
                
                return value
            return None
    
    async def delete(self, key: str):
        """异步删除缓存"""
        async with self._lock:
            if key in self._cache:
                del self._cache[key]
            if key in self._access_order:
                del self._access_order[key]
    
    async def clear(self):
        """异步清空缓存"""
        async with self._lock:
            self._cache.clear()
            self._access_order.clear()
    
    async def exists(self, key: str) -> bool:
        """异步检查键是否存在"""
        await self._cleanup_expired()
        async with self._lock:
            return key in self._cache


# 异步缓存实例
async_cache_manager = AsyncCacheManager(max_size=1000)