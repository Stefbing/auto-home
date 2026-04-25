-- 修复所有表的时间字段类型
-- 统一将 TIMESTAMP 改为 BIGINT（毫秒级时间戳）

-- 1. 修复 user 表
ALTER TABLE user 
MODIFY COLUMN created_at BIGINT NOT NULL DEFAULT 0,
MODIFY COLUMN updated_at BIGINT NOT NULL DEFAULT 0;

-- 2. 修复 systemconfig 表
ALTER TABLE systemconfig 
MODIFY COLUMN updated_at BIGINT NOT NULL;

-- 3. 修复 weightrecord 表
ALTER TABLE weightrecord 
MODIFY COLUMN xiaomi_push_time BIGINT,
MODIFY COLUMN created_at BIGINT NOT NULL DEFAULT 0;

-- 验证修改
DESCRIBE user;
DESCRIBE systemconfig;
DESCRIBE weightrecord;
