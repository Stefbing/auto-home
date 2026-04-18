import pymysql

conn = pymysql.connect(
    host='rm-bp1dm2990215o3n4kko.mysql.rds.aliyuncs.com',
    port=3306,
    user='stef',
    password='&YLQW84TFdX&uat',
    database='auto_home'
)

cursor = conn.cursor()

# 删除旧表
cursor.execute('DROP TABLE IF EXISTS weightrecord')
cursor.execute('DROP TABLE IF EXISTS systemconfig')
cursor.execute('DROP TABLE IF EXISTS user')

# 创建用户表
cursor.execute('''
CREATE TABLE user (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    nickname VARCHAR(100),
    gender VARCHAR(10) DEFAULT 'male',
    age INT DEFAULT 25,
    height INT DEFAULT 175,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
''')

# 创建配置表
cursor.execute('''
CREATE TABLE systemconfig (
    `key` VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    is_encrypted TINYINT(1) NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
''')

# 创建体重记录表
cursor.execute('''
CREATE TABLE weightrecord (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    weight DECIMAL(5,2) NOT NULL,
    impedance INT,
    bmi DECIMAL(5,2),
    body_fat DECIMAL(5,2),
    muscle DECIMAL(5,2),
    water DECIMAL(5,2),
    visceral_fat DECIMAL(5,2),
    bone_mass DECIMAL(5,2),
    bmr DECIMAL(8,2),
    timestamp BIGINT NOT NULL,
    xiaomi_pushed TINYINT(1) DEFAULT 0,
    xiaomi_push_time TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_timestamp (timestamp DESC),
    CONSTRAINT fk_weight_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
''')

conn.commit()
print('✅ All tables created successfully with AUTO_INCREMENT!')

# 验证
cursor.execute('SHOW CREATE TABLE user')
result = cursor.fetchone()
print('\nUser table structure:')
print(result[1])

cursor.close()
conn.close()
