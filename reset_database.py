"""
数据库重置脚本 - 清空所有表并重新创建
警告：此操作将删除所有数据！
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import text
from backend.app.models.db import engine
from backend.app.models.models import SQLModel

def reset_database():
    """重置数据库：删除所有表并重新创建"""
    print("⚠️  警告：即将清空数据库所有数据！")
    confirm = input("确认继续？(yes/no): ")
    
    if confirm.lower() != 'yes':
        print("❌ 操作已取消")
        return
    
    print("\n开始重置数据库...")
    
    with engine.connect() as conn:
        # 1. 禁用外键检查（MySQL）
        conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
        
        # 2. 获取所有表名
        result = conn.execute(text("SHOW TABLES"))
        tables = [row[0] for row in result.fetchall()]
        
        if not tables:
            print("✓ 数据库为空，无需清理")
        else:
            print(f"📋 发现 {len(tables)} 个表：{', '.join(tables)}")
            
            # 3. 删除所有表
            for table in tables:
                print(f"  🗑️  删除表: {table}")
                conn.execute(text(f"DROP TABLE IF EXISTS `{table}`"))
            
            conn.commit()
            print("✓ 所有表已删除")
        
        # 4. 重新创建表结构
        print("\n🔨 重新创建表结构...")
        SQLModel.metadata.create_all(engine)
        print("✓ 表结构创建完成")
        
        # 5. 启用外键检查
        conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
        conn.commit()
        
        # 6. 验证
        result = conn.execute(text("SHOW TABLES"))
        new_tables = [row[0] for row in result.fetchall()]
        print(f"\n✅ 数据库重置完成！当前表：{', '.join(new_tables)}")

if __name__ == "__main__":
    try:
        reset_database()
    except Exception as e:
        print(f"\n❌ 重置失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
