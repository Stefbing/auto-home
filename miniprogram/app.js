const cloudRequest = require('./utils/cloud_request.js');
const BLEUtils = require('./utils/ble_scale.js');

// 配置常量
const CONFIG = {
  MIN_VALID_WEIGHT: 30,  // 最小有效体重 30kg
  MAX_WEIGHT: 200,       // 最大体重 200kg
  FRESHNESS_THRESHOLD: 10000  // 数据新鲜度阈值 10秒
};

App({
  globalData: {
    // 环境标识
    environment: "development",

    // 蓝牙状态（简化）
    bleAdapterInitialized: false,
    bluetoothInitializing: false,  // 防止并发初始化
    latestScaleData: null,
    scaleListeners: [],  // 订阅者列表
    scaleMembers: [],    // 预加载的成员数据
    lastJumpWeight: 0,   // 上次跳转时的体重
    scaleConnectionStatus: 'offline',  // 设备在线状态（基于RSSI）

    // 数据去重相关
    lastProcessedData: null,  // 上次处理的数据
    lastProcessedTimestamp: 0, // 上次处理的时间戳

    // 小米配置检查缓存
    xiaomiConfigChecked: false,
    hasXiaomiConfig: false,

    // Dashboard数据缓存（避免重复请求）
    cachedDashboardData: null,
    dashboardCacheTime: 0,
    dashboardFetching: false,  // 防止并发请求
    dashboardFetchPromise: null  // 共享同一个Promise
  },

  onLaunch() {
    try {
      // 初始化云开发
      const config = require('./utils/cloud_request.js').getConfig ? require('./utils/cloud_request.js').getConfig() : null;
      if (config && config.mode === 'cloud') {
        cloudRequest.initCloud();
      }

      // 检查登录状态，初始化蓝牙
      const userInfo = wx.getStorageSync('userInfo');
      if (userInfo && userInfo.user_id) {
        var self = this;
        setTimeout(function() {
          self.checkAndInitBluetooth(userInfo.user_id);
        }, 500);
      }
    } catch (err) {
      console.error('[App] onLaunch 错误:', err);
    }
  },

  onShow() {
    // 小程序从后台切回前台时，不做处理
    // 数据清除已在 startContinuousScan 中执行
  },

  /**
   * 获取Dashboard数据（带防重复请求机制）
   * @param {number} userId - 用户ID
   * @returns {Promise} Dashboard数据
   */
  async fetchDashboardData(userId) {
    // 如果有缓存且未过期，直接返回
    const now = Date.now();
    if (this.globalData.cachedDashboardData && (now - this.globalData.dashboardCacheTime) < 30000) {
      console.log('[App] ✅ 使用缓存的dashboard数据');
      return this.globalData.cachedDashboardData;
    }

    // 如果正在请求中，等待同一个Promise
    if (this.globalData.dashboardFetching && this.globalData.dashboardFetchPromise) {
      console.log('[App] ⏳ 等待已有的dashboard请求完成');
      return this.globalData.dashboardFetchPromise;
    }

    // 设置请求锁
    this.globalData.dashboardFetching = true;
    
    // 创建新的请求Promise
    this.globalData.dashboardFetchPromise = new Promise((resolve, reject) => {
      cloudRequest.callContainer({
        path: `/api/dashboard/data?user_id=${userId}`,
        method: 'GET',
        success: (res) => {
          console.log('[App] 📦 Dashboard接口返回');
          
          // 缓存数据
          this.globalData.cachedDashboardData = res;
          this.globalData.dashboardCacheTime = Date.now();
          
          // 释放锁
          this.globalData.dashboardFetching = false;
          this.globalData.dashboardFetchPromise = null;
          
          resolve(res);
        },
        fail: (err) => {
          console.error('[App] ❌ Dashboard接口失败:', err);
          
          // 释放锁
          this.globalData.dashboardFetching = false;
          this.globalData.dashboardFetchPromise = null;
          
          reject(err);
        }
      });
    });

    return this.globalData.dashboardFetchPromise;
  },

  async checkAndInitBluetooth(userId) {
    if (!userId) return;

    // 如果已初始化，直接返回
    if (this.globalData.bleAdapterInitialized) {
      console.log('[BLE] ✅ 蓝牙已初始化，跳过');
      return;
    }

    // 防止并发调用
    if (this.globalData.bluetoothInitializing) {
      console.log('[BLE] ⚠️ 蓝牙正在初始化中，跳过');
      return;
    }
    this.globalData.bluetoothInitializing = true;

    // 使用缓存的配置检查结果
    if (this.globalData.xiaomiConfigChecked) {
      if (!this.globalData.hasXiaomiConfig) {
        console.log('[BLE] ⚠️ 已检查过，未配置小米账号');
        this.globalData.bluetoothInitializing = false;
        return;
      }
      // 有配置但未初始化，继续执行
      console.log('[BLE] ⚡ 使用缓存配置，直接初始化');
    } else {
      // 首次检查配置
      try {
        console.log('[BLE] 🔍 检查小米配置...');

        // 使用统一的fetchDashboardData方法
        const res = await this.fetchDashboardData(userId);

        console.log('[BLE] 📦 接口返回:', res);

        // 注意：res 没有 data 字段，直接访问 xiaomi_config
        const hasXiaomiConfig = res.xiaomi_config === true;
        console.log('[BLE] xiaomi_config:', hasXiaomiConfig);

        // 缓存结果
        this.globalData.xiaomiConfigChecked = true;
        this.globalData.hasXiaomiConfig = hasXiaomiConfig;

        if (!hasXiaomiConfig) {
          console.log('[BLE] ❌ 未配置小米账号，跳过蓝牙初始化');
          return;
        }
      } catch (err) {
        console.error('[BLE] ❌ 配置检查失败:', err);
        // 重置缓存标志，允许下次重试
        this.globalData.xiaomiConfigChecked = false;
        this.globalData.hasXiaomiConfig = false;
        return;
      }
    }

    // 初始化蓝牙
    try {
      console.log('[BLE] ✅ 配置检查通过，开始初始化蓝牙');
      this.initBluetoothManager();

      // 预加载成员数据
      this.loadScaleMembers(userId);
    } catch (err) {
      console.error('[BLE] ❌ 初始化蓝牙失败:', err);
    } finally {
      // 释放锁
      this.globalData.bluetoothInitializing = false;
    }
  },

  initBluetoothManager() {
    console.log('[BLE] 🚀 开始初始化蓝牙适配器...');

    // 清除旧的扫描数据，防止误触发跳转
    this.globalData.latestScaleData = null;

    var self = this;
    wx.openBluetoothAdapter({
      success: function() {
        console.log('[BLE] ✅ 蓝牙适配器初始化成功');
        self.globalData.bleAdapterInitialized = true;

        // 监听设备发现
        wx.onBluetoothDeviceFound(self.handleDeviceFound.bind(self));

        // 监听适配器状态变化
        wx.onBluetoothAdapterStateChange(function(res) {
          self.globalData.bleAdapterInitialized = res.available;
          if (!res.available) {
            console.warn('[BLE] ⚠️ 蓝牙适配器不可用');
          }
        });

        // 开始持续扫描（不再周期性停止）
        self.startContinuousScan();
      },
      fail: function(err) {
        console.error('[BLE] ❌ 蓝牙初始化失败:', err);
        self.globalData.bleAdapterInitialized = false;
      }
    });
  },

  startContinuousScan() {
    if (!this.globalData.bleAdapterInitialized) return;

    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: true,
      interval: 300,
      success: function() {
        console.log('[BLE] 📡 开始持续扫描');
      },
      fail: function(err) {
        console.error('[BLE] ❌ 扫描启动失败:', err);
      }
    });
  },

  handleDeviceFound(res) {
    const devices = res.devices || [];
    for (let device of devices) {
      if (!device.name) continue;

      // 设备识别：小米体脂秤 2
      const deviceName = device.name.toLowerCase();
      if (!deviceName.includes('mibfs') && !deviceName.includes('mi scale')) continue;

      // 解析数据
      let finalData = null;
      if (device.serviceData) {
        for (let uuid in device.serviceData) {
          finalData = BLEUtils.parse(device.serviceData[uuid]);
          if (finalData) break;
        }
      }

      if (!finalData && device.advertisData) {
        finalData = BLEUtils.parse(device.advertisData);
      }

      if (!finalData) continue;

      // 数据新鲜度检测（基于设备时间 vs 解析时实时时间）
      const deviceTimestamp = finalData.deviceTimestamp;
      if (!deviceTimestamp) {
        console.log('[BLE] ⚠️ 无设备时间戳，跳过');
        continue;
      }

      // 设备广播的时间已经是北京时间，直接使用
      const parseTime = finalData.receivedAt; // 广播解析时的实时时间
      const timeDiff = Math.abs(parseTime - deviceTimestamp);

      console.log('[BLE] 🕒 设备时间:', new Date(deviceTimestamp).toLocaleString('zh-CN'));
      console.log('[BLE] 🕒 解析时间:', new Date(parseTime).toLocaleString('zh-CN'));
      console.log('[BLE] ⏱️ 时间差值:', Math.round(timeDiff), 'ms');

      // 如果时间差超过10秒，视为过期
      if (timeDiff >= CONFIG.FRESHNESS_THRESHOLD) {
        console.log('[BLE] ⚠️ 数据过期，丢弃');
        continue;
      }

        // 数据去重：检查是否与上次处理的数据相同
        const isDuplicate = this.isDuplicateData(finalData);
        if (isDuplicate) {
          console.log('[BLE] ⚠️ 重复数据，跳过处理');
          continue;
        }

        // 更新全局数据并发布
        this.globalData.latestScaleData = {
          ...finalData,
          deviceId: device.deviceId,
          RSSI: device.RSSI,
          timestamp: parseTime
        };

        // 记录本次处理的数据
        this.globalData.lastProcessedData = finalData;
        this.globalData.lastProcessedTimestamp = Date.now();

      this.notifyScaleListeners(this.globalData.latestScaleData);

      // 更新设备在线状态
      const isOnline = device.RSSI >= -85 && device.RSSI <= -35;
      this.globalData.scaleConnectionStatus = isOnline ? 'online' : 'offline';

      // 已在称重页则跳过跳转
      const pages = getCurrentPages();
      const currentPage = pages[pages.length - 1];
      if (currentPage && currentPage.route === 'pages/scale/scale') {
        console.log('[BLE] ⏸️ 已在称重页，跳过');
        return;
      }

      // 【修改】只要数据新鲜且未处于跳转中，就跳转
      // 不再判断体重是否变化，让称重页自己处理数据更新
      if (!this.globalData.scalePageNavigationInFlight) {
        this.checkAndNavigateToScalePage(finalData.weight);
      } else {
        console.log('[BLE] ⏸️ 跳转进行中，跳过');
      }
    }
  },

  // =====================
  // 发布-订阅模式
  // =====================

  /**
   * 订阅体脂秤数据
   * @param {Function} callback - 回调函数 (data) => void
   * @returns {Function} 取消订阅函数
   */
  subscribeScaleData(callback) {
    if (typeof callback !== 'function') {
      return function() {};
    }

    this.globalData.scaleListeners.push(callback);

    // 如果有最新数据，立即通知
    if (this.globalData.latestScaleData) {
      try {
        callback(this.globalData.latestScaleData);
      } catch (err) {
        console.error('[BLE] 订阅回调失败:', err);
      }
    }

    // 返回取消订阅函数
    var self = this;
    return function() {
      self.unsubscribeScaleData(callback);
    };
  },

  /**
   * 取消订阅
   */
  unsubscribeScaleData(callback) {
    const index = this.globalData.scaleListeners.indexOf(callback);
    if (index > -1) {
      this.globalData.scaleListeners.splice(index, 1);
    }
  },

  /**
   * 通知所有订阅者
   */
  notifyScaleListeners(data) {
    this.globalData.scaleListeners.forEach(function(cb) {
      try {
        cb(data);
      } catch (err) {
        console.error('[BLE] 订阅者回调失败:', err);
      }
    });
  },

  /**
   * 预加载体脂秤成员数据
   */
  async loadScaleMembers(userId) {
    try {
      console.log('[BLE] 🔍 开始加载成员数据...');

      const res = await new Promise((resolve, reject) => {
        cloudRequest.callContainer({
          path: `/api/scale/members?user_id=${userId}`,
          method: 'GET',
          success: resolve,
          fail: reject
        });
      });

      console.log('[BLE] 📦 成员接口返回:', res);

      // 注意：res 直接是 {code, data} 结构，或者就是数组
      let members = [];
      if (res.code === 200 && res.data) {
        members = res.data;
      } else if (Array.isArray(res)) {
        members = res;
      }

      if (members.length > 0) {
        // 存储到全局，供页面使用
        this.globalData.scaleMembers = members;
        console.log(`[BLE] ✅ 预加载 ${members.length} 个成员数据`);
      } else {
        console.warn('[BLE] ⚠️ 未找到成员数据');
      }
    } catch (err) {
      console.error('[BLE] ❌ 预加载成员数据失败:', err);
    }
  },

  /**
   * 检查是否为重复数据
   * @param {Object} newData - 新接收的数据
   * @returns {boolean} 是否为重复数据
   */
  isDuplicateData(newData) {
    const lastData = this.globalData.lastProcessedData;
    if (!lastData) return false;

    // 时间间隔超过5秒，不视为重复（可能是新的测量）
    const timeDiff = Date.now() - this.globalData.lastProcessedTimestamp;
    if (timeDiff > 5000) return false;

    // 如果体重相同且阻抗也相同，则认为是重复数据
    const isSameWeight = Math.abs(lastData.weight - newData.weight) < 0.01;
    const isSameImpedance = (lastData.impedance || 0) === (newData.impedance || 0);
    const isSameStabilized = lastData.isStabilized === newData.isStabilized;

    // 关键：如果新数据有阻抗而旧数据没有，必须视为新数据（即使体重相同）
    if (isSameWeight && !lastData.impedanceValid && newData.impedanceValid) {
      console.log('[BLE] 🆕 新数据包含阻抗，视为非重复');
      return false;
    }

    // 关键：如果旧数据已有阻抗，新数据阻抗不同，也视为新数据
    if (isSameWeight && lastData.impedanceValid && newData.impedanceValid && !isSameImpedance) {
      console.log('[BLE] 🆕 阻抗数据变化，视为非重复');
      return false;
    }

    // 如果所有关键指标都相同，则认为是重复数据
    return isSameWeight && isSameImpedance && isSameStabilized;
  },

  checkAndNavigateToScalePage(currentWeight) {
    const global = this.globalData;

    // 跳转锁：防止页面栈溢出
    if (global.scalePageNavigationInFlight) {
      console.log('[BLE] ⏸️ 跳转进行中，跳过');
      return;
    }

    const pages = getCurrentPages();
    const currentPage = pages[pages.length - 1];
    if (currentPage && currentPage.route === 'pages/scale/scale') {
      console.log('[BLE] ⏸️ 已在称重页，跳过');
      return;
    }

    // 记录本次跳转的体重
    global.lastJumpWeight = currentWeight;
    global.scalePageNavigationInFlight = true;

    console.log('[BLE] 🚀 开始跳转...');
    wx.vibrateShort({ type: 'medium' });
    wx.showLoading({ title: '连接秤...', mask: true });

    var self = this;
    var releaseLock = function() {
      setTimeout(function() {
        self.globalData.scalePageNavigationInFlight = false;
        wx.hideLoading();
      }, 1000);
    };

    wx.navigateTo({
      url: '/pages/scale/scale',
      fail: function() {
        wx.redirectTo({ url: '/pages/scale/scale' });
      },
      complete: releaseLock
    });
  }

});
