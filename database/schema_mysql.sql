-- AutoHome 智能家居系统数据库架构（MySQL 精简版）
-- MySQL 8.0+ 兼容版本
-- 创建日期：2026-04-17
-- 说明：精简表结构，仅保留核心业务数据

-- ============================================================================
-- 1. 用户表
-- ============================================================================
CREATE TABLE IF NOT EXISTS user (
    id INT AUTO_INCREMENT PRIMARY KEY,                  -- 自增主键
    phone_number VARCHAR(20) UNIQUE NOT NULL,          -- 手机号（唯一标识）
    nickname VARCHAR(100),                              -- 昵称
    gender VARCHAR(10) DEFAULT 'male',                  -- 性别：male/female
    age INT DEFAULT 25,                                 -- 年龄
    height INT DEFAULT 175,                             -- 身高（cm）
    created_at BIGINT NOT NULL,                         -- 创建时间戳（毫秒）
    updated_at BIGINT NOT NULL,                         -- 更新时间戳（毫秒）
    
    INDEX idx_phone (phone_number)                      -- 手机号索引：加速登录查询
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- 2. 系统配置表（加密存储敏感信息，支持多用户多设备）
-- ============================================================================
CREATE TABLE IF NOT EXISTS systemconfig (
    id INT AUTO_INCREMENT PRIMARY KEY,                  -- 自增主键
    user_id INT NOT NULL DEFAULT 0,                     -- 关联用户ID（0表示全局配置）
    `key` VARCHAR(50) NOT NULL,                         -- 配置键名（如：account, password, app_version）
    value VARCHAR(500) NOT NULL,                        -- 配置值（加密或明文，限制长度提升性能）
    platform VARCHAR(50) DEFAULT NULL,                  -- 平台：petkit/xiaomi/cloudpets（设备配置专用）
    device_name VARCHAR(100) DEFAULT NULL,              -- 设备名称（设备配置专用）
    is_encrypted TINYINT(1) NOT NULL DEFAULT 0,         -- 是否加密：0=明文, 1=加密
    is_active TINYINT(1) NOT NULL DEFAULT 1,            -- 是否激活：0=已删除, 1=正常
    updated_at BIGINT NOT NULL,                         -- 更新时间戳（毫秒）

    UNIQUE KEY uk_user_key_platform_device (user_id, `key`, platform, device_name), -- 唯一约束：同一配置只能有一个
    INDEX idx_user_active (user_id, is_active),         -- 联合索引：加速查询用户的活跃配置
    INDEX idx_user_platform_active (user_id, platform, is_active) -- 复合索引：优化设备查询
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统配置表（支持多用户多设备，user_id=0为全局配置）';

-- ============================================================================
-- 3. 家庭成员表（支持多用户管理多个私有家庭成员，用于体脂计算）
-- ============================================================================
CREATE TABLE IF NOT EXISTS family_member (
    id INT AUTO_INCREMENT PRIMARY KEY,                  -- 自增主键
    user_id INT NOT NULL,                               -- 关联用户ID（私有成员归属的用户）
    name VARCHAR(50) NOT NULL,                          -- 成员姓名
    gender VARCHAR(10) DEFAULT '',                      -- 性别：male/female/other
    age INT DEFAULT 0,                                  -- 年龄（体脂计算必需）
    height DECIMAL(5,2) DEFAULT 0,                      -- 身高cm（体脂计算必需）
    avatar_color VARCHAR(100) DEFAULT '',               -- 头像渐变颜色
    relationship VARCHAR(20) DEFAULT '',                -- 关系：self/spouse/child/parent/other
    sort_order INT DEFAULT 0,                           -- 排序顺序
    is_active TINYINT(1) NOT NULL DEFAULT 1,            -- 是否激活：0=禁用, 1=启用
    created_at BIGINT NOT NULL,                         -- 创建时间戳（毫秒）
    updated_at BIGINT NOT NULL,                         -- 更新时间戳（毫秒）

    INDEX idx_user_sort (user_id, sort_order),          -- 联合索引：加速查询用户的成员列表
    INDEX idx_user_active (user_id, is_active)          -- 联合索引：加速查询用户的活跃成员
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='家庭成员表（私有成员，仅归属用户可见，用于体脂计算）';

-- ============================================================================
-- 4. 体重记录表
-- ============================================================================
CREATE TABLE IF NOT EXISTS weightrecord (
    id INT AUTO_INCREMENT PRIMARY KEY,                  -- 自增主键
    user_id INT NOT NULL,                               -- 关联用户ID（数据归属用户）
    member_id INT NOT NULL,                             -- 关联家庭成员ID（体脂计算使用的成员）
    weight DECIMAL(5,2) NOT NULL,                       -- 体重（kg），最大 999.99
    impedance INT,                                      -- 阻抗值
    bmi DECIMAL(5,2),                                   -- BMI
    body_fat DECIMAL(5,2),                              -- 体脂率（%）
    muscle DECIMAL(5,2),                                -- 肌肉量（kg）
    water DECIMAL(5,2),                                 -- 水分（%）
    protein DECIMAL(5,2),                               -- 蛋白质率（%）
    visceral_fat DECIMAL(5,2),                          -- 内脏脂肪等级
    bone_mass DECIMAL(5,2),                             -- 骨量（kg）
    bmr DECIMAL(8,2),                                   -- 基础代谢（kcal）
    timestamp BIGINT NOT NULL,                          -- 记录时间戳（毫秒）
    xiaomi_pushed TINYINT(1) DEFAULT 0,                 -- 是否已推送至小米：0=否, 1=是
    xiaomi_push_time BIGINT,                            -- 小米推送时间戳（毫秒）
    created_at BIGINT NOT NULL,                         -- 创建时间戳（毫秒）

    INDEX idx_user_timestamp (user_id, timestamp DESC), -- 联合索引：加速查询用户最新记录
    INDEX idx_member_timestamp (member_id, timestamp DESC), -- 联合索引：加速查询成员历史记录
    INDEX idx_xiaomi_pending (xiaomi_pushed, timestamp) -- 联合索引：加速查询待推送记录
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='体重记录表（关联私有家庭成员，用于体脂趋势分析）';

-- ============================================================================
-- 初始化默认全局配置
-- 注意：由于唯一约束包含 is_active，插入时需指定 is_active=1
-- ============================================================================
INSERT INTO systemconfig (user_id, `key`, value, is_encrypted, is_active, updated_at)
VALUES
    (0, 'app_version', '0.5.0', 0, 1, UNIX_TIMESTAMP() * 1000),
    (0, 'PETKIT_DISABLE_SSL_VERIFY', 'false', 0, 1, UNIX_TIMESTAMP() * 1000)
    ON DUPLICATE KEY UPDATE value = VALUES(value);
