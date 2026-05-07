const cloudRequest = require('./utils/cloud_request.js');
const BLEUtils = require('./utils/ble_scale.js');

// 配置常量
const CONFIG = {
  MIN_VALID_WEIGHT: 30,  // 最小有效体重 30kg
  MAX_WEIGHT: 200        // 最大体重 200kg
};

App({
  globalData: {
    // 环境标识
    environment: "development",

    // 蓝牙状态（简化）
    bleAdapterInitialized: false,
    latestScaleData: null,
    scaleListeners: [],  // 订阅者列表
    scaleMembers: [],    // 预加载的成员数据

    // 跳转控制
    scalePageNavigationInFlight: false,
    lastScalePageNavigateAt: 0,
    
    // 小米配置检查缓存
    xiaomiConfigChecked: false,
    hasXiaomiConfig: false
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
        setTimeout(() => this.checkAndInitBluetooth(userInfo.user_id), 500);
      }
    } catch (err) {
      console.error('[App] onLaunch 错误:', err);
    }
  },

  onShow() {
    // 小程序从后台切回前台时，不做处理
    // 数据清除已在 startContinuousScan 中执行
  },

  async checkAndInitBluetooth(userId) {
    if (!userId) return;
    
    // 如果已初始化，直接返回
    if (this.globalData.bleAdapterInitialized) {
      console.log('[BLE] ✅ 蓝牙已初始化，跳过');
      return;
    }
    
    // 使用缓存的配置检查结果
    if (this.globalData.xiaomiConfigChecked) {
      if (!this.globalData.hasXiaomiConfig) {
        console.log('[BLE] ⚠️ 已检查过，未配置小米账号');
        return;
      }
      // 有配置但未初始化，继续执行
      console.log('[BLE] ⚡ 使用缓存配置，直接初始化');
    } else {
      // 首次检查配置
      try {
        console.log('[BLE] 🔍 检查小米配置...');
        
        const res = await new Promise((resolve, reject) => {
          cloudRequest.callContainer({
            path: `/api/dashboard/data?user_id=${userId}`,
            method: 'GET',
            success: resolve,
            fail: reject
          });
        });

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
    }
  },

  initBluetoothManager() {
    console.log('[BLE] 🚀 开始初始化蓝牙适配器...');
    
    // 清除旧的扫描数据，防止误触发跳转
    this.globalData.latestScaleData = null;
    
    wx.openBluetoothAdapter({
      success: () => {
        console.log('[BLE] ✅ 蓝牙适配器初始化成功');
        this.globalData.bleAdapterInitialized = true;
        
        // 监听设备发现
        wx.onBluetoothDeviceFound(this.handleDeviceFound.bind(this));
        
        // 监听适配器状态变化
        wx.onBluetoothAdapterStateChange((res) => {
          this.globalData.bleAdapterInitialized = res.available;
          if (!res.available) {
            console.warn('[BLE] ⚠️ 蓝牙适配器不可用');
          }
        });
        
        // 开始持续扫描（不再周期性停止）
        this.startContinuousScan();
      },
      fail: (err) => {
        console.error('[BLE] ❌ 蓝牙初始化失败:', err);
        this.globalData.bleAdapterInitialized = false;
      }
    });
  },

  startContinuousScan() {
    if (!this.globalData.bleAdapterInitialized) return;
    
    // 清除旧数据，防止误触发
    this.globalData.latestScaleData = null;
    console.log('[BLE] 🧹 清除旧数据，准备扫描');
    
    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: true,
      interval: 500,  // 500ms 扫描间隔
      success: () => {
        console.log('[BLE] 📡 开始持续扫描');
      },
      fail: (err) => {
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

      // 解析数据：优先 Service Data
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

      // 过滤无效数据
      if (!finalData || finalData.weight < CONFIG.MIN_VALID_WEIGHT || finalData.weight > CONFIG.MAX_WEIGHT) continue;

      // 更新全局数据（带接收时间）
      const receivedAt = Date.now();
      this.globalData.latestScaleData = {
        ...finalData,
        deviceId: device.deviceId,
        RSSI: device.RSSI,
        timestamp: receivedAt
      };

      // 通知所有订阅者（发布-订阅模式）
      this.notifyScaleListeners(this.globalData.latestScaleData);

      // 智能跳转条件：稳定 + RSSI合格 + 防重复
      const isOnline = device.RSSI >= -70 && device.RSSI <= -40;
      const timeSinceLastNavigate = receivedAt - this.globalData.lastScalePageNavigateAt;
      const cooldownPassed = timeSinceLastNavigate > 15000; // 15秒冷却
      
      if (finalData.isStabilized && isOnline && cooldownPassed) {
        console.log('[BLE] ✅ 检测到有效数据，准备跳转');
        this.checkAndNavigateToScalePage();
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
    if (typeof callback !== 'function') return () => {};
    
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
    return () => this.unsubscribeScaleData(callback);
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
    this.globalData.scaleListeners.forEach(cb => {
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

  checkAndNavigateToScalePage() {
    const now = Date.now();
    const global = this.globalData;

    // 跳转锁：防止页面栈溢出
    if (global.scalePageNavigationInFlight || (now - global.lastScalePageNavigateAt < 2500)) return;

    const pages = getCurrentPages();
    const currentPage = pages[pages.length - 1];
    if (currentPage && currentPage.route === 'pages/scale/scale') return;

    global.scalePageNavigationInFlight = true;
    wx.vibrateShort({ type: 'medium' });
    wx.showLoading({ title: '连接秤...', mask: true });

    const releaseLock = () => {
      setTimeout(() => {
        global.scalePageNavigationInFlight = false;
        wx.hideLoading();
      }, 1000);
    };

    wx.navigateTo({
      url: '/pages/scale/scale',
      success: () => {
        global.lastScalePageNavigateAt = Date.now();
      },
      fail: () => wx.redirectTo({ url: '/pages/scale/scale' }),
      complete: releaseLock
    });
  },

});
