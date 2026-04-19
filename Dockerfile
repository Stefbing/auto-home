# 使用轻量级的 Python 3.12 镜像
FROM python:3.12-slim

# 设置工作目录
WORKDIR /app

# 设置环境变量，确保 Python 输出直接打印到控制台
ENV PYTHONUNBUFFERED=1

# 安装系统依赖（如果你的项目需要编译一些 c 库，可以加上，FastAPI 通常不需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件并安装
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制项目代码
COPY . .

# 微信云托管默认监听 80 端口
EXPOSE 80

# 启动命令
# 注意：你需要确保你的 FastAPI 入口路径正确
# 按照你 repo 的结构，应该是 backend.app.main:app
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "80"]
