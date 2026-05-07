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

  // 成员匹配容差：8kg
  MATCH_TOLERANCE: 8
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

    // ===== 家庭成员 =====
    members: [],
    selectedMemberId: null,
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

    // ===== 动画控制 =====
    pulseAnimation: false,
    slideIn: false,
    showResultPanel: false,

    // ===== 蓝牙状态 =====
    bleAvailable: false,
    connectedDevice: null,

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
    
    // 检查蓝牙状态
    this.checkBLEState();
    
    // 注意：不再自动处理旧数据，等待新的蓝牙广播
    // const latestData = getApp().globalData.latestScaleData;
    // if (latestData && latestData.weight >= CONFIG.MIN_VALID_WEIGHT) {
    //   this.handleScaleData(latestData);
    // }
  },

  onHide() {
    console.log('[Scale] 📄 页面隐藏');
    // 取消订阅
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  },

  onUnload() {
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

  // ======================
  // 核心数据处理（订阅回调）
  // ======================
  handleScaleData(data) {
    console.log('[Scale] 📡 收到数据:', data);

    // 过滤无效数据
    if (!data || data.weight < CONFIG.MIN_VALID_WEIGHT || data.weight > CONFIG.MAX_WEIGHT) {
      return;
    }

    // 数据新鲜度检测（10秒内）
    if (data.deviceTimestamp) {
      const now = Date.now();
      const timeDiff = Math.abs(now - data.deviceTimestamp);
      if (timeDiff >= 10000) {
        console.log('[Scale] ⏸️ 数据过期，跳过处理 (差值:', Math.round(timeDiff), 'ms)');
        return;
      }
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

    // MEASURING → COMPLETED
    if (currentState === APP_STATE.MEASURING && isStable && !this.data.measurementLocked) {
      this.lockAndCalculate(data);
      return;
    }

    // COMPLETED → 检测新测量（体重变化 > 0.3kg）
    if (currentState === APP_STATE.COMPLETED && this.data.measurementLocked) {
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

    // 锁定
    this.setData({
      measurementLocked: true,
      lockedWeight: data.weight,
      lockedImpedance: data.impedance || 0
    });

    // 过渡到 COMPLETED
    this.transitionState(APP_STATE.COMPLETED);

    // 异步计算体脂（不阻塞 UI）
    try {
      await this.calculateBodyMetrics(data.weight, data.impedance);
      
      // 自动匹配成员
      this.autoMatchMember(data.weight);
      
      // 震动反馈
      wx.vibrateShort({ type: 'medium' });
    } catch (err) {
      console.error('[Scale] 计算失败:', err);
    }
  },

  // ======================
  // 重置测量
  // ======================
  resetMeasurement() {
    console.log('[Scale] 🧹 重置测量');

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
      matchConfidence: 0
      // 注意：不重置 showMemberSection，保持成员列表显示
    });

    // 清空全局数据
    getApp().globalData.latestScaleData = null;
  },

  // ======================
  // 获取状态文本
  // ======================
  getStatusText(data, isStable) {
    if (this.data.appState === APP_STATE.IDLE) return '准备就绪';
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
    if (!this.data.members || this.data.members.length === 0) {
      // 无成员，弹出创建
      this.showCreateMemberModal(weight);
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
      return;
    }

    // 按体重差异排序
    candidates.sort((a, b) => a.diff - b.diff);

    // 如果只有一个候选或差异明显，直接选择
    if (candidates.length === 1 || (candidates[1].diff - candidates[0].diff > 2)) {
      const bestMatch = candidates[0].member;
      const confidence = Math.max(50, Math.round(100 - (candidates[0].diff / CONFIG.MATCH_TOLERANCE) * 50));
      
      this.setData({
        matchedMember: bestMatch,
        matchConfidence: confidence,
        selectedMemberId: bestMatch.id,
        currentMember: {
          height: bestMatch.height,
          age: bestMatch.age,
          gender: bestMatch.gender
        }
      });
      console.log('[Scale] ✅ 自动匹配成员:', bestMatch.name, '差异:', candidates[0].diff.toFixed(2), 'kg');
    } else {
      // 多个候选且差异小，选择最近的成员
      const bestMatch = candidates[0].member;
      console.log('[Scale] ⚠️ 多个候选成员，自动选择最近:', bestMatch.name);
      
      this.setData({
        matchedMember: bestMatch,
        matchConfidence: 70,
        selectedMemberId: bestMatch.id,
        currentMember: {
          height: bestMatch.height,
          age: bestMatch.age,
          gender: bestMatch.gender
        }
      });
    }
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
          // 跳转到配置页创建成员
          wx.navigateTo({
            url: `/pages/config/config?action=create&weight=${weight}`
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
  // 计算身体指标
  // ======================
  async calculateBodyMetrics(weight, impedance = 0) {
    const { height, age, gender } = this.data.currentMember;
    if (!height || !age) return;

    const isMale = gender === 'male';
    const heightM = height / 100;
    const bmi = weight / (heightM ** 2);

    // 去脂体重（FFM）
    let ffm;
    if (impedance > 100 && impedance < 1000) {
      const h2r = (height ** 2) / impedance;
      ffm = 0.7374 * h2r + 0.1763 * weight - 0.1773 * age - 2.4658 + (isMale ? 2.5 : -1.5);
      ffm = Math.max(weight * 0.5, Math.min(weight * 0.95, ffm));
    } else {
      const sexFactor = isMale ? 1 : 0;
      ffm = weight * (1 - ((1.2 * bmi) + (0.23 * age) - (10.8 * sexFactor) - 5.4) / 100);
      ffm = Math.max(weight * 0.5, Math.min(weight * 0.9, ffm));
    }

    const bodyFat = Math.max(5, Math.min(50, ((weight - ffm) / weight) * 100));

    // 总水分（TBW）
    let tbw = isMale 
      ? 2.447 - 0.09516 * age + 0.1074 * height + 0.3362 * weight
      : -2.097 + 0.1069 * height + 0.2466 * weight;
    const water = Math.max(45, Math.min(75, (tbw / weight) * 100));

    // 肌肉量、蛋白质、BMR
    const muscleMass = ffm * (isMale ? 0.54 : 0.49);
    const protein = Math.min(25, Math.max(12, (muscleMass / weight) * 22));
    const bmr = 10 * weight + 6.25 * height - 5 * age + (isMale ? 5 : -161);

    // 内脏脂肪、骨量、标准体重
    const visceralFat = Math.max(1, Math.min(30, 0.74 * bmi + 0.15 * age + (isMale ? -10.5 : -16.0)));
    const boneMass = weight * (0.035 + (height - 160) * 0.00008);
    const standardWeight = (height - 100) * 0.9;

    // BMI 范围
    let bmiRangeClass = '';
    let bmiRangeText = '';
    if (bmi < 18.5) {
      bmiRangeClass = 'underweight';
      bmiRangeText = '偏瘦';
    } else if (bmi < 24) {
      bmiRangeClass = 'normal';
      bmiRangeText = '正常';
    } else if (bmi < 28) {
      bmiRangeClass = 'overweight';
      bmiRangeText = '偏胖';
    } else {
      bmiRangeClass = 'obese';
      bmiRangeText = '肥胖';
    }

    // 体脂范围
    const bodyFatNormalRange = isMale ? '10-20%' : '18-28%';
    const bodyFatRangeClass = bodyFat > (isMale ? 25 : 35) ? 'high' : 'normal';

    // 内脏脂肪文本
    const visceralFatText = visceralFat <= 9 ? '正常' : '偏高';

    // 肌肉量百分比
    const muscleMassPercent = Math.round((muscleMass / weight) * 100);

    // 生成健康建议
    const advice = this.generateHealthAdvice(bmi, bodyFat, isMale, age);

    // 更新 UI
    this.setData({
      bmi: bmi.toFixed(1),
      bodyFat: bodyFat.toFixed(1),
      water: water.toFixed(1),
      muscleMass: muscleMass.toFixed(1),
      protein: protein.toFixed(1),
      bmr: Math.round(bmr),
      visceralFat: visceralFat.toFixed(1),
      boneMass: boneMass.toFixed(1),
      standardWeight: standardWeight.toFixed(1),
      muscleMassPercent,
      bmiRangeClass,
      bmiRangeText,
      bodyFatRangeClass,
      bodyFatNormalRange,
      genderLabel: isMale ? '男性' : '女性',
      visceralFatText,
      advice: advice.text,
      adviceLevel: advice.level,
      adviceIcon: advice.icon
    });
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
  // 手动重置
  // ======================
  manualReset() {
    console.log('[Scale] 👆 手动重置');
    this.resetMeasurement();
    wx.showToast({
      title: '已重置',
      icon: 'success'
    });
  },

  // ======================
  // 开始测量流程（点击扫描按钮）
  // ======================
  startMeasurementFlow() {
    console.log('[Scale] 🚀 开始测量');
    this.resetMeasurement();
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

  onGenderChange(e) {
    const index = parseInt(e.detail.value);
    this.setData({
      newMemberGenderIndex: index,
      newMemberGender: index === 0 ? 'male' : 'female'
    });
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
          path: '/api/scale/member',
          method: 'POST',
          data: {
            user_id: userInfo.user_id,
            name: newMemberName,
            age: parseInt(newMemberAge),
            height: parseFloat(newMemberHeight),
            gender: newMemberGender
          },
          success: resolve,
          fail: reject
        });
      });

      if (res.data) {
        wx.showToast({ title: '添加成功', icon: 'success' });
        this.closeAddMemberDialog();
        this.loadMembers();
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
    try {
      const res = await new Promise((resolve, reject) => {
        cloudRequest.callContainer({
          path: `/api/scale/member/${memberId}`,
          method: 'DELETE',
          success: resolve,
          fail: reject
        });
      });

      if (res.data) {
        wx.showToast({ title: '删除成功', icon: 'success' });
        this.loadMembers();
      }
    } catch (err) {
      console.error('[Scale] 删除成员失败:', err);
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  }
});
