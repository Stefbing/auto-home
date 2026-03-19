-- AutoHome 智能家居系统数据库架构
-- PostgreSQL 13+

-- 启用必要扩展
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. 用户基础信息表
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    wechat_openid VARCHAR(64) UNIQUE NOT NULL,
    phone_number_encrypted BYTEA, -- 加密存储
    phone_number_hash VARCHAR(64) UNIQUE, -- 用于快速查询
    nickname VARCHAR(100),
    avatar_url VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true
);

-- 2. 用户设备凭证表（加密存储）
CREATE TABLE user_credentials (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,

    -- PetKit 凭证
    petkit_account_encrypted BYTEA,
    petkit_password_encrypted BYTEA,
    petkit_region VARCHAR(10) DEFAULT 'CN',
    petkit_session_data JSONB,

    -- CloudPets 凭证
    cloudpets_account_encrypted BYTEA,
    cloudpets_password_encrypted BYTEA,
    cloudpets_device_id VARCHAR(50),

    -- 小米账号（用于推送健康数据）
    xiaomi_account_encrypted BYTEA,
    xiaomi_password_encrypted BYTEA,
    xiaomi_user_id VARCHAR(50),

    -- 元数据
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(user_id)
);

-- 3. 设备绑定表
CREATE TABLE devices (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    device_type VARCHAR(20) NOT NULL, -- 'petkit', 'cloudpets', 'scale', 'camera'
    device_id VARCHAR(100) NOT NULL,
    device_name VARCHAR(100),
    device_model VARCHAR(50),
    is_master BOOLEAN DEFAULT false, -- 是否为主设备
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(user_id, device_type, device_id)
);

-- 4. 体重记录表
CREATE TABLE weight_records (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    weight DECIMAL(5,2) NOT NULL,
    impedance INTEGER,
    bmi DECIMAL(5,2),
    body_fat DECIMAL(5,2),
    muscle DECIMAL(5,2),
    water DECIMAL(5,2),
    visceral_fat DECIMAL(5,2),
    bone_mass DECIMAL(5,2),
    bmr DECIMAL(8,2),
    timestamp BIGINT NOT NULL,
    device_id INTEGER REFERENCES devices(id),
    xiaomi_pushed BOOLEAN DEFAULT false, -- 是否已推送至小米
    xiaomi_push_time TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. 喂食日志表
CREATE TABLE feeding_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    device_id INTEGER REFERENCES devices(id),
    feed_type VARCHAR(20), -- 'manual' 或 'plan'
    amount INTEGER NOT NULL,
    plan_id VARCHAR(50),
    feed_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN DEFAULT true,
    error_message TEXT
);

-- 6. 猫砂盆使用日志
CREATE TABLE litterbox_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    device_id INTEGER REFERENCES devices(id),
    event_type VARCHAR(20), -- 'visit', 'clean', 'deodorize'
    event_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    duration_seconds INTEGER,
    pet_weight DECIMAL(5,2),
    sand_percent INTEGER,
    deodorant_left_days INTEGER,
    warning_message TEXT
);

-- 索引优化
CREATE INDEX idx_users_phone_hash ON users(phone_number_hash);
CREATE INDEX idx_users_wechat_openid ON users(wechat_openid);
CREATE INDEX idx_credentials_user_id ON user_credentials(user_id);
CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE INDEX idx_weight_records_user_id ON weight_records(user_id);
CREATE INDEX idx_weight_records_timestamp ON weight_records(timestamp DESC);
CREATE INDEX idx_feeding_logs_user_id ON feeding_logs(user_id);
CREATE INDEX idx_litterbox_logs_user_id ON litterbox_logs(user_id);

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_credentials_updated_at BEFORE UPDATE ON user_credentials
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_devices_updated_at BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
