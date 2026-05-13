# AutoHome 智能家居控制中心

AutoHome 是一个轻量级的家庭智能设备聚合控制平台，旨在通过一个统一的入口管理不同品牌的智能设备。目前支持 PetKit（小佩）猫厕所、CloudPets（云宠）智能喂食器以及小米体脂秤（通过小程序直连）。

## 🌟 功能特性

### 1. 猫厕所 (PetKit)
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
*   **数据库**: MySQL 8.0+
*   **部署**: Vercel Serverless / 本地服务器

## 🚀 快速开始

### 1. 本地开发 (Local Development)

#### 环境准备
*   Python 3.9+
*   uv (推荐使用 uv 管理 Python 环境和依赖)
*   Node.js v18+ (用于 Vercel CLI)
*   微信开发者工具

#### 步骤 1: 安装 uv（如果未安装）
```bash
# Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iwr"

# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

#### 步骤 2: 安装依赖
```bash
# 使用 uv 安装依赖（推荐）
uv pip install -r requirements.txt

# 或使用传统方式
pip install -r requirements.txt
```

#### 步骤 3: 数据库配置

**本地开发**：默认使用硬编码的数据库连接（已在代码中配置）

**生产部署**：在 Vercel/服务器环境变量中设置 `DATABASE_URL`
```
DATABASE_URL=mysql+pymysql://user:password@host:3306/database
```

**注意**：
- 账号密码通过小程序首次登录后自动保存到数据库
- 所有配置项存储在数据库 `systemconfig` 表中

#### 步骤 4: 启动后端服务

**方式 A：使用 uv（推荐）**
```bash
uv run uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

**方式 B：传统方式**
```bash
cd backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

启动成功后会看到：
```
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
INFO:backend.app.services.cloudpets_service:Initializing CloudPets Service...
INFO:backend.app.services.petkit_service:Initializing PetKit Service...
PetKit 服务连接成功
INFO:     Application startup complete.
```

访问 `http://localhost:8000/docs` 查看 API 文档。

#### 步骤 5: 启动小程序
1.  使用微信开发者工具导入 `miniprogram` 目录
2.  修改 `miniprogram/app.js` 中的 `apiBaseUrl`:
    ```javascript
    globalData: {
      apiBaseUrl: "http://localhost:8000",  // 或你的服务器地址
      environment: "development" // development | production
    }
    ```
3.  点击“编译”即可预览

**测试连接**：
- 访问 http://localhost:8000/api/dashboard/data 查看设备数据
- 访问 http://localhost:8000/api/petkit/devices-stats 查看猫厕所状态

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
3.  配置环境变量 (`ACCOUNT`, `PASSWORD`, `DATABASE_URL` 等)。
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

### 启动相关

**Q: SSL 证书验证失败？**
```
[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed
```
**解决**：在 `.env` 中添加或修改：
```ini
PETKIT_DISABLE_SSL_VERIFY=true
```
*注意：这仅适用于开发环境，生产环境应修复 SSL 证书*

**Q: 数据库连接失败？**
```
Can't connect to MySQL server
```
**解决**：
1. 检查 MySQL 服务是否运行
2. 确认 DATABASE_URL 配置正确
3. 检查防火墙/安全组配置（云数据库需开放 3306 端口）

**Q: integer out of range 错误？**
```
(psycopg2.errors.NumericValueOutOfRange) integer out of range
```
**解决**：这是时间戳字段溢出问题，已在代码中修复。如仍有此错误，执行以下 SQL：
```sql
UPDATE systemconfig SET updated_at = updated_at / 1000 WHERE updated_at > 10000000000;
```

### 功能相关

*   **喂食计划修改后未刷新？**
    *   前端已实现乐观更新 + 强制刷新机制。如仍有问题，请检查网络连接。
*   **PetKit 今日如厕次数显示不准确？**
    *   已修复！现在系统会优先从官方统计接口获取真实的今日数据，如果接口不可用则会给出明确提示。
*   **CloudPets 控制失败 (401)？**
    *   后端会自动尝试重新登录并更新 Token。如果持续失败，请检查账号密码是否正确。
*   **Vercel 部署报错 "Read-only file system"？**
    *   这是因为 Serverless 环境不支持写入本地文件。本项目已配置在 Vercel 环境下使用 MySQL 数据库。

### 网络相关

**Q: PetKit API 连接失败？**
```
Cannot connect to host api.petkit.cn:443
```
**解决**：
1. 检查网络连接是否正常
2. 可能是 PetKit 服务器暂时不可用
3. 系统会自动重试，稍后再试即可

## 📝 维护者
*   User & Trae (AI Assistant)
