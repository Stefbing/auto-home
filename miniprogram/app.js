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
    lastDiscoveredRSSI: null
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
          console.log('[BLE Manager] 适配器状态变化:', res);
          this.globalData.bleAdapterInitialized = res.available;
          
          if (!res.available) {
            this.stopBleScan();
          }
        });
        
        // 自动开始扫描
        this.startBleScan();
      },
      fail: (err) => {
        console.error('[BLE Manager] 蓝牙适配器初始化失败:', err);
        this.globalData.bleAdapterInitialized = false;
      }
    });
  },
  
  /**
   * 开始蓝牙扫描
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
    
    console.log('[BLE Manager] 停止扫描');
    
    wx.stopBluetoothDevicesDiscovery({
      success: () => {
        console.log('[BLE Manager] 扫描已停止');
        this.globalData.bleScanning = false;
      },
      fail: (err) => {
        console.error('[BLE Manager] 停止扫描失败:', err);
      }
    });
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
      
      // 【精简日志】只在首次发现或数据变化时打印
      const lastDeviceId = this.globalData.lastDiscoveredDeviceId;
      const lastRSSI = this.globalData.lastDiscoveredRSSI;
      const isSameDevice = lastDeviceId === device.deviceId;
      const rssiChanged = !lastRSSI || Math.abs(lastRSSI - device.RSSI) > 5; // RSSI变化超过5dBm才打印
      
      if (!isSameDevice || rssiChanged) {
        console.log('========== [BLE Manager] 发现体脂秤设备 ==========');
        console.log('[BLE Manager] 设备名称:', device.name);
        console.log('[BLE Manager] 设备ID:', device.deviceId);
        console.log('[BLE Manager] 信号强度:', device.RSSI);
        
        this.globalData.lastDiscoveredDeviceId = device.deviceId;
        this.globalData.lastDiscoveredRSSI = device.RSSI;
      }
      
      // 完整打印设备对象
      console.log('[BLE Manager] 完整设备对象:', JSON.stringify({
        name: device.name,
        deviceId: device.deviceId,
        RSSI: device.RSSI,
        advertisDataLength: device.advertisData ? device.advertisData.byteLength : 0,
        hasServiceData: !!device.serviceData,
        hasManufacturerData: !!device.manufacturerData
      }, null, 2));
      
      // 解析广播数据
      const advertisData = device.advertisData;
      if (!advertisData) {
        console.log('[BLE Manager] ⚠️ 设备无 advertisData');
        continue;
      }
      
      console.log('[BLE Manager] advertisData 长度:', advertisData.byteLength);
      console.log('[BLE Manager] advertisData 原始数组:', Array.from(new Uint8Array(advertisData)));
      console.log('[BLE Manager] advertisData Hex:', Array.from(new Uint8Array(advertisData)).map(b => b.toString(16).padStart(2, '0')).join(' '));
      
      // 检查 serviceData
      if (device.serviceData) {
        console.log('[BLE Manager] ✅ 发现 serviceData');
        console.log('[BLE Manager] serviceData 对象:', device.serviceData);
        
        // 遍历所有 service UUID
        for (let uuid in device.serviceData) {
          const serviceData = device.serviceData[uuid];
          console.log(`[BLE Manager] Service UUID ${uuid}:`, {
            length: serviceData.byteLength,
            array: Array.from(new Uint8Array(serviceData)),
            hex: Array.from(new Uint8Array(serviceData)).map(b => b.toString(16).padStart(2, '0')).join(' ')
          });
        }
      } else {
        console.log('[BLE Manager] ⚠️ 无 serviceData');
      }
      
      // 检查 manufacturerData
      if (device.manufacturerData) {
        console.log('[BLE Manager] ✅ 发现 manufacturerData');
        console.log('[BLE Manager] manufacturerData 对象:', device.manufacturerData);
        
        for (let manuId in device.manufacturerData) {
          const manuData = device.manufacturerData[manuId];
          console.log(`[BLE Manager] Manufacturer ID ${manuId}:`, {
            length: manuData.byteLength,
            array: Array.from(new Uint8Array(manuData)),
            hex: Array.from(new Uint8Array(manuData)).map(b => b.toString(16).padStart(2, '0')).join(' ')
          });
        }
      } else {
        console.log('[BLE Manager] ⚠️ 无 manufacturerData');
      }
      
      // 尝试解析 advertisData
      console.log('[BLE Manager] --- 开始解析 advertisData ---');
      const advertScaleData = bleUtils.parseScaleData(advertisData);
      if (advertScaleData) {
        console.log('[BLE Manager] ✅ advertisData 解析成功:', JSON.stringify(advertScaleData));
        console.log('[BLE Manager]    - weight:', advertScaleData.weight, 'kg');
        console.log('[BLE Manager]    - isStabilized:', advertScaleData.isStabilized);
        console.log('[BLE Manager]    - impedance:', advertScaleData.impedance || 0);
      } else {
        console.log('[BLE Manager] ❌ advertisData 解析失败');
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
            console.log('[BLE Manager] ✅ Service 数据解析成功:', JSON.stringify(serviceScaleData));
            console.log('[BLE Manager]    - weight:', serviceScaleData.weight, 'kg');
            console.log('[BLE Manager]    - isStabilized:', serviceScaleData.isStabilized);
            console.log('[BLE Manager]    - impedance:', serviceScaleData.impedance || 0);
            console.log('[BLE Manager]    - timestamp:', serviceScaleData.timestamp ? new Date(serviceScaleData.timestamp).toLocaleString() : 'N/A');
            finalData = serviceScaleData;
            usedDataSource = `Service ${uuid}`;
            break; // 使用第一个成功的Service数据
          } else {
            console.log('[BLE Manager] ❌ Service 数据解析失败');
          }
        }
      }
      
      // 如果Service数据解析失败，回退到advertisData
      if (!finalData && advertScaleData) {
        console.log('[BLE Manager] ⚠️ Service不可用，回退使用 advertisData');
        finalData = advertScaleData;
        usedDataSource = 'advertisData';
      }

      if (!finalData) {
        console.log('[BLE Manager] ❌ 所有数据源解析失败');
        continue;
      }
      
      console.log(`[BLE Manager] ✅ 使用数据源: ${usedDataSource}`);
      console.log('[BLE Manager] ==========================================');
      
      // 【新增】检查 Service Data 时间戳新鲜度（过滤过期广播数据）
      if (finalData.timestamp) {
        const now = Date.now();
        // 体脂秤的 timestamp 是 UTC 时间，需要转换为本地时间
        // JavaScript 的 Date 对象会自动处理时区，直接相减即可
        const dataAge = now - finalData.timestamp;
        const maxAge = SCALE_CONFIG.DATA_DEBOUNCE_TIME; // 3秒
        
        console.log('[BLE Manager] 🕒 时间戳检查', {
          currentTime: new Date(now).toLocaleTimeString(),
          dataTimestamp: new Date(finalData.timestamp).toLocaleTimeString(),
          dataAge: `${(dataAge / 1000).toFixed(1)}s`,
          maxAge: `${(maxAge / 1000).toFixed(1)}s`,
          isExpired: dataAge > maxAge
        });
        
        if (dataAge > maxAge) {
          console.log('[BLE Manager] ⚠️ 数据过期，跳过处理');
          continue; // 跳过这条过期数据
        }
        
        console.log('[BLE Manager] ✅ 数据新鲜度检查通过');
      }
      
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
          receiveTime: Date.now()
        };
        
        // 仍然通知回调（页面需要实时更新）
        this.notifyScaleDataUpdate(this.globalData.latestScaleData);
        
        // 检查稳定性
        const isStableByFlag = finalData.isStabilized;
        const isStableByHistory = this.isWeightStable(3);
        
        // 只有体重超过阈值且稳定时才跳转
        const isAdultWeight = finalData.weight >= LIMITS.MIN_WEIGHT; // 30kg
        if ((isStableByFlag || isStableByHistory) && isAdultWeight) {
          console.log('[BLE Manager] 📊 数据防抖 - 检测到稳定有效体重，准备跳转', {
            weight: finalData.weight,
            isStabilized: finalData.isStabilized
          });
          this.checkAndNavigateToScalePage();
        } else if ((isStableByFlag || isStableByHistory) && !isAdultWeight) {
          console.log('[BLE Manager] ⚠️ 数据防抖 - 体重低于阈值，跳过跳转', {
            weight: finalData.weight,
            threshold: LIMITS.MIN_WEIGHT
          });
        }
        
        continue; // 跳过后续日志输出
      }
      
      // 首次数据或数据变化，打印完整日志
      this.globalData.scaleDeviceFound = true;
      this.globalData.latestScaleData = {
        ...finalData,
        deviceName: device.name,
        deviceId: device.deviceId,
        RSSI: device.RSSI,
        receiveTime: Date.now()
      };
      
      // 记录历史数据（用于稳定性检测）
      this.globalData.scaleDataHistory.push(finalData);
      if (this.globalData.scaleDataHistory.length > LIMITS.HISTORY) {
        this.globalData.scaleDataHistory.shift(); // 保留最近20条
      }
      
      // 通知所有注册的回调
      this.notifyScaleDataUpdate(this.globalData.latestScaleData);
      
      // 【增强】体重超过30kg且数据稳定才跳转
      const hasWeight = finalData.weight > 0;
      const isAdultWeight = finalData.weight >= LIMITS.MIN_WEIGHT; // 30kg
      const isStable = finalData.isStabilized;
      
      if (hasWeight && isAdultWeight && isStable) {
        console.log('[BLE Manager] 📊 检测到有效稳定体重，准备跳转到体脂秤页面', {
          weight: finalData.weight,
          isStabilized: finalData.isStabilized,
          impedance: finalData.impedance || 0
        });
        this.checkAndNavigateToScalePage();
      } else if (hasWeight && isAdultWeight && !isStable) {
        console.log('[BLE Manager] ⏳ 体重有效但未稳定，等待稳定数据', {
          weight: finalData.weight,
          isStabilized: false
        });
      } else if (hasWeight && !isAdultWeight) {
        console.log('[BLE Manager] ⚠️ 体重低于阈值，跳过跳转', {
          weight: finalData.weight,
          threshold: LIMITS.MIN_WEIGHT
        });
      }
    }
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
    
    // 检查是否在后台或首页
    console.log('[BLE Manager] ✅ 检测到稳定体重，准备跳转到体脂秤页面');
    
    // 显示提示
    wx.showToast({
      title: '检测到称重，正在跳转...',
      icon: 'none',
      duration: 1500
    });
    
    // 延迟跳转，给用户反应时间
    setTimeout(() => {
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
    }, SCALE_CONFIG.NAVIGATE_DELAY);
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
