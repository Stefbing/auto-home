-- AutoHome 智能家居系统数据库架构
-- PostgreSQL 13+ / SQLite 兼容版本
-- 创建日期：2026-03-21
-- 说明：此脚本统一了数据库字段类型、长度和约束，确保与后端代码完全对应

-- ============================================================================
-- 1. 基础扩展（仅 PostgreSQL 需要）
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 2. 用户基础信息表
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    wechat_openid VARCHAR(64) UNIQUE NOT NULL,          -- 微信 OpenID（唯一标识）
    phone_number_encrypted BYTEA,                        -- 加密的手机号
    phone_number_hash VARCHAR(64) UNIQUE,                -- 手机号哈希（用于快速查询）
    nickname VARCHAR(100),                               -- 昵称
    avatar_url VARCHAR(255),                             -- 头像 URL
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,      -- 创建时间
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,      -- 更新时间
    is_active BOOLEAN DEFAULT true                       -- 是否激活
);

-- ============================================================================
-- 3. 用户设备凭证表（加密存储）
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_credentials (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- PetKit 凭证
    petkit_account_encrypted BYTEA,                      -- 加密的 PetKit 账号
    petkit_password_encrypted BYTEA,                     -- 加密的 PetKit 密码
    petkit_region VARCHAR(10) DEFAULT 'CN',              -- PetKit 区域
    petkit_session_data JSONB,                           -- PetKit 会话数据（JSON）
    
    -- CloudPets 凭证
    cloudpets_account_encrypted BYTEA,                   -- 加密的 CloudPets 账号
    cloudpets_password_encrypted BYTEA,                  -- 加密的 CloudPets 密码
    
    -- 小米账号（用于推送健康数据）
    xiaomi_account_encrypted BYTEA,                      -- 加密的小米账号
    xiaomi_password_encrypted BYTEA,                     -- 加密的小米密码
    xiaomi_user_id VARCHAR(50),                          -- 小米用户 ID
    
    -- 元数据
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,      -- 创建时间
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,      -- 更新时间
    
    UNIQUE(user_id)                                      -- 一个用户只有一条凭证记录
);

-- ============================================================================
-- 4. 设备绑定表
-- ============================================================================
CREATE TABLE IF NOT EXISTS devices (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_type VARCHAR(20) NOT NULL,                    -- 设备类型：'petkit', 'cloudpets', 'scale', 'camera'
    device_id VARCHAR(100) NOT NULL,                     -- 设备 ID（BLE MAC 或 UUID）
    device_name VARCHAR(100),                            -- 设备名称
    device_model VARCHAR(50),                            -- 设备型号
    is_master BOOLEAN DEFAULT false,                     -- 是否为主设备
    
    -- 元数据
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,      -- 创建时间
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,      -- 更新时间
    
    UNIQUE(user_id, device_type, device_id)              -- 同一用户的同一设备唯一
);

-- ============================================================================
-- 5. 体重记录表
-- ============================================================================
CREATE TABLE IF NOT EXISTS weight_records (
    id SERIAL PRIMARY KEY,
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
    timestamp BIGINT NOT NULL,                           -- 时间戳（毫秒）- 对应后端 int = Field(sa_column={'type': BIGINT})
    device_id INTEGER REFERENCES devices(id),            -- 设备 ID
    xiaomi_pushed BOOLEAN DEFAULT false,                 -- 是否已推送至小米
    xiaomi_push_time TIMESTAMP,                          -- 小米推送时间
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP       -- 创建时间
);

-- ============================================================================
-- 6. 喂食日志表
-- ============================================================================
CREATE TABLE IF NOT EXISTS feeding_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id INTEGER REFERENCES devices(id),
    feed_type VARCHAR(20),                               -- 喂食类型：'manual'（手动）或 'plan'（计划）
    amount INTEGER NOT NULL,                             -- 出粮份数
    plan_id VARCHAR(50),                                 -- 计划 ID（如果是计划喂食）
    feed_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,       -- 喂食时间
    success BOOLEAN DEFAULT true,                        -- 是否成功
    error_message TEXT                                   -- 错误消息
);

-- ============================================================================
-- 7. 猫砂盆使用日志
-- ============================================================================
CREATE TABLE IF NOT EXISTS litterbox_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id INTEGER REFERENCES devices(id),
    event_type VARCHAR(20),                              -- 事件类型：'visit', 'clean', 'deodorize'
    event_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,      -- 事件时间
    duration_seconds INTEGER,                            -- 持续时间（秒）
    pet_weight DECIMAL(5,2),                             -- 宠物体重（kg）
    sand_percent INTEGER,                                -- 猫砂剩余百分比
    deodorant_left_days INTEGER,                         -- 除臭剂剩余天数
    warning_message TEXT                                 -- 警告消息
);

-- ============================================================================
-- 8. 系统配置表（用于存储 Token、缓存等）
-- ============================================================================
CREATE TABLE IF NOT EXISTS systemconfig (
    key VARCHAR(100) PRIMARY KEY,                        -- 配置键名
    value TEXT NOT NULL,                                 -- 配置值
    updated_at BIGINT NOT NULL                           -- 更新时间戳（毫秒）- 对应后端 int = Field(sa_column={'type': BIGINT})
);

-- ============================================================================
-- 9. 设备缓存表（存储高频查询的统计数据）
-- ============================================================================
CREATE TABLE IF NOT EXISTS device_cache (
    device_id VARCHAR(100) PRIMARY KEY,                  -- 设备 ID
    device_type VARCHAR(20) NOT NULL,                    -- 设备类型
    cache_key VARCHAR(100) NOT NULL,                     -- 缓存键名
    cache_value JSONB NOT NULL,                          -- 缓存值（JSON 格式）- 注意：SQLite 需改为 TEXT
    expires_at BIGINT NOT NULL,                          -- 过期时间戳（毫秒）- 对应后端 int = Field(sa_column={'type': BIGINT})
    created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::BIGINT,  -- 创建时间戳（毫秒）
    updated_at BIGINT DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::BIGINT   -- 更新时间戳（毫秒）
);

-- ============================================================================
-- 10. 索引优化
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

-- ============================================================================
-- 11. 触发器：自动更新 updated_at 字段（PostgreSQL 专用）
-- ============================================================================
-- 创建通用触发器函数
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 为需要的表创建触发器
CREATE TRIGGER update_users_updated_at 
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_credentials_updated_at 
    BEFORE UPDATE ON user_credentials
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_devices_updated_at 
    BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 12. 注释说明（便于理解字段用途）
-- ============================================================================
COMMENT ON TABLE users IS '用户基础信息表';
COMMENT ON COLUMN users.wechat_openid IS '微信 OpenID（唯一标识）';
COMMENT ON COLUMN users.phone_number_encrypted IS '加密存储的手机号';
COMMENT ON COLUMN users.phone_number_hash IS '手机号哈希（用于快速查询）';

COMMENT ON TABLE user_credentials IS '用户设备凭证表（加密存储各平台账号密码）';
COMMENT ON COLUMN user_credentials.petkit_session_data IS 'PetKit 会话数据（JSON 格式）';

COMMENT ON TABLE devices IS '用户设备绑定表';
COMMENT ON COLUMN devices.device_type IS '设备类型：petkit, cloudpets, scale, camera';
COMMENT ON COLUMN devices.is_master IS '是否为主设备';

COMMENT ON TABLE weight_records IS '体重记录表';
COMMENT ON COLUMN weight_records.timestamp IS '时间戳（毫秒）- BIGINT 类型';
COMMENT ON COLUMN weight_records.xiaomi_pushed IS '是否已推送至小米运动健康';

COMMENT ON TABLE feeding_logs IS '喂食日志表';
COMMENT ON COLUMN feeding_logs.feed_type IS '喂食类型：manual（手动）或 plan（计划）';

COMMENT ON TABLE litterbox_logs IS '猫砂盆使用日志表';
COMMENT ON COLUMN litterbox_logs.event_type IS '事件类型：visit（访问）, clean（清理）, deodorize（除臭）';

COMMENT ON TABLE systemconfig IS '系统配置表（存储 Token、会话等）';
COMMENT ON COLUMN systemconfig.updated_at IS '更新时间戳（毫秒）- BIGINT 类型';

COMMENT ON TABLE device_cache IS '设备缓存表（存储高频查询的统计数据）';
COMMENT ON COLUMN device_cache.cache_value IS '缓存值（JSON 格式）';
COMMENT ON COLUMN device_cache.expires_at IS '过期时间戳（毫秒）- BIGINT 类型';

-- ============================================================================
-- 13. 初始化数据（可选）
-- ============================================================================
-- 插入默认的系统配置（如果需要）
INSERT INTO systemconfig (key, value, updated_at)
VALUES ('app_version', '0.2.1', EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::BIGINT
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- SQLite 兼容性说明
-- ============================================================================
-- 如果使用 SQLite，需要进行以下调整：
-- 1. 移除 CREATE EXTENSION 语句
-- 2. 将 JSONB 改为 TEXT 类型
-- 3. 将 BYTEA 改为 BLOB 类型
-- 4. 将触发器函数语言改为 PL/pgSQL 的 SQLite 等价物
-- 5. 将 DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::BIGINT 改为 (CAST(strftime('%s', 'now') * 1000 AS BIGINT))
--
-- SQLite 版本的 device_cache 表示例：
-- CREATE TABLE device_cache (
--     device_id VARCHAR(100) PRIMARY KEY,
--     device_type VARCHAR(20) NOT NULL,
--     cache_key VARCHAR(100) NOT NULL,
--     cache_value TEXT NOT NULL,  -- JSON 字符串
--     expires_at BIGINT NOT NULL,
--     created_at BIGINT DEFAULT (CAST(strftime('%s', 'now') * 1000 AS BIGINT)),
--     updated_at BIGINT DEFAULT (CAST(strftime('%s', 'now') * 1000 AS BIGINT))
-- );
