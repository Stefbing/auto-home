const cloudRequest = require('../../utils/cloud_request.js');
const { SCALE_CONFIG, MATCHING, TIMING, LIMITS } = require('../../config/scale_constants.js');
const chartDrawer = require('../../modules/chart_drawer.js');

Page({
  data: {
    scanning: false,
    device: null,
    weight: 0,
    weightDisplay: '0.00', // 格式化后的体重显示
    impedance: 0,
    isStabilized: false,
    logs: [],
    userInfo: null,
    autoSaved: false, // 标记是否已自动保存
    lastSavedWeight: null, // 上次保存的体重，用于去重
    scanTimeout: null, // 扫描超时定时器
    measurementLocked: false, // 测量完成后锁定，等待用户选择成员
    lockedWeight: null, // 锁定的体重数据
    lockedImpedance: null, // 锁定的阻抗数据
    lastDataTime: null, // 最后一次收到数据的时间戳
    
    // 家庭成员管理
    members: [],
    selectedMemberId: null,
    currentMember: null,
    isLoadingMembers: false,
    
    // 添加/编辑成员弹窗
    showAddMemberDialog: false,
    editingMemberId: null,
    newMemberName: '',
    newMemberAge: '',
    newMemberHeight: '',
    newMemberGender: '',
    newMemberGenderIndex: -1,
    
    // 体脂计算结果
    bmi: null,
    bodyFat: null,
    water: null,
    muscleMass: null,
    protein: null,
    bmr: null,
    boneMass: null,
    visceralFat: null,
    advice: null
  },

  onLoad() {
    this.checkLoginStatus();
    
    // 检查并初始化蓝牙（三个条件：已登录 + 有体脂秤设备 + 未初始化）
    this.checkAndInitBluetoothIfNeeded();
  },
  
  /**
   * 检查并初始化蓝牙（满足三个条件时才申请权限）
   * 1. 用户已登录
   * 2. 用户有体脂秤设备配置（从后端实时查询）
   * 3. 蓝牙尚未初始化
   */
  async checkAndInitBluetoothIfNeeded() {
    const app = getApp();
    
    // 条件1: 检查是否已登录
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.user_id) {
      console.log('[Scale] 用户未登录，不初始化蓝牙');
      return;
    }
    
    // 条件2: 从后端实时检查是否有体脂秤设备
    try {
      const res = await cloudRequest.callContainer({
        path: `/api/dashboard/data?user_id=${userInfo.user_id}`,
        method: 'GET'
      });
      
      const hasXiaomiConfig = res.xiaomi_config || false;
      
      if (!hasXiaomiConfig) {
        console.log('[Scale] 用户未配置体脂秤设备，不初始化蓝牙');
        wx.showModal({
          title: '未配置设备',
          content: '请先在首页添加体脂秤设备',
          showCancel: false,
          confirmText: '去配置',
          success: () => {
            wx.reLaunch({ url: '/pages/index/index' });
          }
        });
        return;
      }
      
      console.log('[Scale] 检测到用户有体脂秤配置');
    } catch (err) {
      console.error('[Scale] 检查设备配置失败:', err);
      return;
    }
    
    // 条件3: 检查蓝牙是否已初始化
    if (app.globalData.bleAdapterInitialized) {
      console.log('[Scale] 蓝牙已初始化，跳过');
      return;
    }
    
    // 三个条件都满足，初始化蓝牙
    console.log('[Scale] 满足所有条件，开始初始化蓝牙');
    app.checkAndInitBluetooth();
  },

  onShow() {
    // 只在已有userInfo时才刷新，避免与onLoad重复
    if (this.data.userInfo && this.data.members.length > 0) {
      this.loadMembers();
    }
    
    // 重新注册回调（页面显示时）
    this.registerBleCallback();
    
    // 检查是否有最新的蓝牙数据
    const app = getApp();
    if (app.globalData.latestScaleData) {
      this.handleScaleDataUpdate(app.globalData.latestScaleData);
    }
    
    // 设置超时断连机制（60秒无数据则断开）
    this.startScanTimeout();
  },
  
  onHide() {
    // 页面隐藏时注销回调，避免内存泄漏
    this.unregisterBleCallback();
    
    // 页面隐藏时不重置状态，保持测量数据
    console.log('[Scale Page] 页面隐藏，保持测量状态');
  },
  
  onUnload() {
    // 页面卸载时注销回调
    this.unregisterBleCallback();
    
    // 清除定时器
    if (this.data.scanTimeout) {
      clearTimeout(this.data.scanTimeout);
    }
    
    console.log('[Scale Page] 页面卸载，清理资源');
  },
  
  /**
   * 注册蓝牙数据更新回调
   */
  registerBleCallback() {
    const app = getApp();
    
    // 避免重复注册
    if (this.bleCallback) {
      return;
    }
    
    this.bleCallback = (data) => {
      console.log('[Scale Page] 收到蓝牙数据更新:', data);
      this.handleScaleDataUpdate(data);
    };
    
    app.registerScaleCallback(this.bleCallback);
  },
  
  /**
   * 注销蓝牙数据更新回调
   */
  unregisterBleCallback() {
    const app = getApp();
    
    if (this.bleCallback) {
      app.unregisterScaleCallback(this.bleCallback);
      this.bleCallback = null;
    }
  },
  
  /**
   * 启动扫描超时定时器（60秒）
   */
  startScanTimeout() {
    // 清除旧定时器
    if (this.data.scanTimeout) {
      clearTimeout(this.data.scanTimeout);
    }
    
    // 设置新定时器
    const timeout = setTimeout(() => {
      console.log('[超时] 60秒无数据，断开连接');
      this.resetMeasurementState();
      wx.showToast({
        title: '已断开连接',
        icon: 'none',
        duration: 2000
      });
    }, TIMING.TIMEOUT);
    
    this.setData({ scanTimeout: timeout });
  },
  
  /**
   * 重置扫描超时定时器
   */
  resetScanTimeout() {
    this.startScanTimeout();
  },
  
  /**
   * 重置测量状态（断连或超时时调用）
   */
  resetMeasurementState() {
    console.log('[Scale Page] 🔄 重置测量状态');
    
    // 清除定时器
    if (this.data.scanTimeout) {
      clearTimeout(this.data.scanTimeout);
    }
    
    // 重置所有状态
    this.setData({
      scanning: false,
      device: null,
      weight: 0,
      weightDisplay: '0.00',
      impedance: 0,
      isStabilized: false,
      autoSaved: false,
      measurementLocked: false,
      lockedWeight: null,
      lockedImpedance: null,
      lastDataTime: null,
      // 保留体脂计算结果，让用户能看到最后的数据
      // bmi, bodyFat, water 等不清空
    });
    
    this.log('连接已断开，状态已重置');
  },
  
  /**
   * 处理蓝牙数据更新
   */
  handleScaleDataUpdate(data) {
    console.log('[Scale Page] 收到原始数据:', JSON.stringify(data));
      
    // 【锁定检查】如果已锁定，忽略新数据
    if (this.data.measurementLocked) {
      console.log('[Scale Page] ⚠️ 测量已锁定，忽略新数据');
      return;
    }
        
    // 【关键验证】检查数据有效性
    if (!data || !data.weight || data.weight <= 0) {
      console.log('[Scale Page] ❌ 无效数据:', data);
      return;
    }
        
    // 【关键验证】体重合理性检查（0.1kg - 300kg）
    if (data.weight < 0.1 || data.weight > 300) {
      console.log('[Scale Page] ❌ 体重超出合理范围:', data.weight);
      return;
    }
    
    // 【重要】实时测量时不强制要求阻抗数据（体脂秤在测量过程中可能先返回体重）
    // 只有在数据稳定时才严格验证阻抗
    const hasImpedance = data.impedance && data.impedance > 0;
    const isStable = data.isStabilized;
    
    console.log('[Scale Page] 数据验证:', {
      weight: data.weight,
      impedance: data.impedance,
      hasImpedance,
      isStable
    });
    
    // 如果数据稳定但没有阻抗，说明可能不是真正的体脂秤数据
    if (isStable && !hasImpedance) {
      console.log('[Scale Page] ⚠️ 数据稳定但无阻抗，等待下一次数据');
      return;
    }
    
    // 如果有阻抗数据，验证合理性
    if (hasImpedance && (data.impedance < 100 || data.impedance > 3000)) {
      console.log('[Scale Page] ❌ 阻抗超出合理范围:', data.impedance);
      return;
    }
        
    // 检查是否为相同数据（误差<0.05kg），避免重复计算
    const isSameData = Math.abs(this.data.weight - data.weight) < MATCHING.DEDUPLICATION_THRESHOLD;
    console.log('[Scale Page] 数据对比:', {
      oldWeight: this.data.weight,
      newWeight: data.weight,
      diff: Math.abs(this.data.weight - data.weight),
      isSameData
    });
        
    // 【防抖】如果刚刚保存过（3秒内）且数据相同，跳过处理
    const now = Date.now();
    if (this.lastSaveTime && (now - this.lastSaveTime) < TIMING.DEBOUNCE && isSameData) {
      console.log('[Scale Page] ⏱️ 防抖：距离上次保存不足3秒且数据相同，跳过');
      return;
    }
        
    console.log('[Scale Page] ✅ 数据通过验证，开始更新UI');
    
    // 更新页面数据（CSS会自动动画）
    this.setData({
      device: data.deviceName || '小米体脂秤',
      weight: data.weight,
      weightDisplay: data.weight.toFixed(2), // 格式化显示
      impedance: data.impedance || 0,
      isStabilized: data.isStabilized,
      scanning: true,
      autoSaved: false, // 重置自动保存状态
      lastDataTime: now // 记录最后一次收到数据的时间
    }, () => {
      console.log('[Scale Page] UI更新完成:', {
        weight: this.data.weight,
        weightDisplay: this.data.weightDisplay,
        isStabilized: this.data.isStabilized
      });
    });
        
    // 重置超时定时器
    this.resetScanTimeout();
      
    this.log(`体重: ${data.weight}kg | 阻抗: ${data.impedance || 0}Ω | 稳定: ${data.isStabilized ? '是' : '否'}`);
        
    // 只有数据稳定时才进行后续处理
    if (!data.isStabilized) {
      console.log('[Scale Page] 📊 数据未稳定，仅更新显示');
      return;
    }
      
    // 【关键】数据稳定后，锁定测量，等待用户选择成员
    console.log('[Scale Page] 🔒 数据已稳定，锁定测量');
    this.setData({
      measurementLocked: true,
      lockedWeight: data.weight,
      lockedImpedance: data.impedance
    });
      
    // 提示用户选择成员
    wx.showToast({
      title: '请选择成员',
      icon: 'none',
      duration: 2000
    });
      
    // 如果体重稳定且不是相同数据，才重新计算和匹配
    if (!isSameData) {
      // 确保当前已选择成员
      if (!this.data.currentMember) {
        console.log('[Scale Page] 👤 未选择成员，等待用户操作');
          
        // 如果成员列表为空，等待加载完成
        if (this.data.members.length === 0) {
          console.log('[Scale Page] ⚠️ 成员列表未加载，等待...');
          return;
        }
          
        // 不自动选择，等待用户手动选择
        console.log('[Scale Page] ⏳ 等待用户选择成员');
      } else {
        // 已有选中成员，直接计算体脂
        console.log('[Scale Page] 🧮 已有成员，计算体脂');
        this.calculateBodyMetrics();
      }
    }
  },
  
  /**
   * 自动匹配成员（基于历史体重±3kg范围）
   */
  autoMatchMember(currentWeight) {
    const members = this.data.members;
    
    if (!members || members.length === 0) {
      console.log('[自动匹配] 无成员列表');
      return;
    }
    
    // 如果只有一个成员，直接选择
    if (members.length === 1) {
      console.log('[自动匹配] 只有一个成员，自动选择');
      this.selectMemberByIndex(0);
      return;
    }
    
    // 查找体重最接近的成员（容差±3kg）
    let bestMatch = null;
    let minDiff = Infinity;
    const tolerance = MATCHING.TOLERANCE; // 容差3kg
    
    members.forEach((member, index) => {
      if (member.lastWeight && member.lastWeight > 0) {
        const diff = Math.abs(member.lastWeight - currentWeight);
        
        if (diff <= tolerance && diff < minDiff) {
          minDiff = diff;
          bestMatch = { member, index };
        }
      }
    });
    
    if (bestMatch) {
      console.log(`[自动匹配] 找到匹配成员: ${bestMatch.member.name} (差异: ${minDiff.toFixed(1)}kg)`);
      this.selectMemberByIndex(bestMatch.index);
      wx.showToast({
        title: `已选择: ${bestMatch.member.name}`,
        icon: 'success',
        duration: 1500
      });
    } else {
      // 没有找到匹配的成员，检查是否有成员的历史体重
      const hasHistoryMembers = members.some(m => m.lastWeight && m.lastWeight > 0);
      
      if (hasHistoryMembers) {
        // 有历史成员但体重差距大，提示用户
        console.log('[自动匹配] 体重差距过大，提示用户选择');
        
        // 找出体重最接近的成员（即使超过容差）
        let closestMatch = null;
        let closestDiff = Infinity;
        
        members.forEach((member, index) => {
          if (member.lastWeight && member.lastWeight > 0) {
            const diff = Math.abs(member.lastWeight - currentWeight);
            if (diff < closestDiff) {
              closestDiff = diff;
              closestMatch = { member, index };
            }
          }
        });
        
        if (closestMatch) {
          wx.showModal({
            title: '体重差异较大',
            content: `当前体重 ${currentWeight}kg 与 ${closestMatch.member.name} 的历史体重 ${closestMatch.member.lastWeight}kg 相差 ${closestDiff.toFixed(1)}kg\n\n是否仍选择该成员？`,
            confirmText: '选择',
            cancelText: '切换',
            success: (res) => {
              if (res.confirm) {
                // 用户确认选择
                this.selectMemberByIndex(closestMatch.index);
              } else {
                // 用户取消，提示手动选择或添加新成员
                wx.showModal({
                  title: '选择成员',
                  content: '请从下方列表中选择成员，或点击右上角“+”添加新成员',
                  showCancel: false,
                  confirmText: '知道了'
                });
              }
            }
          });
        }
      } else {
        // 所有成员都没有历史体重，选择第一个（通常是"自己"）
        console.log('[自动匹配] 所有成员无历史体重，选择第一个');
        this.selectMemberByIndex(0);
        wx.showToast({
          title: `已选择: ${members[0].name}`,
          icon: 'success',
          duration: 1500
        });
      }
    }
  },
  
  /**
   * 通过索引选择成员（用于自动匹配）
   */
  selectMemberByIndex(index) {
    if (!this.data.members || index < 0 || index >= this.data.members.length) {
      console.log('[选择成员] 索引无效');
      return;
    }
    
    const member = this.data.members[index];
    
    // 【新增】如果已选择过成员且已有计算结果，切换时需要确认
    if (this.data.currentMember && this.data.currentMember.id !== member.id && this.data.bodyFat) {
      wx.showModal({
        title: '切换成员',
        content: `当前已计算 ${this.data.currentMember.name} 的数据，是否切换到 ${member.name}？\n\n切换后将重新计算并保存新数据。`,
        confirmText: '切换',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            // 用户确认切换，先清除旧数据
            this.clearCalculationResults();
            // 执行切换
            this.performMemberSwitch(member);
          }
        }
      });
      return;
    }
    
    // 首次选择或无计算结果，直接切换
    this.performMemberSwitch(member);
  },
  
  /**
   * 执行成员切换逻辑
   */
  performMemberSwitch(member) {
    console.log('[Scale Page] 选择成员:', member.name);
    
    this.setData({
      selectedMemberId: member.id,
      currentMember: member
    });
    
    // 显示计算中提示
    wx.showLoading({ title: '计算中...', mask: true });
    
    // 【关键】如果测量已锁定，使用锁定的数据计算
    if (this.data.measurementLocked && this.data.lockedWeight) {
      console.log('[Scale Page] 使用锁定数据计算体脂');
      // 临时更新weight和impedance为锁定值
      const tempWeight = this.data.weight;
      const tempImpedance = this.data.impedance;
      
      this.setData({
        weight: this.data.lockedWeight,
        impedance: this.data.lockedImpedance
      });
      
      // 计算体脂
      setTimeout(() => {
        this.calculateBodyMetrics(() => {
          // 计算完成后隐藏loading
          wx.hideLoading();
          
          // 恢复当前实时数据（如果有）
          if (tempWeight > 0) {
            this.setData({
              weight: tempWeight,
              impedance: tempImpedance
            });
          }
          
          // 解锁，允许下一次测量
          this.setData({
            measurementLocked: false,
            lockedWeight: null,
            lockedImpedance: null
          });
          
          console.log('[Scale Page] 测量完成，已解锁');
        });
      }, 500); // 延迟500ms让用户看到"计算中"
    } else {
      // 正常模式，直接计算
      setTimeout(() => {
        this.calculateBodyMetrics(() => {
          wx.hideLoading();
        });
      }, 500);
    }
  },
  
  /**
   * 清除计算结果（切换成员时调用）
   */
  clearCalculationResults() {
    console.log('[Scale Page] 清除旧的计算结果');
    this.setData({
      bmi: null,
      bodyFat: null,
      water: null,
      muscleMass: null,
      protein: null,
      bmr: null,
      boneMass: null,
      visceralFat: null,
      advice: null,
      autoSaved: false
    });
  },

  checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo');
    console.log('[Scale] 体脂秤页面 - userInfo:', userInfo);
    
    if (!userInfo) {
      this.log('未登录，跳转到首页');
      wx.showModal({
        title: '未登录',
        content: '请先在首页登录',
        showCancel: false,
        confirmText: '去登录',
        success: () => {
          wx.reLaunch({ url: '/pages/index/index' });
        }
      });
      return;
    }
    
    // 确保有user_id
    if (!userInfo.user_id) {
      console.error('[Scale] userInfo中缺少user_id字段');
      this.log('用户信息异常');
      wx.showToast({ title: '用户信息异常', icon: 'none' });
      return;
    }
    
    this.setData({ userInfo });
    this.log(`用户登录: ${userInfo.nickname || userInfo.phone_number}`);
    
    // 先加载成员，如果没有“自己”则自动创建
    this.loadMembers();
  },

  // 加载家庭成员（从后端）
  loadMembers(callback) {
    console.log('开始加载家庭成员');
        
    // 防止重复加载
    if (this.data.isLoadingMembers) {
      console.log('正在加载中，跳过');
      return;
    }
        
    if (!this.data.userInfo || !this.data.userInfo.user_id) {
      console.error('用户信息不完整，无法加载成员');
      return;
    }
        
    this.setData({ isLoadingMembers: true });
    const userId = this.data.userInfo.user_id;
        
    console.log('请求API:', `/api/family-members?user_id=${userId}`);
        
    cloudRequest.callContainer({
      path: `/api/family-members?user_id=${userId}`,
      method: 'GET',
      success: (res) => {
        console.log('API返回数据:', res);
        // 接口直接返回数组，不是 {data: [...]}
        let members = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);
        console.log('加载成员成功:', members.length, '个成员');
        console.log('成员列表详情:', members.map(m => ({ id: m.id, name: m.name, relationship: m.relationship })));
            
        // 检查是否存在“自己”这个成员
        const hasSelf = members.some(m => m.relationship === 'self');
        console.log('是否存在“自己”成员:', hasSelf);
            
        // 如果没有“自己”这个成员，创建默认成员
        if (!hasSelf && this.data.userInfo) {
          console.log('未找到“自己”成员，创建默认成员');
          this.createDefaultMember();
          // 注意：这里不设置isLoadingMembers=false，因为createDefaultMember会再次调用loadMembers
          return;
        }
          
        // 转换字段名为驼峰格式
        members = members.map(member => ({
          ...member,
          avatarColor: member.avatar_color || this.getRandomColor(),
          lastWeight: null,
          bmi: null,
          bodyFat: null,
          water: null,
          advice: null,
          weightHistory: []  // 添加历史数据数组
        }));
          
        // 为每个成员加载历史记录
        this.loadMembersHistory(members, callback);
      },
      fail: (err) => {
        console.error('加载家庭成员失败:', err);
        wx.showToast({ title: '加载失败', icon: 'none' });
        this.setData({ isLoadingMembers: false });
        // 失败时也执行回调
        if (typeof callback === 'function') {
          callback();
        }
      }
    });
  },

  // 为每个成员加载历史记录
  loadMembersHistory(members, callback) {
    if (members.length === 0) {
      this.setData({ 
        members,
        selectedMemberId: null,
        currentMember: null,
        isLoadingMembers: false
      });
      // 执行回调
      if (typeof callback === 'function') {
        callback();
      }
      return;
    }
    
    console.log('[历史记录] 开始加载成员历史, 成员数:', members.length);
    
    // 并行获取所有成员的历史记录（最近7条）
    const promises = members.map(member => {
      return new Promise((resolve) => {
        cloudRequest.callContainer({
          path: `/api/family-members/${member.id}/history?user_id=${this.data.userInfo.user_id}&limit=7`,
          method: 'GET',
          success: (res) => {
            const history = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);
            console.log(`[历史记录] 成员 ${member.name} 获取到 ${history.length} 条记录`);
            
            let updatedMember = { ...member, weightHistory: history };
            
            // 如果有历史记录，计算最新数据
            if (history.length > 0) {
              const latest = history[0];
              updatedMember.lastWeight = latest.weight;
              updatedMember.bodyFat = latest.body_fat;
              updatedMember.water = latest.water;
              updatedMember.bmi = this.calculateBMI(latest.weight, member.height);
              updatedMember.advice = this.generateAdvice({ ...member, bmi: updatedMember.bmi });
            }
            
            resolve(updatedMember);
          },
          fail: (err) => {
            console.error(`[历史记录] 成员 ${member.name} 加载失败:`, err);
            resolve(member);
          }
        });
      });
    });
    
    Promise.all(promises).then(updatedMembers => {
      console.log('[历史记录] 所有成员历史加载完成');
      
      // 为每个成员计算maxWeight和格式化日期
      updatedMembers = updatedMembers.map(member => {
        if (member.weightHistory && member.weightHistory.length > 0) {
          // 计算最大体重（用于图表比例）
          const maxWeight = Math.max(...member.weightHistory.map(h => h.weight));
          console.log(`[历史记录] 成员 ${member.name} maxWeight: ${maxWeight}, 记录数: ${member.weightHistory.length}`);
          
          // 格式化日期
          member.weightHistory = member.weightHistory.map(record => {
            const date = new Date(record.timestamp || record.created_at);
            return {
              ...record,
              date: `${date.getMonth() + 1}/${date.getDate()}`,
              bodyFat: record.body_fat || 0  // 保留体脂数据
            };
          });
          
          member.maxWeight = maxWeight;
        } else {
          console.log(`[历史记录] 成员 ${member.name} 无历史记录`);
        }
        return member;
      });
      
      this.setData({ 
        members: updatedMembers,
        selectedMemberId: updatedMembers[0]?.id || null,
        currentMember: updatedMembers[0] || null,
        isLoadingMembers: false
      });
      console.log('[历史记录] 页面数据已更新，当前成员:', updatedMembers[0]?.name);
      console.log('[历史记录] 当前成员weightHistory:', updatedMembers[0]?.weightHistory?.length || 0, '条');
      console.log('[历史记录] 当前成员maxWeight:', updatedMembers[0]?.maxWeight);
      
      // 绘制图表
      setTimeout(() => {
        this.drawCombinedChart();
      }, TIMING.CHART_DELAY);
      
      // 如果已有体重数据且稳定，自动计算体脂
      if (this.data.weight > 0 && this.data.isStabilized) {
        console.log('[历史记录] 检测到已有稳定体重数据，自动计算体脂');
        setTimeout(() => {
          this.calculateBodyMetrics();
        }, TIMING.CALCULATE_DELAY);
      }
      
      // 执行回调
      if (typeof callback === 'function') {
        callback();
      }
    });
  },

  // 创建默认成员
  createDefaultMember() {
    const userId = this.data.userInfo.user_id;
    const defaultMember = {
      name: this.data.userInfo.nickname || this.data.userInfo.phone_number || '我',
      gender: this.data.userInfo.gender || '',
      age: this.data.userInfo.age || 0,
      height: this.data.userInfo.height || 0,
      avatar_color: this.getRandomColor(),
      relationship: 'self'
    };

    console.log('创建默认成员:', defaultMember.name);

    cloudRequest.callContainer({
      path: `/api/family-members?user_id=${userId}`,
      method: 'POST',
      data: defaultMember,
      success: (res) => {
        console.log('创建成功:', res.data || res);
        // 创建成功后重新加载列表
        this.loadMembers();
      },
      fail: (err) => {
        console.error('创建默认成员失败:', err);
        this.setData({ isLoadingMembers: false });
      }
    });
  },

  // 长按成员卡片 - 显示操作菜单
  onLongPressMember(e) {
    const memberId = e.currentTarget.dataset.id;
    const memberName = e.currentTarget.dataset.name;
    const member = this.data.members.find(m => m.id === memberId);
    
    if (!member) return;
    
    // “自己”这个成员只能编辑，不能删除
    if (member.relationship === 'self') {
      wx.showActionSheet({
        itemList: ['编辑信息'],
        success: (res) => {
          if (res.tapIndex === 0) {
            this.editMember(member);
          }
        }
      });
    } else {
      // 其他成员可以编辑或删除
      wx.showActionSheet({
        itemList: ['编辑信息', '删除成员'],
        itemColor: '#ff4d4f',
        success: (res) => {
          if (res.tapIndex === 0) {
            this.editMember(member);
          } else if (res.tapIndex === 1) {
            this.confirmDeleteMember(memberId, memberName);
          }
        }
      });
    }
  },

  // 编辑成员
  editMember(member) {
    this.setData({
      showAddMemberDialog: true,
      editingMemberId: member.id,
      newMemberName: member.name,
      newMemberAge: member.age ? String(member.age) : '',
      newMemberHeight: member.height ? String(member.height) : '',
      newMemberGender: member.gender === 'male' ? '男' : (member.gender === 'female' ? '女' : ''),
      newMemberGenderIndex: member.gender === 'male' ? 0 : (member.gender === 'female' ? 1 : -1)
    });
  },

  // 确认删除成员
  confirmDeleteMember(memberId, memberName) {
    wx.showModal({
      title: '删除成员',
      content: `确定要删除“${memberName}”吗？`,
      confirmText: '删除',
      confirmColor: '#ff4d4f',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          this.deleteMember(memberId);
        }
      }
    });
  },

  // 删除成员
  deleteMember(memberId) {
    wx.showLoading({ title: '删除中...' });
    
    cloudRequest.callContainer({
      path: `/api/family-members/${memberId}?user_id=${this.data.userInfo.user_id}`,
      method: 'DELETE',
      success: () => {
        wx.hideLoading();
        wx.showToast({ title: '删除成功', icon: 'success' });
        // 重新加载列表
        this.loadMembers();
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('删除成员失败:', err);
        wx.showToast({ title: '删除失败', icon: 'error' });
      }
    });
  },

  // 选择成员
  selectMember(e) {
    const memberId = e.currentTarget.dataset.id;
    const member = this.data.members.find(m => m.id === memberId);
    
    if (!member) return;
    
    // 【新增】如果已选择过成员且已有计算结果，切换时需要确认
    if (this.data.currentMember && this.data.currentMember.id !== member.id && this.data.bodyFat) {
      wx.showModal({
        title: '切换成员',
        content: `当前已计算 ${this.data.currentMember.name} 的数据，是否切换到 ${member.name}？\n\n切换后将重新计算并保存新数据。`,
        confirmText: '切换',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            // 用户确认切换，先清除旧数据
            this.clearCalculationResults();
            // 执行切换
            this.performMemberSwitch(member);
          }
        }
      });
      return;
    }
    
    // 首次选择或无计算结果，直接切换
    this.performMemberSwitch(member);
  },
  


  // 显示添加成员弹窗
  showAddMemberModal() {
    this.setData({
      showAddMemberDialog: true,
      editingMemberId: null,  // 清空编辑ID，表示添加模式
      newMemberName: '',
      newMemberAge: '',
      newMemberHeight: '',
      newMemberGender: '',
      newMemberGenderIndex: -1
    });
  },

  // 关闭添加成员弹窗
  closeAddMemberModal() {
    this.setData({ 
      showAddMemberDialog: false,
      editingMemberId: null,
      newMemberName: '',
      newMemberAge: '',
      newMemberHeight: '',
      newMemberGender: '',
      newMemberGenderIndex: -1
    });
  },

  // 阻止事件冒泡
  stopPropagation() {},

  // 输入姓名
  onMemberNameInput(e) {
    this.setData({ newMemberName: e.detail.value });
  },

  // 输入年龄
  onMemberAgeInput(e) {
    this.setData({ newMemberAge: e.detail.value });
  },

  // 输入身高
  onMemberHeightInput(e) {
    this.setData({ newMemberHeight: e.detail.value });
  },

  // 选择性别
  onMemberGenderChange(e) {
    const index = e.detail.value;
    const genders = ['男', '女'];
    this.setData({
      newMemberGenderIndex: index,
      newMemberGender: genders[index]
    });
  },

  // 提交添加/编辑成员
  submitAddMember() {
    const { newMemberName, newMemberAge, newMemberHeight, newMemberGender, editingMemberId } = this.data;
    
    // 验证必填字段
    if (!newMemberName) {
      wx.showToast({ title: '请输入姓名', icon: 'none' });
      return;
    }
    
    if (!newMemberAge || parseInt(newMemberAge) <= 0) {
      wx.showToast({ title: '请输入有效年龄', icon: 'none' });
      return;
    }
    
    if (!newMemberHeight || parseFloat(newMemberHeight) <= 0) {
      wx.showToast({ title: '请输入有效身高', icon: 'none' });
      return;
    }
    
    if (!newMemberGender) {
      wx.showToast({ title: '请选择性别', icon: 'none' });
      return;
    }

    const userId = this.data.userInfo.user_id;
    
    // 查找当前编辑的成员，保留 relationship 字段
    const currentMember = this.data.members.find(m => m.id === editingMemberId);
    
    const memberData = {
      name: newMemberName,
      age: parseInt(newMemberAge),
      height: parseFloat(newMemberHeight),
      gender: newMemberGender === '男' ? 'male' : (newMemberGender === '女' ? 'female' : ''),
      avatar_color: currentMember?.avatar_color || this.getRandomColor(),
      relationship: currentMember?.relationship || ''  // 保留原有的 relationship
    };

    wx.showLoading({ title: editingMemberId ? '保存中...' : '添加中...' });

    if (editingMemberId) {
      // 编辑模式
      cloudRequest.callContainer({
        path: `/api/family-members/${editingMemberId}?user_id=${userId}`,
        method: 'PUT',
        data: memberData,
        success: () => {
          wx.hideLoading();
          wx.showToast({ title: '保存成功' });
          this.closeAddMemberModal();
          this.loadMembers();
        },
        fail: (err) => {
          wx.hideLoading();
          console.error('编辑成员失败:', err);
          wx.showToast({ title: '保存失败', icon: 'error' });
        }
      });
    } else {
      // 添加模式
      cloudRequest.callContainer({
        path: `/api/family-members?user_id=${userId}`,
        method: 'POST',
        data: memberData,
        success: () => {
          wx.hideLoading();
          wx.showToast({ title: '添加成功' });
          this.closeAddMemberModal();
          this.loadMembers();
        },
        fail: (err) => {
          wx.hideLoading();
          console.error('添加成员失败:', err);
          wx.showToast({ title: '添加失败', icon: 'error' });
        }
      });
    }
  },

  // 获取随机颜色
  getRandomColor() {
    const colors = SCALE_CONFIG.AVATAR_COLORS;
    return colors[Math.floor(Math.random() * colors.length)];
  },

  // 计算BMI
  calculateBMI(weight, height) {
    if (!weight || !height) return null;
    const heightInMeters = height / 100;
    return (weight / (heightInMeters * heightInMeters)).toFixed(1);
  },

  // 生成健康建议
  generateAdvice(member) {
    if (!member.bmi) return null;
    
    const bmi = parseFloat(member.bmi);
    let advice = '';
    
    if (bmi < 18.5) {
      advice = '您的体重偏轻，建议增加营养摄入，适当进行力量训练。';
    } else if (bmi >= 18.5 && bmi < 24) {
      advice = '您的体重正常，请继续保持健康的生活方式！';
    } else if (bmi >= 24 && bmi < 28) {
      advice = '您的体重偏重，建议控制饮食，增加有氧运动。';
    } else {
      advice = '您的体重过重，建议咨询专业医生或营养师制定减重计划。';
    }
    
    return advice;
  },

  /**
   * 计算体脂指标（基于体重、阻抗、用户信息）
   * 
   * 参考公式（结合实测数据校准）：
   * - BMI = 体重(kg) / 身高(m)²
   * - 体脂率 = f(BMI, 年龄, 性别, 阻抗)
   * - 水分率、肌肉量等衍生指标
   * 
   * @param {Function} callback - 计算完成后的回调函数
   */
  calculateBodyMetrics(callback) {
    const { weight, impedance, currentMember } = this.data;
    
    if (!currentMember || !weight || weight <= 0) {
      console.log('[体脂计算] 数据不完整，无法计算');
      if (typeof callback === 'function') callback();
      return;
    }
    
    const { age, gender, height } = currentMember;
    
    // 验证必填字段，给出明确提示
    const missingFields = [];
    if (!age || age <= 0) missingFields.push('年龄');
    if (!height || height <= 0) missingFields.push('身高');
    if (!gender) missingFields.push('性别');
    
    if (missingFields.length > 0) {
      // 如果正在编辑成员，不弹窗（避免重复提示）
      if (this.data.showAddMemberDialog && this.data.editingMemberId === currentMember.id) {
        console.log('[体脂计算] 正在编辑成员，跳过提示');
        if (typeof callback === 'function') callback();
        return;
      }
      
      wx.showModal({
        title: '完善成员信息',
        content: `请先完善${currentMember.name}的${missingFields.join('、')}信息，才能计算体脂数据`,
        confirmText: '去完善',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            // 打开编辑成员弹窗
            this.editMember(currentMember);
          }
          if (typeof callback === 'function') callback();
        }
      });
      return;
    }
    
    // 1. 计算 BMI
    const bmi = this.calculateBMI(weight, height);
    console.log('[体脂计算] BMI:', bmi);
    
    // 2. 计算体脂率
    let bodyFat = 0;
    
    if (impedance > 0 && height > 0) {
      // 有阻抗数据时使用更精确的公式
      // Deurenberg-Piersma 公式变体
      const sex = gender === 'male' ? 1 : 0;
      
      // 基础体脂率
      bodyFat = (1.20 * bmi) + (0.23 * age) - (10.8 * sex) - 5.4;
      
      // 阻抗修正（基于生物电阻抗分析 BIA）
      // 阻抗指数 = 身高(cm)² / 阻抗(Ω)
      const impedanceIndex = (height * height) / impedance;
      
      // 阻抗修正系数（经验值）
      const impedanceCorrection = impedanceIndex * 0.001;
      bodyFat += impedanceCorrection;
      
      console.log('[体脂计算] 使用阻抗修正，阻抗指数:', impedanceIndex.toFixed(2));
    } else {
      // 无阻抗数据时使用简化公式
      // 根据实测数据校准：BMI=24.6, 年龄=33, 性别=男 → 体脂率=21.9%
      const sex = gender === 'male' ? 1 : 0;
      
      // 基础公式
      bodyFat = (1.20 * bmi) + (0.23 * age) - (10.8 * sex) - 5.4;
      
      // 微调系数（使结果更接近真实值）
      // 实测偏差约 +1%，这里做补偿
      bodyFat += 1.0;
      
      console.log('[体脂计算] 无阻抗数据，使用简化公式');
    }
    
    // 限制体脂率在合理范围内
    bodyFat = Math.max(SCALE_CONFIG.BODY_FAT_MIN, Math.min(SCALE_CONFIG.BODY_FAT_MAX, bodyFat));
    console.log('[体脂计算] 体脂率:', bodyFat.toFixed(1) + '%');
    
    // 3. 计算水分率
    // 根据 ZeepLife 实测数据校准：体重68.5kg, 体脂21.6%, 水分53.8%
    // 成年男性正常范围: 50-65%, 女性: 45-60%
    let water = 0;
    if (gender === 'male') {
      // 男性: 基准值与体脂率负相关，但斜率更陡
      // 实测: 体脂21.6% → 水分53.8%
      // 公式: water = 68 - (bodyFat - 10) * 0.7
      water = 68 - (bodyFat - 10) * 0.7;
    } else {
      // 女性: 基准值略低
      water = 63 - (bodyFat - 15) * 0.7;
    }
    water = Math.max(SCALE_CONFIG.WATER_MIN, Math.min(SCALE_CONFIG.WATER_MAX, water));
    console.log('[体脂计算] 水分率:', water.toFixed(1) + '%');
    
    // 4. 计算肌肉量 (kg)
    // 肌肉量 = 体重 × (1 - 体脂率 - 骨重比例)
    // 骨重约占体重4-5%
    const boneMassRatio = SCALE_CONFIG.BONE_MASS_RATIO; // 4%
    const muscleMass = weight * (1 - bodyFat / 100 - boneMassRatio);
    console.log('[体脂计算] 肌肉量:', muscleMass.toFixed(2) + 'kg');
    
    // 5. 计算蛋白质率
    // 根据 ZeepLife 实测数据校准：体重68.5kg, 体脂21.6%, 蛋白质20.6%
    // 蛋白质约占去脂体重的比例，但与水分相关
    const leanMass = weight * (1 - bodyFat / 100); // 去脂体重
    
    // 实测: 去脂体重=53.7kg, 蛋白质20.6% → 蛋白质质量=14.1kg
    // 蛋白质率 = 蛋白质质量 / 体重 * 100
    // 优化公式：蛋白质与水分正相关，与体脂负相关
    let protein = 0;
    if (gender === 'male') {
      // 男性: 基准22%，随体脂增加而减少
      protein = 22 - (bodyFat - 15) * 0.3;
    } else {
      // 女性: 基准20%
      protein = 20 - (bodyFat - 20) * 0.3;
    }
    protein = Math.max(SCALE_CONFIG.PROTEIN_MIN, Math.min(SCALE_CONFIG.PROTEIN_MAX, protein));
    console.log('[体脂计算] 蛋白质:', protein.toFixed(1) + '%');
    
    // 6. 计算基础代谢 (BMR)
    // 根据 ZeepLife 实测数据校准：体重68.5kg, 年龄33岁, 身高174cm, BMR=1482千卡
    // Mifflin-St Jeor 公式计算结果偏高，需要调整
    let bmr = 0;
    if (gender === 'male') {
      // 原始公式: 10 * weight + 6.25 * height - 5 * age + 5
      // 实测偏差: +81千卡，需要减去修正系数
      bmr = 10 * weight + 6.25 * height - 5 * age + 5;
      // 根据实测数据校准：减去约80千卡
      bmr -= 80;
    } else {
      bmr = 10 * weight + 6.25 * height - 5 * age - 161;
      // 女性也需要适当调整
      bmr -= 60;
    }
    bmr = Math.round(bmr);
    console.log('[体脂计算] 基础代谢:', bmr + '千卡');
    
    // 7. 计算骨重 (kg)
    const boneMass = weight * boneMassRatio;
    console.log('[体脂计算] 骨重:', boneMass.toFixed(2) + 'kg');
    
    // 8. 计算内脏脂肪等级
    // 根据 ZeepLife 实测数据校准：BMI=24.5, 年龄33岁, 内脏脂肪=11
    // 原公式计算结果偏低，需要大幅调整
    let visceralFat = 0;
    if (gender === 'male') {
      // 男性: 基于BMI和年龄的综合评估
      // 实测: BMI=24.5, 年龄33 → 内脏脂肪=11
      // 优化公式: 基准值 + BMI影响(更陡) + 年龄影响(更强)
      visceralFat = (bmi - 20) * 2.5 + (age - 25) * 0.3;
    } else {
      // 女性: 基准值略低
      visceralFat = (bmi - 19) * 2.5 + (age - 25) * 0.3;
    }
    visceralFat = Math.max(SCALE_CONFIG.VISCERAL_FAT_MIN, Math.min(SCALE_CONFIG.VISCERAL_FAT_MAX, Math.round(visceralFat * 10) / 10));
    console.log('[体脂计算] 内脏脂肪等级:', visceralFat);
    
    // 9. 生成健康建议
    const advice = this.generateAdvice({ ...currentMember, bmi: parseFloat(bmi) });
    
    console.log('[体脂计算] ✅ 完整结果:', {
      bmi: parseFloat(bmi).toFixed(1),
      bodyFat: parseFloat(bodyFat).toFixed(1) + '%',
      water: parseFloat(water).toFixed(1) + '%',
      muscleMass: parseFloat(muscleMass).toFixed(2) + 'kg',
      protein: parseFloat(protein).toFixed(1) + '%',
      bmr: bmr + 'kcal',
      boneMass: parseFloat(boneMass).toFixed(2) + 'kg',
      visceralFat: visceralFat
    });
    
    // 更新页面数据
    this.setData({
      bmi: parseFloat(parseFloat(bmi).toFixed(1)),
      bodyFat: parseFloat(parseFloat(bodyFat).toFixed(1)),
      water: parseFloat(parseFloat(water).toFixed(1)),
      muscleMass: parseFloat(parseFloat(muscleMass).toFixed(2)),
      protein: parseFloat(parseFloat(protein).toFixed(1)),
      bmr: bmr,
      boneMass: parseFloat(parseFloat(boneMass).toFixed(2)),
      visceralFat: visceralFat,
      advice
    }, () => {
      // setData完成后执行回调
      if (typeof callback === 'function') callback();
    });
    
    this.log(`BMI: ${parseFloat(bmi).toFixed(1)} | 体脂率: ${parseFloat(bodyFat).toFixed(1)}% | 水分: ${parseFloat(water).toFixed(1)}%`);
    
    // 【重要】立即保存到数据库（不等待自动保存）
    if (this.data.isStabilized && this.data.currentMember) {
      console.log('[体脂计算] 📤 立即保存到数据库');
      this.autoSaveToDatabase();
    }
  },

  /**
   * 获取健康范围参考
   */
  getHealthRanges(gender) {
    const ranges = {
      bmi: { normal: '18.5-23.9', low: '<18.5', high: '≥24' },
      bodyFat: gender === 'male' 
        ? { normal: '10-20%', low: '<10%', high: '>25%' }
        : { normal: '18-28%', low: '<18%', high: '>35%' },
      water: gender === 'male'
        ? { normal: '55-65%', low: '<55%', high: '>65%' }
        : { normal: '45-60%', low: '<45%', high: '>60%' },
      visceralFat: { normal: '1-9', warning: '10-14', high: '≥15' },
      muscleMass: gender === 'male'
        ? { normal: '75-89%', unit: '%' }
        : { normal: '63-75.5%', unit: '%' }
    };
    return ranges;
  },

  /**
   * 绘制合并趋势图（体重+体脂）
   */
  drawCombinedChart() {
    if (!this.data.currentMember || !this.data.currentMember.weightHistory || this.data.currentMember.weightHistory.length === 0) {
      console.log('[图表] 无历史数据，跳过绘制');
      return;
    }

    const history = this.data.currentMember.weightHistory;
    console.log('[图表] 开始绘制合并趋势图，数据条数:', history.length);

    // 创建canvas上下文
    const ctx = wx.createCanvasContext('combinedChart', this);
    
    // 调用模块绘制
    chartDrawer.drawCombinedChart(ctx, history, 'combinedChart');
  },

  startScan() {
    const app = getApp();
    
    // 检查蓝牙是否已初始化
    if (!app.globalData.bleAdapterInitialized) {
      wx.showModal({
        title: '蓝牙未就绪',
        content: '正在初始化蓝牙，请稍候...',
        showCancel: false
      });
      return;
    }
    
    // 如果已在扫描，只更新UI状态
    if (app.globalData.bleScanning) {
      this.setData({ scanning: true });
      this.log("扫描已在运行中");
      wx.showToast({ title: '扫描进行中', icon: 'success' });
      return;
    }
    
    // 启动全局扫描
    app.startBleScan();
    this.setData({ scanning: true });
    this.log("开始扫描体脂秤");
    
    wx.showToast({ title: '扫描已启动', icon: 'success' });
    
    // 提示用户操作步骤
    setTimeout(() => {
      this.log('请将体脂秤放在手机1米内，然后站上秤');
    }, 1000);
  },

  stopScan() {
    const app = getApp();
    // 注意：不停止全局扫描，只更新页面状态
    this.setData({ scanning: false });
    this.log("页面停止显示扫描状态");
  },
  
  /**
   * 手动刷新设备列表（读取最新蓝牙广播）
   */
  refreshDevices() {
    this.log('刷新蓝牙广播...');
    
    // 重置扫描状态
    this.setData({ scanning: true });
    
    wx.getBluetoothDevices({
      success: (res) => {
        console.log('[Scale] 已发现的设备:', res.devices);
        this.log(`发现 ${res.devices.length} 个蓝牙设备`);
        
        // 打印所有设备名称
        let scaleFound = false;
        res.devices.forEach((device, index) => {
          if (device.name) {
            this.log(`${index + 1}. ${device.name} (RSSI: ${device.RSSI})`);
            
            // 检查是否是体脂秤
            const deviceName = device.name.toLowerCase();
            if (deviceName.includes('mi scale') || 
                deviceName.includes('body') || 
                deviceName.includes('scale') ||
                deviceName.includes('米秤') ||
                deviceName.includes('体脂') ||
                deviceName.includes('mibfs')) {
              scaleFound = true;
              
              // 如果有advertisData，尝试解析
              if (device.advertisData) {
                const bleUtils = require('../../utils/ble_scale.js');
                const scaleData = bleUtils.parseScaleData(device.advertisData);
                if (scaleData) {
                  console.log('[Scale] 解析到体重数据:', scaleData);
                  this.handleScaleDataUpdate({
                    ...scaleData,
                    deviceName: device.name
                  });
                }
              }
            }
          }
        });
        
        if (!scaleFound) {
          wx.showToast({
            title: '未发现体脂秤',
            icon: 'none',
            duration: 2000
          });
          this.setData({ scanning: false });
        }
      },
      fail: (err) => {
        console.error('[Scale] 获取设备列表失败:', err);
        this.log('获取设备列表失败');
        this.setData({ scanning: false });
      }
    });
  },

  /**
   * 自动保存到数据库（波动小于10kg时）
   */
  autoSaveToDatabase() {
    if (!this.data.currentMember || !this.data.isStabilized || this.data.weight <= 0) {
      console.log('[自动保存] 条件不满足，跳过');
      return;
    }
    
    const member = this.data.currentMember;
    const currentWeight = this.data.weight;
    const lastWeight = member.lastWeight || 0;
    
    // 检查体重波动是否小于10kg
    if (lastWeight > 0 && Math.abs(currentWeight - lastWeight) >= SCALE_CONFIG.AUTO_SAVE_WEIGHT_DIFF) {
      console.log(`[自动保存] 体重波动过大 (${Math.abs(currentWeight - lastWeight).toFixed(1)}kg)，跳过`);
      wx.showToast({
        title: '体重波动过大，请确认',
        icon: 'none',
        duration: 2000
      });
      return;
    }
    
    // 如果还没有计算体脂指标，先计算
    if (!this.data.bmi) {
      this.calculateBodyMetrics();
    }
    
    // 验证必填数据
    if (!this.data.bmi || !this.data.bodyFat) {
      console.log('[自动保存] 体脂数据不完整，跳过');
      return;
    }
    
    console.log('[自动保存] 开始保存数据到数据库...');
    
    cloudRequest.callContainer({
      path: '/api/scale/record',
      method: 'POST',
      data: {
        weight: this.data.weight,
        impedance: this.data.impedance || 0,
        bmi: parseFloat(this.data.bmi),
        body_fat: parseFloat(this.data.bodyFat),
        water: parseFloat(this.data.water) || 0,
        muscle: parseFloat(this.data.muscleMass) || 0,  // 修正字段名：muscle_mass -> muscle
        protein: parseFloat(this.data.protein) || 0,
        bmr: this.data.bmr || 0,
        bone_mass: parseFloat(this.data.boneMass) || 0,
        visceral_fat: this.data.visceralFat || 0,
        timestamp: Date.now(),
        user_id: parseInt(this.data.userInfo.user_id),
        member_id: member.id
      },
      success: (res) => {
        console.log('[自动保存] 保存成功:', res);
        this.setData({ autoSaved: true });
        this.lastSaveTime = Date.now(); // 记录保存时间
        this.log('数据已自动保存到数据库');
        
        // 【新增】显示成功提示
        wx.showToast({
          title: '保存成功',
          icon: 'success',
          duration: 1500
        });
        
        // 不再自动刷新成员列表，避免循环调用
        // 用户可以在下次进入页面时看到最新数据
      },
      fail: (err) => {
        console.error('[自动保存] 保存失败:', err);
        this.log("自动保存失败 " + JSON.stringify(err));
        
        // 【新增】显示失败提示
        wx.showToast({
          title: '保存失败',
          icon: 'error',
          duration: 2000
        });
      }
    });
  },

  uploadData() {
    if (this.data.weight <= 0) {
      wx.showToast({ title: '无效体重', icon: 'none' });
      return;
    }
    
    if (!this.data.currentMember) {
      wx.showToast({ title: '请选择成员', icon: 'none' });
      return;
    }
    
    const member = this.data.currentMember;
    
    // 如果还没有计算体脂指标，先计算
    if (!this.data.bmi) {
      this.calculateBodyMetrics();
    }
    
    // 验证必填数据
    if (!this.data.bmi || !this.data.bodyFat) {
      wx.showToast({ title: '请先完善成员信息', icon: 'none' });
      return;
    }
    
    // 上传到后端
    wx.showLoading({ title: '上传中...' });
    
    cloudRequest.callContainer({
      path: '/api/scale/record',
      method: 'POST',
      data: {
        weight: this.data.weight,
        impedance: this.data.impedance || 0,
        bmi: parseFloat(this.data.bmi),
        body_fat: parseFloat(this.data.bodyFat),
        water: parseFloat(this.data.water) || 0,
        muscle: parseFloat(this.data.muscleMass) || 0,  // 修正字段名：muscle_mass -> muscle
        protein: parseFloat(this.data.protein) || 0,
        bmr: this.data.bmr || 0,
        bone_mass: parseFloat(this.data.boneMass) || 0,
        visceral_fat: this.data.visceralFat || 0,
        timestamp: Date.now(),
        user_id: parseInt(this.data.userInfo.user_id),
        member_id: member.id
      },
      success: (res) => {
        wx.hideLoading();
        wx.showToast({ title: '上传成功', icon: 'success' });
        
        this.log('数据上传成功');
        
        // 刷新成员数据（包含最新历史记录）
        this.loadMembers();
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('上传体重记录失败:', err);
        
        if (err.statusCode === 503) {
          wx.showModal({
            title: '服务未配置',
            content: '体重秤功能需要配置账号密码\n\n请在首页添加体脂秤设备',
            showCancel: true,
            cancelText: '取消',
            confirmText: '去配置',
            success: (res) => {
              if (res.confirm) {
                wx.reLaunch({ url: '/pages/index/index' });
              }
            }
          });
        } else {
          this.log("上传失败 " + JSON.stringify(err));
          wx.showToast({
            title: '上传失败',
            icon: 'error'
          });
        }
      }
    });
  },

  log(msg) {
    const logs = this.data.logs;
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `${timestamp} ${msg}`;
    
    logs.unshift(logEntry);
    
    // 保留最近50条日志
    if (logs.length > LIMITS.LOGS) {
      logs.pop();
    }
    
    this.setData({ logs });
    
    // 同时输出到控制台，方便调试
    console.log('[Scale Log]', msg);
  }
});
