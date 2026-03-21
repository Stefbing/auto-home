-- AutoHome 智能家居系统数据库架构（SQLite 版本）
-- 与后端 SQLModel 代码完全对应
-- 创建日期：2026-03-21
-- 说明：此脚本统一了数据库字段类型、长度和约束，确保与后端代码完全对应

-- ============================================================================
-- 1. 用户基础信息表
-- 对应后端模型：backend/app/models/models.py (未使用，保留用于未来扩展)
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wechat_openid VARCHAR(64) UNIQUE NOT NULL,          -- 微信 OpenID（唯一标识）
    phone_number_encrypted BLOB,                         -- 加密的手机号
    phone_number_hash VARCHAR(64) UNIQUE,                -- 手机号哈希（用于快速查询）
    nickname VARCHAR(100),                               -- 昵称
    avatar_url VARCHAR(255),                             -- 头像 URL
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,       -- 创建时间
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,       -- 更新时间
    is_active BOOLEAN DEFAULT 1                          -- 是否激活 (SQLite 用 0/1)
);

-- ============================================================================
-- 2. 用户设备凭证表（加密存储）
-- 对应后端模型：未使用，保留用于未来扩展
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- PetKit 凭证
    petkit_account_encrypted BLOB,                       -- 加密的 PetKit 账号
    petkit_password_encrypted BLOB,                      -- 加密的 PetKit 密码
    petkit_region VARCHAR(10) DEFAULT 'CN',              -- PetKit 区域
    petkit_session_data TEXT,                            -- PetKit 会话数据（JSON 字符串）
    
    -- CloudPets 凭证
    cloudpets_account_encrypted BLOB,                    -- 加密的 CloudPets 账号
    cloudpets_password_encrypted BLOB,                   -- 加密的 CloudPets 密码
    
    -- 小米账号（用于推送健康数据）
    xiaomi_account_encrypted BLOB,                       -- 加密的小米账号
    xiaomi_password_encrypted BLOB,                      -- 加密的小米密码
    xiaomi_user_id VARCHAR(50),                          -- 小米用户 ID
    
    -- 元数据
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,       -- 创建时间
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,       -- 更新时间
    
    UNIQUE(user_id)                                      -- 一个用户只有一条凭证记录
);

-- ============================================================================
-- 3. 设备绑定表
-- 对应后端模型：未直接使用，通过 devices 表管理
-- ============================================================================
CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_type VARCHAR(20) NOT NULL,                    -- 设备类型：'petkit', 'cloudpets', 'scale', 'camera'
    device_id VARCHAR(100) NOT NULL,                     -- 设备 ID（BLE MAC 或 UUID）
    device_name VARCHAR(100),                            -- 设备名称
    device_model VARCHAR(50),                            -- 设备型号
    is_master BOOLEAN DEFAULT 0,                         -- 是否为主设备 (SQLite 用 0/1)
    
    -- 元数据
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,       -- 创建时间
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,       -- 更新时间
    
    UNIQUE(user_id, device_type, device_id)              -- 同一用户的同一设备唯一
);

-- ============================================================================
-- 4. 体重记录表 ✅ 已在使用
-- 对应后端模型：backend/app/models/models.py - WeightRecord
-- ============================================================================
CREATE TABLE IF NOT EXISTS weight_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    weight DECIMAL(5,2) NOT NULL,                        -- 体重（kg），最大 999.99
    impedance INTEGER,                                   -- 阻抗值
    bmi DECIMAL(5,2),                                    -- BMI
    body_fat DECIMAL(5,2),                               -- 体脂率（%）
    muscle DECIMAL(5,2),                                 -- 肌肉量（kg）
    water DECIMAL(5,2),                                  -- 水分（%）
    visceral_fat DECIMAL(5,2),                           -- 内脏脂肪等级
    bone_mass DECIMAL(5,2),                              -- 骨量（kg）
    bmr DECIMAL(8,2),                                    -- 基础代谢（kcal），最大 999999.99
    timestamp BIGINT NOT NULL,                           -- 时间戳（毫秒）✅ 对应后端：int = Field(sa_column={'type': BIGINT})
    device_id INTEGER REFERENCES devices(id),            -- 设备 ID
    xiaomi_pushed BOOLEAN DEFAULT 0,                     -- 是否已推送至小米 (SQLite 用 0/1)
    xiaomi_push_time DATETIME,                           -- 小米推送时间
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP        -- 创建时间
);

-- ============================================================================
-- 5. 喂食日志表
-- 对应后端模型：未直接使用，通过 FeedingPlan 管理计划
-- ============================================================================
CREATE TABLE IF NOT EXISTS feeding_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id INTEGER REFERENCES devices(id),
    feed_type VARCHAR(20),                               -- 喂食类型：'manual'（手动）或 'plan'（计划）
    amount INTEGER NOT NULL,                             -- 出粮份数
    plan_id VARCHAR(50),                                 -- 计划 ID（如果是计划喂食）
    feed_time DATETIME DEFAULT CURRENT_TIMESTAMP,        -- 喂食时间
    success BOOLEAN DEFAULT 1,                           -- 是否成功 (SQLite 用 0/1)
    error_message TEXT                                   -- 错误消息
);

-- ============================================================================
-- 6. 猫砂盆使用日志
-- 对应后端模型：未直接使用，通过服务层管理
-- ============================================================================
CREATE TABLE IF NOT EXISTS litterbox_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id INTEGER REFERENCES devices(id),
    event_type VARCHAR(20),                              -- 事件类型：'visit', 'clean', 'deodorize'
    event_time DATETIME DEFAULT CURRENT_TIMESTAMP,       -- 事件时间
    duration_seconds INTEGER,                            -- 持续时间（秒）
    pet_weight DECIMAL(5,2),                             -- 宠物体重（kg）
    sand_percent INTEGER,                                -- 猫砂剩余百分比
    deodorant_left_days INTEGER,                         -- 除臭剂剩余天数
    warning_message TEXT                                 -- 警告消息
);

-- ============================================================================
-- 7. 系统配置表 ✅ 已在使用
-- 对应后端模型：backend/app/models/models.py - SystemConfig
-- ============================================================================
CREATE TABLE IF NOT EXISTS systemconfig (
    key VARCHAR(100) PRIMARY KEY,                        -- 配置键名
    value TEXT NOT NULL,                                 -- 配置值
    updated_at BIGINT NOT NULL                           -- 更新时间戳（毫秒）✅ 对应后端：int = Field(sa_column={'type': BIGINT})
);

-- ============================================================================
-- 8. 设备缓存表 ✅ 已在使用
-- 对应后端模型：backend/app/models/models.py - DeviceCache
-- ============================================================================
CREATE TABLE IF NOT EXISTS device_cache (
    device_id VARCHAR(100) PRIMARY KEY,                  -- 设备 ID
    device_type VARCHAR(20) NOT NULL,                    -- 设备类型
    cache_key VARCHAR(100) NOT NULL,                     -- 缓存键名
    cache_value TEXT NOT NULL,                           -- 缓存值（JSON 字符串）✅ 注意：SQLite 使用 TEXT 存储 JSON
    expires_at BIGINT NOT NULL,                          -- 过期时间戳（毫秒）✅ 对应后端：int = Field(sa_column={'type': BIGINT})
    created_at BIGINT DEFAULT (CAST(strftime('%s', 'now') * 1000 AS BIGINT)),  -- 创建时间戳（毫秒）
    updated_at BIGINT DEFAULT (CAST(strftime('%s', 'now') * 1000 AS BIGINT))   -- 更新时间戳（毫秒）
);

-- ============================================================================
-- 9. 已知设备表 ✅ 已在使用
-- 对应后端模型：backend/app/models/models.py - KnownDevice
-- ============================================================================
CREATE TABLE IF NOT EXISTS knowndevice (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id VARCHAR(100) UNIQUE NOT NULL,              -- 设备 ID（BLE MAC 或 UUID）
    name VARCHAR(100) NOT NULL,                          -- 设备名称
    type VARCHAR(20) NOT NULL,                           -- 设备类型：'scale', 'camera' 等
    last_seen BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') * 1000 AS BIGINT))  -- 最后在线时间戳（毫秒）✅ 对应后端：int = Field(sa_column={'type': BIGINT})
);

-- ============================================================================
-- 10. 喂食计划表 ✅ 已在使用
-- 对应后端模型：backend/app/models/models.py - FeedingPlan
-- ============================================================================
CREATE TABLE IF NOT EXISTS feedingplan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time VARCHAR(5) NOT NULL,                            -- 喂食时间 HH:mm
    amount INTEGER NOT NULL,                             -- 出粮份数
    enabled BOOLEAN DEFAULT 1                            -- 是否启用 (SQLite 用 0/1)
);

-- ============================================================================
-- 11. 用户表（简化版）✅ 已在使用
-- 对应后端模型：backend/app/models/models.py - User
-- 注意：此处的 User 模型与上面的 users 表不同，这是简化版本
-- ============================================================================
CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(255) NOT NULL,                          -- 用户名
    gender VARCHAR(10) DEFAULT 'male',                   -- 性别：male/female
    age INTEGER DEFAULT 25,                              -- 年龄
    height INTEGER DEFAULT 175                           -- 身高（cm）
);

-- ============================================================================
-- 12. 索引优化
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_users_phone_hash ON users(phone_number_hash);
CREATE INDEX IF NOT EXISTS idx_users_wechat_openid ON users(wechat_openid);
CREATE INDEX IF NOT EXISTS idx_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(device_type);
CREATE INDEX IF NOT EXISTS idx_weight_records_user_id ON weight_records(user_id);
CREATE INDEX IF NOT EXISTS idx_weight_records_timestamp ON weight_records(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_feeding_logs_user_id ON feeding_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_feeding_logs_time ON feeding_logs(feed_time DESC);
CREATE INDEX IF NOT EXISTS idx_litterbox_logs_user_id ON litterbox_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_litterbox_logs_time ON litterbox_logs(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_systemconfig_key ON systemconfig(key);
CREATE INDEX IF NOT EXISTS idx_device_cache_type ON device_cache(device_type);
CREATE INDEX IF NOT EXISTS idx_device_cache_key ON device_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_device_cache_expires ON device_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_knowndevice_device_id ON knowndevice(device_id);
CREATE INDEX IF NOT EXISTS idx_knowndevice_type ON knowndevice(type);

-- ============================================================================
-- 13. 触发器：自动更新 updated_at 字段（SQLite 版本）
-- ============================================================================
-- 创建通用触发器函数（SQLite 使用 CREATE TRIGGER 直接定义）
CREATE TRIGGER IF NOT EXISTS update_users_updated_at 
AFTER UPDATE ON users
FOR EACH ROW
BEGIN
    UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS update_user_credentials_updated_at 
AFTER UPDATE ON user_credentials
FOR EACH ROW
BEGIN
    UPDATE user_credentials SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS update_devices_updated_at 
AFTER UPDATE ON devices
FOR EACH ROW
BEGIN
    UPDATE devices SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS update_device_cache_updated_at 
AFTER UPDATE ON device_cache
FOR EACH ROW
BEGIN
    UPDATE device_cache SET updated_at = CAST(strftime('%s', 'now') * 1000 AS BIGINT) WHERE device_id = OLD.device_id;
END;

-- ============================================================================
-- 14. 初始化数据（可选）
-- ============================================================================
-- 插入默认的系统配置
INSERT OR IGNORE INTO systemconfig (key, value, updated_at)
VALUES ('app_version', '0.2.1', CAST(strftime('%s', 'now') * 1000 AS BIGINT));

-- ============================================================================
-- 字段类型对照表（PostgreSQL vs SQLite）
-- ============================================================================
-- PostgreSQL          | SQLite              | 后端 Python/SQLModel
-- --------------------|---------------------|----------------------------------
-- SERIAL              | INTEGER PRIMARY KEY | Optional[int] = Field(primary_key)
-- VARCHAR(n)          | VARCHAR(n)          | str = Field(max_length=n)
-- TEXT                | TEXT                | str
-- BYTEA               | BLOB                | bytes (加密字段)
-- JSONB               | TEXT                | str (JSON 字符串)
-- BOOLEAN             | BOOLEAN (0/1)       | bool
-- TIMESTAMP           | DATETIME            | datetime (不常用)
-- INTEGER             | INTEGER             | int
-- BIGINT              | BIGINT              | int = Field(sa_column={'type': BIGINT})
-- DECIMAL(p,s)        | DECIMAL(p,s)        | float
-- ============================================================================

-- ============================================================================
-- 重要说明
-- ============================================================================
-- 1. 时间戳字段统一使用 BIGINT 类型，存储毫秒时间戳
--    - 对应后端：timestamp: int = Field(default_factory=lambda: int(time.time() * 1000), sa_column={'type': BIGINT})
-- 
-- 2. JSON 字段在 SQLite 中使用 TEXT 类型存储 JSON 字符串
--    - 对应后端：cache_value: str = Field(default="{}")
-- 
-- 3. 布尔类型在 SQLite 中使用 BOOLEAN，实际存储为 0/1
--    - 对应后端：enabled: bool = True
-- 
-- 4. 加密字段使用 BLOB 类型（PostgreSQL 为 BYTEA）
--    - 对应后端：phone_number_encrypted: bytes
-- 
-- 5. 所有必填字段添加 NOT NULL 约束
-- 6. 外键关系使用 REFERENCES 定义
-- 7. 唯一性约束使用 UNIQUE 关键字
-- ============================================================================
