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
    bluetoothInitializing: false,  // 防止并发初始化
    latestScaleData: null,
    scaleListeners: [],  // 订阅者列表
    scaleMembers: [],    // 预加载的成员数据
    lastJumpWeight: 0,   // 上次跳转时的体重
    scaleConnectionStatus: 'offline',  // 设备在线状态（基于RSSI）

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
    } finally {
      // 释放锁
      this.globalData.bluetoothInitializing = false;
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

      // 详细日志：判断是否应该跳转
      console.log('[BLE] 📊 数据详情:', {
        weight: finalData.weight,
        isStabilized: finalData.isStabilized,
        isMeasuring: finalData.isMeasuring,
        hasImpedance: finalData.hasImpedance,
        impedance: finalData.impedance,
        RSSI: device.RSSI,
        format: finalData.format
      });

      // 更新设备在线状态（仅基于RSSI）
      const isOnline = device.RSSI >= -85 && device.RSSI <= -35;
      this.globalData.scaleConnectionStatus = isOnline ? 'online' : 'offline';
      console.log('[BLE] 📡 设备状态:', this.globalData.scaleConnectionStatus, '(RSSI:', device.RSSI + ')');

      // 智能跳转条件：数据新鲜度 + 体重去重
      
      // 已在称重页则跳过跳转检测
      const pages = getCurrentPages();
      const currentPage = pages[pages.length - 1];
      if (currentPage && currentPage.route === 'pages/scale/scale') {
        console.log('[BLE] ⏸️ 已在称重页，跳过跳转检测');
        return;
      }
      
      // 检查数据新鲜度（10秒内）
      let isFresh = false;
      if (finalData.deviceTimestamp) {
        const now = Date.now();
        const deviceTime = finalData.deviceTimestamp;
        const timeDiff = Math.abs(now - deviceTime);
        isFresh = timeDiff < 10000; // 10秒误差允许
        
        console.log('[BLE] 🕒 时间比对:', {
          '当前时间': new Date(now).toLocaleString('zh-CN'),
          '设备时间': new Date(deviceTime).toLocaleString('zh-CN'),
          '差值(ms)': Math.round(timeDiff),
          '是否新鲜': isFresh ? '✅' : '❌'
        });
      }
      
      // 体重去重：与上次跳转的体重相同则跳过
      const lastWeight = this.globalData.lastJumpWeight || 0;
      const isSameWeight = Math.abs(finalData.weight - lastWeight) < 0.1; // 0.1kg容差
      
      if (isFresh && !isSameWeight) {
        console.log('[BLE] ✅ 检测到新的实时数据，准备跳转');
        this.checkAndNavigateToScalePage(finalData.weight);
      } else if (isSameWeight) {
        console.log('[BLE] ⏸️ 体重相同，跳过跳转 (', finalData.weight, 'kg)');
      } else {
        console.log('[BLE] ⏸️ 数据过期，不跳转');
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

  checkAndNavigateToScalePage(currentWeight) {
    const now = Date.now();
    const global = this.globalData;

    // 跳转锁：防止页面栈溢出
    if (global.scalePageNavigationInFlight) {
      console.log('[BLE] ⏸️ 跳转进行中，跳过');
      return;
    }
    
    // 冷却检查：2.5秒内不重复跳转
    const timeSinceLastNavigate = now - global.lastScalePageNavigateAt;
    if (timeSinceLastNavigate < 2500) {
      console.log('[BLE] ⏸️ 冷却中，剩余', Math.round((2500 - timeSinceLastNavigate) / 1000), '秒');
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
    // 立即更新跳转时间，防止并发触发
    global.lastScalePageNavigateAt = now;
    global.scalePageNavigationInFlight = true;
    
    console.log('[BLE] 🚀 开始跳转...');
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
      fail: () => wx.redirectTo({ url: '/pages/scale/scale' }),
      complete: releaseLock
    });
  },

});
