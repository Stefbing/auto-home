# AutoHome 智能家居控制中心

AutoHome 是一个轻量级的家庭智能设备聚合控制平台，旨在通过一个统一的入口管理不同品牌的智能设备。目前支持 PetKit（小佩）智能猫厕所、CloudPets（云宠）智能喂食器以及小米体脂秤（通过小程序直连）。

## 🌟 功能特性

### 1. 智能猫厕所 (PetKit)
*   **状态监控**: 实时查看设备在线状态。
*   **远程控制**: 支持手动触发清理、除臭操作。
*   **准确统计**: 修复了今日如厕次数显示不准确的问题，现在完全使用 pypetkitapi 原生统计方法，确保数据准确性。
*   **多设备支持**: 自动发现账号下的所有兼容设备（如 MAX2 等）。

### 2. 智能喂食器 (CloudPets)
*   **喂食计划**: 查看、添加、修改、删除定时喂食计划，支持多时段、多份数设置。
*   **手动喂食**: 支持远程手动出粮。
*   **数据统计**: 查看今日已出粮份数统计。
*   **智能重连**: 自动处理 Token 过期问题 (401 错误自动重登)。

### 3. 健康监测 (小米体脂秤)
*   **直连模式**: 小程序直接通过蓝牙连接小米体脂秤，无需后端中转，响应更快。
*   **数据分析**: 自动计算 BMI、体脂率、肌肉量、水分、内脏脂肪等级、骨量及基础代谢率 (BMR)。
*   **历史记录**: 后端存储并展示近期体重记录趋势。

## 🛠️ 技术栈

*   **后端**: Python 3.12 (FastAPI, SQLModel, Uvicorn)
*   **前端**: 微信小程序 (原生开发)
*   **数据库**: 
    *   本地开发: SQLite (轻量级，零配置)
    *   Vercel 部署: Postgres (Serverless 适配)
*   **部署**: Vercel Serverless

## 🚀 快速开始

### 1. 本地开发 (Local Development)

#### 环境准备
*   Python 3.9+
*   Node.js v18+ (用于 Vercel CLI)
*   微信开发者工具

#### 步骤 1: 安装依赖
```bash
pip install -r requirements.txt
```

#### 步骤 2: 配置环境变量
在 `backend/.env` 文件中配置账号信息（系统已集成默认账号，如需修改请参考）：

```ini
# 统一账号配置 (必须配置)
ACCOUNT=your_username (例如 86-17757577548)
PASSWORD=your_password

# 选填：如果 CloudPets 账号与主账号不同
# CLOUDPETS_ACCOUNT=...
# CLOUDPETS_PASSWORD=...
```
*注意：CloudPets 服务会自动处理 `86-` 前缀。*

#### 步骤 3: 启动后端服务
```bash
cd backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```
访问 `http://localhost:8000` 查看服务状态。

#### 步骤 4: 启动小程序
1.  使用微信开发者工具导入 `miniprogram` 目录。
2.  修改 `miniprogram/app.js` 中的 `apiBaseUrl`:
    ```javascript
    globalData: {
      apiBaseUrl: "http://localhost:8000" 
    }
    ```
3.  点击“编译”即可预览。

### 2. Vercel 远程部署 (Deployment)

本项目已针对 Vercel Serverless 环境进行优化。

#### 方法 A: Vercel CLI (推荐测试)
1.  安装 CLI: `npm install -g vercel`
2.  登录: `vercel login`
3.  部署: 在根目录运行 `vercel`，一路回车即可。
4.  配置环境变量: 在 Vercel 控制台添加 `ACCOUNT` 和 `PASSWORD`。

#### 方法 B: Git 自动部署 (推荐生产)
1.  将代码推送到 GitHub。
2.  在 Vercel 控制台导入项目。
3.  配置环境变量 (`ACCOUNT`, `PASSWORD`, `POSTGRES_URL` 等)。
4.  点击 Deploy。

## 📁 目录结构

*   `backend/`: FastAPI 后端服务
    *   `app/`: 核心代码
        *   `services/`: 设备服务逻辑 (PetKit, CloudPets)
        *   `models/`: 数据库模型
        *   `main.py`: 入口文件与路由
    *   `static/`: 简单的 Web 控制台页面
*   `miniprogram/`: 微信小程序源码
*   `api/`: Vercel Serverless 入口

## ❓ 常见问题 (FAQ)

*   **喂食计划修改后未刷新？**
    *   前端已实现乐观更新 + 强制刷新机制。如仍有问题，请检查网络连接。
*   **PetKit 今日如厕次数显示不准确？**
    *   已修复！现在系统会优先从官方统计接口获取真实的今日数据，如果接口不可用则会给出明确提示。
*   **CloudPets 控制失败 (401)？**
    *   后端会自动尝试重新登录并更新 Token。如果持续失败，请检查账号密码是否正确。
*   **Vercel 部署报错 "Read-only file system"？**
    *   这是因为 Serverless 环境不支持写入本地 SQLite 文件。本项目已配置在 Vercel 环境下使用内存数据库或 Postgres。

## 📝 维护者
*   User & Trae (AI Assistant)
