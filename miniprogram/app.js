const cloudRequest = require('./utils/cloud_request.js');
const BLEUtils = require('./utils/ble_scale.js');

App({
  globalData: {
    // 环境标识
    environment: "development",

    // 蓝牙状态
    bleAdapterInitialized: false,
    bleScanning: false,
    scaleDeviceFound: false,
    latestScaleData: null,
    bleCallbacks: [],

    // 跳转控制
    scalePageNavigationInFlight: false,
    lastScalePageNavigateAt: 0,
    hasVisitedScalePage: false,

    // 设备在线状态
    deviceOnlineStatus: {},
    scaleConnectionStatus: 'offline',

    // 扫描定时器
    scanTimer: null,

    // 扫描策略配置
    SCAN_PHASES: [
      { duration: 300000, interval: 500, scanTime: 4000 },   // 前5分钟：高频
      { duration: Infinity, interval: 10000, scanTime: 5000 } // 之后：节能
    ],
    currentPhaseIndex: 0,
    phaseStartTime: null
  },

  onLaunch() {
    // 初始化云开发
    const config = require('./utils/cloud_request.js').getConfig ? require('./utils/cloud_request.js').getConfig() : null;
    if (config && config.mode === 'cloud') {
      cloudRequest.initCloud();
    }

    // 检查登录状态，初始化蓝牙
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo && userInfo.user_id) {
      setTimeout(() => this.checkAndInitBluetooth(), 500);
    }
  },

  checkAndInitBluetooth() {
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.user_id) return;

    // 优先检查 has_configured 字段
    if (userInfo.has_configured) {
      this.initBluetoothManager();
      return;
    }

    // 从后端获取设备列表确认
    cloudRequest.callContainer({
      path: `/api/dashboard/data?user_id=${userInfo.user_id}`,
      method: 'GET',
      success: (res) => {
        const hasScaleDevice = (res.health_devices || []).some(d => d.device_type === 'scale');
        if (hasScaleDevice) this.initBluetoothManager();
      }
    });
  },

  initBluetoothManager() {
    wx.openBluetoothAdapter({
      success: () => {
        this.globalData.bleAdapterInitialized = true;
        wx.onBluetoothDeviceFound(this.handleDeviceFound.bind(this));
        wx.onBluetoothAdapterStateChange((res) => {
          this.globalData.bleAdapterInitialized = res.available;
          if (!res.available) this.stopPeriodicScan();
        });
        this.startPeriodicScan();
      },
      fail: (err) => {
        console.error('[BLE] 初始化失败:', err);
        this.globalData.bleAdapterInitialized = false;
      }
    });
  },

  startPeriodicScan() {
    this.globalData.currentPhaseIndex = 0;
    this.globalData.phaseStartTime = Date.now();
    this.executeScan();
    this.scheduleNextScan();
  },

  scheduleNextScan() {
    if (this.globalData.scanTimer) clearTimeout(this.globalData.scanTimer);

    const phase = this.globalData.SCAN_PHASES[this.globalData.currentPhaseIndex];
    const elapsed = Date.now() - this.globalData.phaseStartTime;

    // 切换阶段
    if (elapsed >= phase.duration && this.globalData.currentPhaseIndex < this.globalData.SCAN_PHASES.length - 1) {
      this.globalData.currentPhaseIndex++;
      this.globalData.phaseStartTime = Date.now();
    }

    const currentPhase = this.globalData.SCAN_PHASES[this.globalData.currentPhaseIndex];
    
    // 保持状态：已发现设备则 online，否则 scanning
    this.globalData.scaleConnectionStatus = this.globalData.scaleDeviceFound ? 'online' : 'scanning';

    this.globalData.scanTimer = setTimeout(() => {
      this.executeScan();
      this.scheduleNextScan();
    }, currentPhase.interval);
  },

  executeScan() {
    if (this.globalData.bleScanning || !this.globalData.bleAdapterInitialized) return;

    const scanDuration = this.globalData.SCAN_PHASES[this.globalData.currentPhaseIndex].scanTime;
    this.globalData.bleScanning = true;
    
    if (!this.globalData.scaleDeviceFound) {
      this.globalData.scaleConnectionStatus = 'scanning';
    }

    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: true,
      success: () => {
        setTimeout(() => this.stopBleScan(), scanDuration);
      },
      fail: () => {
        this.globalData.bleScanning = false;
      }
    });
  },

  stopPeriodicScan() {
    if (this.globalData.scanTimer) {
      clearTimeout(this.globalData.scanTimer);
      this.globalData.scanTimer = null;
    }
    this.stopBleScan();
    this.globalData.currentPhaseIndex = 0;
    this.globalData.phaseStartTime = null;
  },

  stopBleScan() {
    if (!this.globalData.bleScanning) return;

    wx.stopBluetoothDevicesDiscovery({
      success: () => {
        this.globalData.bleScanning = false;
      }
    });
  },

  updateDeviceOnlineStatus(device) {
    if (!device || !device.deviceId) return;

    const deviceKey = `ble_${device.deviceId.replace(/:/g, '_')}`;
    const isOnline = (device.advertisData && device.advertisData.byteLength > 0) ||
                     (device.serviceData && Object.keys(device.serviceData).length > 0);

    this.globalData.deviceOnlineStatus[deviceKey] = {
      online: isOnline,
      lastSeen: Date.now(),
      deviceId: device.deviceId,
      deviceName: device.name,
      RSSI: device.RSSI
    };
  },

  handleDeviceFound(res) {
    const devices = res.devices || [];
    for (let device of devices) {
      if (!device.name) continue;

      // 设备识别
      const deviceName = device.name.toLowerCase();
      const keywords = ['mi scale', 'body', 'scale', '米秤', '体脂', 'mibfs'];
      if (!keywords.some(keyword => deviceName.includes(keyword))) continue;

      // 发现设备，切换到高频模式
      if (!this.globalData.scaleDeviceFound) {
        this.globalData.scaleDeviceFound = true;
        this.globalData.scaleConnectionStatus = 'online';
        this.globalData.currentPhaseIndex = 0;
        this.globalData.phaseStartTime = Date.now();
      }

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

      if (!finalData || finalData.weight <= 0.1) continue;

      // 防抖：0.02kg 以内波动不重复触发
      const lastData = this.globalData.latestScaleData;
      const isDuplicate = lastData &&
          Math.abs(lastData.weight - finalData.weight) < 0.02 &&
          lastData.isStabilized === finalData.isStabilized;

      this.globalData.latestScaleData = {
        ...finalData,
        deviceId: device.deviceId,
        RSSI: device.RSSI,
        receiveTime: Date.now()
      };

      // 通知回调（即使重复也要同步状态）
      this.notifyScaleDataUpdate(this.globalData.latestScaleData);

      // 智能跳转：RSSI -40~-70dBm 且数据稳定
      const isOnline = device.RSSI >= -70 && device.RSSI <= -40;
      if (finalData.isStabilized && isOnline) {
        this.checkAndNavigateToScalePage();
      }
    }
  },

  connectToDevice(deviceId, callback) {
    wx.createBLEConnection({
      deviceId,
      timeout: 10000,
      success: () => {
        setTimeout(() => callback && callback(), 1000);
      },
      fail: () => {
        callback && callback(); // 失败也执行回调（使用广播数据）
      }
    });
  },

  registerScaleCallback(callback) {
    if (typeof callback === 'function') {
      this.globalData.bleCallbacks.push(callback);
    }
  },

  unregisterScaleCallback(callback) {
    const index = this.globalData.bleCallbacks.indexOf(callback);
    if (index > -1) {
      this.globalData.bleCallbacks.splice(index, 1);
    }
  },

  notifyScaleDataUpdate(data) {
    this.globalData.bleCallbacks.forEach(cb => {
      try { cb(data); } catch (err) { console.error('[BLE] 回调失败:', err); }
    });
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
        global.hasVisitedScalePage = true;
      },
      fail: () => wx.redirectTo({ url: '/pages/scale/scale' }),
      complete: releaseLock
    });
  },

});
