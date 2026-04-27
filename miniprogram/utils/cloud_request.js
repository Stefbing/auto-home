/**
 * 通用请求封装 - 支持云开发和本地调试
 */

// 配置：切换运行环境
const CONFIG = {
  // 'cloud' - 云托管模式, 'local' - 本地调试模式
  mode: 'cloud',

  // 云托管配置
  cloudEnv: 'prod-d5g0so0137afcfdd5',
  cloudService: 'auto-home',

  // 本地调试配置（替换为你的本地后端地址）
  localBaseUrl: 'http://192.168.1.4:8000'
};

let isCloudInitialized = false;

// 初始化云开发环境 (建议在 app.js 的 onLaunch 中也调一次)
function initCloud() {
  if (isCloudInitialized) return true;
  if (!wx.cloud) {
    console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    return false;
  }

  wx.cloud.init({
    env: CONFIG.cloudEnv,
    traceUser: true,
  });

  isCloudInitialized = true;
  return true;
}

/**
 * 统一请求封装 - 自动根据模式选择请求方式
 */
function callContainer(options) {
  const { path, method = 'GET', data = {}, header = {}, success, fail } = options;

  // 自动从本地缓存获取 Token
  const token = wx.getStorageSync('token');
  const authHeader = token ? { 'Authorization': `Bearer ${token}` } : {};

  // 根据模式选择请求方式
  if (CONFIG.mode === 'local') {
    return localRequest(path, method, data, { ...authHeader, ...header }, success, fail);
  } else {
    return cloudRequest(path, method, data, { ...authHeader, ...header }, success, fail);
  }
}

/**
 * 本地调试请求
 */
function localRequest(path, method, data, header, success, fail) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${CONFIG.localBaseUrl}${path}`,
      method: method,
      header: {
        'Content-Type': 'application/json',
        ...header
      },
      data: data,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const result = res.data;
          if (success) success(result);
          resolve(result);
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
        console.error('本地请求异常:', err);
        if (fail) fail(err);
        reject(err);
      }
    });
  });
}

/**
 * 云托管请求
 */
function cloudRequest(path, method, data, header, success, fail) {
  if (!initCloud()) {
    const error = new Error('云开发初始化失败');
    if (fail) fail(error);
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      config: {
        env: CONFIG.cloudEnv
      },
      path: path,
      method: method,
      header: {
        'X-WX-SERVICE': CONFIG.cloudService,
        'Content-Type': 'application/json',
        ...header
      },
      data: data,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const result = res.data;
          if (success) success(result);
          resolve(result);
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
  initCloud,
  getConfig: () => CONFIG
};
