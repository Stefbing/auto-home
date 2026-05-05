const cloudRequest = require('../../utils/cloud_request.js');

Page({

  data: {
    // 测量数据
    weight: 0,
    weightDisplay: '0.00',
    impedance: 0,
    isStabilized: false,
    stabilityProgress: 0,
    stabilitySteps: 5,

    // 锁定机制
    measurementLocked: false,
    lockedWeight: null,
    lockedImpedance: null,

    // 时间戳控制
    lastExitTime: 0,
    lastRealMeasureTime: 0,
    lastWeight: 0,

    // 家庭成员
    members: [],
    selectedMemberId: null,
    isLoadingMembers: false,

    // 当前成员信息
    currentMember: {
      height: 170,
      age: 25,
      gender: 'male'
    },

    // 健康指标
    bmi: null,
    bodyFat: null,
    water: null,
    muscleMass: null,
    protein: null,
    bmr: null,
    visceralFat: null,
    advice: null,

    // 弹窗控制
    showAddMemberDialog: false,
    editingMemberId: null,
    newMemberName: '',
    newMemberAge: '',
    newMemberHeight: '',
    newMemberGender: '',
    newMemberGenderIndex: 0,

    // 自动保存标记
    autoSaved: false
  },

  onLoad() {
    this.loadMembers();
  },

  async onShow() {
    this.registerBleCallback();
    // 同步加载成员（确保最新数据）
    await this.loadMembers();
    // 恢复上次选择的成员
    const lastMemberId = wx.getStorageSync('lastSelectedMemberId');
    if (lastMemberId && this.data.members.length > 0) {
      const member = this.data.members.find(m => m.id === lastMemberId);
      if (member) {
        this.selectMember({ currentTarget: { dataset: { id: member.id } } });
      }
    }
  },

  onHide() {
    this.unregisterBleCallback();
    this.lastExitTime = Date.now();

    this.setData({
      measurementLocked: false,
      lockedWeight: null,
      lockedImpedance: null,
      isStabilized: false,
      stabilityProgress: 0,
      autoSaved: false
    });
  },

  onUnload() {
    this.unregisterBleCallback();
  },

  registerBleCallback() {
    const app = getApp();
    this.bleCallback = (data) => this.handleBLE(data);
    app.registerScaleCallback(this.bleCallback);
  },

  unregisterBleCallback() {
    if (this.bleCallback) {
      getApp().unregisterScaleCallback(this.bleCallback);
      this.bleCallback = null;
    }
  },

  
  // ======================
  // BLE数据处理
  // ======================
  handleBLE(data) {
    if (!data || data.weight < 0.1 || data.weight > 300) return;
  
    // 冷却期（防止页面退出后触发）
    if (this.lastExitTime && Date.now() - this.lastExitTime < 3000) {
      return;
    }
  
    const weight = data.weight;
    const diff = Math.abs(weight - this.data.lastWeight);
  
    // 更新稳定性进度（平滑处理）
    let stabilityProgress = this.data.stabilityProgress;
    if (diff < 0.5 && weight > 5) {
      stabilityProgress = Math.min(stabilityProgress + 1, this.data.stabilitySteps);
    } else if (diff > 2) {  // 提高阈值到2kg，避免微调姿势时重置
      stabilityProgress = 0;
    }
  
    this.setData({
      weight,
      weightDisplay: weight.toFixed(2),
      impedance: data.impedance || 0,
      lastWeight: weight,
      isStabilized: data.isStabilized || false,
      stabilityProgress
    });
  
    // ❗ 判断"是否真的上秤"
    if (weight < 5 || diff < 0.2) {
      return;
    }
  
    // ❗ 稳定且未锁定时，标记稳定状态
    if (data.isStabilized && !this.data.measurementLocked) {
      console.log('[Scale] ⚖️ 体重已稳定，等待阻抗...');
    }
    
    // ❗ 稳定后，当阻抗到来时触发计算
    if (data.isStabilized && data.impedance && data.impedance > 0) {
      // 防重复触发（3秒内相同体重忽略）
      if (this.data.measurementLocked) {
        const weightDiff = Math.abs(this.data.lockedWeight - weight);
        if (weightDiff < 0.2 && Date.now() - this.lastRealMeasureTime < 3000) {
          return;
        }
      }
  
      console.log('[Scale] 🔒 锁定测量，阻抗:', data.impedance);
  
      this.setData({
        measurementLocked: true,
        lockedWeight: weight,
        lockedImpedance: data.impedance
      });
  
      this.lastRealMeasureTime = Date.now();
  
      // ❗ 延迟一点再计算（避免刚进页面误触）
      setTimeout(() => {
        if (Date.now() - this.lastRealMeasureTime < 1000) {
          return;
        }
  
        console.log('[Scale] ✅ 真实测量，开始计算');
        this.calculateBodyMetrics();
      }, 1200);
    }
  },

  // ======================
  // 体脂计算（9项指标）
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

    // 1. BMI
    const bmi = weight / ((height / 100) ** 2);

    // 2. 体脂率（使用阻抗法，更准确）
    let bodyFat;
    if (impedance > 0) {
      // Deurenberg 公式（带阻抗）
      const sex = gender === 'male' ? 1 : 0;
      bodyFat = (1.2 * bmi) + (0.23 * age) - (10.8 * sex) - 5.4;
      
      // 如果有阻抗，使用更精确的公式
      if (impedance > 100) {
        bodyFat = (0.7 * bodyFat) + (0.3 * ((impedance / (height ** 2)) * 100));
      }
    } else {
      // 无阻抗时的估算
      const sex = gender === 'male' ? 1 : 0;
      bodyFat = (1.2 * bmi) + (0.23 * age) - (10.8 * sex) - 5.4;
    }

    // 3. 水分率
    const water = gender === 'male' ? 55 + (bodyFat < 20 ? 5 : 0) : 45 + (bodyFat < 28 ? 5 : 0);

    // 4. 肌肉量
    const muscleMass = weight * ((100 - bodyFat) / 100) * 0.45;

    // 5. 蛋白质
    const protein = gender === 'male' ? 18 + (muscleMass > 30 ? 2 : 0) : 16 + (muscleMass > 25 ? 2 : 0);

    // 6. 基础代谢率 (Mifflin-St Jeor 公式)
    let bmr;
    if (gender === 'male') {
      bmr = 10 * weight + 6.25 * height - 5 * age + 5;
    } else {
      bmr = 10 * weight + 6.25 * height - 5 * age - 161;
    }

    // 7. 内脏脂肪等级
    const visceralFat = Math.max(1, Math.min(15, (bmi - 15) / 2));

    // 8. 骨量
    const boneMass = weight * 0.03;

    // 9. 标准体重
    const standardWeight = (height - 100) * 0.9;

    // 健康建议
    let advice = '';
    if (bmi < 18.5) {
      advice = '体重偏轻，建议增加营养摄入并适当增肌';
    } else if (bmi < 24) {
      advice = '体型良好，请继续保持健康的生活方式';
    } else if (bmi < 28) {
      advice = '体重偏重，建议控制饮食并增加有氧运动';
    } else {
      advice = '肥胖风险较高，建议咨询专业医生制定减重计划';
    }

    this.setData({
      bmi: bmi.toFixed(1),
      bodyFat: bodyFat.toFixed(1),
      water: water.toFixed(1),
      muscleMass: muscleMass.toFixed(1),
      protein: protein.toFixed(1),
      bmr: Math.round(bmr),
      visceralFat: visceralFat.toFixed(1),
      advice
    });

    // 自动保存到数据库
    this.autoSaveMeasurement();
  },

  // ======================
  // 家庭成员管理
  // ======================
  async loadMembers() {
    this.setData({ isLoadingMembers: true });

    try {
      // 从云端加载（始终获取最新数据）
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
          weightHistory: m.weight_history || []
        }));

        this.setData({ members });
        wx.setStorageSync('scaleMembers', members);
      }
    } catch (err) {
      console.error('[Scale] 加载成员失败:', err);
      // 降级：使用本地缓存
      const localMembers = wx.getStorageSync('scaleMembers');
      if (localMembers && localMembers.length > 0) {
        this.setData({ members: localMembers });
      }
      wx.showToast({ title: '加载失败', icon: 'none' });
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
      }
    });

    // 保存最后选择的成员
    wx.setStorageSync('lastSelectedMemberId', memberId);

    // 如果已有测量数据，重新计算
    if (this.data.lockedWeight) {
      this.calculateBodyMetrics();
    }
  },

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
      content: `确定要删除「${memberName}」吗？`,
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

  // ======================
  // 添加/编辑成员弹窗
  // ======================
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
    const index = e.detail.value;
    this.setData({
      newMemberGenderIndex: index,
      newMemberGender: index === 0 ? '男' : '女'
    });
  },

  async submitAddMember() {
    const { newMemberName, newMemberAge, newMemberHeight, newMemberGender, editingMemberId } = this.data;

    // 验证
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
        // 编辑
        res = await cloudRequest.callContainer({
          path: `/api/scale/members/${editingMemberId}`,
          method: 'PUT',
          data: memberData
        });
      } else {
        // 新增
        res = await cloudRequest.callContainer({
          path: '/api/scale/members',
          method: 'POST',
          data: memberData
        });
      }

      if (res.code === 200) {
        wx.showToast({ title: editingMemberId ? '修改成功' : '添加成功', icon: 'success' });
        this.closeAddMemberModal();
        this.loadMembers(); // 重新加载列表
      }
    } catch (err) {
      console.error('[Scale] 保存成员失败:', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  // ======================
  // 自动保存测量数据
  // ======================
  async autoSaveMeasurement() {
    const { lockedWeight, lockedImpedance, selectedMemberId, bmi, bodyFat, water, muscleMass, protein, bmr, visceralFat } = this.data;

    if (!lockedWeight || !selectedMemberId) {
      console.warn('[Scale] 无法保存：缺少体重或成员信息');
      return;
    }

    try {
      const res = await cloudRequest.callContainer({
        path: '/api/scale/measurements',
        method: 'POST',
        data: {
          member_id: selectedMemberId,
          weight: lockedWeight,
          impedance: lockedImpedance || 0,
          bmi: parseFloat(bmi),
          body_fat: parseFloat(bodyFat),
          water: parseFloat(water),
          muscle_mass: parseFloat(muscleMass),
          protein: parseFloat(protein),
          bmr: parseInt(bmr),
          visceral_fat: parseFloat(visceralFat)
        }
      });

      if (res.code === 200) {
        console.log('[Scale] ✅ 数据已自动保存');
        this.setData({ autoSaved: true });

        // 更新成员的最近体重
        const members = this.data.members.map(m => {
          if (m.id === selectedMemberId) {
            return {
              ...m,
              lastWeight: lockedWeight,
              weightHistory: [...(m.weightHistory || []), {
                date: new Date().toISOString(),
                weight: lockedWeight
              }]
            };
          }
          return m;
        });

        this.setData({ members });
        wx.setStorageSync('scaleMembers', members);
      }
    } catch (err) {
      console.error('[Scale] 保存失败:', err);
      // 不显示错误提示，避免打扰用户
    }
  }
});
