import pymysql

conn = pymysql.connect(
    host='rm-bp1dm2990215o3n4kko.mysql.rds.aliyuncs.com',
    port=3306,
    user='stef',
    password='&YLQW84TFdX&uat',
    database='auto_home'
)

cursor = conn.cursor()

# 清空数据
cursor.execute('DELETE FROM user')

# 插入测试数据
cursor.execute("INSERT INTO user (phone_number, nickname) VALUES ('17757577548', '测试用户')")
conn.commit()

# 获取最后插入的ID
cursor.execute('SELECT LAST_INSERT_ID()')
last_id = cursor.fetchone()[0]
print(f'Last inserted ID: {last_id}')

# 查询所有数据
cursor.execute('SELECT * FROM user')
rows = cursor.fetchall()
print(f'Total users: {len(rows)}')
for row in rows:
    print(f'  ID={row[0]}, Phone={row[1]}, Nickname={row[2]}')

cursor.close()
conn.close()
