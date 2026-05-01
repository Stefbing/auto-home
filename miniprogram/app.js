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
    
    // 日志优化：记录上次发现的设备信息
    lastDiscoveredDeviceId: null,
    lastDiscoveredRSSI: null,
    
    // 设备在线状态管理
    deviceOnlineStatus: {}, // {deviceKey: {online: boolean, lastSeen: timestamp}}
    
    // 体脂秤扫描状态：'offline' | 'scanning' | 'online'
    scaleConnectionStatus: 'offline',
    
    // 定时扫描控制
    scanTimer: null, // 扫描定时器
    
    // 智能扫描策略：先频繁后缓慢
    SCAN_PHASES: [
      { duration: 60000, interval: 10000, scanTime: 5000 },   // 第1阶段：前1分钟，每10秒扫5秒
      { duration: 300000, interval: 30000, scanTime: 10000 },  // 第2阶段：接下来5分钟，每30秒扫10秒
      { duration: Infinity, interval: 60000, scanTime: 10000 } // 第3阶段：之后，每60秒扫10秒
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
        console.log('[BLE Manager] 蓝牙适配器初始化成功');
        this.globalData.bleAdapterInitialized = true;
        
        // 监听蓝牙适配器状态变化
        wx.onBluetoothAdapterStateChange((res) => {
          // console.log('[BLE Manager] 适配器状态变化:', res);  // 弱化此日志
          this.globalData.bleAdapterInitialized = res.available;
          
          if (!res.available) {
            this.stopPeriodicScan();
          }
        });
        
        // 启动定时扫描
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
    if (this.globalData.bleScanning) {
      console.log('[BLE Manager] 上次扫描仍在进行，跳过');
      return;
    }
    
    if (!this.globalData.bleAdapterInitialized) {
      console.log('[BLE Manager] 蓝牙未初始化，跳过扫描');
      return;
    }
    
    // 获取当前阶段的扫描时长
    const currentPhase = this.globalData.SCAN_PHASES[this.globalData.currentPhaseIndex];
    const scanDuration = currentPhase.scanTime;
    
    console.log('[BLE Manager] 开始单次扫描（持续', scanDuration / 1000, '秒）');
    
    // 关键：只在未发现设备时显示scanning
    // 如果已发现设备，保持online状态不变
    if (!this.globalData.scaleDeviceFound) {
      this.globalData.scaleConnectionStatus = 'scanning';
    }
    
    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: true,
      success: (res) => {
        console.log('[BLE Manager] 扫描启动成功');
        this.globalData.bleScanning = true;
        
        // 监听设备发现
        wx.onBluetoothDeviceFound(this.handleDeviceFound.bind(this));
        
        // 设置定时器，scanDuration后停止扫描
        setTimeout(() => {
          this.stopBleScan();
          // 扫描结束后，保持当前状态
          console.log('[BLE Manager] 单次扫描结束，当前状态:', this.globalData.scaleConnectionStatus);
        }, scanDuration);
      },
      fail: (err) => {
        console.error('[BLE Manager] 扫描启动失败:', err);
        this.globalData.bleScanning = false;
        // 只在真正失败时设置为offline
        if (!this.globalData.scaleDeviceFound) {
          this.globalData.scaleConnectionStatus = 'offline';
        }
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
      // 过滤小米体脂秤设备
      if (!device.name) continue;
      
      const deviceName = device.name.toLowerCase();
      const isScaleDevice = SCALE_CONFIG.SCALE_DEVICE_KEYWORDS.some(keyword => 
        deviceName.includes(keyword)
      );
      
      if (!isScaleDevice) continue;
      
      // 更新设备在线状态
      this.updateDeviceOnlineStatus(device);
      
      // 【关键】只要发现设备且有广播数据，就标记为在线
      const hasAdvertData = device.advertisData && device.advertisData.byteLength > 0;
      const hasServiceData = device.serviceData && Object.keys(device.serviceData).length > 0;
      
      if (hasAdvertData || hasServiceData) {
        const wasOffline = !this.globalData.scaleDeviceFound;
        this.globalData.scaleConnectionStatus = 'online';
        this.globalData.scaleDeviceFound = true;
        
        // 如果刚从离线变为在线，优化扫描策略
        if (wasOffline) {
          console.log('[BLE Manager] 🎯 首次发现设备，优化扫描策略');
          // 切换到第2阶段（中等频率），平衡实时性和电量
          this.globalData.currentPhaseIndex = 1;
          this.globalData.phaseStartTime = Date.now();
        }
      }
      
      // 完整打印设备对象（仅首次或RSSI变化大时）
      const lastDeviceId = this.globalData.lastDiscoveredDeviceId;
      const lastRSSI = this.globalData.lastDiscoveredRSSI;
      const isSameDevice = lastDeviceId === device.deviceId;
      const rssiChanged = !lastRSSI || Math.abs(lastRSSI - device.RSSI) > 5;
      
      if (!isSameDevice || rssiChanged) {
        console.log('[BLE] 🔍 发现设备:', device.name, '| RSSI:', device.RSSI);
        console.log('[BLE]    deviceId:', device.deviceId);
        this.globalData.lastDiscoveredDeviceId = device.deviceId;
        this.globalData.lastDiscoveredRSSI = device.RSSI;
      }
      
      // ========== 详细打印所有广播数据 ==========
      console.log('[BLE] ========== 广播数据详情 ==========');
      
      // 1. advertisData
      const advertisData = device.advertisData;
      if (advertisData && advertisData.byteLength > 0) {
        const advertArray = Array.from(new Uint8Array(advertisData));
        const advertHex = advertArray.map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log('[BLE] 📦 advertisData:');
        console.log('   - 长度:', advertisData.byteLength, '字节');
        console.log('   - 原始数组:', advertArray);
        console.log('   - Hex:', advertHex);
        console.log('   - 二进制:', advertArray.map(b => b.toString(2).padStart(8, '0')).join(' '));
      } else {
        console.log('[BLE] ⚠️ 无 advertisData');
      }
      
      // 2. serviceData
      if (device.serviceData && Object.keys(device.serviceData).length > 0) {
        console.log('[BLE] 📦 serviceData:');
        for (let uuid in device.serviceData) {
          const serviceData = device.serviceData[uuid];
          const serviceArray = Array.from(new Uint8Array(serviceData));
          const serviceHex = serviceArray.map(b => b.toString(16).padStart(2, '0')).join(' ');
          console.log(`   - UUID: ${uuid}`);
          console.log(`     长度: ${serviceData.byteLength} 字节`);
          console.log(`     原始数组:`, serviceArray);
          console.log(`     Hex:`, serviceHex);
          console.log(`     二进制:`, serviceArray.map(b => b.toString(2).padStart(8, '0')).join(' '));
        }
      } else {
        console.log('[BLE] ⚠️ 无 serviceData');
      }
      
      // 3. manufacturerData
      if (device.manufacturerData && Object.keys(device.manufacturerData).length > 0) {
        console.log('[BLE] 📦 manufacturerData:');
        for (let manuId in device.manufacturerData) {
          const manuData = device.manufacturerData[manuId];
          const manuArray = Array.from(new Uint8Array(manuData));
          const manuHex = manuArray.map(b => b.toString(16).padStart(2, '0')).join(' ');
          console.log(`   - Manufacturer ID: ${manuId}`);
          console.log(`     长度: ${manuData.byteLength} 字节`);
          console.log(`     原始数组:`, manuArray);
          console.log(`     Hex:`, manuHex);
          console.log(`     二进制:`, manuArray.map(b => b.toString(2).padStart(8, '0')).join(' '));
        }
      } else {
        console.log('[BLE] ⚠️ 无 manufacturerData');
      }
      
      console.log('[BLE] ==========================================');
      
      // 尝试解析 advertisData
      const advertScaleData = bleUtils.parseScaleData(advertisData);
      if (advertScaleData) {
        console.log('[BLE] 📡 advertisData:', `${advertScaleData.weight}kg`, advertScaleData.isStabilized ? '✅稳定' : '⏳未稳定');
      } else {
        console.log('[BLE] ⚠️ advertisData解析失败');
      }
      
      // 优先解析 serviceData（包含完整数据：体重+阻抗+时间戳）
      let finalData = null;
      let usedDataSource = '';
      
      if (device.serviceData) {
        console.log('[BLE Manager] --- 尝试解析 Service Data（优先级最高）---');
        for (let uuid in device.serviceData) {
          const serviceData = device.serviceData[uuid];
          console.log(`[BLE Manager] Service UUID: ${uuid}`);
          console.log(`[BLE Manager] Service Data 长度: ${serviceData.byteLength} 字节`);
          console.log(`[BLE Manager] Service Data Hex: ${Array.from(new Uint8Array(serviceData)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
          
          const serviceScaleData = bleUtils.parseScaleData(serviceData);
          if (serviceScaleData) {
            console.log('[BLE] 🎯 Service数据解析成功:');
            console.log('   - 体重:', serviceScaleData.weight, 'kg');
            console.log('   - 稳定状态:', serviceScaleData.isStabilized ? '✅' : '⏳');
            console.log('   - 阻抗:', serviceScaleData.impedance || 0, 'Ω');
            console.log('   - 时间戳:', serviceScaleData.timestamp ? new Date(serviceScaleData.timestamp).toLocaleTimeString() : 'N/A');
            finalData = serviceScaleData;
            usedDataSource = `Service ${uuid}`;
            break; // 使用第一个成功的Service数据
          } else {
            console.log('[BLE] ❌ Service 数据解析失败');
          }
        }
      }
      
      // 如果Service数据解析失败，回退到advertisData
      if (!finalData && advertScaleData) {
        console.log('[BLE] ⚠️ Service不可用，回退使用 advertisData');
        finalData = advertScaleData;
        usedDataSource = 'advertisData';
      }

      if (!finalData) {
        console.log('[BLE] ❌ 所有数据源解析失败');
        continue;
      }
      
      console.log(`[BLE] ✅ 使用数据源: ${usedDataSource}`);
      console.log('[BLE] ==========================================');
      
      // 【关键】只处理有阻抗数据的完整测量结果
      if (!finalData.impedance || finalData.impedance === 0) {
        console.log('[BLE] ⚠️ 阻抗为0，跳过（等待完整测量数据）');
        continue;
      }
      
      // 【优化】使用接收时间而非设备时间戳（避免时钟不同步问题）
      const receiveTime = Date.now();
      
      // 【防抖】如果体重和稳定状态都没变化，跳过处理（减少日志）
      const lastData = this.globalData.latestScaleData;
      if (lastData && 
          Math.abs(lastData.weight - finalData.weight) < 0.05 &&
          lastData.isStabilized === finalData.isStabilized) {
        // 静默更新，不打印日志
        this.globalData.latestScaleData = {
          ...finalData,
          deviceName: device.name,
          deviceId: device.deviceId,
          RSSI: device.RSSI,
          receiveTime: receiveTime
        };
        
        // 仍然通知回调（页面需要实时更新）
        this.notifyScaleDataUpdate(this.globalData.latestScaleData);
        
        continue; // 跳过后续日志输出
      }
      
      // 首次数据或数据变化，打印完整日志
      this.globalData.scaleDeviceFound = true;
      this.globalData.latestScaleData = {
        ...finalData,
        deviceName: device.name,
        deviceId: device.deviceId,
        RSSI: device.RSSI,
        receiveTime: receiveTime
      };
      
      // 记录历史数据（用于稳定性检测）
      this.globalData.scaleDataHistory.push(finalData);
      if (this.globalData.scaleDataHistory.length > LIMITS.HISTORY) {
        this.globalData.scaleDataHistory.shift(); // 保留最近20条
      }
      
      // 通知所有注册的回调
      this.notifyScaleDataUpdate(this.globalData.latestScaleData);
      
      // 【关键】只有有阻抗数据且体重有效时才跳转
      const hasWeight = finalData.weight > 0;
      const isAdultWeight = finalData.weight >= LIMITS.MIN_WEIGHT; // 30kg
      
      if (hasWeight && isAdultWeight) {
        console.log('[BLE Manager] 📊 检测到完整测量数据，立即跳转', {
          weight: finalData.weight,
          impedance: finalData.impedance,
          isStabilized: finalData.isStabilized
        });
        
        // 直接跳转，不需要连接设备
        this.checkAndNavigateToScalePage();
      } else if (hasWeight && !isAdultWeight) {
        console.log('[BLE Manager] ⚠️ 体重低于阈值，跳过跳转', {
          weight: finalData.weight,
          threshold: LIMITS.MIN_WEIGHT
        });
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
    // 获取当前页面栈
    const pages = getCurrentPages();
    const currentPage = pages[pages.length - 1];
    
    // 如果已经在体脂秤页面，不跳转
    if (currentPage && currentPage.route === 'pages/scale/scale') {
      console.log('[BLE Manager] 已在体脂秤页面，无需跳转');
      return;
    }
    
    // 立即跳转，无延迟
    console.log('[BLE Manager] ✅ 检测到有效体重，立即跳转到体脂秤页面');
    
    // 使用navigateTo保留页面栈，确保有返回按钮
    wx.navigateTo({
      url: '/pages/scale/scale',
      fail: (err) => {
        console.error('[BLE Manager] 跳转失败:', err);
        // 如果navigateTo失败（页面栈满），尝试redirectTo
        wx.redirectTo({
          url: '/pages/scale/scale',
          fail: (err2) => {
            console.error('[BLE Manager] redirectTo也失败:', err2);
          }
        });
      }
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
