"""
内存缓存管理器 - 高性能热点数据缓存
"""
import time
from typing import Any, Optional
import logging

logger = logging.getLogger(__name__)


class CacheManager:
    """纯内存缓存管理器（TTL 自动过期）"""
    
    def __init__(self):
        self._cache = {}
        self._expiry = {}
    
    async def get(self, key: str) -> Optional[Any]:
        """获取缓存（自动检查过期）"""
        if key in self._expiry and time.time() < self._expiry[key]:
            return self._cache[key]
        
        # 过期或不存在，清理
        self._cache.pop(key, None)
        self._expiry.pop(key, None)
        return None
    
    async def set(self, key: str, value: Any, ttl: int = 300):
        """设置缓存（秒）"""
        self._cache[key] = value
        self._expiry[key] = time.time() + ttl
    
    async def delete(self, key: str):
        """删除缓存"""
        self._cache.pop(key, None)
        self._expiry.pop(key, None)
    
    async def clear(self):
        """清空所有缓存"""
        self._cache.clear()
        self._expiry.clear()
    
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
