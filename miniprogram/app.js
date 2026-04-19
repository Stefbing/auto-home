const cloudRequest = require('./utils/cloud_request.js');

App({
  globalData: {
    // 当前环境标识
    environment: "development" // development | production
  },
  onLaunch() {
    // 应用启动初始化
    console.log('AutoHome 小程序启动');
    
    // 初始化云开发
    cloudRequest.initCloud();
    console.log('云开发已初始化');

    // 检查网络连接
    wx.getNetworkType({
      success: (res) => {
        console.log('网络类型:', res.networkType);
      }
    });
  }
})
