const cloudRequest = require('./utils/cloud_request.js');
const bleUtils = require('./utils/ble_scale.js');
const { SCALE_CONFIG, LIMITS } = require('./config/scale_constants.js');

App({
  globalData: {
    // 当前环境标识
    environment: "development", // development | production

    // 蓝牙管理器状态
    bleAdapterInitialized: false,
    bleScanning: false,
    scaleDeviceFound: false,
    latestScaleData: null,
    scaleDataHistory: [], // 用于稳定性检测
    bleCallbacks: [], // 回调函数列表
    scalePageNavigationInFlight: false,
    lastScalePageNavigateAt: 0,

    // 日志优化：记录上次发现的设备信息
    lastDiscoveredDeviceId: null,
    lastDiscoveredRSSI: null,

    // 设备在线状态管理
    deviceOnlineStatus: {}, // {deviceKey: {online: boolean, lastSeen: timestamp}}

    // 体脂秤扫描状态：'offline' | 'scanning' | 'online'
    scaleConnectionStatus: 'offline',

    // 【新增】标记用户是否访问过体脂秤页面（防止首页误跳转）
    hasVisitedScalePage: false,

    // 定时扫描控制
    scanTimer: null, // 扫描定时器

    // 【优化】扫描策略：Phase 1 改为无缝扫描，提升站上去瞬间的响应率
    SCAN_PHASES: [
      { duration: 300000, interval: 500, scanTime: 4000 },   // 前5分钟：极短间歇，长扫描
      { duration: Infinity, interval: 10000, scanTime: 5000 } // 5分钟后：节能模式
    ],
    currentPhaseIndex: 0, // 当前阶段索引
    phaseStartTime: null, // 阶段开始时间
  },

  onLaunch() {
    console.log('AutoHome 小程序启动');

    // 初始化云开发（仅在云模式下需要）
    const config = require('./utils/cloud_request.js').getConfig ? require('./utils/cloud_request.js').getConfig() : null;
    if (config && config.mode === 'cloud') {
      cloudRequest.initCloud();
      console.log('云开发已初始化');
    } else {
      console.log('本地调试模式 - 后端地址:', config?.localBaseUrl || 'http://localhost:8000');
    }

    // 检查网络连接
    wx.getNetworkType({
      success: (res) => {
        console.log('网络类型:', res.networkType);
      }
    });

    // 检查是否有登录信息，如果有则尝试初始化蓝牙
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo && userInfo.user_id) {
      console.log('[BLE Manager] 检测到用户已登录，检查是否需要初始化蓝牙');
      // 延迟执行，确保页面加载完成
      setTimeout(() => {
        this.checkAndInitBluetooth();
      }, 500);
    } else {
      console.log('[BLE Manager] 用户未登录，等待登录后初始化蓝牙');
    }
  },

  /**
   * 检查并初始化蓝牙（登录后调用）
   */
  checkAndInitBluetooth() {
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.user_id) {
      console.log('[BLE Manager] 用户未登录，跳过蓝牙初始化');
      return;
    }

    // 优先检查 has_configured 字段
    if (userInfo.has_configured) {
      console.log('[BLE Manager] 用户已配置体脂秤设备（has_configured=true），开始初始化蓝牙');
      this.initBluetoothManager();
      return;
    }

    // 如果 has_configured 不存在或为 false，尝试从后端获取设备列表确认
    console.log('[BLE Manager] has_configured 未设置，尝试从后端获取设备列表...');
    const cloudRequest = require('./utils/cloud_request.js');

    cloudRequest.callContainer({
      path: `/api/dashboard/data?user_id=${userInfo.user_id}`,
      method: 'GET',
      success: (res) => {
        const healthDevices = res.health_devices || [];
        const hasScaleDevice = healthDevices.some(d => d.device_type === 'scale');

        if (hasScaleDevice) {
          console.log('[BLE Manager] 后端返回有体脂秤设备，开始初始化蓝牙');
          this.initBluetoothManager();
        } else {
          console.log('[BLE Manager] 后端返回无体脂秤设备，跳过蓝牙初始化');
        }
      },
      fail: (err) => {
        console.error('[BLE Manager] 获取设备列表失败:', err);
      }
    });
  },

  /**
   * 初始化蓝牙管理器
   */
  initBluetoothManager() {
    console.log('[BLE Manager] 开始初始化蓝牙适配器');
    wx.openBluetoothAdapter({
      success: (res) => {
        this.globalData.bleAdapterInitialized = true;

        // 【优化】监听器只需在初始化时绑定一次，避免内存泄漏或逻辑重复执行
        wx.onBluetoothDeviceFound(this.handleDeviceFound.bind(this));

        wx.onBluetoothAdapterStateChange((res) => {
          this.globalData.bleAdapterInitialized = res.available;
          if (!res.available) this.stopPeriodicScan();
        });

        this.startPeriodicScan();
      },
      fail: (err) => {
        console.error('[BLE Manager] 蓝牙适配器初始化失败:', err);
        this.globalData.bleAdapterInitialized = false;
      }
    });
  },

  /**
   * 启动定时扫描
   */
  startPeriodicScan() {
    console.log('[BLE Manager] 启动智能定时扫描机制');

    // 重置阶段
    this.globalData.currentPhaseIndex = 0;
    this.globalData.phaseStartTime = Date.now();

    // 立即执行一次扫描
    this.executeScan();

    // 设置定时器，根据当前阶段动态调整间隔
    this.scheduleNextScan();
  },

  /**
   * 调度下一次扫描
   */
  scheduleNextScan() {
    // 清除旧定时器（setTimeout）
    if (this.globalData.scanTimer) {
      clearTimeout(this.globalData.scanTimer);
    }

    // 获取当前阶段的配置
    const phase = this.globalData.SCAN_PHASES[this.globalData.currentPhaseIndex];
    const elapsed = Date.now() - this.globalData.phaseStartTime;

    // 检查是否需要切换到下一阶段
    if (elapsed >= phase.duration && this.globalData.currentPhaseIndex < this.globalData.SCAN_PHASES.length - 1) {
      this.globalData.currentPhaseIndex++;
      this.globalData.phaseStartTime = Date.now();
      console.log('[BLE Manager] 切换到扫描阶段', this.globalData.currentPhaseIndex + 1);
    }

    const currentPhase = this.globalData.SCAN_PHASES[this.globalData.currentPhaseIndex];
    console.log(`[BLE Manager] 当前阶段 ${this.globalData.currentPhaseIndex + 1}: 间隔${currentPhase.interval/1000}秒, 扫描${currentPhase.scanTime/1000}秒`);

    // 关键：在扫描间隔期间，保持当前状态
    // - 如果已发现设备，保持online（不因为扫描间隙而变成offline）
    // - 如果未发现设备，保持scanning（表示正在监听）
    if (this.globalData.scaleDeviceFound) {
      // 已发现设备，保持online状态
      this.globalData.scaleConnectionStatus = 'online';
    } else {
      // 未发现设备，保持scanning状态
      this.globalData.scaleConnectionStatus = 'scanning';
    }

    // 设置下一次扫描
    this.globalData.scanTimer = setTimeout(() => {
      this.executeScan();
      this.scheduleNextScan(); // 递归调度
    }, currentPhase.interval);
  },

  /**
   * 执行单次扫描
   */
  executeScan() {
    if (this.globalData.bleScanning || !this.globalData.bleAdapterInitialized) return;

    const currentPhase = this.globalData.SCAN_PHASES[this.globalData.currentPhaseIndex];
    const scanDuration = currentPhase.scanTime;

    this.globalData.bleScanning = true;
    if (!this.globalData.scaleDeviceFound) {
      this.globalData.scaleConnectionStatus = 'scanning';
    }

    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: true, // 必须开启，否则无法实时获取动态体重[cite: 1]
      success: () => {
        // scanDuration 后自动停止，配合 scheduleNextScan 形成循环
        setTimeout(() => {
          this.stopBleScan();
        }, scanDuration);
      },
      fail: () => {
        this.globalData.bleScanning = false;
      }
    });
  },

  /**
   * 停止定时扫描
   */
  stopPeriodicScan() {
    console.log('[BLE Manager] 停止定时扫描');

    // 清除定时器（setTimeout）
    if (this.globalData.scanTimer) {
      clearTimeout(this.globalData.scanTimer);
      this.globalData.scanTimer = null;
    }

    // 停止当前扫描
    this.stopBleScan();

    // 注意：不改变connectionStatus状态
    // 如果已发现设备，保持online；否则保持scanning或offline
    // 这样可以避免状态闪烁

    // 重置阶段索引（下次启动时从第1阶段开始）
    this.globalData.currentPhaseIndex = 0;
    this.globalData.phaseStartTime = null;
  },

  /**
   * 开始蓝牙扫描（保留原有方法，用于手动触发）
   */
  startBleScan() {
    if (this.globalData.bleScanning) {
      console.log('[BLE Manager] 已在扫描中，跳过');
      return;
    }

    if (!this.globalData.bleAdapterInitialized) {
      console.log('[BLE Manager] 蓝牙未初始化，等待初始化');
      return;
    }

    console.log('[BLE Manager] 开始扫描蓝牙设备（高频模式）');

    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: true, // 允许重复上报，确保实时性
      success: (res) => {
        console.log('[BLE Manager] 扫描启动成功');
        this.globalData.bleScanning = true;
        this.globalData.scaleConnectionStatus = 'scanning'; // 设置为扫描中

        // 监听设备发现
        wx.onBluetoothDeviceFound(this.handleDeviceFound.bind(this));
      },
      fail: (err) => {
        console.error('[BLE Manager] 扫描启动失败:', err);
        this.globalData.bleScanning = false;
      }
    });
  },

  /**
   * 停止蓝牙扫描
   */
  stopBleScan() {
    if (!this.globalData.bleScanning) {
      return;
    }

    console.log('[BLE Manager] 停止单次扫描');

    wx.stopBluetoothDevicesDiscovery({
      success: () => {
        console.log('[BLE Manager] 扫描已停止');
        this.globalData.bleScanning = false;
        // 注意：不在这里设置offline，由定时扫描机制控制
      },
      fail: (err) => {
        console.error('[BLE Manager] 停止扫描失败:', err);
      }
    });
  },

  /**
   * 更新设备在线状态
   */
  updateDeviceOnlineStatus(device) {
    if (!device || !device.deviceId) return;

    // 生成设备key，这里使用设备ID作为唯一标识
    const deviceKey = `ble_${device.deviceId.replace(/:/g, '_')}`;

    // 检查是否有广播数据或serviceData，这表示设备在线
    const hasAdvertData = device.advertisData && device.advertisData.byteLength > 0;
    const hasServiceData = device.serviceData && Object.keys(device.serviceData).length > 0;
    const isOnline = hasAdvertData || hasServiceData;

    // 更新在线状态
    this.globalData.deviceOnlineStatus[deviceKey] = {
      online: isOnline,
      lastSeen: Date.now(),
      deviceId: device.deviceId,
      deviceName: device.name,
      RSSI: device.RSSI
    };

    console.log(`[BLE Manager] 设备在线状态更新: ${deviceKey}`, {
      online: isOnline
      // hasAdvertData,  // 弱化详细日志
      // hasServiceData
    });

    // 通知首页更新设备状态
    this.notifyDeviceStatusUpdate();
  },

  /**
   * 通知设备状态更新
   */
  notifyDeviceStatusUpdate() {
    // 通过全局数据共享，页面可以通过轮询或直接读取获取最新状态
    // console.log('[BLE Manager] 设备在线状态已更新');  // 弱化此日志
  },

  /**
   * 获取设备在线状态
   */
  getDeviceOnlineStatus(deviceKey) {
    return this.globalData.deviceOnlineStatus[deviceKey] || { online: false };
  },

  /**
   * 处理设备发现事件
   */
  handleDeviceFound(res) {
    const devices = res.devices || [];
    for (let device of devices) {
      if (!device.name) continue;

      const deviceName = device.name.toLowerCase();
      const isScaleDevice = SCALE_CONFIG.SCALE_DEVICE_KEYWORDS.some(keyword =>
          deviceName.includes(keyword)
      );
      if (!isScaleDevice) continue;

      // 1. 发现设备立即切换到 Phase 1 (高频模式)
      if (!this.globalData.scaleDeviceFound) {
        this.globalData.scaleDeviceFound = true;
        this.globalData.scaleConnectionStatus = 'online';
        this.globalData.currentPhaseIndex = 0;
        this.globalData.phaseStartTime = Date.now();
      }

      // 2. 解析数据：优先使用 Service Data[cite: 4]
      let finalData = null;
      if (device.serviceData) {
        for (let uuid in device.serviceData) {
          finalData = bleUtils.parseScaleData(device.serviceData[uuid]);
          if (finalData) break;
        }
      }
      if (!finalData && device.advertisData) {
        finalData = bleUtils.parseScaleData(device.advertisData);
      }

      if (!finalData || finalData.weight <= 0.1) continue;

      // 3. 数据同步与防抖
      const lastData = this.globalData.latestScaleData;
      // 0.02kg 以内的波动不重复触发页面更新[cite: 1]
      const isDuplicate = lastData &&
          Math.abs(lastData.weight - finalData.weight) < 0.02 &&
          lastData.isStabilized === finalData.isStabilized;

      this.globalData.latestScaleData = {
        ...finalData,
        deviceId: device.deviceId,
        RSSI: device.RSSI,
        receiveTime: Date.now()
      };

      if (!isDuplicate || (finalData.isStabilized && !lastData.isStabilized)) {
        this.notifyScaleDataUpdate(this.globalData.latestScaleData);
      }

      // 4. 智能跳转逻辑：站上即跳[cite: 1]
      const navigateThreshold = SCALE_CONFIG.MIN_NAVIGATE_WEIGHT || 5.0;
      if (finalData.weight >= navigateThreshold) {
        this.checkAndNavigateToScalePage();
      }
    }
  },

  /**
   * 连接到体脂秤设备
   * @param {String} deviceId - 设备ID
   * @param {Function} callback - 连接成功后的回调
   */
  connectToDevice(deviceId, callback) {
    console.log('[BLE Manager] 尝试连接设备:', deviceId);

    wx.createBLEConnection({
      deviceId: deviceId,
      timeout: 10000, // 10秒超时
      success: (res) => {
        console.log('[BLE Manager] ✅ 连接成功');

        // 延迟一下再回调，让设备有时间发送完整数据
        setTimeout(() => {
          if (callback && typeof callback === 'function') {
            callback();
          }
        }, 1000);
      },
      fail: (err) => {
        console.error('[BLE Manager] ❌ 连接失败:', err);
        // 即使连接失败，也执行回调（使用广播数据）
        if (callback && typeof callback === 'function') {
          callback();
        }
      }
    });
  },

  /**
   * 注册体脂数据更新回调
   * @param {Function} callback - 回调函数 (data) => void
   */
  registerScaleCallback(callback) {
    if (typeof callback === 'function') {
      this.globalData.bleCallbacks.push(callback);
      console.log('[BLE Manager] 注册回调，当前回调数:', this.globalData.bleCallbacks.length);
    }
  },

  /**
   * 注销体脂数据更新回调
   * @param {Function} callback - 要注销的回调函数
   */
  unregisterScaleCallback(callback) {
    const index = this.globalData.bleCallbacks.indexOf(callback);
    if (index > -1) {
      this.globalData.bleCallbacks.splice(index, 1);
      console.log('[BLE Manager] 注销回调，剩余回调数:', this.globalData.bleCallbacks.length);
    }
  },

  /**
   * 通知所有回调函数
   */
  notifyScaleDataUpdate(data) {
    this.globalData.bleCallbacks.forEach(callback => {
      try {
        callback(data);
      } catch (err) {
        console.error('[BLE Manager] 回调执行失败:', err);
      }
    });
  },

  /**
   * 检测并跳转到体脂秤页面
   */
  checkAndNavigateToScalePage() {
    const now = Date.now();
    const global = this.globalData;

    // 跳转锁：防止页面栈溢出
    if (global.scalePageNavigationInFlight || (now - global.lastScalePageNavigateAt < 2500)) return;

    const pages = getCurrentPages();
    const currentPage = pages[pages.length - 1];
    if (currentPage && currentPage.route === 'pages/scale/scale') return;

    // 反馈与跳转[cite: 1]
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
        global.hasVisitedScalePage = true;
      },
      fail: () => {
        // 如果页面栈满，尝试重定向
        wx.redirectTo({ url: '/pages/scale/scale' });
      },
      complete: releaseLock
    });
  },

  /**
   * 检测体重是否稳定（连续N次相同值）
   * @param {Number} threshold - 稳定阈值（次数），默认3次
   * @returns {Boolean}
   */
  isWeightStable(threshold = SCALE_CONFIG.STABLE_THRESHOLD) {
    const history = this.globalData.scaleDataHistory;
    if (history.length < threshold) return false;

    const recent = history.slice(-threshold);
    const firstWeight = recent[0].weight;

    // 检查最近N次体重是否一致（误差<0.05kg）
    return recent.every(item => Math.abs(item.weight - firstWeight) < SCALE_CONFIG.DATA_DEDUPLICATION_THRESHOLD);
  }
});
