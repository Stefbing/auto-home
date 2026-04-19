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
async function callContainer(options) {
  const { path, method = 'GET', data = {}, header = {} } = options;

  if (!initCloud()) {
    throw new Error('云开发初始化失败');
  }

  // 自动从本地缓存获取 Token（假设你的 FastAPI 使用 Bearer Token）
  const token = wx.getStorageSync('token');
  const authHeader = token ? { 'Authorization': `Bearer ${token}` } : {};

  try {
    const res = await wx.cloud.callContainer({
      config: {
        env: 'prod-2gv6fjaz6751c24a'
      },
      path: path,
      method: method,
      header: {
        'X-WX-SERVICE': 'auto-home',
        'Content-Type': 'application/json',
        ...authHeader, // 自动注入鉴权
        ...header
      },
      data: data,
    });

    // 状态码拦截：FastAPI 返回的非 2xx 状态码
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return res.data; // 直接返回业务数据
    } else if (res.statusCode === 401) {
      // 可以在这里处理自动跳转登录
      console.error('登录失效');
      throw res;
    } else {
      throw res;
    }
  } catch (err) {
    console.error('云托管请求异常:', err);
    throw err;
  }
}

module.exports = {
  callContainer,
  initCloud
};
