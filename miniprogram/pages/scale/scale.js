const cloudRequest = require('../../utils/cloud_request.js');
const bleUtils = require('../../utils/ble_scale.js');

Page({
  data: {
    scanning: false,
    device: null,
    weight: 0,
    isStabilized: false,
    logs: [],
    userInfo: null,
    
    // 家庭成员管理
    members: [],
    selectedMemberId: null,
    currentMember: null,
    isLoadingMembers: false,  // 防止重复加载
    
    // 添加/编辑成员弹窗
    showAddMemberDialog: false,
    editingMemberId: null,  // 编辑模式时的成员ID
    newMemberName: '',
    newMemberAge: '',
    newMemberHeight: '',
    newMemberGender: '',
    newMemberGenderIndex: -1
  },

  onLoad() {
    this.checkLoginStatus();
  },

  onShow() {
    // 只在已有userInfo时才刷新，避免与onLoad重复
    if (this.data.userInfo && this.data.members.length > 0) {
      this.loadMembers();
    }
  },

  checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo');
    console.log('体脂秤页面 - userInfo:', userInfo);
    
    if (!userInfo) {
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
      console.error('userInfo中缺少user_id字段');
      wx.showToast({ title: '用户信息异常', icon: 'none' });
      return;
    }
    
    this.setData({ userInfo });
    // 先加载成员，如果没有“自己”则自动创建
    this.loadMembers();
  },

  // 加载家庭成员（从后端）
  loadMembers() {
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
          
        // 检查是否存在"自己"这个成员
        const hasSelf = members.some(m => m.relationship === 'self');
        console.log('是否存在“自己”成员:', hasSelf);
          
        // 如果没有"自己"这个成员，创建默认成员
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
        this.loadMembersHistory(members);
      },
      fail: (err) => {
        console.error('加载家庭成员失败:', err);
        wx.showToast({ title: '加载失败', icon: 'none' });
        this.setData({ isLoadingMembers: false });
      }
    });
  },

  // 为每个成员加载历史记录
  loadMembersHistory(members) {
    if (members.length === 0) {
      this.setData({ 
        members,
        selectedMemberId: null,
        currentMember: null,
        isLoadingMembers: false
      });
      return;
    }
    
    // 并行获取所有成员的历史记录（最近7条）
    const promises = members.map(member => {
      return new Promise((resolve) => {
        cloudRequest.callContainer({
          path: `/api/family-members/${member.id}/history?user_id=${this.data.userInfo.user_id}&limit=7`,
          method: 'GET',
          success: (res) => {
            const history = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);
            
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
          fail: () => {
            resolve(member);
          }
        });
      });
    });
    
    Promise.all(promises).then(updatedMembers => {
      this.setData({ 
        members: updatedMembers,
        selectedMemberId: updatedMembers[0]?.id || null,
        currentMember: updatedMembers[0] || null,
        isLoadingMembers: false
      });
      console.log('页面数据已更新，当前成员数:', updatedMembers.length);
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
    
    this.setData({
      selectedMemberId: memberId,
      currentMember: member
    });
    
    console.log('选择成员:', member?.name);
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
    
    if (!newMemberName) {
      wx.showToast({ title: '请输入姓名', icon: 'none' });
      return;
    }

    const userId = this.data.userInfo.user_id;
    
    // 查找当前编辑的成员，保留 relationship 字段
    const currentMember = this.data.members.find(m => m.id === editingMemberId);
    
    const memberData = {
      name: newMemberName,
      age: parseInt(newMemberAge) || 0,
      height: parseFloat(newMemberHeight) || 0,
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
    const colors = [
      'linear-gradient(135deg, #667EEA 0%, #764BA2 100%)',
      'linear-gradient(135deg, #F093FB 0%, #F5576C 100%)',
      'linear-gradient(135deg, #4FACFE 0%, #00F2FE 100%)',
      'linear-gradient(135deg, #43E97B 0%, #38F9D7 100%)',
      'linear-gradient(135deg, #FA709A 0%, #FEE140 100%)',
      'linear-gradient(135deg, #FF9A9E 0%, #FECFEF 100%)'
    ];
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

  startScan() {
    if (this.data.scanning) return;
    
    wx.openBluetoothAdapter({
      success: (res) => {
        this.setData({ scanning: true });
        this.log("蓝牙已初始化");
        
        wx.startBluetoothDevicesDiscovery({
          allowDuplicatesKey: true,
          success: (res) => {
            this.log("开始扫描");
            wx.onBluetoothDeviceFound(this.onDeviceFound);
          }
        });
      },
      fail: (err) => {
        this.log("蓝牙初始化失败 " + JSON.stringify(err));
        wx.showToast({ title: '请打开蓝牙', icon: 'none' });
      }
    });
  },

  stopScan() {
    wx.stopBluetoothDevicesDiscovery();
    wx.closeBluetoothAdapter();
    this.setData({ scanning: false });
    this.log("停止扫描");
  },

  onDeviceFound(res) {
    res.devices.forEach(device => {
      if (device.name && (device.name.includes("MI Scale") || device.name.includes("Body"))) {
        const manufacturerData = device.advertisData;
        if (manufacturerData) {
          const result = bleUtils.parseScaleData(manufacturerData);
          if (result) {
            this.setData({
              device: device.name,
              weight: result.weight,
              isStabilized: result.isStabilized
            });
            
            if (result.isStabilized) {
               this.log(`稳定体重 ${result.weight}kg`);
            }
          }
        }
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
    const bmi = this.calculateBMI(this.data.weight, member.height);
    const advice = this.generateAdvice({ ...member, bmi });
    
    // 上传到后端
    wx.showLoading({ title: '上传中...' });
    
    cloudRequest.callContainer({
      path: '/api/scale/record',
      method: 'POST',
      data: {
        weight: this.data.weight,
        timestamp: Date.now(),
        user_id: parseInt(this.data.userInfo.user_id),
        member_id: member.id
      },
      success: (res) => {
        wx.hideLoading();
        wx.showToast({ title: '上传成功' });
        
        // 刷新成员数据
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
    logs.unshift(new Date().toLocaleTimeString() + " " + msg);
    this.setData({ logs });
  },
  
  onUnload() {
    this.stopScan();
  }
});
