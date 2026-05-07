import asyncio
import time
from typing import Callable, Dict, Any, Optional
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class TaskScheduler:
    """异步定时任务调度器 - 支持错误重试、执行统计、动态管理"""
    
    def __init__(self):
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.running = False
        self._task_handles: Dict[str, asyncio.Task] = {}
        self._stats: Dict[str, Dict[str, Any]] = {}  # 任务执行统计
    
    async def add_task(self, name: str, func: Callable, interval: int, 
                      immediate: bool = False, max_retries: int = 3, 
                      retry_delay: int = 5, *args, **kwargs):
        """添加定时任务
        
        Args:
            name: 任务名称
            func: 执行函数
            interval: 执行间隔（秒）
            immediate: 是否立即执行一次
            max_retries: 最大重试次数
            retry_delay: 重试延迟（秒）
            *args, **kwargs: 传递给func的参数
        """
        self.tasks[name] = {
            'func': func,
            'interval': interval,
            'args': args,
            'kwargs': kwargs,
            'immediate': immediate,
            'max_retries': max_retries,
            'retry_delay': retry_delay
        }
        
        # 初始化统计信息
        self._stats[name] = {
            'total_runs': 0,
            'success_count': 0,
            'error_count': 0,
            'last_run': None,
            'last_error': None
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
        
        if name in self._stats:
            del self._stats[name]
    
    def get_task_stats(self, name: str = None) -> Dict:
        """获取任务执行统计"""
        if name:
            return self._stats.get(name, {})
        return dict(self._stats)
    
    async def _execute_with_retry(self, name: str, func: Callable, 
                                  max_retries: int, retry_delay: int, 
                                  *args, **kwargs):
        """带重试的执行逻辑"""
        for attempt in range(max_retries + 1):
            try:
                start_time = time.time()
                await func(*args, **kwargs)
                elapsed = time.time() - start_time
                
                # 更新统计
                self._stats[name]['success_count'] += 1
                self._stats[name]['last_run'] = datetime.now().isoformat()
                
                if attempt > 0:
                    logger.info(f"Task {name} succeeded after {attempt + 1} attempts ({elapsed:.2f}s)")
                else:
                    logger.debug(f"Task {name} completed in {elapsed:.2f}s")
                
                return True
            except Exception as e:
                self._stats[name]['error_count'] += 1
                self._stats[name]['last_error'] = str(e)
                
                if attempt < max_retries:
                    logger.warning(f"Task {name} failed (attempt {attempt + 1}/{max_retries + 1}): {e}")
                    await asyncio.sleep(retry_delay)
                else:
                    logger.error(f"Task {name} failed after {max_retries + 1} attempts: {e}")
                    return False
    
    async def _start_single_task(self, name: str):
        """启动单个任务"""
        if name not in self.tasks:
            return
            
        task_config = self.tasks[name]
        
        async def task_loop():
            try:
                # 立即执行（如果需要）
                if task_config['immediate']:
                    self._stats[name]['total_runs'] += 1
                    await self._execute_with_retry(
                        name, 
                        task_config['func'],
                        task_config['max_retries'],
                        task_config['retry_delay'],
                        *task_config['args'], 
                        **task_config['kwargs']
                    )
                
                while True:
                    await asyncio.sleep(task_config['interval'])
                    self._stats[name]['total_runs'] += 1
                    await self._execute_with_retry(
                        name,
                        task_config['func'],
                        task_config['max_retries'],
                        task_config['retry_delay'],
                        *task_config['args'],
                        **task_config['kwargs']
                    )
            except asyncio.CancelledError:
                logger.info(f"Task {name} cancelled")
            except Exception as e:
                logger.error(f"Task {name} unexpected error: {e}")
        
        self._task_handles[name] = asyncio.create_task(task_loop())
    
    async def start(self):
        """启动所有任务"""
        if self.running:
            return
            
        self.running = True
        logger.info(f"Starting task scheduler with {len(self.tasks)} tasks...")
        
        for name in self.tasks:
            await self._start_single_task(name)
        
        logger.info("✓ Task scheduler started")
    
    async def stop(self):
        """停止所有任务"""
        if not self.running:
            return
            
        self.running = False
        logger.info("Stopping task scheduler...")
        
        for handle in self._task_handles.values():
            handle.cancel()
        
        # 等待所有任务完成
        if self._task_handles:
            await asyncio.gather(*self._task_handles.values(), return_exceptions=True)
        
        self._task_handles.clear()
        logger.info("✓ Task scheduler stopped")


# 全局调度器实例
scheduler = TaskScheduler()