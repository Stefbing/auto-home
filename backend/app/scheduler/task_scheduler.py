import asyncio
import time
from typing import Callable, Dict, Any, Optional
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class TaskScheduler:
    """异步定时任务调度器"""
    
    def __init__(self):
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.running = False
        self._task_handles: Dict[str, asyncio.Task] = {}
    
    async def add_task(self, name: str, func: Callable, interval: int, 
                      immediate: bool = False, *args, **kwargs):
        """添加定时任务
        
        Args:
            name: 任务名称
            func: 执行函数
            interval: 执行间隔（秒）
            immediate: 是否立即执行一次
            *args, **kwargs: 传递给func的参数
        """
        self.tasks[name] = {
            'func': func,
            'interval': interval,
            'args': args,
            'kwargs': kwargs,
            'immediate': immediate
        }
        
        if self.running:
            await self._start_single_task(name)
    
    async def remove_task(self, name: str):
        """移除任务"""
        if name in self._task_handles:
            self._task_handles[name].cancel()
            del self._task_handles[name]
        
        if name in self.tasks:
            del self.tasks[name]
    
    async def _start_single_task(self, name: str):
        """启动单个任务"""
        if name not in self.tasks:
            return
            
        task_config = self.tasks[name]
        
        async def task_loop():
            try:
                # 立即执行（如果需要）
                if task_config['immediate']:
                    await task_config['func'](*task_config['args'], **task_config['kwargs'])
                
                while True:
                    await asyncio.sleep(task_config['interval'])
                    await task_config['func'](*task_config['args'], **task_config['kwargs'])
            except asyncio.CancelledError:
                logger.info(f"Task {name} cancelled")
            except Exception as e:
                logger.error(f"Task {name} error: {e}")
        
        self._task_handles[name] = asyncio.create_task(task_loop())
    
    async def start(self):
        """启动所有任务"""
        if self.running:
            return
            
        self.running = True
        logger.info("Starting task scheduler...")
        
        for name in self.tasks:
            await self._start_single_task(name)
    
    async def stop(self):
        """停止所有任务"""
        self.running = False
        logger.info("Stopping task scheduler...")
        
        for handle in self._task_handles.values():
            handle.cancel()
        
        # 等待所有任务完成
        if self._task_handles:
            await asyncio.gather(*self._task_handles.values(), return_exceptions=True)
        
        self._task_handles.clear()


# 全局调度器实例
scheduler = TaskScheduler()


class DataRefreshTask:
    """数据刷新任务类"""
    
    def __init__(self, petkit_service, cloudpets_service, cache_manager):
        self.petkit_service = petkit_service
        self.cloudpets_service = cloudpets_service
        self.cache_manager = cache_manager
    
    async def refresh_petkit_data(self):
        """刷新PetKit设备数据"""
        try:
            if not self.petkit_service:
                return
                
            logger.info("Refreshing PetKit data...")
            
            # 获取设备列表
            devices = await self.petkit_service.get_devices()
            await self.cache_manager.set('petkit_devices', devices, ttl=300)  # 5分钟缓存
            
            # 为每个设备获取统计信息
            for device in devices:
                if hasattr(device, 'id'):
                    stats = await self.petkit_service.get_daily_stats(device.id)
                    cache_key = f'petkit_stats_{device.id}'
                    await self.cache_manager.set(cache_key, stats, ttl=180)  # 3分钟缓存
                    
        except Exception as e:
            logger.error(f"Failed to refresh PetKit data: {e}")
    
    async def refresh_cloudpets_data(self):
        """刷新CloudPets数据"""
        try:
            if not self.cloudpets_service:
                return
                
            logger.info("Refreshing CloudPets data...")
            
            # 获取今日投喂次数
            servings = await self.cloudpets_service.get_servings_today()
            await self.cache_manager.set('cloudpets_servings', servings, ttl=120)  # 2分钟缓存
            
            # 获取喂食计划
            plans = await self.cloudpets_service.get_feeding_plans()
            await self.cache_manager.set('cloudpets_plans', plans, ttl=300)  # 5分钟缓存
            
        except Exception as e:
            logger.error(f"Failed to refresh CloudPets data: {e}")
    
    async def refresh_combined_dashboard_data(self):
        """刷新首页聚合数据"""
        try:
            logger.info("Refreshing dashboard data...")
            
            # 并行获取所有数据
            tasks = []
            
            # PetKit数据
            if self.petkit_service:
                tasks.append(self.refresh_petkit_data())
            
            # CloudPets数据
            if self.cloudpets_service:
                tasks.append(self.refresh_cloudpets_data())
            
            # 等待所有任务完成
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
                
            # 标记数据已刷新
            await self.cache_manager.set('dashboard_last_refresh', time.time(), ttl=3600)
            
        except Exception as e:
            logger.error(f"Failed to refresh dashboard data: {e}")


# 创建数据刷新任务实例的工厂函数
def create_data_refresh_task(petkit_service, cloudpets_service, cache_manager):
    return DataRefreshTask(petkit_service, cloudpets_service, cache_manager)