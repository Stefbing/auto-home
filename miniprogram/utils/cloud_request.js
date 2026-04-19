/**
 * 微信云托管请求封装 - 优化版
 */

let isCloudInitialized = false;

// 初始化云开发环境 (建议在 app.js 的 onLaunch 中也调一次)
function initCloud() {
  if (isCloudInitialized) return true;
  if (!wx.cloud) {
    console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    return false;
  }

  wx.cloud.init({
    env: 'prod-2gv6fjaz6751c24a',
    traceUser: true,
  });

  isCloudInitialized = true;
  return true;
}

/**
 * 云托管请求封装
 */
function callContainer(options) {
  const { path, method = 'GET', data = {}, header = {}, success, fail } = options;

  if (!initCloud()) {
    const error = new Error('云开发初始化失败');
    if (fail) fail(error);
    return Promise.reject(error);
  }

  // 自动从本地缓存获取 Token
  const token = wx.getStorageSync('token');
  const authHeader = token ? { 'Authorization': `Bearer ${token}` } : {};

  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      config: {
        env: 'prod-2gv6fjaz6751c24a'
      },
      path: path,
      method: method,
      header: {
        'X-WX-SERVICE': 'home',
        'Content-Type': 'application/json',
        ...authHeader,
        ...header
      },
      data: data,
      success: (res) => {
        // 状态码拦截
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const result = res.data; // 直接返回业务数据
          if (success) success(result); // 兼容回调方式
          resolve(result); // Promise 方式
        } else if (res.statusCode === 401) {
          console.error('登录失效');
          if (fail) fail(res);
          reject(res);
        } else {
          if (fail) fail(res);
          reject(res);
        }
      },
      fail: (err) => {
        console.error('云托管请求异常:', err);
        if (fail) fail(err);
        reject(err);
      }
    });
  });
}

module.exports = {
  callContainer,
  initCloud
};
