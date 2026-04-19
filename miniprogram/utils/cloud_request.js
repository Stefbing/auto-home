/**
 * 微信云托管请求封装
 */

// 初始化云开发环境
function initCloud() {
  if (!wx.cloud) {
    console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    return false;
  }
  
  wx.cloud.init({
    env: 'vrrwaeoq', // 云托管环境ID
    traceUser: true,
  });
  
  return true;
}

/**
 * 云托管请求封装
 * @param {Object} options - 请求配置
 * @param {string} options.path - API路径（如：/api/auth/login）
 * @param {string} [options.method='GET'] - 请求方法
 * @param {Object} [options.data] - 请求数据
 * @param {Object} [options.header] - 请求头
 * @returns {Promise}
 */
function callContainer(options) {
  const { path, method = 'GET', data = {}, header = {} } = options;
  
  return new Promise((resolve, reject) => {
    // 确保云开发已初始化
    if (!initCloud()) {
      reject(new Error('云开发初始化失败'));
      return;
    }
    
    wx.cloud.callContainer({
      config: {
        env: 'vrrwaeoq' // 云托管环境ID
      },
      path: path,
      method: method,
      header: {
        'X-WX-SERVICE': 'auto-home', // 服务名称
        'Content-Type': 'application/json',
        ...header
      },
      data: data,
      success: (res) => {
        resolve(res);
      },
      fail: (err) => {
        console.error('云托管请求失败:', err);
        reject(err);
      }
    });
  });
}

module.exports = {
  callContainer,
  initCloud
};
