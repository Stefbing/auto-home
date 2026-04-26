const app = getApp()
const cloudRequest = require('../../utils/cloud_request.js')

Page({
  data: {
    userInfo: null,
    phoneNumber: '',
    userDevices: [],
    petDevices: [],
    healthDevices: [],
    showAddDeviceDialog: false,
    showDeviceConfigDialog: false,
    selectedDeviceType: '',
    selectedPlatform: '',
    selectedDeviceTypeText: '',
    deviceAccount: '',
    devicePassword: '',
    greeting: ''
  },
  
  onLoad: function () {
    this.updateGreeting()
    this.checkLoginStatus()
  },
  
  onShow: function() {
    this.updateGreeting()
    if (this.data.userInfo) {
      this.loadUserDevices()
    }
  },
  
  // 更新时间问候语
  updateGreeting() {
    const hour = new Date().getHours()
    let greeting = ''
    
    if (hour >= 5 && hour < 9) {
      greeting = '早上好'
    } else if (hour >= 9 && hour < 12) {
      greeting = '上午好'
    } else if (hour >= 12 && hour < 14) {
      greeting = '中午好'
    } else if (hour >= 14 && hour < 18) {
      greeting = '下午好'
    } else if (hour >= 18 && hour < 22) {
      greeting = '晚上好'
    } else {
      greeting = '晚上好'
    }
    
    this.setData({ greeting })
  },
  
  // 检查登录状态
  checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo')
    if (userInfo) {
      this.setData({ userInfo })
      this.loadUserDevices()
    }
  },
  
  // 手机号输入
  onPhoneInput(e) {
    this.setData({ phoneNumber: e.detail.value })
  },
  
  // 登录/注册
  async onLogin() {
    const { phoneNumber } = this.data
    
    if (!phoneNumber || phoneNumber.length !== 11) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' })
      return
    }
    
    wx.showLoading({ title: '登录中...' })
    
    try {
      const res = await cloudRequest.callContainer({
        path: '/api/auth/login',
        method: 'POST',
        data: {
          phone_number: phoneNumber,
          nickname: `用户${phoneNumber.slice(-4)}`
        }
      })
      
      const userInfo = res
      wx.setStorageSync('userInfo', userInfo)
      this.setData({ userInfo })
      
      // 自动加载设备（后端已自动初始化服务）
      await this.loadUserDevices()
      
      wx.hideLoading()
      wx.showToast({ 
        title: userInfo.has_configured ? '登录成功，设备已连接' : '登录成功', 
        icon: 'success' 
      })
    } catch (err) {
      wx.hideLoading()
      console.error('登录异常:', err)
      wx.showToast({ 
        title: err.errMsg || '登录失败，请重试', 
        icon: 'none',
        duration: 3000
      })
    }
  },
  
  // 加载用户设备列表
  async loadUserDevices() {
    if (!this.data.userInfo || !this.data.userInfo.user_id) return
    
    try {
      const devices = await cloudRequest.callContainer({
        path: `/api/devices?user_id=${this.data.userInfo.user_id}`,
        method: 'GET'
      })
      
      const petDevices = devices.filter(d => d.device_type === 'feeder' || d.device_type === 'litterbox')
      const healthDevices = devices.filter(d => d.device_type === 'scale')
      
      this.setData({
        userDevices: devices,
        petDevices,
        healthDevices
      })
    } catch (err) {
      console.error('加载设备列表失败:', err)
    }
  },
  
  // 显示添加设备弹窗
  showAddDeviceModal() {
    this.setData({ showAddDeviceDialog: true })
  },

  // 关闭添加设备弹窗
  closeAddDeviceModal() {
    this.setData({ showAddDeviceDialog: false })
  },

  // 选择设备类型
  selectDeviceType(e) {
    const type = e.currentTarget.dataset.type
    const platform = e.currentTarget.dataset.platform
    const typeMap = {
      'feeder': '喂食机',
      'litterbox': '猫厕所',
      'scale': '体脂秤'
    }
    
    this.setData({
      selectedDeviceType: type,
      selectedPlatform: platform,
      selectedDeviceTypeText: typeMap[type],
      showAddDeviceDialog: false,
      showDeviceConfigDialog: true,
      deviceAccount: '',
      devicePassword: ''
    })
  },

  // 关闭设备配置弹窗
  closeDeviceConfigModal() {
    this.setData({
      showDeviceConfigDialog: false,
      deviceAccount: '',
      devicePassword: ''
    })
  },
  
  // 账号输入
  onAccountInput(e) {
    this.setData({ deviceAccount: e.detail.value })
  },
  
  // 密码输入
  onPasswordInput(e) {
    this.setData({ devicePassword: e.detail.value })
  },

  // 提交设备配置
  async onSubmitDeviceConfig() {
    const { selectedDeviceType, selectedPlatform, deviceAccount, devicePassword } = this.data
    
    if (!deviceAccount || !devicePassword) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' })
      return
    }
    
    wx.showLoading({ title: '添加中...' })
    
    try {
      await cloudRequest.callContainer({
        path: `/api/devices/add?user_id=${this.data.userInfo.user_id}`,
        method: 'POST',
        data: {
          device_type: selectedDeviceType,
          platform: selectedPlatform,
          account: deviceAccount,
          password: devicePassword
        }
      })
      
      wx.hideLoading()
      wx.showToast({ title: '添加成功', icon: 'success' })
      
      this.closeDeviceConfigModal()
      await this.loadUserDevices()
    } catch (err) {
      wx.hideLoading()
      console.error('添加设备失败:', err)
      wx.showToast({ title: '添加失败，请重试', icon: 'none' })
    }
  },

  // 阻止事件冒泡
  stopPropagation() {},

  // 跳转到配置页面
  goToConfig() {
    wx.navigateTo({
      url: '/pages/config/config'
    })
  },

  // 退出登录
  logout() {
    wx.showModal({
      title: '确认退出',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('userInfo')
          this.setData({ 
            userInfo: null,
            userDevices: [],
            petDevices: [],
            healthDevices: []
          })
          wx.showToast({ title: '已退出', icon: 'success' })
        }
      }
    })
  }
})
