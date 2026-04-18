App({
  globalData: {
    // API 基础地址配置
    // 真机调试需要使用电脑IP或内网穿透地址
    // apiBaseUrl: "http://192.168.1.4:8002",

    apiBaseUrl: "https://auto-home-three.vercel.app",

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
