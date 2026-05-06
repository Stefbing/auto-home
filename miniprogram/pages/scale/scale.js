const cloudRequest = require('../../utils/cloud_request.js');
const { parseScaleData, fastStabilityCheck, smoothWeight, detectWeightTrend, FLAGS } = require('../../utils/ble_scale.js');

// ======================
// 状态机定义
// ======================
const APP_STATE = {
  IDLE: 'idle',           // 空闲等待
  SCANNING: 'scanning',   // 主动扫描设备
  CONNECTING: 'connecting', // 发现设备
  MEASURING: 'measuring', // 实时测量中（用户已上秤）
  STABILIZING: 'stabilizing', // 趋于稳定
  LOCKED: 'locked',       // 数据锁定，计算中
  COMPLETED: 'completed', // 完成保存
  ERROR: 'error'          // 异常状态
};

// ======================
// 配置常量（基于实测优化）
// ======================
const CONFIG = {
  // 稳定检测：连续 3 次差异 < 0.3kg
  STABILITY_THRESHOLD: 0.3,
  STABILITY_COUNT: 3,

  // 阻抗等待超时：稳定后最多等 5 秒
  IMPEDANCE_TIMEOUT: 5000,
  IMPEDANCE_INTERVAL: 100, // 进度条更新间隔

  // 防重复触发：2 秒内相同体重忽略
  LOCK_COOLDOWN: 2000,

  // 称重完成后自动重置倒计时（秒）
  RESET_COUNTDOWN: 10,

  // 体重变化阈值：> 0.15kg 视为有效变化
  WEIGHT_CHANGE_THRESHOLD: 0.15,

  // 最小有效体重：> 3kg 视为上秤
  MIN_VALID_WEIGHT: 3,

  // 扫描超时
  SCAN_TIMEOUT: 15000,

  // 数据平滑因子（EWMA）
  SMOOTH_FACTOR: 0.6,

  // 成员匹配容差：8kg
  MATCH_TOLERANCE: 8,

  // 蓝牙信号强度阈值（真在线范围：-40 ~ -70dBm）
  RSSI_MIN: -70,   // 最小可接受信号
  RSSI_MAX: -40    // 最大可接受信号
};

Page({

  data: {
    // ===== 核心测量数据 =====
    weight: 0,
    weightDisplay: '0.00',
    impedance: 0,
    isStabilized: false,
    isMeasuring: false,

    // ===== 状态机 =====
    appState: APP_STATE.IDLE,
    stateDisplay: '准备就绪',
    stateIcon: 'scan',

    // ===== 稳定性优化 =====
    stabilityProgress: 0,
    stabilityTotal: CONFIG.STABILITY_COUNT,
    weightHistory: [],

    // ===== 锁定机制 =====
    measurementLocked: false,
    lockedWeight: null,
    lockedImpedance: null,
    lockTimestamp: 0,

    // ===== 阻抗等待 =====
    impedanceWaiting: false,
    impedanceWaitProgress: 0,
    impedanceWaitTotal: CONFIG.IMPEDANCE_TIMEOUT / CONFIG.IMPEDANCE_INTERVAL,

    // ===== 时间戳控制 =====
    lastExitTime: 0,
    lastRealMeasureTime: 0,
    lastWeight: 0,

    // ===== 家庭成员 =====
    members: [],
    selectedMemberId: null,
    isLoadingMembers: false,
    matchedMember: null,
    matchConfidence: 0,

    // ===== 当前成员信息 =====
    currentMember: {
      height: 170,
      age: 25,
      gender: 'male'
    },

    // ===== 健康指标 =====
    bmi: null,
    bodyFat: null,
    water: null,
    muscleMass: null,
    protein: null,
    bmr: null,
    visceralFat: null,
    boneMass: null,
    standardWeight: null,
    bodyScore: 0,
    advice: null,
    adviceLevel: 'normal',

    // ===== 弹窗控制 =====
    showAddMemberDialog: false,
    editingMemberId: null,
    newMemberName: '',
    newMemberAge: '',
    newMemberHeight: '',
    newMemberGender: '',
    newMemberGenderIndex: 0,

    // ===== 自动保存 =====
    autoSaved: false,
    saving: false,

    // ===== 重置控制 =====
    showResetHint: false,       // 显示重置提示
    resetCountdown: 0,          // 重置倒计时（秒）
    canReset: false,            // 是否允许重置

    // ===== 动画控制 =====
    pulseAnimation: false,
    slideIn: false,
    showResultPanel: false,

    // ===== 蓝牙状态 =====
    bleAvailable: false,
    bleScanning: false,
    connectedDevice: null,
    rssi: 0,

    // ===== 预计算百分比（供 WXML 绑定） =====
    muscleMassPercent: 0,
    boneMassPercent: 0,
    impedanceWaitPercent: 0,

    // ===== 状态图标 Emoji（供 WXML 绑定） =====
    stateIconEmoji: '⚖️',

    // ===== BMI/体脂范围文本（供 WXML 绑定） =====
    bmiRangeClass: '',
    bmiRangeText: '',
    bodyFatRangeClass: '',
    genderLabel: '',
    bodyFatNormalRange: '',

    // ===== 状态类/文本（供 WXML 绑定） =====
    statusDotClass: 'disconnected',
    statusPillText: '实时测量中',
    bleBadgeClass: 'idle',
    saveCardClass: '',
    saveStatusText: '准备保存',
    adviceIcon: '✅',
    showMemberSection: false,

    // ===== 评分相关（供 WXML 绑定） =====
    bodyScoreColor: '#10B981',
    bodyScoreGrade: '优秀',
    visceralFatText: '正常',

    // ===== 仪表盘角度（供 WXML 绑定） =====
    needleAngle: -90,
    scoreBarOffset: 326.73,

    // ===== 诊断信息（调试用，可隐藏） =====
    debugInfo: {
      ctrlRaw: '',
      weightRaw: 0,
      impedanceRaw: 0,
      dataQuality: 0,
      trend: 'stable'
    }
  },

  // ======================
  // 生命周期
  // ======================
  onLoad(options) {
    this.initBLE();
    this.loadMembers();

    if (options.autoStart) {
      this.startMeasurementFlow();
    }
  },

  async onShow() {
    console.log('[Scale] 📄 页面显示');
    
    // 先注册回调，确保能接收数据
    this.registerBleCallback();
    
    // 加载成员
    await this.loadMembers();

    const lastMemberId = wx.getStorageSync('lastSelectedMemberId');
    if (lastMemberId && this.data.members.length > 0) {
      const member = this.data.members.find(m => m.id === lastMemberId);
      if (member) {
        this.selectMember({ currentTarget: { dataset: { id: member.id } } });
      }
    }

    // 检查 BLE 状态
    this.checkBLEState();
    
    // 【关键修复】如果全局已有最新数据，立即处理
    const app = getApp();
    if (app.globalData.latestScaleData) {
      console.log('[Scale] 🚀 使用全局最新数据:', app.globalData.latestScaleData);
      
      // 如果数据已稳定且体重有效，直接跳转到测量状态
      if (app.globalData.latestScaleData.isStabilized && 
          app.globalData.latestScaleData.weight >= CONFIG.MIN_VALID_WEIGHT) {
        console.log('[Scale] ⚡ 数据已稳定，直接转换到 MEASURING');
        this.transitionState(APP_STATE.MEASURING, '测量中...', 'activity', true);
      }
      
      this.handleBLE(app.globalData.latestScaleData);
    }
    
    // 如果处于 IDLE 状态且蓝牙可用，立即开始扫描
    if (this.data.bleAvailable && this.data.appState === APP_STATE.IDLE) {
      console.log('[Scale] 🚀 主动启动扫描');
      this.startBLEScan();
    }
  },

  onHide() {
    console.log('[Scale] 📄 页面隐藏');
    this.unregisterBleCallback();
    this.stopImpedanceTimer();
    
    // 清理重置定时器
    if (this.resetTimer) {
      clearInterval(this.resetTimer);
      this.resetTimer = null;
    }
    
    this.lastExitTime = Date.now();
    // 不重置状态，保持当前测量数据
  },

  onUnload() {
    this.unregisterBleCallback();
    this.stopImpedanceTimer();
    
    // 清理重置定时器
    if (this.resetTimer) {
      clearInterval(this.resetTimer);
      this.resetTimer = null;
    }
  },

  // ======================
  // BLE 初始化与主动扫描
  // ======================
  initBLE() {
    wx.openBluetoothAdapter({
      success: () => {
        this.setData({ bleAvailable: true });
        this.startBLEScan();
      },
      fail: (err) => {
        console.error('[BLE] 初始化失败:', err);
        this.setData({
          bleAvailable: false,
          appState: APP_STATE.ERROR,
          stateDisplay: '请开启蓝牙',
          stateIcon: 'bluetooth-off'
        });

        wx.showModal({
          title: '蓝牙未开启',
          content: '请开启手机蓝牙以连接体脂秤',
          confirmText: '去开启',
          success: (res) => {
            if (res.confirm) {
              wx.openSetting();
            }
          }
        });
      }
    });
  },

  checkBLEState() {
    wx.getBluetoothAdapterState({
      success: (res) => {
        this.setData({ bleAvailable: res.available });
        if (res.available && !this.data.bleScanning && this.data.appState === APP_STATE.IDLE) {
          this.startBLEScan();
        }
      }
    });
  },

  startBLEScan() {
    if (this.data.bleScanning) return;

    this.setData({
      bleScanning: true,
      appState: APP_STATE.SCANNING,
      stateDisplay: '正在搜索体脂秤...',
      stateIcon: 'scan',
      pulseAnimation: true
    });

    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: true,
      interval: 500,
      success: () => {
        console.log('[BLE] 开始扫描');
        this.scanTimer = setTimeout(() => {
          if (this.data.appState === APP_STATE.SCANNING) {
            wx.stopBluetoothDevicesDiscovery();
            this.setData({
              bleScanning: false,
              appState: APP_STATE.IDLE,
              stateDisplay: '未找到设备，点击重试',
              stateIcon: 'refresh',
              pulseAnimation: false
            });
          }
        }, CONFIG.SCAN_TIMEOUT);
      },
      fail: (err) => {
        console.error('[BLE] 扫描失败:', err);
        this.setData({ bleScanning: false });
      }
    });
  },

  stopBLEScan() {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    wx.stopBluetoothDevicesDiscovery();
    this.setData({ bleScanning: false });
  },

  // ======================
  // BLE 回调注册（核心）
  // ======================
  registerBleCallback() {
    const app = getApp();
    this.bleCallback = (data) => {
      console.log('[Scale] 📡 收到 BLE 数据:', data);
      this.handleBLE(data);
    };
    app.registerScaleCallback(this.bleCallback);
    console.log('[Scale] ✅ BLE 回调已注册');

    // 监听蓝牙设备发现
    wx.onBluetoothDeviceFound((res) => {
      res.devices.forEach(device => {
        if (this.isScaleDevice(device)) {
          console.log('[Scale] 🔵 发现体脂秤:', device.name, 'RSSI:', device.RSSI);
          
          // 信号强度判断（真在线：-40 ~ -70dBm）
          const isOnline = device.RSSI && device.RSSI >= CONFIG.RSSI_MIN && device.RSSI <= CONFIG.RSSI_MAX;
          if (!isOnline) {
            console.log('[Scale] ⚠️ 信号不在有效范围，忽略:', device.RSSI);
            return; // 信号不在有效范围，忽略
          }

          this.setData({
            connectedDevice: {
              name: device.name || '小米体脂秤',
              deviceId: device.deviceId,
              rssi: device.RSSI
            },
            rssi: device.RSSI
          });

          // 状态转换：扫描 → 连接 → 测量
          if (this.data.appState === APP_STATE.SCANNING) {
            console.log('[Scale] ✅ 停止扫描，准备连接');
            this.stopBLEScan();
            this.transitionState(APP_STATE.CONNECTING, '发现设备', 'bluetooth', true);

            setTimeout(() => {
              this.transitionState(APP_STATE.MEASURING, '请上秤', 'user', false);
              
              // 检查是否有全局数据需要处理
              const app = getApp();
              if (app.globalData.latestScaleData && 
                  app.globalData.latestScaleData.weight >= CONFIG.MIN_VALID_WEIGHT) {
                console.log('[Scale] 📊 处理设备发现时的最新数据');
                this.handleBLE(app.globalData.latestScaleData);
              }
            }, 600);
          } else if (this.data.appState === APP_STATE.IDLE) {
            // 如果处于 IDLE 状态，直接跳转到测量
            console.log('[Scale] ✅ 从 IDLE 直接跳转到测量');
            this.transitionState(APP_STATE.MEASURING, '请上秤', 'user', false);
            
            // 检查是否有全局数据需要处理
            const app = getApp();
            if (app.globalData.latestScaleData && 
                app.globalData.latestScaleData.weight >= CONFIG.MIN_VALID_WEIGHT) {
              console.log('[Scale] 📊 处理 IDLE 状态下的最新数据');
              this.handleBLE(app.globalData.latestScaleData);
            }
          }
        }
      });
    });
  },

  unregisterBleCallback() {
    if (this.bleCallback) {
      getApp().unregisterScaleCallback(this.bleCallback);
      this.bleCallback = null;
    }
    wx.offBluetoothDeviceFound();
  },

  isScaleDevice(device) {
    const name = (device.name || '').toLowerCase();
    const localName = (device.localName || '').toLowerCase();

    // 小米体脂秤特征判断
    const isMiScale = name.includes('scale') || name.includes('体脂') ||
        localName.includes('scale') || localName.includes('mi') ||
        name.includes('xmtzc');

    // 广播数据长度判断
    const hasValidData = device.advertisData &&
        (device.advertisData.byteLength === 8 ||
            device.advertisData.byteLength >= 13);

    return isMiScale || hasValidData;
  },

  // ======================
  // 状态机工具函数
  // ======================
  transitionState(newState, display, icon, pulse) {
    const stateIconEmoji = icon === 'scan' ? '🔍' :
        icon === 'bluetooth' ? '🔵' :
            icon === 'user' ? '👤' :
                icon === 'activity' ? '⚡' :
                    icon === 'check-circle' ? '✓' :
                        icon === 'loader' ? '⏳' :
                            icon === 'check' ? '✅' : '⚖️';

    // 计算状态点类
    const statusDotClass = newState === 'measuring' || newState === 'stabilizing' || newState === 'locked'
        ? 'connected'
        : (newState === 'completed' ? 'success' : 'disconnected');

    // 计算 ble 徽章类
    const bleBadgeClass = this.data.bleScanning
        ? 'scanning'
        : (this.data.connectedDevice ? 'connected' : 'idle');

    this.setData({
      appState: newState,
      stateDisplay: display,
      stateIcon: icon,
      stateIconEmoji,
      statusDotClass,
      bleBadgeClass,
      pulseAnimation: pulse
    });
  },

  // ======================
  // 核心：BLE 数据处理（最终优化版）
  // ======================
  handleBLE(rawData) {
    if (!rawData) return;

    // 冷却期检查
    if (this.lastExitTime && Date.now() - this.lastExitTime < 1500) {
      console.log('[Scale] 冷却期内，忽略数据');
      return;
    }

    // 解析数据
    let data;
    try {
      if (typeof rawData === 'object' && rawData.weight !== undefined) {
        data = rawData; // 已解析的数据对象
      } else {
        data = parseScaleData(rawData.buffer || rawData, rawData.deviceId || rawData.macAddress);
      }
    } catch (err) {
      console.error('[Scale] 数据解析失败:', err);
      return;
    }

    if (!data || data.weight < CONFIG.MIN_VALID_WEIGHT || data.weight > 300) {
      console.log('[Scale] 数据过滤:', data ? `weight=${data.weight}` : 'null');
      return;
    }

    // 数据质量过滤（低于 60 分的数据可能是噪声）
    if (data.quality !== undefined && data.quality < 60) {
      console.warn('[Scale] 数据质量过低，忽略:', data.quality, 'ctrl:', data.ctrlRaw);
      return;
    }

    const weight = data.weight;
    const now = Date.now();

    // EWMA 平滑处理（减少显示跳动）
    const smoothedWeight = smoothWeight(weight, this.data.lastWeight, CONFIG.SMOOTH_FACTOR);

    // 更新历史记录
    let history = this.data.weightHistory;
    history.push({
      weight: smoothedWeight,
      timestamp: now,
      isStabilized: data.isStabilized,
      impedance: data.impedance || 0
    });
    if (history.length > 5) history = history.slice(-5);

    // 快速稳定检测
    const stability = fastStabilityCheck(history);
    const isStable = stability.isStable || data.isStabilized;

    // 体重趋势检测（上秤/下秤/稳定）
    const trend = detectWeightTrend(history);

    // 计算稳定性进度（0-100%）
    let stabilityProgress = 0;
    if (isStable) {
      stabilityProgress = 100;
    } else if (history.length >= 2) {
      const recentDiff = Math.abs(history[history.length - 1].weight - history[history.length - 2].weight);
      stabilityProgress = Math.min(100, Math.round((1 - Math.min(recentDiff, 1) / 1) * 100));
    }

    // 判断"是否真的上秤"
    const weightDiff = Math.abs(weight - this.data.lastWeight);
    const isRealMeasurement = weight >= CONFIG.MIN_VALID_WEIGHT &&
        (weightDiff >= CONFIG.WEIGHT_CHANGE_THRESHOLD || trend === 'rising');

    // 更新调试信息
    this.setData({
      debugInfo: {
        ctrlRaw: data.ctrlRaw || '',
        weightRaw: data.weightRaw || 0,
        impedanceRaw: data.impedanceRaw || 0,
        dataQuality: data.quality || 0,
        trend
      }
    });

    // 更新显示（实时）
    const showMemberSection = isStable || this.data.appState === 'completed';
    const statusPillText = isStable
        ? (data.impedance > 0 ? '测量完成' : '已稳定，分析中...')
        : '实时测量中';
    const needleAngle = (smoothedWeight / 150) * 180 - 90;

    console.log('[Scale] 📊 更新显示:', {
      weight: smoothedWeight,
      isStable,
      impedance: data.impedance,
      appState: this.data.appState,
      stabilityProgress
    });

    this.setData({
      weight: smoothedWeight,
      weightDisplay: smoothedWeight.toFixed(2),
      lastWeight: smoothedWeight,
      weightHistory: history,
      stabilityProgress,
      isStabilized: isStable,
      isMeasuring: data.isMeasuring || false,
      impedance: data.impedance || 0,
      showMemberSection,
      statusPillText,
      needleAngle
    });

    // 状态机转换
    console.log('[Scale] 🔄 处理状态机:', {
      currentState: this.data.appState,
      isStable,
      isRealMeasurement,
      impedance: data.impedance,
      hasImpedance: data.hasImpedance,
      impedanceValid: data.impedanceValid
    });
    
    this.processStateMachine({
      weight: smoothedWeight,
      impedance: data.impedance || 0,
      isStabilized: isStable,
      isMeasuring: data.isMeasuring || false,
      hasImpedance: data.hasImpedance || false,
      impedanceValid: data.impedanceValid || false,
      isRealMeasurement,
      stabilityProgress,
      trend,
      history
    });
  },

  // ======================
  // 状态机处理（核心逻辑）
  // ======================
  processStateMachine(ctx) {
    const { weight, impedance, isStabilized, isMeasuring, hasImpedance, impedanceValid, isRealMeasurement, stabilityProgress, trend, history } = ctx;
    const currentState = this.data.appState;
    const now = Date.now();

    console.log('[Scale] 🔄 状态机:', {
      currentState,
      weight,
      isStabilized,
      isRealMeasurement,
      trend,
      hasImpedance,
      impedanceValid
    });

    switch (currentState) {
      case APP_STATE.IDLE:
      case APP_STATE.SCANNING:
      case APP_STATE.CONNECTING:
        console.log('[Scale] 🔀 检测到有效测量，准备转换状态');
        if (isRealMeasurement) {
          console.log('[Scale] ✅ 执行状态转换: SCANNING → MEASURING');
          this.transitionState(APP_STATE.MEASURING, '测量中...', 'activity', true);
        } else {
          console.log('[Scale] ⚠️ isRealMeasurement=false，不转换');
        }
        break;

      case APP_STATE.MEASURING:
        // 检测到稳定
        if (isStabilized) {
          this.transitionState(APP_STATE.STABILIZING, '已稳定，分析中...', 'check-circle', false);

          // 判断阻抗状态
          if (hasImpedance && !impedanceValid) {
            // 有阻抗标志但数据无效（正在测量中），启动等待
            this.startImpedanceTimer();
          } else if (impedanceValid) {
            // 阻抗已到位，立即锁定
            this.lockMeasurement(weight, impedance);
          } else {
            // 无阻抗设备（如体重秤1代），直接锁定
            this.lockMeasurement(weight, 0);
          }
        } else if (trend === 'falling' && weight < 5) {
          // 用户下秤，重置状态
          this.resetMeasurementState();
          this.transitionState(APP_STATE.MEASURING, '请上秤', 'user', false);
        }
        break;

      case APP_STATE.STABILIZING:
        // 等待阻抗或超时
        if (impedanceValid && !this.data.measurementLocked) {
          this.stopImpedanceTimer();
          this.lockMeasurement(weight, impedance);
        }
        // 如果体重开始下降（用户下秤），取消锁定
        if (trend === 'falling' && weight < 5) {
          this.stopImpedanceTimer();
          this.resetMeasurementState();
          this.transitionState(APP_STATE.MEASURING, '请上秤', 'user', false);
        }
        break;

      case APP_STATE.LOCKED:
      case APP_STATE.COMPLETED:
        // 检测新测量（体重显著变化或下秤后重新上秤）
        if (isRealMeasurement && !this.data.measurementLocked) {
          const lockDiff = Math.abs(this.data.lockedWeight - weight);
          const timeSinceLock = now - this.data.lockTimestamp;

          if (lockDiff >= 0.3 || timeSinceLock >= CONFIG.LOCK_COOLDOWN) {
            // 新测量，重置并重新开始
            this.resetMeasurementState();
            this.transitionState(APP_STATE.MEASURING, '新测量...', 'activity', true);
          }
        }
        break;
    }
  },

  // ======================
  // 阻抗等待计时器
  // ======================
  startImpedanceTimer() {
    if (this.impedanceTimer) return; // 防止重复启动

    this.setData({
      impedanceWaiting: true,
      impedanceWaitProgress: 0
    });

    let progress = 0;
    const totalSteps = CONFIG.IMPEDANCE_TIMEOUT / CONFIG.IMPEDANCE_INTERVAL;

    this.impedanceTimer = setInterval(() => {
      progress++;
      const impedanceWaitPercent = Math.round((progress / totalSteps) * 100);
      this.setData({
        impedanceWaitProgress: progress,
        impedanceWaitPercent
      });

      if (progress >= totalSteps) {
        // 超时：使用无阻抗计算
        this.stopImpedanceTimer();
        console.log('[Scale] 阻抗等待超时，使用无阻抗模式计算');
        this.lockMeasurement(this.data.weight, 0);
      }
    }, CONFIG.IMPEDANCE_INTERVAL);
  },

  stopImpedanceTimer() {
    if (this.impedanceTimer) {
      clearInterval(this.impedanceTimer);
      this.impedanceTimer = null;
    }
    this.setData({
      impedanceWaiting: false,
      impedanceWaitProgress: 0
    });
  },

  // ======================
  // 锁定测量
  // ======================
  lockMeasurement(weight, impedance) {
    const now = Date.now();

    // 防重复检查
    if (this.data.measurementLocked) {
      const weightDiff = Math.abs(this.data.lockedWeight - weight);
      const timeDiff = now - this.lastRealMeasureTime;
      if (weightDiff < 0.2 && timeDiff < CONFIG.LOCK_COOLDOWN) {
        return;
      }
    }

    console.log('[Scale] 🔒 锁定测量:', weight, 'kg, 阻抗:', impedance, 'Ω');

    this.setData({
      appState: APP_STATE.LOCKED,
      measurementLocked: true,
      lockedWeight: weight,
      lockedImpedance: impedance,
      lockTimestamp: now,
      stateDisplay: '计算中...',
      stateIcon: 'loader',
      pulseAnimation: true
    });

    this.lastRealMeasureTime = now;

    // 震动反馈
    wx.vibrateShort({ type: 'medium' });

    // 自动匹配成员
    this.autoMatchMember(weight);

    // 延迟计算（确保数据稳定）
    setTimeout(() => {
      this.calculateBodyMetrics();
      
      // 计算完成后，启动重置倒计时
      this.startResetCountdown();
    }, 400);
  },

  // ======================
  // 自动成员匹配（基于历史体重）
  // ======================
  autoMatchMember(weight) {
    const members = this.data.members;
    if (!members.length) return;

    let bestMatch = null;
    let minScore = Infinity;
    let matchConfidence = 0;
    const now = Date.now(); // 修复：定义 now 变量

    members.forEach(member => {
      if (member.lastWeight) {
        const weightDiff = Math.abs(member.lastWeight - weight);
        const timeSinceLast = member.lastMeasureTime ? now - member.lastMeasureTime : Infinity;

        // 综合评分算法
        let score = weightDiff;
        // 时间加权：越近期的记录权重越高
        if (timeSinceLast < 24 * 3600 * 1000) score *= 0.5;      // 1天内
        else if (timeSinceLast < 7 * 24 * 3600 * 1000) score *= 0.7; // 1周内
        else if (timeSinceLast < 30 * 24 * 3600 * 1000) score *= 0.9; // 1月内

        if (score < minScore && weightDiff < CONFIG.MATCH_TOLERANCE) {
          minScore = score;
          bestMatch = member;
          matchConfidence = Math.max(0, Math.round((1 - weightDiff / CONFIG.MATCH_TOLERANCE) * 100));
        }
      }
    });

    if (bestMatch) {
      // 更新成员列表中的匹配标记
      const members = this.data.members.map(m => ({
        ...m,
        isMatched: m.id === bestMatch.id
      }));

      this.setData({
        matchedMember: bestMatch,
        matchConfidence,
        selectedMemberId: bestMatch.id,
        members,
        currentMember: {
          height: bestMatch.height,
          age: bestMatch.age,
          gender: bestMatch.gender
        }
      });
      wx.setStorageSync('lastSelectedMemberId', bestMatch.id);

      wx.showToast({
        title: `已匹配: ${bestMatch.name} (${matchConfidence}%)`,
        icon: 'none',
        duration: 2000
      });
    }
  },

  // ======================
  // 重置倒计时
  // ======================
  startResetCountdown() {
    console.log('[Scale] ⏱️ 启动重置倒计时:', CONFIG.RESET_COUNTDOWN, '秒');
    
    this.setData({
      showResetHint: true,
      resetCountdown: CONFIG.RESET_COUNTDOWN,
      canReset: false
    });

    // 启动倒计时定时器
    this.resetTimer = setInterval(() => {
      const newCountdown = this.data.resetCountdown - 1;
      
      if (newCountdown <= 0) {
        // 倒计时结束，自动重置
        clearInterval(this.resetTimer);
        this.resetTimer = null;
        console.log('[Scale] 🔄 自动重置');
        this.performReset();
      } else {
        this.setData({ resetCountdown: newCountdown });
      }
    }, 1000);
  },

  // ======================
  // 执行重置
  // ======================
  performReset() {
    console.log('[Scale] 🧹 执行重置，清空缓存');
    
    // 停止所有定时器
    if (this.resetTimer) {
      clearInterval(this.resetTimer);
      this.resetTimer = null;
    }
    this.stopImpedanceTimer();
    
    // 清空测量数据
    this.setData({
      // 核心数据
      weight: 0,
      weightDisplay: '0.00',
      impedance: 0,
      isStabilized: false,
      isMeasuring: false,
      
      // 状态机
      appState: APP_STATE.IDLE,
      stateDisplay: '准备就绪',
      stateIcon: 'scan',
      stateIconEmoji: '⚖️',
      
      // 稳定性
      stabilityProgress: 0,
      weightHistory: [],
      
      // 锁定机制
      measurementLocked: false,
      lockedWeight: null,
      lockedImpedance: null,
      lockTimestamp: 0,
      
      // 阻抗等待
      impedanceWaiting: false,
      impedanceWaitProgress: 0,
      
      // 健康指标
      bmi: null,
      bodyFat: null,
      water: null,
      muscleMass: null,
      protein: null,
      bmr: null,
      visceralFat: null,
      boneMass: null,
      standardWeight: null,
      bodyScore: 0,
      advice: null,
      adviceLevel: 'normal',
      
      // 保存状态
      autoSaved: false,
      saving: false,
      
      // 动画
      pulseAnimation: false,
      slideIn: false,
      showResultPanel: false,
      
      // 重置控制
      showResetHint: false,
      resetCountdown: 0,
      canReset: true,
      
      // 匹配
      matchedMember: null,
      matchConfidence: 0,
      
      // 仪表盘
      needleAngle: -90,
      scoreBarOffset: 326.73,
      
      // WXML 绑定字段
      statusDotClass: 'disconnected',
      statusPillText: '实时测量中',
      bleBadgeClass: 'idle',
      saveCardClass: '',
      saveStatusText: '准备保存',
      adviceIcon: '✅',
      showMemberSection: false,
      
      // 调试信息
      debugInfo: {
        ctrlRaw: '',
        weightRaw: 0,
        impedanceRaw: 0,
        dataQuality: 0,
        trend: 'stable'
      }
    });
    
    // 清空全局最新数据
    const app = getApp();
    app.globalData.latestScaleData = null;
    
    // 清空本地存储的离线数据
    wx.removeStorageSync('offlineMeasurements');
    
    // 震动反馈
    wx.vibrateShort({ type: 'light' });
    
    wx.showToast({
      title: '已重置，可以重新称重',
      icon: 'success',
      duration: 2000
    });
    
    console.log('[Scale] ✅ 重置完成');
  },

  // ======================
  // 手动重置
  // ======================
  manualReset() {
    console.log('[Scale] 👆 手动触发重置');
    
    // 停止倒计时
    if (this.resetTimer) {
      clearInterval(this.resetTimer);
      this.resetTimer = null;
    }
    
    this.performReset();
  },

  // ======================
  // 体脂计算（基于 InBody BIA 模型优化）[^5^][^7^]
  // ======================
  calculateBodyMetrics() {
    const { lockedWeight, lockedImpedance, currentMember } = this.data;

    if (!lockedWeight || !currentMember) {
      console.warn('[Scale] 缺少必要数据');
      return;
    }

    const { height, age, gender } = currentMember;
    const weight = lockedWeight;
    const impedance = lockedImpedance || 0;
    const isMale = gender === 'male';

    // 基础参数
    const heightM = height / 100;
    const heightCm = height;
    const bmi = weight / (heightM ** 2);

    // ===== 1. 去脂体重（FFM）- 基于 BIA 核心公式 [^5^] =====
    let ffm;
    if (impedance > 100 && impedance < 1000) {
      // 使用 BIA 阻抗公式（基于人群验证的回归模型）[^5^]
      // FFM = 0.7374*(Ht²/R) + 0.1763*BW - 0.1773*Age + 0.1198*Xc - 2.4658
      // 简化版（单频 BIA，无 reactance 数据）：
      const h2r = (heightCm ** 2) / impedance;
      ffm = 0.7374 * h2r + 0.1763 * weight - 0.1773 * age - 2.4658;

      // 性别校正
      ffm += isMale ? 2.5 : -1.5;

      // 确保 FFM 在合理范围
      ffm = Math.max(weight * 0.5, Math.min(weight * 0.95, ffm));
    } else {
      // 无阻抗：使用 BMI 估算
      const sexFactor = isMale ? 1 : 0;
      ffm = weight * (1 - ((1.2 * bmi) + (0.23 * age) - (10.8 * sexFactor) - 5.4) / 100);
      ffm = Math.max(weight * 0.5, Math.min(weight * 0.9, ffm));
    }

    // ===== 2. 体脂率 =====
    const bodyFat = ((weight - ffm) / weight) * 100;
    const clampedBodyFat = Math.max(5, Math.min(50, bodyFat));

    // ===== 3. 总水分（TBW）- 基于 Watson 公式 =====
    let tbw;
    if (isMale) {
      tbw = 2.447 - 0.09516 * age + 0.1074 * heightCm + 0.3362 * weight;
    } else {
      tbw = -2.097 + 0.1069 * heightCm + 0.2466 * weight;
    }
    const water = Math.max(45, Math.min(75, (tbw / weight) * 100));

    // ===== 4. 肌肉量（骨骼肌）- 优化版 =====
    // 骨骼肌约占 FFM 的 50-55%（去骨、去器官质量）
    const muscleRatio = isMale ? 0.54 : 0.49;
    const muscleMass = ffm * muscleRatio;

    // ===== 5. 蛋白质 =====
    // 蛋白质约占体重的 16-20%，与肌肉量正相关
    const protein = Math.min(25, Math.max(12, (muscleMass / weight) * 22));

    // ===== 6. 基础代谢率（Mifflin-St Jeor）=====
    let bmr;
    if (isMale) {
      bmr = 10 * weight + 6.25 * heightCm - 5 * age + 5;
    } else {
      bmr = 10 * weight + 6.25 * heightCm - 5 * age - 161;
    }

    // ===== 7. 内脏脂肪等级 =====
    let visceralFat;
    if (isMale) {
      visceralFat = 0.74 * bmi + 0.15 * age - 10.5;
    } else {
      visceralFat = 0.74 * bmi + 0.15 * age - 16.0;
    }
    visceralFat = Math.max(1, Math.min(30, visceralFat));

    // ===== 8. 骨量 =====
    // 成人骨量约占体重 3-5%
    const boneMass = weight * (0.035 + (heightCm - 160) * 0.00008);

    // ===== 9. 标准体重 =====
    const standardWeight = (heightCm - 100) * 0.9;

    // ===== 10. 身体评分（综合健康指数）=====
    let bodyScore = 100;

    // BMI 扣分
    if (bmi < 18.5) bodyScore -= 12;
    else if (bmi >= 28) bodyScore -= 15;
    else if (bmi >= 24) bodyScore -= 8;

    // 体脂率扣分
    const normalBodyFatMax = isMale ? 20 : 28;
    const normalBodyFatMin = isMale ? 10 : 18;
    if (clampedBodyFat > normalBodyFatMax) bodyScore -= 10;
    else if (clampedBodyFat < normalBodyFatMin) bodyScore -= 5;

    // 内脏脂肪扣分
    if (visceralFat > 10) bodyScore -= 12;
    else if (visceralFat > 8) bodyScore -= 6;

    // 水分扣分
    if (water < 50) bodyScore -= 5;

    // 肌肉量加分（相对于标准）
    const standardMuscle = isMale ? weight * 0.42 : weight * 0.38;
    if (muscleMass > standardMuscle * 1.1) bodyScore += 5;

    bodyScore = Math.max(60, Math.min(100, bodyScore));

    // ===== 11. 健康建议 =====
    let advice = '';
    let adviceLevel = 'normal';

    if (bmi < 18.5) {
      advice = '体重偏轻，建议增加优质蛋白摄入，配合力量训练增加肌肉量';
      adviceLevel = 'warning';
    } else if (bmi < 24) {
      if (clampedBodyFat > normalBodyFatMax) {
        advice = '体重正常但体脂偏高，建议每周进行 150 分钟有氧运动，控制精制碳水摄入';
        adviceLevel = 'warning';
      } else if (visceralFat > 8) {
        advice = '体型良好，但内脏脂肪略高，注意减少久坐，增加核心肌群训练';
        adviceLevel = 'warning';
      } else if (muscleMass < standardMuscle * 0.9) {
        advice = '肌肉量不足，建议增加抗阻训练，补充足量蛋白质（每公斤体重 1.2-1.6g）';
        adviceLevel = 'warning';
      } else {
        advice = '各项指标良好，请继续保持规律运动和均衡饮食';
        adviceLevel = 'normal';
      }
    } else if (bmi < 28) {
      advice = '体重超重，建议控制每日热量摄入（减少 300-500kcal），每周运动 200 分钟以上';
      adviceLevel = 'warning';
    } else {
      advice = '肥胖风险较高，建议咨询专业医生或营养师制定科学减重方案，关注代谢指标';
      adviceLevel = 'danger';
    }

    // 预计算百分比（供 WXML 绑定，WXML 不支持复杂表达式）
    const muscleMassPercent = weight > 0 ? round((muscleMass / weight) * 100, 1) : 0;
    const boneMassPercent = weight > 0 ? round((boneMass / weight) * 100, 1) : 0;

    // 预计算 BMI 范围
    const bmiRangeClass = bmi < 18.5 || bmi >= 24 ? 'warning' : '';
    const bmiRangeText = bmi < 18.5 ? '偏瘦' : (bmi < 24 ? '正常' : (bmi < 28 ? '超重' : '肥胖'));

    // 预计算体脂范围（复用上面的 isMale）
    const bodyFatRangeClass = clampedBodyFat > (isMale ? 20 : 28) ? 'warning' : '';
    const genderLabel = isMale ? '男' : '女';
    const bodyFatNormalRange = isMale ? '10-20%' : '18-28%';

    // 预计算评分颜色和等级
    const bodyScoreColor = bodyScore >= 90 ? '#10B981' :
        (bodyScore >= 80 ? '#3B82F6' :
            (bodyScore >= 70 ? '#F59E0B' : '#EF4444'));
    const bodyScoreGrade = bodyScore >= 90 ? '优秀' :
        (bodyScore >= 80 ? '良好' :
            (bodyScore >= 70 ? '一般' : '需改善'));

    // 预计算内脏脂肪文本
    const visceralFatText = visceralFat <= 9 ? '正常' :
        (visceralFat <= 14 ? '偏高' : '过高');

    // 预计算建议图标
    const adviceIcon = adviceLevel === 'normal' ? '✅' :
        (adviceLevel === 'warning' ? '⚠️' : '🚨');

    // 预计算保存状态
    const autoSaved = this.data.autoSaved;
    const saving = this.data.saving;
    const saveCardClass = autoSaved ? 'saved' : (saving ? 'saving' : '');
    const saveStatusText = saving ? '正在保存...' : (autoSaved ? '已保存到云端' : '准备保存');

    // 更新数据并触发动画
    this.setData({
      appState: APP_STATE.COMPLETED,
      stateDisplay: '测量完成',
      stateIcon: 'check',
      pulseAnimation: false,

      bmi: round(bmi, 1),
      bodyFat: round(clampedBodyFat, 1),
      water: round(water, 1),
      muscleMass: round(muscleMass, 1),
      protein: round(protein, 1),
      bmr: Math.round(bmr),
      visceralFat: round(visceralFat, 1),
      boneMass: round(boneMass, 2),
      standardWeight: round(standardWeight, 1),
      bodyScore: Math.round(bodyScore),
      advice,
      adviceLevel,

      // WXML 预计算字段
      muscleMassPercent,
      boneMassPercent,
      stateIconEmoji: this.data.stateIconEmoji,
      bmiRangeClass,
      bmiRangeText,
      bodyFatRangeClass,
      genderLabel,
      bodyFatNormalRange,
      bodyScoreColor,
      bodyScoreGrade,
      visceralFatText,
      adviceIcon,
      saveCardClass,
      saveStatusText,
      scoreBarOffset: 326.73 - (bodyScore / 100) * 326.73,

      showResultPanel: true,
      slideIn: true
    });

    // 自动保存
    this.autoSaveMeasurement();
  },

  // ======================
  // 家庭成员管理
  // ======================
  async loadMembers() {
    this.setData({ isLoadingMembers: true });

    try {
      const userInfo = wx.getStorageSync('userInfo');
      const userId = userInfo ? userInfo.user_id : null;

      const res = await cloudRequest.callContainer({
        path: `/api/scale/members${userId ? '?user_id=' + userId : ''}`,
        method: 'GET'
      });

      if (res.code === 200 && res.data) {
        const members = res.data.map(m => ({
          id: m.id,
          name: m.name,
          age: m.age,
          height: m.height,
          gender: m.gender,
          avatarColor: this.getRandomAvatarColor(),
          lastWeight: m.last_weight || null,
          lastMeasureTime: m.last_measure_time ? new Date(m.last_measure_time).getTime() : null,
          weightHistory: m.weight_history || [],
          isMatched: false
        }));

        this.setData({ members });
        wx.setStorageSync('scaleMembers', members);
      }
    } catch (err) {
      console.error('[Scale] 加载成员失败:', err);
      const localMembers = wx.getStorageSync('scaleMembers');
      if (localMembers && localMembers.length > 0) {
        this.setData({ members: localMembers });
      }
    } finally {
      this.setData({ isLoadingMembers: false });
    }
  },

  selectMember(e) {
    const memberId = e.currentTarget.dataset.id;
    const member = this.data.members.find(m => m.id === memberId);
    if (!member) return;

    this.setData({
      selectedMemberId: memberId,
      currentMember: {
        height: member.height,
        age: member.age,
        gender: member.gender
      },
      matchedMember: null,
      matchConfidence: 0
    });

    wx.setStorageSync('lastSelectedMemberId', memberId);

    if (this.data.lockedWeight) {
      this.calculateBodyMetrics();
    }
  },

  // ======================
  // 自动保存（含离线队列）
  // ======================
  async autoSaveMeasurement() {
    const { lockedWeight, lockedImpedance, selectedMemberId, bmi, bodyFat, water, muscleMass, protein, bmr, visceralFat, boneMass } = this.data;

    if (!lockedWeight || !selectedMemberId) {
      console.warn('[Scale] 无法保存：缺少体重或成员信息');
      return;
    }

    this.setData({ saving: true });

    const measurementData = {
      member_id: selectedMemberId,
      weight: lockedWeight,
      impedance: lockedImpedance || 0,
      bmi: parseFloat(bmi),
      body_fat: parseFloat(bodyFat),
      water: parseFloat(water),
      muscle_mass: parseFloat(muscleMass),
      protein: parseFloat(protein),
      bmr: parseInt(bmr),
      visceral_fat: parseFloat(visceralFat),
      bone_mass: parseFloat(boneMass),
      measured_at: new Date().toISOString()
    };

    try {
      const res = await cloudRequest.callContainer({
        path: '/api/scale/measurements',
        method: 'POST',
        data: measurementData
      });

      if (res.code === 200) {
        this.setData({
          autoSaved: true,
          saving: false,
          saveCardClass: 'saved',
          saveStatusText: '已保存到云端'
        });

        // 更新成员最近体重
        const members = this.data.members.map(m => {
          if (m.id === selectedMemberId) {
            return {
              ...m,
              lastWeight: lockedWeight,
              lastMeasureTime: Date.now(),
              weightHistory: [...(m.weightHistory || []).slice(-29), {
                date: new Date().toISOString(),
                weight: lockedWeight
              }]
            };
          }
          return m;
        });

        this.setData({ members });
        wx.setStorageSync('scaleMembers', members);

        wx.showToast({
          title: '保存成功',
          icon: 'success',
          duration: 1500
        });
      }
    } catch (err) {
      console.error('[Scale] 保存失败:', err);
      this.setData({ saving: false });

      // 离线缓存
      const offlineData = wx.getStorageSync('offlineMeasurements') || [];
      offlineData.push(measurementData);
      wx.setStorageSync('offlineMeasurements', offlineData);

      wx.showToast({
        title: '已离线保存，联网后同步',
        icon: 'none',
        duration: 2000
      });
    }
  },

  // ======================
  // 重置测量状态
  // ======================
  resetMeasurementState() {
    this.stopImpedanceTimer();

    this.setData({
      measurementLocked: false,
      lockedWeight: null,
      lockedImpedance: null,
      lockTimestamp: 0,
      isStabilized: false,
      stabilityProgress: 0,
      weightHistory: [],
      impedanceWaiting: false,
      impedanceWaitProgress: 0,
      autoSaved: false,
      saving: false,
      showResultPanel: false,
      slideIn: false,
      matchedMember: null,
      matchConfidence: 0,

      bmi: null,
      bodyFat: null,
      water: null,
      muscleMass: null,
      protein: null,
      bmr: null,
      visceralFat: null,
      boneMass: null,
      standardWeight: null,
      bodyScore: 0,
      advice: null,
      adviceLevel: 'normal'
    });
  },

  // ======================
  // 手动开始测量流程
  // ======================
  startMeasurementFlow() {
    this.resetMeasurementState();

    if (!this.data.bleAvailable) {
      this.initBLE();
      return;
    }

    if (!this.data.bleScanning) {
      this.startBLEScan();
    }
  },

  // ======================
  // 其他原有方法（兼容）
  // ======================
  onLongPressMember(e) {
    const memberId = e.currentTarget.dataset.id;
    const memberName = e.currentTarget.dataset.name;

    wx.showActionSheet({
      itemList: ['编辑', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.editMember(memberId);
        } else if (res.tapIndex === 1) {
          this.deleteMember(memberId, memberName);
        }
      }
    });
  },

  editMember(memberId) {
    const member = this.data.members.find(m => m.id === memberId);
    if (!member) return;

    this.setData({
      showAddMemberDialog: true,
      editingMemberId: memberId,
      newMemberName: member.name,
      newMemberAge: String(member.age),
      newMemberHeight: String(member.height),
      newMemberGender: member.gender === 'male' ? '男' : '女',
      newMemberGenderIndex: member.gender === 'male' ? 0 : 1
    });
  },

  deleteMember(memberId, memberName) {
    wx.showModal({
      title: '确认删除',
      content: `确定要删除「${memberName}」吗？相关历史数据也将被删除`,
      success: (res) => {
        if (res.confirm) {
          const members = this.data.members.filter(m => m.id !== memberId);
          this.setData({ members });
          wx.setStorageSync('scaleMembers', members);

          if (this.data.selectedMemberId === memberId) {
            this.setData({
              selectedMemberId: null,
              currentMember: { height: 170, age: 25, gender: 'male' }
            });
          }

          wx.showToast({ title: '删除成功', icon: 'success' });
        }
      }
    });
  },

  getRandomAvatarColor() {
    const colors = [
      'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
      'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
      'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
      'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
      'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  },

  showAddMemberModal() {
    this.setData({
      showAddMemberDialog: true,
      editingMemberId: null,
      newMemberName: '',
      newMemberAge: '',
      newMemberHeight: '',
      newMemberGender: '',
      newMemberGenderIndex: 0
    });
  },

  closeAddMemberModal() {
    this.setData({ showAddMemberDialog: false });
  },

  stopPropagation() {},
  onMemberNameInput(e) { this.setData({ newMemberName: e.detail.value }); },
  onMemberAgeInput(e) { this.setData({ newMemberAge: e.detail.value }); },
  onMemberHeightInput(e) { this.setData({ newMemberHeight: e.detail.value }); },
  onMemberGenderChange(e) {
    const index = e.detail.value;
    this.setData({
      newMemberGenderIndex: index,
      newMemberGender: index === 0 ? '男' : '女'
    });
  },

  async submitAddMember() {
    const { newMemberName, newMemberAge, newMemberHeight, newMemberGender, editingMemberId } = this.data;

    if (!newMemberName || !newMemberAge || !newMemberHeight || !newMemberGender) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' });
      return;
    }

    const age = parseInt(newMemberAge);
    const height = parseInt(newMemberHeight);

    if (age < 1 || age > 150 || height < 50 || height > 250) {
      wx.showToast({ title: '年龄或身高不合理', icon: 'none' });
      return;
    }

    try {
      const memberData = {
        name: newMemberName,
        age,
        height,
        gender: newMemberGender === '男' ? 'male' : 'female'
      };

      let res;
      if (editingMemberId) {
        res = await cloudRequest.callContainer({
          path: `/api/scale/members/${editingMemberId}`,
          method: 'PUT',
          data: memberData
        });
      } else {
        res = await cloudRequest.callContainer({
          path: '/api/scale/members',
          method: 'POST',
          data: memberData
        });
      }

      if (res.code === 200) {
        wx.showToast({ title: editingMemberId ? '修改成功' : '添加成功', icon: 'success' });
        this.closeAddMemberModal();
        this.loadMembers();
      }
    } catch (err) {
      console.error('[Scale] 保存成员失败:', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  }
});

// 工具函数
function round(num, decimals) {
  return parseFloat(num.toFixed(decimals));
}
