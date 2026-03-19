App({
  globalData: {
    // 开发环境配置 - 请根据实际情况修改
    // 方案1: 局域网访问（手机和电脑同一网络）
    // apiBaseUrl: "http://192.168.1.100:8000", // 替换为你的电脑IP
    
    // 方案2: 内网穿透服务（如ngrok、frp等）
    // apiBaseUrl: "https://your-ngrok-url.ngrok.io",
    
    // 方案3: 本地开发（仅模拟器可用）
    apiBaseUrl: "http://localhost:8000",
    
    // 当前环境标识
    environment: "development" // development | production
  },
  onLaunch() {
    // 应用启动初始化
    console.log('AutoHome 小程序启动');
    console.log('API基础地址:', this.globalData.apiBaseUrl);
    
    // 检查网络连接
    wx.getNetworkType({
      success: (res) => {
        console.log('网络类型:', res.networkType);
      }
    });
  }
})
