const cloudRequest = require('../../utils/cloud_request.js');
const { SCALE_CONFIG, MATCHING, TIMING, LIMITS } = require('../../config/scale_constants.js');
const chartDrawer = require('../../modules/chart_drawer.js');
const { parseScaleData } = require('../../utils/ble_scale.js');

Page({
  data: {
    scanning: false, device: null, weight: 0, weightDisplay: '0.00',
    impedance: 0, isStabilized: false, stabilityProgress: 0,
    showMemberModal: false, // 控制成员选择弹窗
    hasTriggeredSelection: false, // 防抖锁：防止一次称重多次弹窗
    stabilitySteps: [1, 2, 3, 4, 5], logs: [], userInfo: null,
    autoSaved: false, scanTimeout: null, measurementLocked: false,
    lockedWeight: null, lockedImpedance: null, lastDataTime: null,
    weightHistory: [], debugMode: false, rawAdvertisements: [],
    members: [], selectedMemberId: null, currentMember: null, isLoadingMembers: false,
    showAddMemberDialog: false, editingMemberId: null,
    newMemberName: '', newMemberAge: '', newMemberHeight: '',
    newMemberGender: '', newMemberGenderIndex: -1,
    bmi: null, bodyFat: null, water: null, muscleMass: null,
    protein: null, bmr: null, boneMass: null, visceralFat: null, advice: null
  },

  onLoad() {
    this.checkLoginStatus();
    getApp().globalData.hasVisitedScalePage = true;
    this.initBluetoothIfNeeded();
  },

  async initBluetoothIfNeeded() {
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo?.user_id) return;

    try {
      const res = await cloudRequest.callContainer({
        path: `/api/dashboard/data?user_id=${userInfo.user_id}`, method: 'GET'
      });

      if (!res.xiaomi_config) {
        wx.showModal({
          title: '未配置设备', content: '请先在首页添加体脂秤设备',
          showCancel: false, confirmText: '去配置',
          success: () => wx.reLaunch({ url: '/pages/index/index' })
        });
        return;
      }
    } catch (err) { console.error('[Scale] 检查配置失败:', err); return; }

    const app = getApp();
    if (!app.globalData.bleAdapterInitialized) app.checkAndInitBluetooth();
  },

  onShow() {
    if (this.data.userInfo && this.data.members.length > 0) this.loadMembers();
    if (this.data.measurementLocked) {
      this.setData({ measurementLocked: false, lockedWeight: null, lockedImpedance: null });
    }
    this.registerBleCallback();
    this.startScanTimeout();
  },

  onHide() { this.unregisterBleCallback(); },
  onUnload() {
    this.unregisterBleCallback();
    if (this.data.scanTimeout) clearTimeout(this.data.scanTimeout);
  },

  registerBleCallback() {
    const app = getApp();
    // 统一指向 handleScaleDataUpdate
    this.bleCallback = (data) => this.handleScaleDataUpdate(data);
    app.registerScaleCallback(this.bleCallback);
  },

  unregisterBleCallback() {
    if (this.bleCallback) {
      getApp().unregisterScaleCallback(this.bleCallback);
      this.bleCallback = null;
    }
  },

  startScanTimeout() {
    if (this.data.scanTimeout) clearTimeout(this.data.scanTimeout);
    const timeout = setTimeout(() => {
      this.resetState();
      wx.showToast({ title: '已断开连接', icon: 'none', duration: 2000 });
    }, TIMING.TIMEOUT);
    this.setData({ scanTimeout: timeout });
  },

  resetScanTimeout() { this.startScanTimeout(); },

  resetState() {
    if (this.data.scanTimeout) clearTimeout(this.data.scanTimeout);
    this.setData({
      scanning: false, device: null, weight: 0, weightDisplay: '0.00',
      impedance: 0, isStabilized: false, stabilityProgress: 0,
      autoSaved: false, measurementLocked: false,
      lockedWeight: null, lockedImpedance: null,
      lastDataTime: null, weightHistory: []
    });
    this.log('连接已断开');
  },

  getStabilityState(newWeight, isHardwareStable = false) {
    const history = [...this.data.weightHistory, { weight: newWeight, timestamp: Date.now() }].slice(-10);
    const totalSteps = SCALE_CONFIG.STABILITY_PROGRESS_STEPS || 5;
    let progress = history.length > 0 ? 1 : 0;

    for (let i = history.length - 1; i > 0 && progress < totalSteps; i--) {
      if (Math.abs(history[i].weight - history[i - 1].weight) < MATCHING.DEDUPLICATION_THRESHOLD) {
        progress += 1;
      } else break;
    }

    if (isHardwareStable) progress = totalSteps;
    return { history, progress, isStable: progress >= totalSteps };
  },

  handleScaleDataUpdate(data) {
    if (!data || data.weight < 0.1 || data.weight > 300) return;

    const isHardwareStable = data.isStabilized;
    const stabilityState = this.getStabilityState(data.weight, isHardwareStable);
    const isStable = isHardwareStable || stabilityState.isStable;
    const stabilityProgress = isHardwareStable ? 5 : stabilityState.progress;

    if (data.impedance > 0 && (data.impedance < 100 || data.impedance > 3000)) return;

    this.setData({
      device: data.deviceName || '小米体脂秤',
      weight: data.weight,
      weightDisplay: data.weight.toFixed(2),
      impedance: data.impedance || 0,
      isStabilized: isStable,
      stabilityProgress,
      scanning: true,
      autoSaved: false,
      lastDataTime: Date.now(),
      weightHistory: stabilityState.history
    });

    this.resetScanTimeout();
    this.log(`体重: ${data.weight}kg | 阻抗: ${data.impedance || 0}Ω | 稳定: ${isStable ? '是' : '否'}`);

    console.log('[Scale Page] 状态:', { isStable, impedance: data.impedance, locked: this.data.measurementLocked, member: !!this.data.currentMember });

    if (!isStable) return;

    if (!data.impedance) {
      console.log('[Scale Page] ⏳ 等待阻抗');
      return;
    }

    if (this.data.measurementLocked && this.data.currentMember) {
      console.log('[Scale Page] ✅ 已完成');
      return;
    }

    if (this.data.measurementLocked && !this.data.currentMember) {
      console.log('[Scale Page] 🔓 解锁重新匹配');
      this.setData({ measurementLocked: false });
    }

    console.log('[Scale Page] 🔒 锁定');
    this.setData({ measurementLocked: true, lockedWeight: data.weight, lockedImpedance: data.impedance });

    if (!this.data.currentMember) {
      if (this.data.members.length === 0) {
        console.log('[Scale Page] ⚠️ 成员未加载');
        return;
      }
      console.log('[Scale Page] 🎯 自动匹配');
      this.autoMatchMember(data.weight);
    } else {
      console.log('[Scale Page] ✅ 直接计算');
      wx.showLoading({ title: '计算中...', mask: true });
      this.calculateBodyMetrics(() => wx.hideLoading());
    }
  },

  autoMatchMember(currentWeight) {
    const members = this.data.members;
    if (!members?.length) return;

    if (members.length === 1) {
      this.performSwitch(members[0], true);
      return;
    }

    let bestMatch = null, minDiff = Infinity;
    members.forEach(member => {
      if (member.lastWeight > 0) {
        const diff = Math.abs(member.lastWeight - currentWeight);
        if (diff <= MATCHING.TOLERANCE && diff < minDiff) {
          minDiff = diff;
          bestMatch = member;
        }
      }
    });

    if (bestMatch) {
      console.log(`[Scale] 自动匹配: ${bestMatch.name}`);
      this.performSwitch(bestMatch, true);
    } else {
      this.setData({ showMemberModal: true });
      wx.showToast({ title: '请手动选择成员', icon: 'none' });
    }
  },

  async createGuestMember(weight) {
    const guestName = `访客${new Date().getTime().toString().slice(-4)}`;
    try {
      await cloudRequest.callContainer({
        path: `/api/family-members?user_id=${this.data.userInfo.user_id}`,
        method: 'POST',
        data: { name: guestName, gender: 'unknown', age: null, height: null, is_active: true }
      });
      await this.loadMembers();
      const newMember = this.data.members.find(m => m.name === guestName);
      if (newMember) {
        this.setData({ selectedMemberId: newMember.id, currentMember: newMember });
        wx.showLoading({ title: '计算中...', mask: true });
        this.calculateBodyMetrics(() => wx.hideLoading());
        wx.showToast({ title: `已创建: ${guestName}`, icon: 'success' });
      }
    } catch (err) {
      console.error('[Scale] 创建访客失败:', err);
      wx.showToast({ title: '创建失败', icon: 'error' });
    }
  },

  selectMember(e) {
    const member = this.data.members.find(m => m.id === e.currentTarget.dataset.id);
    if (!member) return;
    this.switchWithConfirm(member, true);
  },

  selectAndSwitch(member, autoCalculate = true) {
    this.switchWithConfirm(member, autoCalculate);
  },

  switchWithConfirm(member, autoCalculate) {
    if (this.data.currentMember && this.data.currentMember.id !== member.id && this.data.bodyFat) {
      wx.showModal({
        title: '切换成员',
        content: `当前已计算 ${this.data.currentMember.name} 的数据，是否切换到 ${member.name}？`,
        confirmText: '切换', cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            this.clearResults();
            this.performSwitch(member, autoCalculate);
          }
        }
      });
      return;
    }
    this.performSwitch(member, autoCalculate);
  },

  performSwitch(member, autoCalculate) {
    this.setData({ selectedMemberId: member.id, currentMember: member });
    if (!autoCalculate) {
      wx.showToast({ title: `已选择: ${member.name}`, icon: 'success' });
      return;
    }

    wx.showLoading({ title: '计算中...', mask: true });
    if (this.data.measurementLocked && this.data.lockedWeight) {
      const tempW = this.data.weight, tempI = this.data.impedance;
      this.setData({ weight: this.data.lockedWeight, impedance: this.data.lockedImpedance });
      this.calculateBodyMetrics(() => {
        wx.hideLoading();
        if (tempW > 0) this.setData({ weight: tempW, impedance: tempI });
        this.setData({ measurementLocked: false, lockedWeight: null, lockedImpedance: null });
      });
    } else {
      this.calculateBodyMetrics(() => wx.hideLoading());
    }
  },

  clearResults() {
    this.setData({
      bmi: null, bodyFat: null, water: null, muscleMass: null,
      protein: null, bmr: null, boneMass: null, visceralFat: null,
      advice: null, autoSaved: false
    });
  },

  checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo) {
      wx.showModal({
        title: '未登录', content: '请先在首页登录',
        showCancel: false, confirmText: '去登录',
        success: () => wx.reLaunch({ url: '/pages/index/index' })
      });
      return;
    }
    if (!userInfo.user_id) {
      wx.showToast({ title: '用户信息异常', icon: 'none' });
      return;
    }
    this.setData({ userInfo });
    this.log(`用户登录: ${userInfo.nickname || userInfo.phone_number}`);
    this.loadMembers();
  },

  loadMembers(callback) {
    if (this.data.isLoadingMembers || !this.data.userInfo?.user_id) return;
    this.setData({ isLoadingMembers: true });
    const userId = this.data.userInfo.user_id;

    cloudRequest.callContainer({
      path: `/api/family-members?user_id=${userId}`, method: 'GET',
      success: (res) => {
        let members = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);
        if (!members.some(m => m.relationship === 'self') && this.data.userInfo) {
          this.createDefaultMember();
          return;
        }
        members = members.map(m => ({
          ...m, avatarColor: m.avatar_color || this.getRandomColor(),
          lastWeight: null, bmi: null, bodyFat: null, water: null,
          advice: null, weightHistory: []
        }));
        this.loadMembersHistory(members, callback);
      },
      fail: (err) => {
        console.error('加载成员失败:', err);
        wx.showToast({ title: '加载失败', icon: 'none' });
        this.setData({ isLoadingMembers: false });
        if (typeof callback === 'function') callback();
      }
    });
  },

  loadMembersHistory(members, callback) {
    if (!members.length) {
      this.setData({ members, selectedMemberId: null, currentMember: null, isLoadingMembers: false });
      if (typeof callback === 'function') callback();
      return;
    }

    const promises = members.map(member => new Promise((resolve) => {
      cloudRequest.callContainer({
        path: `/api/family-members/${member.id}/history?user_id=${this.data.userInfo.user_id}&limit=7`,
        method: 'GET',
        success: (res) => {
          const history = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);
          let updated = { ...member, weightHistory: history };
          if (history.length > 0) {
            const latest = history[0];
            updated.lastWeight = latest.weight;
            updated.bodyFat = latest.body_fat;
            updated.water = latest.water;
            updated.bmi = this.calcBMI(latest.weight, member.height);
            updated.advice = this.genAdvice({ ...member, bmi: updated.bmi });
          }
          resolve(updated);
        },
        fail: () => resolve(member)
      });
    }));

    Promise.all(promises).then(updatedMembers => {
      updatedMembers = updatedMembers.map(m => {
        if (m.weightHistory?.length > 0) {
          m.maxWeight = Math.max(...m.weightHistory.map(h => h.weight));
          m.weightHistory = m.weightHistory.map(r => {
            const d = new Date(r.timestamp || r.created_at);
            return { ...r, date: `${d.getMonth() + 1}/${d.getDate()}`, bodyFat: r.body_fat || 0 };
          });
        }
        return m;
      });

      this.setData({
        members: updatedMembers,
        selectedMemberId: updatedMembers[0]?.id || null,
        currentMember: updatedMembers[0] || null,
        isLoadingMembers: false
      });

      if (this.data.weight > 0 && this.data.isStabilized) {
        setTimeout(() => this.calculateBodyMetrics(), TIMING.CALCULATE_DELAY);
      }

      const app = getApp();
      if (app.globalData.latestScaleData && !this.data.isStabilized) {
        this.handleScaleDataUpdate(app.globalData.latestScaleData);
      }
      if (typeof callback === 'function') callback();
    });
  },

  createDefaultMember() {
    cloudRequest.callContainer({
      path: `/api/family-members?user_id=${this.data.userInfo.user_id}`,
      method: 'POST',
      data: {
        name: this.data.userInfo.nickname || this.data.userInfo.phone_number || '我',
        gender: this.data.userInfo.gender || '', age: this.data.userInfo.age || 0,
        height: this.data.userInfo.height || 0,
        avatar_color: this.getRandomColor(), relationship: 'self'
      },
      success: () => this.loadMembers(),
      fail: () => this.setData({ isLoadingMembers: false })
    });
  },

  onLongPressMember(e) {
    const member = this.data.members.find(m => m.id === e.currentTarget.dataset.id);
    if (!member) return;
    const itemList = member.relationship === 'self' ? ['编辑信息'] : ['编辑信息', '删除成员'];
    wx.showActionSheet({
      itemList, itemColor: '#ff4d4f',
      success: (res) => {
        if (res.tapIndex === 0) this.editMember(member);
        else if (res.tapIndex === 1) this.confirmDelete(member.id, e.currentTarget.dataset.name);
      }
    });
  },

  editMember(member) {
    this.setData({
      showAddMemberDialog: true, editingMemberId: member.id,
      newMemberName: member.name,
      newMemberAge: member.age ? String(member.age) : '',
      newMemberHeight: member.height ? String(member.height) : '',
      newMemberGender: member.gender === 'male' ? '男' : (member.gender === 'female' ? '女' : ''),
      newMemberGenderIndex: member.gender === 'male' ? 0 : (member.gender === 'female' ? 1 : -1)
    });
  },

  confirmDelete(id, name) {
    wx.showModal({
      title: '删除成员', content: `确定要删除"${name}"吗？`,
      confirmText: '删除', confirmColor: '#ff4d4f', cancelText: '取消',
      success: (res) => { if (res.confirm) this.deleteMember(id); }
    });
  },

  deleteMember(id) {
    wx.showLoading({ title: '删除中...' });
    cloudRequest.callContainer({
      path: `/api/family-members/${id}?user_id=${this.data.userInfo.user_id}`,
      method: 'DELETE',
      success: () => {
        wx.hideLoading();
        wx.showToast({ title: '删除成功', icon: 'success' });
        this.loadMembers();
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '删除失败', icon: 'error' });
      }
    });
  },

  showAddMemberModal() {
    this.setData({
      showAddMemberDialog: true, editingMemberId: null,
      newMemberName: '', newMemberAge: '', newMemberHeight: '',
      newMemberGender: '', newMemberGenderIndex: -1
    });
  },

  closeAddMemberModal() {
    this.setData({
      showAddMemberDialog: false, editingMemberId: null,
      newMemberName: '', newMemberAge: '', newMemberHeight: '',
      newMemberGender: '', newMemberGenderIndex: -1
    });
  },

  stopPropagation() {},
  onMemberNameInput(e) { this.setData({ newMemberName: e.detail.value }); },
  onMemberAgeInput(e) { this.setData({ newMemberAge: e.detail.value }); },
  onMemberHeightInput(e) { this.setData({ newMemberHeight: e.detail.value }); },
  onMemberGenderChange(e) {
    const genders = ['男', '女'];
    this.setData({ newMemberGenderIndex: e.detail.value, newMemberGender: genders[e.detail.value] });
  },

  submitAddMember() {
    const { newMemberName, newMemberAge, newMemberHeight, newMemberGender, editingMemberId } = this.data;
    if (!newMemberName) { wx.showToast({ title: '请输入姓名', icon: 'none' }); return; }
    if (!newMemberAge || parseInt(newMemberAge) <= 0) { wx.showToast({ title: '请输入有效年龄', icon: 'none' }); return; }
    if (!newMemberHeight || parseFloat(newMemberHeight) <= 0) { wx.showToast({ title: '请输入有效身高', icon: 'none' }); return; }
    if (!newMemberGender) { wx.showToast({ title: '请选择性别', icon: 'none' }); return; }

    const currentMember = this.data.members.find(m => m.id === editingMemberId);
    const memberData = {
      name: newMemberName, age: parseInt(newMemberAge),
      height: parseFloat(newMemberHeight),
      gender: newMemberGender === '男' ? 'male' : (newMemberGender === '女' ? 'female' : ''),
      avatar_color: currentMember?.avatar_color || this.getRandomColor(),
      relationship: currentMember?.relationship || ''
    };

    wx.showLoading({ title: editingMemberId ? '保存中...' : '添加中...' });
    const apiPath = editingMemberId
      ? `/api/family-members/${editingMemberId}?user_id=${this.data.userInfo.user_id}`
      : `/api/family-members?user_id=${this.data.userInfo.user_id}`;

    cloudRequest.callContainer({
      path: apiPath, method: editingMemberId ? 'PUT' : 'POST',
      data: memberData,
      success: () => {
        wx.hideLoading();
        wx.showToast({ title: editingMemberId ? '保存成功' : '添加成功' });
        this.closeAddMemberModal();
        this.loadMembers();
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: editingMemberId ? '保存失败' : '添加失败', icon: 'error' });
      }
    });
  },

  getRandomColor() {
    return SCALE_CONFIG.AVATAR_COLORS[Math.floor(Math.random() * SCALE_CONFIG.AVATAR_COLORS.length)];
  },

  calcBMI(weight, height) {
    if (!weight || !height) return null;
    return (weight / ((height / 100) ** 2)).toFixed(1);
  },

  genAdvice(member) {
    if (!member.bmi) return null;
    const bmi = parseFloat(member.bmi);
    if (bmi < 18.5) return '您的体重偏轻，建议增加营养摄入，适当进行力量训练。';
    if (bmi < 24) return '您的体重正常，请继续保持健康的生活方式！';
    if (bmi < 28) return '您的体重偏重，建议控制饮食，增加有氧运动。';
    return '您的体重过重，建议咨询专业医生或营养师制定减重计划。';
  },

  calculateBodyMetrics(callback) {
    const { weight, impedance, currentMember } = this.data;
    if (!currentMember || !weight || weight <= 0) {
      if (typeof callback === 'function') callback();
      return;
    }

    const { age, gender, height } = currentMember;
    const missing = [];
    if (!age || age <= 0) missing.push('年龄');
    if (!height || height <= 0) missing.push('身高');
    if (!gender) missing.push('性别');

    if (missing.length > 0) {
      if (this.data.showAddMemberDialog && this.data.editingMemberId === currentMember.id) {
        if (typeof callback === 'function') callback();
        return;
      }
      wx.showModal({
        title: '完善成员信息',
        content: `请先完善${currentMember.name}的${missing.join('、')}信息`,
        confirmText: '去完善', cancelText: '取消',
        success: (res) => {
          if (res.confirm) this.editMember(currentMember);
          if (typeof callback === 'function') callback();
        }
      });
      return;
    }

    const bmi = this.calcBMI(weight, height);
    let bodyFat = 0;
    const sex = gender === 'male' ? 1 : 0;

    if (impedance > 0 && height > 0) {
      bodyFat = (1.20 * bmi) + (0.23 * age) - (10.8 * sex) - 5.4;
      bodyFat += ((height * height) / impedance) * 0.001;
    } else {
      bodyFat = (1.20 * bmi) + (0.23 * age) - (10.8 * sex) - 5.4 + 1.0;
    }
    bodyFat = Math.max(SCALE_CONFIG.BODY_FAT_MIN, Math.min(SCALE_CONFIG.BODY_FAT_MAX, bodyFat));

    let water = gender === 'male' ? 68 - (bodyFat - 10) * 0.7 : 63 - (bodyFat - 15) * 0.7;
    water = Math.max(SCALE_CONFIG.WATER_MIN, Math.min(SCALE_CONFIG.WATER_MAX, water));

    const boneRatio = SCALE_CONFIG.BONE_MASS_RATIO;
    const muscleMass = weight * (1 - bodyFat / 100 - boneRatio);

    let protein = gender === 'male' ? 22 - (bodyFat - 15) * 0.3 : 20 - (bodyFat - 20) * 0.3;
    protein = Math.max(SCALE_CONFIG.PROTEIN_MIN, Math.min(SCALE_CONFIG.PROTEIN_MAX, protein));

    let bmr = gender === 'male'
      ? 10 * weight + 6.25 * height - 5 * age + 5 - 80
      : 10 * weight + 6.25 * height - 5 * age - 161 - 60;
    bmr = Math.round(bmr);

    const boneMass = weight * boneRatio;

    let visceralFat = gender === 'male'
      ? (bmi - 20) * 2.5 + (age - 25) * 0.3
      : (bmi - 19) * 2.5 + (age - 25) * 0.3;
    visceralFat = Math.max(SCALE_CONFIG.VISCERAL_FAT_MIN, Math.min(SCALE_CONFIG.VISCERAL_FAT_MAX, Math.round(visceralFat * 10) / 10));

    this.setData({
      bmi: parseFloat(parseFloat(bmi).toFixed(1)),
      bodyFat: parseFloat(parseFloat(bodyFat).toFixed(1)),
      water: parseFloat(parseFloat(water).toFixed(1)),
      muscleMass: parseFloat(parseFloat(muscleMass).toFixed(2)),
      protein: parseFloat(parseFloat(protein).toFixed(1)),
      bmr, boneMass: parseFloat(parseFloat(boneMass).toFixed(2)),
      visceralFat, advice: this.genAdvice({ ...currentMember, bmi: parseFloat(bmi) })
    }, () => {
      if (typeof callback === 'function') callback();
    });

    this.log(`BMI: ${parseFloat(bmi).toFixed(1)} | 体脂率: ${parseFloat(bodyFat).toFixed(1)}%`);
    if (this.data.isStabilized && this.data.currentMember) this.autoSaveToDatabase();
  },

  drawCombinedChart() {
    if (!this.data.currentMember?.weightHistory?.length) return;
    const ctx = wx.createCanvasContext('combinedChart', this);
    chartDrawer.drawCombinedChart(ctx, this.data.currentMember.weightHistory, 'combinedChart');
  },

  startScan() {
    const app = getApp();
    if (!app.globalData.bleAdapterInitialized) {
      wx.showModal({ title: '蓝牙未就绪', content: '正在初始化蓝牙，请稍候...', showCancel: false });
      return;
    }
    if (app.globalData.bleScanning) {
      this.setData({ scanning: true });
      wx.showToast({ title: '扫描进行中', icon: 'success' });
      return;
    }
    app.startBleScan();
    this.setData({ scanning: true });
    this.log("开始扫描体脂秤");
    wx.showToast({ title: '扫描已启动', icon: 'success' });
    setTimeout(() => this.log('请将体脂秤放在手机1米内，然后站上秤'), 1000);
  },

  stopScan() {
    this.setData({ scanning: false });
    this.log("停止扫描");
  },

  refreshDevices() {
    this.log('刷新蓝牙广播...');
    this.setData({ scanning: true });
    wx.getBluetoothDevices({
      success: (res) => {
        this.log(`发现 ${res.devices.length} 个设备`);
        let found = false;
        res.devices.forEach((device, i) => {
          if (device.name) {
            this.log(`${i + 1}. ${device.name} (RSSI: ${device.RSSI})`);
            const name = device.name.toLowerCase();
            if (name.includes('mi scale') || name.includes('body') || name.includes('scale') ||
                name.includes('米秤') || name.includes('体脂') || name.includes('mibfs')) {
              found = true;
              if (device.advertisData) {
                const data = parseScaleData(device.advertisData);
                if (data) this.handleScaleDataUpdate({ ...data, deviceName: device.name });
              }
            }
          }
        });
        if (!found) {
          wx.showToast({ title: '未发现体脂秤', icon: 'none', duration: 2000 });
          this.setData({ scanning: false });
        }
      },
      fail: () => {
        this.log('获取设备失败');
        this.setData({ scanning: false });
      }
    });
  },

  autoSaveToDatabase() {
    if (!this.data.currentMember || !this.data.isStabilized || this.data.weight <= 0) return;
    const member = this.data.currentMember;
    const lastWeight = member.lastWeight || 0;

    if (lastWeight > 0 && Math.abs(this.data.weight - lastWeight) >= SCALE_CONFIG.AUTO_SAVE_WEIGHT_DIFF) {
      wx.showToast({ title: '体重波动过大，请确认', icon: 'none', duration: 2000 });
      return;
    }

    if (!this.data.bmi) this.calculateBodyMetrics();
    if (!this.data.bmi || !this.data.bodyFat) return;

    cloudRequest.callContainer({
      path: '/api/scale/record', method: 'POST',
      data: {
        weight: this.data.weight, impedance: this.data.impedance || 0,
        bmi: parseFloat(this.data.bmi), body_fat: parseFloat(this.data.bodyFat),
        water: parseFloat(this.data.water) || 0, muscle: parseFloat(this.data.muscleMass) || 0,
        protein: parseFloat(this.data.protein) || 0, bmr: this.data.bmr || 0,
        bone_mass: parseFloat(this.data.boneMass) || 0, visceral_fat: this.data.visceralFat || 0,
        timestamp: Date.now(), user_id: parseInt(this.data.userInfo.user_id),
        member_id: member.id
      },
      success: () => {
        this.setData({ autoSaved: true });
        this.lastSaveTime = Date.now();
        this.log('数据已自动保存');
        wx.showToast({ title: '保存成功', icon: 'success', duration: 1500 });
      },
      fail: () => {
        this.log("自动保存失败");
        wx.showToast({ title: '保存失败', icon: 'error', duration: 2000 });
      }
    });
  },

  uploadData() {
    if (this.data.weight <= 0) { wx.showToast({ title: '无效体重', icon: 'none' }); return; }
    if (!this.data.currentMember) { wx.showToast({ title: '请选择成员', icon: 'none' }); return; }
    if (!this.data.bmi) this.calculateBodyMetrics();
    if (!this.data.bmi || !this.data.bodyFat) { wx.showToast({ title: '请先完善成员信息', icon: 'none' }); return; }

    wx.showLoading({ title: '上传中...' });
    cloudRequest.callContainer({
      path: '/api/scale/record', method: 'POST',
      data: {
        weight: this.data.weight, impedance: this.data.impedance || 0,
        bmi: parseFloat(this.data.bmi), body_fat: parseFloat(this.data.bodyFat),
        water: parseFloat(this.data.water) || 0, muscle: parseFloat(this.data.muscleMass) || 0,
        protein: parseFloat(this.data.protein) || 0, bmr: this.data.bmr || 0,
        bone_mass: parseFloat(this.data.boneMass) || 0, visceral_fat: this.data.visceralFat || 0,
        timestamp: Date.now(), user_id: parseInt(this.data.userInfo.user_id),
        member_id: this.data.currentMember.id
      },
      success: () => {
        wx.hideLoading();
        wx.showToast({ title: '上传成功', icon: 'success' });
        this.log('数据上传成功');
        this.loadMembers();
      },
      fail: (err) => {
        wx.hideLoading();
        if (err.statusCode === 503) {
          wx.showModal({
            title: '服务未配置', content: '请在首页添加体脂秤设备',
            showCancel: true, cancelText: '取消', confirmText: '去配置',
            success: (res) => { if (res.confirm) wx.reLaunch({ url: '/pages/index/index' }); }
          });
        } else {
          this.log("上传失败");
          wx.showToast({ title: '上传失败', icon: 'error' });
        }
      }
    });
  },

  log(msg) {
    const logs = this.data.logs;
    logs.unshift(`${new Date().toLocaleTimeString()} ${msg}`);
    if (logs.length > LIMITS.LOGS) logs.pop();
    this.setData({ logs });
    console.log('[Scale]', msg);
  },

  toggleDebugMode() {
    const newMode = !this.data.debugMode;
    this.setData({ debugMode: newMode, rawAdvertisements: [] });
    if (newMode) {
      wx.showToast({ title: '调试模式已开启', icon: 'success' });
      this.startRawAdvertisementListener();
    } else {
      wx.showToast({ title: '调试模式已关闭', icon: 'none' });
      this.stopRawAdvertisementListener();
    }
  },

  startRawAdvertisementListener() {
    const app = getApp();
    if (!app.globalData.bleAdapterInitialized) {
      app.checkAndInitBluetooth(() => this.beginScanAdvertisements());
      return;
    }
    this.beginScanAdvertisements();
  },

  beginScanAdvertisements() {
    wx.stopBluetoothDevicesDiscovery({
      complete: () => {
        wx.startBluetoothDevicesDiscovery({
          allowDuplicatesKey: true,
          success: () => {
            wx.onBluetoothDeviceFound((res) => {
              if (res.devices?.length > 0) {
                res.devices.forEach(device => this.handleRawAdvertisement(device));
              }
            });
          }
        });
      }
    });
  },

  stopRawAdvertisementListener() {
    wx.stopBluetoothDevicesDiscovery();
  },

  handleRawAdvertisement(device) {
    if (!device.advertisData || device.advertisData.byteLength === 0) return;
    const bytes = new Uint8Array(device.advertisData);
    if (bytes.length !== 8 && bytes.length !== 13) return;

    const timestamp = new Date().toLocaleTimeString();
    const hexString = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

    console.log('\n========== MIBFS ==========');
    console.log('⏰', timestamp);
    console.log('📱', device.name || 'Unknown');
    console.log('📶 RSSI:', device.RSSI, 'dBm');
    console.log('📏 Length:', bytes.length, 'bytes');
    console.log('🔢 Hex:', hexString);
    console.log('🔣 Bytes:', JSON.stringify(Array.from(bytes)));

    console.log('\n--- Parse ---');
    try {
      const parsed = parseScaleData(device.advertisData);
      if (parsed) {
        console.log('✅ Weight:', parsed.weight, parsed.unit);
        console.log('💧 Impedance:', parsed.impedance, 'Ω');
        console.log('🎯 Stable:', parsed.isStabilized);
        console.log('📋 Format:', parsed.format);
        console.log('🕐 Time:', new Date(parsed.timestamp).toLocaleString());
      } else console.log('❌ Parse failed');
    } catch (e) { console.log('❌ Error:', e.message); }
    console.log('==============================\n');

    const ads = this.data.rawAdvertisements;
    ads.unshift({
      time: timestamp, name: device.name || 'Unknown',
      rssi: device.RSSI, length: bytes.length, hex: hexString,
      parsed: '', success: false
    });
    if (ads.length > 100) ads.pop();
    this.setData({ rawAdvertisements: ads });
  },

  clearAdvertisements() {
    this.setData({ rawAdvertisements: [] });
    this.log('🗑️ 已清空广播记录');
    wx.showToast({ title: '已清空', icon: 'success' });
  }
});
