# 智能家居控制系统架构设计文档

## 1. 项目概述
本项目旨在开发一套家庭内网智能设备控制系统，通过微信小程序或网页作为前端入口，配合部署在公网的后端服务，实现对家庭内网特定智能设备的控制与数据管理。

### 1.1 核心需求
- **远程控制**：通过微信小程序或网页在任何网络环境下控制家中设备。
- **设备接入**：
  - **PetKit 猫厕所 MAX2**：清理、设备数据查看。
  - **云宠智能 智能喂食机**：(暂无官方API，需抓包) 投喂、氛围灯、喂食计划。
  - **小米体脂秤 2**：蓝牙近场同步、多用户数据管理。
- **扩展性**：未来接入摄像机、空调等设备。

## 2. 系统架构

### 2.1 总体架构图
```mermaid
graph TD
    User[用户 (微信小程序)] -->|HTTPS| Tunnel[内网穿透服务 (FRP/Cloudflare)]
    Tunnel -->|反向代理| Gateway[内网网关 (Python/FastAPI)]
    
    subgraph Home_Network [家庭内网]
        Gateway -->|HTTP/API (pypetkitapi)| PetKit_Cloud[PetKit 云端 API]
        Gateway -->|私有协议 (待实现)| PetWant_Device[PetWant 喂食机]
        
        User -.->|BLE 蓝牙| Xiaomi_Scale[小米体脂秤 2]
        User -.->|数据上传| Gateway
        
        Gateway -->|读写| DB[(SQLite 数据库)]
    end
    
    PetKit_Cloud -->|控制指令| Real_PetKit_Device[PetKit 设备]
```

### 2.2 技术栈选型

#### 2.2.1 后端服务 (Home Server)
- **语言**: Python 3.10+
- **框架**: FastAPI
- **依赖库**:
  - `pypetkitapi`: 用于对接小佩设备 (社区开源库)。
  - `sqlmodel`: 数据持久化。
- **部署**: Docker 或直接运行在 PC/树莓派/NAS 上。

#### 2.2.2 前端 (微信小程序)
- **框架**: 微信原生小程序。
- **功能**:
  - PetKit: 查看状态、一键清理。
  - PetWant: (待抓包后实现) 投喂控制。
  - Scale: 蓝牙连接小米体脂秤。

#### 2.2.3 内网穿透
- **推荐**: Cloudflare Tunnel (无需公网 IP)。

## 3. 模块详细设计

### 3.1 数据库设计 (SQLite)
- **Users**: 存储家庭成员信息。
- **WeightRecords**: 存储体重记录。
- **FeedingSchedules**: 缓存喂食计划。

### 3.2 接口设计 (API)

| 模块 | 方法 | 路径 | 描述 |
| --- | --- | --- | --- |
| **PetKit** | POST | `/api/petkit/clean` | 立即清理猫厕所 |
| | GET | `/api/petkit/devices` | 获取设备列表与状态 |
| **PetWant** | POST | `/api/petwant/feed` | (需抓包) 手动投喂 |
| **Scale** | POST | `/api/scale/record` | 上传体脂秤数据 |
| | GET | `/api/users` | 获取用户列表 |

### 3.3 设备接入方案详情

#### A. 小佩 (PetKit)
- **方案**: 使用 Python `pypetkitapi` 库。
- **鉴权**: 使用账号密码登录 (建议使用家庭共享的次账号)。
- **注意**: 库基于逆向协议，可能随官方更新失效。

#### B. 云宠智能 (PetWant)
- **现状**: 无公开 API。
- **行动**: 需要使用 Android 抓包工具 (HttpCanary) 抓取 App 操作 (投喂、开灯) 的请求，导出 .pcap 文件进行分析。

#### C. 小米体脂秤 2
- **方案**: 小程序直接连接蓝牙广播。
