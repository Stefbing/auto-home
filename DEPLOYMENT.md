# Auto Home - 智能家居管理系统

## 部署到 Vercel

### 环境变量配置

为了使 PetKit 功能正常工作，需要在 Vercel 项目中设置以下环境变量：

1. 登录 Vercel 控制台
2. 进入你的项目设置
3. 在 "Environment Variables" 部分添加：

```
PETKIT_USERNAME=你的PetKit账号手机号
PETKIT_PASSWORD=你的PetKit密码
DATABASE_URL=你的数据库连接URL
```

或者使用原有的环境变量名称：
```
ACCOUNT=你的PetKit账号手机号
PASSWORD=你的PetKit密码
DATABASE_URL=你的数据库连接URL
```

### 本地开发

在本地开发时，在项目根目录创建 `.env` 文件：

```env
PETKIT_USERNAME=你的PetKit账号手机号
PETKIT_PASSWORD=你的PetKit密码
DATABASE_URL=sqlite:///./test.db
```

### 功能特性

- ✅ PetKit 猫厕所设备控制
- ✅ 准确的今日统计数据（如厕次数、猫咪体重等）
- ✅ 云宠智能喂食机控制
- ✅ 蓝牙体脂秤数据记录
- ✅ 响应式移动端界面

### API 端点

- `GET /api/petkit/devices` - 获取设备列表
- `GET /api/petkit/stats` - 获取今日准确统计数据
- `POST /api/petkit/clean` - 触发清理
- `POST /api/petkit/deodorize` - 触发除臭
- `GET /api/cloudpets/servings_today` - 获取今日喂食次数
- `GET /api/cloudpets/plans` - 获取喂食计划

### 注意事项

如果遇到 "PetKit service not initialized or credentials missing" 错误，请检查：
1. 环境变量是否正确设置
2. 账号密码是否正确
3. 网络连接是否正常