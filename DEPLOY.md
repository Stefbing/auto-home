# AutoHome 部署与运行指南

本文档涵盖了 AutoHome 项目的本地开发准备和 Vercel 远程部署的完整流程。

## 1. 部署前准备 (Prerequisites)

### Vercel 要求
*   **技术栈**: Python (FastAPI) + Miniprogram
*   **Python 版本**: Vercel 支持 3.9, 3.10, 3.11, 3.12。本项目推荐使用 **3.12**。
*   **项目结构**: 需要根目录的 `api/index.py` 作为入口（已配置）。
*   **数据库**: Serverless 环境不支持 SQLite 持久化，**必须**使用 Vercel Postgres 或其他云数据库。

### 本地环境检查
确保您的本地环境满足以下要求：
*   **Node.js**: v18+ (用于安装 Vercel CLI)
*   **Python**: v3.9+ (本地开发)
*   **Git**: 用于版本控制和触发部署
*   **配置文件**:
    *   `vercel.json`: 已存在，配置了 Python 路由重写。
    *   `requirements.txt`: 已存在，包含后端依赖。
    *   `pyproject.toml`: 已存在，用于 Vercel Python 构建。

## 2. 本地开发流程 (Local Development)

### 步骤 1: 安装依赖
在项目根目录运行：
```bash
pip install -r requirements.txt
```

### 步骤 2: 配置环境变量
复制 `.env.example` 为 `.env` 并填入您的凭证：
```ini
PETKIT_USERNAME=your_username
PETKIT_PASSWORD=your_password
CLOUDPETS_TOKEN=your_token
```

### 步骤 3: 启动后端服务
```bash
# 进入后端目录
cd backend
# 启动服务
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```
启动成功后，访问 `http://localhost:8000/api/petkit/debug` 验证服务是否正常。

### 步骤 4: 启动小程序
使用微信开发者工具导入 `miniprogram` 目录，修改 `app.js` 中的 `apiBaseUrl` 为 `http://localhost:8000`。

## 3. Vercel 远程部署流程 (Deployment)

### 方法 A: Vercel CLI 部署 (推荐用于测试)

1.  **安装 Vercel CLI**:
    ```bash
    npm install -g vercel
    ```

2.  **登录**:
    ```bash
    vercel login
    ```
    (按照提示在浏览器中完成授权)

3.  **部署**:
    在项目根目录运行：
    ```bash
    vercel
    ```
    *   `Set up and deploy?` -> **Y**
    *   `Which scope?` -> 选择您的账号
    *   `Link to existing project?` -> **N**
    *   `Project name?` -> **auto-home**
    *   `Directory?` -> **./** (默认)

4.  **配置环境变量**:
    部署过程中或完成后，在 Vercel 控制台的 `Settings` -> `Environment Variables` 中添加：
    *   `PETKIT_USERNAME`
    *   `PETKIT_PASSWORD`
    *   `CLOUDPETS_TOKEN`
    *   `CLOUDPETS_FAMILY_ID`
    *   `CLOUDPETS_DEVICE_ID`
    *   `POSTGRES_URL` (如果在 Vercel 创建了数据库)

### 方法 B: Git 自动部署 (推荐用于生产)

1.  **推送代码**: 将本地代码推送到 GitHub/GitLab。
2.  **导入项目**: 在 Vercel 控制台点击 "Add New..." -> "Project" -> "Import Git Repository"。
3.  **配置项目**:
    *   **Framework Preset**: 选择 **Other**。
    *   **Root Directory**: 保持默认 (`./`)。
    *   **Environment Variables**: 填入上述环境变量。
4.  **部署**: 点击 **Deploy**。

## 4. 验证与后续 (Verification)

### 部署验证
1.  **访问 URL**: Vercel 会提供一个 `*.vercel.app` 的域名。
2.  **API 测试**: 访问 `https://your-app.vercel.app/api/petkit/debug` 确认返回 JSON 数据。
3.  **小程序连接**: 将小程序 `app.js` 中的 `apiBaseUrl` 更新为您的 Vercel 域名 (必须是 HTTPS)。

### 持续集成 (CI/CD)
*   **自动部署**: 每次向 `main` 分支推送代码，Vercel 会自动触发构建和部署。
*   **预览环境**: 推送代码到非 `main` 分支（或提交 Pull Request）会触发预览部署，生成独立的测试 URL。

## 5. 常见问题 (Troubleshooting)

*   **500 Internal Server Error**: 检查 Vercel Logs (Functions 标签页)，通常是环境变量缺失或 Python 代码错误。
*   **Database Error**: 确认 `POSTGRES_URL` 已正确配置，且数据库允许外部连接。
*   **Timezone Warning**: 日志中的时区警告通常不影响核心功能，可忽略。
