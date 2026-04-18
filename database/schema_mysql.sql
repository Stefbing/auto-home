-- AutoHome 智能家居系统数据库架构（MySQL 精简版）
-- MySQL 8.0+ 兼容版本
-- 创建日期：2026-04-17
-- 说明：精简表结构，仅保留核心业务数据

-- ============================================================================
-- 1. 用户表
-- ============================================================================
CREATE TABLE IF NOT EXISTS user (
    id VARCHAR(32) PRIMARY KEY,                       -- UUID (32 chars, no hyphens)
    phone_number VARCHAR(20) UNIQUE NOT NULL,          -- 手机号（唯一标识）
    nickname VARCHAR(100),                              -- 昵称
    gender VARCHAR(10) DEFAULT 'male',                  -- 性别：male/female
    age INT DEFAULT 25,                                 -- 年龄
    height INT DEFAULT 175,                             -- 身高（cm）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,     -- 创建时间
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP  -- 更新时间
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 2. 系统配置表（加密存储敏感信息）
-- ============================================================================
CREATE TABLE IF NOT EXISTS systemconfig (
    `key` VARCHAR(100) PRIMARY KEY,                     -- 配置键名（key 是 MySQL 保留字，需要反引号）
    value TEXT NOT NULL,                                -- 配置值（加密或明文）
    is_encrypted TINYINT(1) NOT NULL DEFAULT 0,         -- 是否加密：0=明文, 1=加密
    updated_at BIGINT NOT NULL                          -- 更新时间戳（毫秒）
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 3. 体重记录表
-- ============================================================================
CREATE TABLE IF NOT EXISTS weightrecord (
    id VARCHAR(32) PRIMARY KEY,                         -- UUID (32 chars, no hyphens)
    user_id VARCHAR(32) NOT NULL,                       -- 关联用户 UUID
    weight DECIMAL(5,2) NOT NULL,                       -- 体重（kg），最大 999.99
    impedance INT,                                      -- 阻抗值
    bmi DECIMAL(5,2),                                   -- BMI
    body_fat DECIMAL(5,2),                              -- 体脂率（%）
    muscle DECIMAL(5,2),                                -- 肌肉量（kg）
    water DECIMAL(5,2),                                 -- 水分（%）
    visceral_fat DECIMAL(5,2),                          -- 内脏脂肪等级
    bone_mass DECIMAL(5,2),                             -- 骨量（kg）
    bmr DECIMAL(8,2),                                   -- 基础代谢（kcal）
    timestamp BIGINT NOT NULL,                          -- 时间戳（毫秒）
    xiaomi_pushed TINYINT(1) DEFAULT 0,                 -- 是否已推送至小米：0=否, 1=是
    xiaomi_push_time TIMESTAMP,                         -- 小米推送时间
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,     -- 创建时间
    
    INDEX idx_user_id (user_id),                        -- 用户ID索引
    INDEX idx_timestamp (timestamp DESC),               -- 时间戳索引（降序）
    CONSTRAINT fk_weight_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 初始化默认配置
-- ============================================================================
INSERT INTO systemconfig (`key`, value, is_encrypted, updated_at)
VALUES 
    ('app_version', '0.3.0', 0, UNIX_TIMESTAMP() * 1000),
    ('initialized', 'false', 0, UNIX_TIMESTAMP() * 1000)
ON DUPLICATE KEY UPDATE value = VALUES(value);
