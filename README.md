# AutoHome 智能家居控制中心

AutoHome 是一个轻量级的家庭智能设备聚合控制平台，旨在通过一个统一的入口管理不同品牌的智能设备。目前支持 PetKit（小佩）智能猫厕所、CloudPets（云宠）智能喂食器以及小米体脂秤（通过小程序直连）。

## 🌟 功能特性

### 1. 智能猫厕所 (PetKit)
*   **状态监控**: 实时查看设备在线状态。
*   **远程控制**: 支持手动触发清理、除臭操作。
*   **多设备支持**: 自动发现账号下的所有兼容设备（如 MAX2 等）。

### 2. 智能喂食器 (CloudPets)
*   **喂食计划**: 查看、添加、修改、删除定时喂食计划。
*   **手动喂食**: 支持远程手动出粮。
*   **数据统计**: 查看今日已出粮份数统计。

### 3. 健康监测 (小米体脂秤)
*   **直连模式**: 小程序直接通过蓝牙连接小米体脂秤，无需后端中转，响应更快。
*   **数据分析**: 自动计算 BMI、体脂率、肌肉量、水分、内脏脂肪等级、骨量及基础代谢率 (BMR)。
*   **历史记录**: 后端存储并展示近期体重记录趋势。

## 🛠️ 技术栈

*   **后端**: Python (FastAPI, SQLModel, Uvicorn)
*   **前端**: 微信小程序 (原生开发)
*   **数据库**: SQLite (轻量级，零配置)

## 🚀 部署说明

### Vercel 一键部署 (Serverless)

本项目已适配 Vercel Serverless 环境，推荐使用 Vercel 进行部署。

1.  **准备数据库**:
    *   在 Vercel 项目控制台中，点击 "Storage" -> "Create Database" -> "Postgres"。
    *   创建完成后，将自动生成的环境变量（`POSTGRES_URL` 等）关联到你的项目。
    *   **注意**: Serverless 环境不支持 SQLite 持久化，必须使用 Postgres。

2.  **配置环境变量**:
    在 Vercel 项目设置中 (Settings -> Environment Variables)，添加以下变量：
    *   `PETKIT_USERNAME`
    *   `PETKIT_PASSWORD`
    *   `CLOUDPETS_TOKEN`
    *   `CLOUDPETS_FAMILY_ID`
    *   `CLOUDPETS_DEVICE_ID`

3.  **推送代码**:
    将代码推送到 GitHub，Vercel 会自动检测并开始构建。
    *   入口文件: `api/index.py` (已配置)
    *   配置文件: `vercel.json` (已配置)
    *   依赖文件: `backend/requirements.txt` (已包含 psycopg2-binary)

### 本地开发 (Localhost)

1.  **环境准备**
    *   Python 3.8+
*   微信开发者工具

### 2. 后端部署

1.  **安装依赖**:
    ```bash
    cd backend
    pip install -r requirements.txt
    ```

2.  **配置环境变量**:
    `.env` 并填入你的设备账号信息：
    *   `PETKIT_USERNAME` / `PETKIT_PASSWORD`: 小佩账号密码
    *   `CLOUDPETS_TOKEN`: 云宠 API Token (需抓包获取)
    *   `CLOUDPETS_DEVICE_ID`: 云宠设备 ID

3.  **启动服务**:
    ```bash
    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
    ```
    启动后访问 `http://localhost:8000` 可查看 API 文档或测试页面。

### 3. 小程序运行

1.  **打开项目**: 使用微信开发者工具导入 `miniprogram` 目录。
2.  **配置 API 地址**:
    打开 `miniprogram/app.js`，修改 `apiBaseUrl`:
    ```javascript
    globalData: {
      // 本地调试填本机IP，真机调试需内网穿透或局域网IP
      apiBaseUrl: "http://localhost:8000" 
    }
    ```
3.  **编译运行**: 点击开发者工具的“编译”即可预览。

## 📁 目录结构

*   `backend/`: FastAPI 后端服务
    *   `app/`: 核心代码
        *   `services/`: 设备服务逻辑 (PetKit, CloudPets)
        *   `models/`: 数据库模型
        *   `main.py`: 入口文件与路由
    *   `static/`: 简单的 Web 控制台页面
*   `miniprogram/`: 微信小程序源码
    *   `pages/`: 页面 (Feeder, Litterbox, Scale, Index)
    *   `utils/`: 工具类 (蓝牙解析等)

## 📝 注意事项

*   **蓝牙功能**: 小米体脂秤功能依赖手机蓝牙，请在小程序中授权蓝牙权限。
*   **Token 有效期**: CloudPets 的 Token 可能会过期，如发现控制失效，请重新抓包更新 `.env` 中的 Token。
