import os
import sys

# 将 backend 目录加入 Python 路径，以便能导入 app
# Vercel 的根目录是 /var/task，我们需要把 backend 加入路径
sys.path.append(os.path.join(os.path.dirname(__file__), '../backend'))

from app.main import app

# Vercel Serverless Function 需要暴露一个名为 app 的变量
# FastAPI 实例名为 app，这里直接暴露即可
