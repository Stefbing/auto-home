App({
  globalData: {
    // 这里填入你的内网穿透地址，例如 http://your-frp-domain.com
    // 开发时如果手机和电脑在同一局域网，可以填 http://电脑IP:8000
    apiBaseUrl: "http://localhost:8000" 
  },
  onLaunch() {
    // 应用启动初始化
  }
})
