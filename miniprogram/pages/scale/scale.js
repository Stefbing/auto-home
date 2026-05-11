const cloudRequest = require('../../utils/cloud_request.js');
const BLEUtils = require('../../utils/ble_scale.js');

// ======================
// 简化状态机（3个状态）
// ======================
const APP_STATE = {
  IDLE: 'idle',           // 空闲等待
  MEASURING: 'measuring', // 测量中（包含稳定检测）
  COMPLETED: 'completed'  // 完成（显示结果）
};

const CONFIG = {
  // 稳定检测：连续 3 次差异 < 0.3kg
  STABILITY_THRESHOLD: 0.3,
  STABILITY_COUNT: 3,

  // 最小有效体重：> 3kg 视为上秤
  MIN_VALID_WEIGHT: 3,

  // 最大体重限制
  MAX_WEIGHT: 300,

  // 成员匹配容差：10kg（增大使能匹配体重波动）
  MATCH_TOLERANCE: 10,

  // 数据新鲜度阈值 10秒
  FRESHNESS_THRESHOLD: 10000,

  // 体重骤降阈值：变化超过10kg视为下秤
  WEIGHT_DROP_THRESHOLD: 10,

  // 测量完成后延迟重置时间（毫秒）
  RESET_DELAY: 5000
};

Page({
  data: {
    // ===== 核心测量数据 =====
    weight: 0,
    weightDisplay: '0.00',
    impedance: 0,
    isStabilized: false,

    // ===== 状态机（3个状态）=====
    appState: APP_STATE.IDLE,

    // ===== 稳定性检测 =====
    stabilityProgress: 0,
    weightHistory: [],

    // ===== 锁定机制 =====
    measurementLocked: false,
    lockedWeight: null,
    lockedImpedance: null,

    // ===== 称重页完成标志（用于控制是否接收蓝牙数据）=====
    scalePageCompleted: false,  // true=已完成且未重置，忽略所有蓝牙数据

    // ===== 家庭成员 =====
    members: [],
    selectedMemberId: null,
    matchedMember: null,

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

    // ===== 延迟重置定时器 =====
    resetTimer: null,
    resetCountdown: 30, // 倒计时秒数
    autoResetCancelled: false,  // 用户是否取消了自动重置

    // ===== 阻抗等待定时器 =====
    impedanceWaitTimer: null,

    // ===== 动画控制 =====
    pulseAnimation: false,
    slideIn: false,
    showResultPanel: false,

    // ===== 蓝牙状态 =====
    bleAvailable: false,
    connectedDevice: null,
    deviceOnlineStatus: 'offline',  // 设备在线状态（从app.js同步）

    // ===== 预计算值（供 WXML 绑定）=====
    muscleMassPercent: 0,
    needleAngle: -90,
    scoreBarOffset: 326.73,
    statusPillText: '准备就绪',
    bmiRangeClass: '',
    bmiRangeText: '',
    bodyFatRangeClass: '',
    genderLabel: '',
    bodyFatNormalRange: '',
    bodyScoreColor: '#10B981',
    bodyScoreGrade: '优秀',
    visceralFatText: '正常',
    showMemberSection: false
  },

  // ======================
  // 生命周期
  // ======================
  onLoad(options) {
    // 订阅蓝牙数据流（发布-订阅模式）
    this.unsubscribe = getApp().subscribeScaleData(this.handleScaleData.bind(this));

    // 加载成员数据（优先使用全局预加载的）
    this.loadMembers();
  },

  onShow() {
    console.log('[Scale] 📄 页面显示');

    // 【关键】页面重新显示时，完全重置到初始状态
    this.setData({ 
      scalePageCompleted: false,
      weight: 0,
      weightDisplay: '0.00',
      impedance: 0,
      isStabilized: false,
      appState: APP_STATE.IDLE,
      stabilityProgress: 0,
      weightHistory: [],
      measurementLocked: false,
      lockedWeight: null,
      lockedImpedance: null,
      needleAngle: -90,
      statusPillText: '准备就绪'
    });

    // 检查蓝牙状态
    this.checkBLEState();

    // 同步设备在线状态
    this.syncDeviceOnlineStatus();

    // 注意：不再自动处理旧数据，等待新的蓝牙广播
    // const latestData = getApp().globalData.latestScaleData;
    // if (latestData && latestData.weight >= CONFIG.MIN_VALID_WEIGHT) {
    //   this.handleScaleData(latestData);
    // }
  },

  onHide() {
    console.log('[Scale] 📄 页面隐藏');

    // 清除延迟重置定时器
    if (this.data.resetTimer) {
      clearTimeout(this.data.resetTimer);
      this.setData({ resetTimer: null });
    }

    // 清除阻抗等待定时器
    if (this.data.impedanceWaitTimer) {
      clearTimeout(this.data.impedanceWaitTimer);
      this.setData({ impedanceWaitTimer: null });
    }

    // 取消订阅
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  },

  onUnload() {
    // 清除延迟重置定时器
    if (this.data.resetTimer) {
      clearTimeout(this.data.resetTimer);
      this.setData({ resetTimer: null });
    }

    // 清除阻抗等待定时器
    if (this.data.impedanceWaitTimer) {
      clearTimeout(this.data.impedanceWaitTimer);
      this.setData({ impedanceWaitTimer: null });
    }

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  },

  // ======================
  // 蓝牙状态检查
  // ======================
  checkBLEState() {
    wx.getBluetoothAdapterState({
      success: (res) => {
        this.setData({ bleAvailable: res.available });
      },
      fail: () => {
        this.setData({ bleAvailable: false });
      }
    });
  },

  // 同步设备在线状态
  syncDeviceOnlineStatus() {
    const app = getApp();
    const status = app.globalData.scaleConnectionStatus || 'offline';
    this.setData({ deviceOnlineStatus: status });
    console.log('[Scale] 📡 设备在线状态:', status);
  },

  // ======================
  // 核心数据处理（订阅回调）
  // ======================
  handleScaleData(data) {
    console.log('[Scale] 📡 收到数据:', data);

    // 【关键】如果称重页已完成且未重置，忽略所有蓝牙数据
    if (this.data.scalePageCompleted) {
      console.log('[Scale] ⏸️ 称重页已完成，忽略蓝牙数据');
      return;
    }

    // 过滤无效数据
    if (!data || data.weight < CONFIG.MIN_VALID_WEIGHT || data.weight > CONFIG.MAX_WEIGHT) {
      return;
    }

    // 注意：数据已在 app.js 中经过新鲜度检测和去重检测，此处无需重复检测

    // 检测体重骤降（下秤）
    if (this.data.appState === APP_STATE.COMPLETED && this.data.lockedWeight) {
      const weightDrop = this.data.lockedWeight - data.weight;

      // 只有体重下降且低于最小有效体重，才视为下秤
      if (weightDrop > CONFIG.WEIGHT_DROP_THRESHOLD && data.weight < CONFIG.MIN_VALID_WEIGHT * 2) {
        console.log('[Scale] ⚠️ 检测到体重骤降:', weightDrop.toFixed(2), 'kg，视为下秤');
        // 清除延迟重置定时器
        if (this.data.resetTimer) {
          clearTimeout(this.data.resetTimer);
          this.setData({ resetTimer: null });
        }
        // 立即重置
        this.resetMeasurement();
        return;
      }
    }

    // COMPLETED 状态下，如果收到阻抗数据且之前没有，重新计算
    if (this.data.appState === APP_STATE.COMPLETED &&
        this.data.measurementLocked &&
        !this.data.lockedImpedance &&
        data.impedanceValid &&
        data.impedance > 0) {
      console.log('[Scale] 🔄 延迟收到阻抗数据，重新计算');
      this.setData({
        lockedImpedance: data.impedance,
        impedance: data.impedance,
        impedanceValid: true
      });
      this.calculateBodyMetrics(this.data.lockedWeight, data.impedance);
      // 重新保存
      this.autoSaveMeasurement();
      return;
    }

    // 更新历史
    const history = [...this.data.weightHistory, {
      weight: data.weight,
      timestamp: Date.now()
    }];
    if (history.length > 10) history.shift(); // 保留最近10条

    // 检测稳定性：优先使用广播数据的 isStabilized 标识位
    const isStable = data.isStabilized || this.checkStability(history);

    // 如果有阻抗数据，说明测量完成且稳定
    const hasImpedance = data.impedance > 0 && data.impedanceValid;
    const finalStable = isStable || hasImpedance;

    const stabilityProgress = finalStable ? 100 : Math.min(100, Math.round((history.length / CONFIG.STABILITY_COUNT) * 100));

    // 更新显示
    const needleAngle = (data.weight / 150) * 180 - 90;
    const statusPillText = this.getStatusText(data, finalStable);

    this.setData({
      weight: data.weight,
      weightDisplay: data.weight.toFixed(2),
      impedance: data.impedance || 0,
      isStabilized: finalStable,
      stabilityProgress,
      weightHistory: history,
      needleAngle,
      statusPillText
    });

    // 状态转换
    this.processStateTransition(data, finalStable);
  },

  // ======================
  // 稳定性检测（纯函数）
  // ======================
  checkStability(history) {
    if (history.length < CONFIG.STABILITY_COUNT) return false;

    const recent = history.slice(-CONFIG.STABILITY_COUNT);
    for (let i = 1; i < recent.length; i++) {
      if (Math.abs(recent[i].weight - recent[i - 1].weight) > CONFIG.STABILITY_THRESHOLD) {
        return false;
      }
    }
    return true;
  },

  // ======================
  // 状态转换逻辑（独立函数）
  // ======================
  processStateTransition(data, isStable) {
    const currentState = this.data.appState;

    // IDLE → MEASURING
    if (currentState === APP_STATE.IDLE && data.weight >= CONFIG.MIN_VALID_WEIGHT) {
      this.transitionState(APP_STATE.MEASURING);
      return;
    }

    // MEASURING → COMPLETED（体重稳定 且 有阻抗数据）
    if (currentState === APP_STATE.MEASURING && !this.data.measurementLocked) {
      const hasImpedance = data.impedance > 0 && data.impedanceValid;

      // 必须有阻抗数据才锁定
      if (hasImpedance && isStable) {
        console.log('[Scale] ✅ 检测到阻抗数据且稳定，立即锁定');
        this.lockAndCalculate(data);
        return;
      }

      // 如果稳定但没有阻抗，持续等待（不设置超时）
      if (isStable && !this.data.impedanceWaitTimer) {
        console.log('[Scale] ⏳ 体重稳定，等待阻抗数据...');

        // 提示用户站好位置
        wx.showToast({
          title: '请站稳在电极片上',
          icon: 'none',
          duration: 3000
        });
      }
    }

    // COMPLETED → 检测新测量（体重变化 > 0.3kg）
    if (currentState === APP_STATE.COMPLETED && this.data.measurementLocked) {
      // 如果用户取消了自动重置，忽略所有新数据
      if (this.data.autoResetCancelled) {
        console.log('[Scale] ⏸️ 用户已取消自动重置，忽略新数据');
        return;
      }

      // 检查是否在延迟重置期内
      if (this.data.resetTimer) {
        console.log('[Scale] ⏸️ 延迟重置期内，忽略新数据');
        return;
      }

      const weightDiff = Math.abs(this.data.lockedWeight - data.weight);
      if (weightDiff > 0.3) {
        this.resetMeasurement();
        this.transitionState(APP_STATE.MEASURING);
      }
    }
  },

  // ======================
  // 状态转换
  // ======================
  transitionState(newState) {
    console.log(`[Scale] 🔄 状态转换: ${this.data.appState} → ${newState}`);

    const stateConfig = {
      [APP_STATE.IDLE]: { text: '准备就绪' },
      [APP_STATE.MEASURING]: { text: '实时测量中' },
      [APP_STATE.COMPLETED]: { text: '测量完成' }
    };

    this.setData({
      appState: newState,
      statusPillText: stateConfig[newState]?.text || ''
    });
  },

  // ======================
  // 锁定数据并计算体脂
  // ======================
  async lockAndCalculate(data) {
    console.log('[Scale] 🔒 锁定数据:', data);

    // 先自动匹配成员，等待 setData 完成
    const matchSuccess = await this.autoMatchMember(data.weight);

    if (!matchSuccess) {
      console.warn('[Scale] ⚠️ 成员匹配失败，无法保存');
      return;
    }

    // 锁定
    this.setData({
      measurementLocked: true,
      lockedWeight: data.weight,
      lockedImpedance: data.impedance || 0,
      scalePageCompleted: true  // 【关键】标记称重页已完成，后续忽略蓝牙数据
    });

    // 过渡到 COMPLETED
    this.transitionState(APP_STATE.COMPLETED);

    // 异步计算体脂（不阻塞 UI）
    try {
      await this.calculateBodyMetrics(data.weight, data.impedance);

      // 震动反馈
      wx.vibrateShort({ type: 'medium' });

      // 延迟一下确保 setData 完成，然后保存
      setTimeout(() => {
        this.autoSaveMeasurement();
      }, 100);

      // 启动10秒倒计时自动重置
      this.startResetCountdown();
    } catch (err) {
      console.error('[Scale] 计算失败:', err);
    }
  },

  // ======================
  // 启动重置倒计时
  // ======================
  startResetCountdown() {
    let countdown = 30;
    this.setData({ resetCountdown: countdown });

    const timer = setInterval(() => {
      countdown--;
      if (countdown <= 0) {
        clearInterval(timer);
        console.log('[Scale] ⏰ 倒计时结束，自动重置');
        this.resetMeasurement();
      } else {
        this.setData({ resetCountdown: countdown });
      }
    }, 1000);

    this.setData({ resetTimer: timer });
  },

  // ======================
  // 手动取消重置
  // ======================
  cancelReset() {
    console.log('[Scale] ❌ 用户取消重置');
    if (this.data.resetTimer) {
      clearInterval(this.data.resetTimer);
      this.setData({
        resetTimer: null,
        resetCountdown: 0,
        autoResetCancelled: true  // 标记用户已取消自动重置
        // scalePageCompleted 保持为 true，继续忽略蓝牙数据
      });
    }
  },

  // ======================
  // 立即重置
  // ======================
  immediateReset() {
    console.log('[Scale] 🔄 用户立即重置');
    this.resetMeasurement();
  },

  // ======================
  // 重置测量
  // ======================
  resetMeasurement() {
    console.log('[Scale] 🧹 重置测量');

    // 清除延迟重置定时器（支持 setInterval）
    if (this.data.resetTimer) {
      clearInterval(this.data.resetTimer);
      this.setData({ resetTimer: null });
    }

    // 清除阻抗等待定时器
    if (this.data.impedanceWaitTimer) {
      clearTimeout(this.data.impedanceWaitTimer);
      this.setData({ impedanceWaitTimer: null });
    }

    this.setData({
      weight: 0,
      weightDisplay: '0.00',
      impedance: 0,
      isStabilized: false,
      appState: APP_STATE.IDLE,
      stabilityProgress: 0,
      weightHistory: [],
      measurementLocked: false,
      lockedWeight: null,
      lockedImpedance: null,
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
      needleAngle: -90,
      scoreBarOffset: 326.73,
      statusPillText: '准备就绪',
      matchedMember: null,
      autoResetCancelled: false,  // 重置取消标志
      scalePageCompleted: false   // 【关键】重置完成标志，允许重新接收蓝牙数据
      // 注意：不重置 showMemberSection，保持成员列表显示
    });

    // 清空全局数据
    getApp().globalData.latestScaleData = null;
  },

  // ======================
  // 获取状态文本
  // ======================
  getStatusText(data, isStable) {
    if (this.data.appState === APP_STATE.IDLE) {
      // IDLE 状态下，根据是否有体重数据显示不同文本
      if (data && data.weight >= CONFIG.MIN_VALID_WEIGHT) {
        return '请站到秤上';
      }
      return '准备就绪';
    }
    if (this.data.appState === APP_STATE.COMPLETED) return '测量完成';

    // MEASURING 状态
    if (isStable) {
      return data.impedance > 0 ? '已稳定，分析中...' : '趋于稳定...';
    }
    return '实时测量中';
  },

  // ======================
  // 加载成员数据
  // ======================
  async loadMembers() {
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.user_id) return;

    // 优先使用全局预加载的数据
    const globalMembers = getApp().globalData.scaleMembers;
    if (globalMembers && globalMembers.length > 0) {
      console.log('[Scale] ✅ 使用预加载的成员数据:', globalMembers.length, '个');
      // 转换字段名：avatar_color -> avatarColor
      const normalizedMembers = globalMembers.map(m => ({
        ...m,
        avatarColor: m.avatar_color || m.avatarColor
      }));
      console.log('[Scale] 📋 转换后的成员数据:', JSON.stringify(normalizedMembers[0]));
      this.setData({
        members: normalizedMembers,
        showMemberSection: true  // 自动显示成员区域
      });
      console.log('[Scale] ✅ setData 完成，members.length:', this.data.members.length);
      return;
    }

    // 如果已经加载过，不再重复请求
    if (this.data.members.length > 0) {
      console.log('[Scale] ⚠️ 成员数据已加载，跳过');
      return;
    }

    // 否则从后端加载
    try {
      console.log('[Scale] 🔍 从后端加载成员...');
      const res = await new Promise((resolve, reject) => {
        cloudRequest.callContainer({
          path: `/api/scale/members?user_id=${userInfo.user_id}`,
          method: 'GET',
          success: resolve,
          fail: reject
        });
      });

      console.log('[Scale] 📦 成员接口返回:', res);

      // 注意：res 直接是 {code, data} 结构，或者就是数组
      let members = [];
      if (res.code === 200 && res.data) {
        members = res.data;
      } else if (Array.isArray(res)) {
        members = res;
      }

      if (members.length > 0) {
        // 转换字段名：avatar_color -> avatarColor
        const normalizedMembers = members.map(m => ({
          ...m,
          avatarColor: m.avatar_color || m.avatarColor
        }));
        this.setData({
          members: normalizedMembers,
          showMemberSection: true  // 自动显示成员区域
        });
        console.log(`[Scale] ✅ 加载 ${normalizedMembers.length} 个成员`);
      } else {
        console.warn('[Scale] ⚠️ 未找到成员数据');
      }
    } catch (err) {
      console.error('[Scale] ❌ 加载成员失败:', err);
    }
  },

  // ======================
  // 自动匹配成员
  // ======================
  autoMatchMember(weight) {
    return new Promise((resolve) => {
      if (!this.data.members || this.data.members.length === 0) {
        // 无成员，弹出创建
        this.showCreateMemberModal(weight);
        resolve(false);
        return;
      }

      // 查找所有在容差范围内的成员
      const candidates = [];
      this.data.members.forEach(member => {
        if (!member.last_weight) return;

        const diff = Math.abs(member.last_weight - weight);
        if (diff < CONFIG.MATCH_TOLERANCE) {
          candidates.push({ member, diff });
        }
      });

      if (candidates.length === 0) {
        // 无匹配，弹出创建
        this.showCreateMemberModal(weight);
        resolve(false);
        return;
      }

      // 按体重差异排序
      candidates.sort((a, b) => a.diff - b.diff);

      // 如果只有一个候选或差异明显，直接选择
      if (candidates.length === 1 || (candidates[1].diff - candidates[0].diff > 2)) {
        const bestMatch = candidates[0].member;

        this.setData({
          matchedMember: bestMatch,
          selectedMemberId: bestMatch.id,
          currentMember: {
            height: bestMatch.height,
            age: bestMatch.age,
            gender: bestMatch.gender
          }
        }, () => {
          console.log('[Scale] ✅ 自动匹配成员:', bestMatch.name, '差异:', candidates[0].diff.toFixed(2), 'kg');
          resolve(true);
        });
      } else {
        // 多个候选且差异小，选择最近的成员
        const bestMatch = candidates[0].member;
        console.log('[Scale] ⚠️ 多个候选成员，自动选择最近:', bestMatch.name);

        this.setData({
          matchedMember: bestMatch,
          selectedMemberId: bestMatch.id,
          currentMember: {
            height: bestMatch.height,
            age: bestMatch.age,
            gender: bestMatch.gender
          }
        }, () => {
          resolve(true);
        });
      }
    });
  },

  // ======================
  // 显示创建成员弹窗
  // ======================
  showCreateMemberModal(weight) {
    wx.showModal({
      title: '创建新成员',
      content: `检测到新体重 ${weight.toFixed(1)}kg，是否创建新成员？`,
      confirmText: '创建',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          // 使用弹窗创建成员，不跳转页面
          this.setData({
            showAddMemberDialog: true,
            editingMemberId: null,
            newMemberName: '',
            newMemberAge: '',
            newMemberHeight: '',
            newMemberGender: 'male',
            newMemberGenderIndex: 0
          });
        }
      }
    });
  },

  // ======================
  // 选择成员
  // ======================
  selectMember(e) {
    const memberId = e.currentTarget.dataset.id;
    const member = this.data.members.find(m => m.id === memberId);

    if (member) {
      this.setData({
        selectedMemberId: memberId,
        currentMember: {
          height: member.height,
          age: member.age,
          gender: member.gender
        },
        matchedMember: null // 清除自动匹配
      });

      // 重新计算
      if (this.data.lockedWeight) {
        this.calculateBodyMetrics(this.data.lockedWeight, this.data.lockedImpedance);
      }

      wx.setStorageSync('lastSelectedMemberId', memberId);
    }
  },

  // ======================
// 小米体脂秤2 BIA生物电阻抗算法（优化版）
// ======================
async calculateBodyMetrics(weight, impedance = 0) {
  const { height, age, gender } = this.data.currentMember;
  
  // 参数校验
  if (!height || !age || height <= 0 || age <= 0 || weight <= 0) {
    console.warn('[Scale] ⚠️ 参数不完整或无效');
    return;
  }

  const isMale = gender === 'male';
  const heightCm = height; // 厘米
  const heightM = height / 100; // 米
  
  // 1. BMI 计算
  const bmi = weight / (heightM * heightM);
  
  // 2. 阻抗指数 (Impedance Index) - BIA核心变量
  let impedanceIndex = 0;
  if (impedance > 0) {
    // 阻抗指数 = 身高²(cm) / 阻抗(Ω)
    impedanceIndex = (heightCm * heightCm) / impedance;
  } else {
    console.warn('[Scale] ⚠️ 阻抗为0，使用BMI估算模式');
  }

  // 3. 体脂率 (Body Fat %) - BIA生物电阻抗算法
  let bodyFat = 0;
  let ffm = 0; // 去脂体重
  
  if (impedance > 0) {
    // 使用简化的BIA公式（基于体重、阻抗、身高）
    // 参考：Sun et al. (2003) BIA预测方程
    if (isMale) {
      // 男性：FFM = 0.407×体重 + 0.267×身高 - 0.094×阻抗 + 19.2
      ffm = (0.407 * weight) + (0.267 * heightCm) - (0.094 * impedance) + 19.2;
    } else {
      // 女性：FFM = 0.252×体重 + 0.473×身高 - 0.094×阻抗 + 48.3  
      ffm = (0.252 * weight) + (0.473 * heightCm) - (0.094 * impedance) + 48.3;
    }
    
    // 确保FFM合理范围（不超过体重）
    ffm = Math.max(weight * 0.5, Math.min(weight * 0.95, ffm));
    
    // 计算体脂率
    const fatMass = weight - ffm;
    bodyFat = (fatMass / weight) * 100;
    
    console.log('[Scale] 📐 BIA计算:', {
      ffm: ffm.toFixed(2),
      fatMass: (weight - ffm).toFixed(2),
      rawBodyFat: bodyFat.toFixed(2)
    });
  } else {
    // 无阻抗时的BMI估算兜底公式（Deurenberg公式）
    if (isMale) {
      bodyFat = (1.20 * bmi) + (0.23 * age) - 16.2;
    } else {
      bodyFat = (1.20 * bmi) + (0.23 * age) - 5.4;
    }
    console.log('[Scale] ⚠️ 无阻抗数据，使用BMI估算');
  }
  
  // 体脂率约束范围：男性 5%-40%，女性 10%-50%
  const minFat = isMale ? 5 : 10;
  const maxFat = isMale ? 40 : 50;
  bodyFat = Math.max(minFat, Math.min(maxFat, bodyFat));
  
  // 重新计算FFM（基于约束后的体脂率）
  ffm = weight * (1 - bodyFat / 100);

  // 5. 脂肪质量 (FM - Fat Mass)
  const fatMass = weight - ffm;

  // 6. 肌肉量 (Muscle Mass) - 小米定义：包含骨骼肌+平滑肌+水分
  // 肌肉量 ≈ 去脂体重 × 肌肉占比系数
  const muscleRatio = isMale ? 0.52 : 0.46; // 男性约52%，女性约46%
  const muscleMass = ffm * muscleRatio;

  // 7. 骨量 (Bone Mass) - 基于体重的线性回归
  // 小米官方系数：男性 0.022×体重+1.2，女性 0.018×体重+0.9
  const boneMass = isMale 
    ? (0.022 * weight) + 1.2 
    : (0.018 * weight) + 0.9;

  // 8. 水分率 (Water %) - 占总体重的百分比
  // 水分主要存在于肌肉中，约占肌肉量的73%
  const waterMass = muscleMass * 0.73;
  const waterPercent = (waterMass / weight) * 100;

  // 9. 蛋白质率 (Protein %) - 占总体重的百分比
  // 蛋白质约占去脂体重的20-22%
  const proteinMass = ffm * 0.21;
  const proteinPercent = (proteinMass / weight) * 100;

  // 10. 基础代谢率 (BMR) - Mifflin-St Jeor 公式（最准确）
  let bmr = 0;
  if (isMale) {
    bmr = (10 * weight) + (6.25 * heightCm) - (5 * age) + 5;
  } else {
    bmr = (10 * weight) + (6.25 * heightCm) - (5 * age) - 161;
  }

  // 11. 内脏脂肪等级 (Visceral Fat Level) - 1-15级
  // 基于BMI、年龄、性别的经验公式
  let visceralFat = 0;
  if (isMale) {
    visceralFat = (bmi * 0.4) + (age * 0.1) - 5;
  } else {
    visceralFat = (bmi * 0.4) + (age * 0.1) - 4;
  }
  visceralFat = Math.max(1, Math.min(15, visceralFat));

  // 12. 标准体重 (Standard Weight) - WHO标准
  const standardWeight = isMale
    ? (heightCm - 80) * 0.7
    : (heightCm - 70) * 0.6;

  // 13. 身体评分 (Body Score) - 综合评分0-100
  const bodyScore = this.calculateBodyScore(bmi, bodyFat, isMale, age);

  // ===== 更新UI数据（统一格式）=====
  this.setData({
    // 基础指标
    bmi: parseFloat(bmi.toFixed(2)),              // 保留2位小数
    bodyFat: parseFloat(bodyFat.toFixed(1)),       // 保留1位小数
    
    // 组成成分（kg或%）
    water: parseFloat(waterPercent.toFixed(1)),    // 水分率 %
    muscleMass: parseFloat(muscleMass.toFixed(2)), // 肌肉量 kg
    protein: parseFloat(proteinPercent.toFixed(1)),// 蛋白质率 %
    boneMass: parseFloat(boneMass.toFixed(2)),     // 骨量 kg
    
    // 代谢指标
    bmr: Math.round(bmr),                          // 基础代谢 kcal（整数）
    visceralFat: parseFloat(visceralFat.toFixed(1)),// 内脏脂肪等级
    
    // 参考指标
    standardWeight: parseFloat(standardWeight.toFixed(2)), // 标准体重 kg
    bodyScore: Math.round(bodyScore),              // 身体评分（整数）
    
    // 辅助显示
    muscleMassJin: parseFloat((muscleMass * 2).toFixed(1)), // 肌肉量（斤）
    boneMassJin: parseFloat((boneMass * 2).toFixed(1))      // 骨量（斤）
  });

  // 生成健康建议
  const advice = this.generateHealthAdvice(bmi, bodyFat, isMale, age);
  this.setData({
    advice: advice.text,
    adviceLevel: advice.level,
    adviceIcon: advice.icon
  });

  console.log('[Scale] 📊 BIA计算结果:', {
    weight, impedance, height, age, gender,
    bmi: bmi.toFixed(2),
    bodyFat: bodyFat.toFixed(1) + '%',
    muscleMass: muscleMass.toFixed(2) + 'kg',
    water: waterPercent.toFixed(1) + '%',
    boneMass: boneMass.toFixed(2) + 'kg',
    bmr: Math.round(bmr) + 'kcal'
  });
},

  // ======================
  // 身体评分计算 (0-100分)
  // ======================
  calculateBodyScore(bmi, bodyFat, isMale, age) {
    let score = 100;
    
    // BMI 扣分项（正常范围 18.5-24）
    if (bmi < 18.5) {
      score -= (18.5 - bmi) * 3; // 偏瘦扣分
    } else if (bmi > 24) {
      if (bmi <= 28) {
        score -= (bmi - 24) * 2; // 超重扣分
      } else {
        score -= (bmi - 24) * 4; // 肥胖严重扣分
      }
    }
    
    // 体脂率扣分项
    const optimalMin = isMale ? 10 : 18;
    const optimalMax = isMale ? 20 : 28;
    
    if (bodyFat < optimalMin) {
      score -= (optimalMin - bodyFat) * 2; // 过低扣分
    } else if (bodyFat > optimalMax) {
      if (bodyFat <= 30) {
        score -= (bodyFat - optimalMax) * 1.5; // 偏高扣分
      } else {
        score -= (bodyFat - optimalMax) * 3; // 过高严重扣分
      }
    }
    
    // 年龄因素（年轻人标准更严格）
    if (age < 30) {
      score *= 0.95; // 年轻人要求更高
    } else if (age > 50) {
      score *= 1.05; // 年长者适度放宽
    }
    
    // 约束范围 0-100
    return Math.max(0, Math.min(100, score));
  },

  // ======================
  // BMI 范围分类
  // ======================
  getBmiRangeClass(bmi) {
    if (bmi < 18.5) return 'underweight';
    if (bmi < 24) return 'normal';
    if (bmi < 28) return 'overweight';
    return 'obese';
  },

  getBmiRangeText(bmi) {
    if (bmi < 18.5) return '偏瘦';
    if (bmi < 24) return '正常';
    if (bmi < 28) return '偏胖';
    return '肥胖';
  },

  // ======================
  // 生成健康建议
  // ======================
  generateHealthAdvice(bmi, bodyFat, isMale, age) {
    let text = '';
    let level = 'normal'; // normal, warning, danger
    let icon = '💡';

    // BMI 相关建议
    if (bmi < 18.5) {
      text = '您的体重偏轻，建议增加营养摄入，适当进行力量训练增肌。';
      level = 'warning';
      icon = '⚠️';
    } else if (bmi >= 24 && bmi < 28) {
      text = '您的体重略超重，建议控制饮食热量，每周至少3次有氧运动。';
      level = 'warning';
      icon = '⚠️';
    } else if (bmi >= 28) {
      text = '您的体重超标较多，建议制定减重计划，咨询营养师或健身教练。';
      level = 'danger';
      icon = '🔴';
    }

    // 体脂率相关建议（优先级更高）
    const highBodyFat = isMale ? bodyFat > 25 : bodyFat > 35;
    const lowBodyFat = isMale ? bodyFat < 10 : bodyFat < 18;

    if (highBodyFat) {
      text = '体脂率偏高，建议减少高糖高脂食物，增加有氧运动和力量训练结合。';
      level = 'warning';
      icon = '⚠️';
    } else if (lowBodyFat && age > 18) {
      text = '体脂率偏低，请确保充足营养摄入，避免过度节食。';
      level = 'warning';
      icon = '⚠️';
    }

    // 正常范围
    if (!text) {
      text = '身体状况良好！保持均衡饮食和规律运动，继续加油！';
      level = 'normal';
      icon = '✅';
    }

    return { text, level, icon };
  },

  // ======================
  // 自动保存测量数据
  // ======================
  async autoSaveMeasurement() {
    if (!this.data.selectedMemberId || !this.data.lockedWeight) {
      console.log('[Scale] ⚠️ 未选择成员或未锁定数据，跳过保存');
      return;
    }

    this.setData({ saving: true });

    try {
      const res = await new Promise((resolve, reject) => {
        cloudRequest.callContainer({
          path: '/api/scale/measurements',
          method: 'POST',
          data: {
            member_id: this.data.selectedMemberId,
            weight: this.data.lockedWeight,
            impedance: this.data.lockedImpedance || 0,
            bmi: parseFloat(this.data.bmi),
            body_fat: parseFloat(this.data.bodyFat),
            water: parseFloat(this.data.water),
            muscle_mass: parseFloat(this.data.muscleMass),
            protein: parseFloat(this.data.protein),
            bmr: parseFloat(this.data.bmr),
            visceral_fat: parseFloat(this.data.visceralFat),
            bone_mass: parseFloat(this.data.boneMass)  // 添加骨量字段
          },
          success: resolve,
          fail: reject
        });
      });

      if (res.code === 200) {
        console.log('[Scale] ✅ 自动保存成功:', res.message);
        this.setData({
          autoSaved: true,
          saveCardClass: 'saved'
        });
        wx.showToast({
          title: res.message || '保存成功',
          icon: 'success',
          duration: 1500
        });
      }
    } catch (err) {
      console.error('[Scale] ❌ 自动保存失败:', err);
      wx.showToast({
        title: '保存失败',
        icon: 'none'
      });
    } finally {
      this.setData({ saving: false });
    }
  },

  // ======================
  // 显示添加成员弹窗
  // ======================
  showAddMemberModal() {
    this.setData({
      showAddMemberDialog: true,
      editingMemberId: null,
      newMemberName: '',
      newMemberAge: '',
      newMemberHeight: '',
      newMemberGender: 'male',
      newMemberGenderIndex: 0
    });
  },

  closeAddMemberDialog() {
    this.setData({ showAddMemberDialog: false });
  },

  // ======================
  // 表单输入处理
  // ======================
  onMemberNameInput(e) {
    this.setData({ newMemberName: e.detail.value });
  },

  onMemberAgeInput(e) {
    this.setData({ newMemberAge: e.detail.value });
  },

  onMemberHeightInput(e) {
    this.setData({ newMemberHeight: e.detail.value });
  },

  onMemberGenderChange(e) {
    const index = parseInt(e.detail.value);
    this.setData({
      newMemberGenderIndex: index,
      newMemberGender: index === 0 ? 'male' : 'female'
    });
  },

  // ======================
  // 提交添加成员
  // ======================
  submitAddMember() {
    this.saveMember();
  },

  // ======================
  // 保存成员
  // ======================
  async saveMember() {
    const { newMemberName, newMemberAge, newMemberHeight, newMemberGender } = this.data;

    if (!newMemberName || !newMemberAge || !newMemberHeight) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' });
      return;
    }

    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.user_id) return;

    try {
      const res = await new Promise((resolve, reject) => {
        cloudRequest.callContainer({
          path: `/api/family-members?user_id=${userInfo.user_id}`,
          method: 'POST',
          data: {
            name: newMemberName,
            age: parseInt(newMemberAge),
            height: parseFloat(newMemberHeight),
            gender: newMemberGender,
            avatar_color: '',
            relationship: ''
          },
          success: resolve,
          fail: reject
        });
      });

      console.log('[Scale] ✅ 添加成员返回:', res);
      
      // 【修复】直接判断 res，不需要 res.data
      if (res && res.id) {
        wx.showToast({ title: '添加成功', icon: 'success' });
        this.closeAddMemberDialog();
        
        // 【优化】局部更新成员列表，不清除全局缓存
        const newMember = {
          id: res.id,
          name: newMemberName,
          age: parseInt(newMemberAge),
          height: parseFloat(newMemberHeight),
          gender: newMemberGender,
          avatarColor: '',
          last_weight: null
        };
        
        const updatedMembers = [...this.data.members, newMember];
        this.setData({
          members: updatedMembers,
          showMemberSection: true
        });
        
        // 同步更新全局缓存
        getApp().globalData.scaleMembers = updatedMembers;
      } else {
        throw new Error('返回数据异常');
      }
    } catch (err) {
      console.error('[Scale] 保存成员失败:', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  // ======================
  // 长按删除成员
  // ======================
  onLongPressMember(e) {
    const memberId = e.currentTarget.dataset.id;
    const memberName = e.currentTarget.dataset.name;

    wx.showModal({
      title: '确认删除',
      content: `确定要删除成员"${memberName}"吗？`,
      success: async (res) => {
        if (res.confirm) {
          await this.deleteMember(memberId);
        }
      }
    });
  },

  async deleteMember(memberId) {
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.user_id) return;

    try {
      const res = await new Promise((resolve, reject) => {
        cloudRequest.callContainer({
          path: `/api/family-members/${memberId}?user_id=${userInfo.user_id}`,
          method: 'DELETE',
          success: resolve,
          fail: reject
        });
      });

      console.log('[Scale] ✅ 删除成员返回:', res);
      
      // 【修复】直接判断 res，不需要 res.data
      if (res && (res.status === 'success' || res.message)) {
        wx.showToast({ title: '删除成功', icon: 'success' });
        
        // 【优化】局部更新成员列表，移除被删除的成员
        const updatedMembers = this.data.members.filter(m => m.id !== memberId);
        this.setData({
          members: updatedMembers,
          showMemberSection: updatedMembers.length > 0
        });
        
        // 同步更新全局缓存
        getApp().globalData.scaleMembers = updatedMembers;
        
        // 如果删除的是当前选中的成员，清空选中状态
        if (this.data.selectedMemberId === memberId) {
          this.setData({
            selectedMemberId: null,
            matchedMember: null
          });
        }
      } else {
        throw new Error('返回数据异常');
      }
    } catch (err) {
      console.error('[Scale] 删除成员失败:', err);
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  }
});
