App({
  globalData: {
    // 这里填入你的内网穿透地址，例如 http://your-frp-domain.com
    // 开发时如果手机和电脑在同一局域网，可以填 http://电脑IP:8000
    apiBaseUrl: "http://192.168.1.X:8000" 
  },
  onLaunch() {
    console.log("App Launched");
  }
})
