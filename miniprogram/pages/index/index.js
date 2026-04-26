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
      // 获取仪表板数据（包含设备和实时统计）
      const dashboardData = await cloudRequest.callContainer({
        path: '/api/dashboard/data',
        method: 'GET'
      })
      
      // 从 dashboardData 构建设备列表
      const petDevices = []
      const healthDevices = []
      const userDevices = []
      
      // 处理 CloudPets 喂食机
      if (dashboardData.cloudpets_servings !== undefined) {
        const feederDevice = {
          device_key: 'device_feeder',
          device_type: 'feeder',
          device_name: 'cloudpets',
          platform: 'cloudpets',
          status: 'active'
        }
        // 解析今日投喂次数 - 使用 result 字段
        const servingsData = dashboardData.cloudpets_servings
        if (servingsData && typeof servingsData === 'object') {
          feederDevice.today_servings = servingsData.result || 0
        } else if (typeof servingsData === 'number') {
          feederDevice.today_servings = servingsData
        } else {
          feederDevice.today_servings = 0
        }
        
        // 计算计划剩余数量 - 只计算当前时间之后的启用计划
        const plans = dashboardData.cloudpets_plans || []
        if (Array.isArray(plans)) {
          // 获取当前时间 HH:mm
          const now = new Date()
          const currentMinutes = now.getHours() * 60 + now.getMinutes()
          
          let remaining = 0
          plans.forEach(p => {
            // 确保 plan 结构中有 time 且 enabled
            if (p.time && p.enabled !== false && p.enabled !== 0 && p.enabled !== '0') {
              const [h, m] = p.time.split(':').map(Number)
              const planMinutes = h * 60 + m
              if (planMinutes > currentMinutes) {
                remaining++
              }
            }
          })
          
          feederDevice.remaining_plans = remaining
        } else {
          feederDevice.remaining_plans = 0
        }
        
        petDevices.push(feederDevice)
        userDevices.push(feederDevice)
      }
      
      // 处理 PetKit 猫厕所
      const petkitDevices = dashboardData.petkit_devices || []
      if (petkitDevices.length > 0) {
        const litterboxDevice = {
          device_key: 'device_litterbox',
          device_type: 'litterbox',
          device_name: 'petkit',
          platform: 'petkit',
          status: 'active'
        }
        const litterboxStats = dashboardData.litterbox_stats || {}
        
        // 查找第一个猫厕所设备（与Web端一致）
        const litterboxPetkitDevice = petkitDevices.find(d => {
          if (!d || !d.type) return false
          const name = d.name || ''
          return ['T3', 'T4', 'T4 Pura MAX', 'T5'].includes(d.type) || name.includes('MAX')
        })
        
        if (litterboxPetkitDevice) {
          // 优先使用缓存的统计数据（与Web端一致）
          let stats = {}
          if (litterboxStats[litterboxPetkitDevice.id]) {
            stats = litterboxStats[litterboxPetkitDevice.id]
          } else if (litterboxPetkitDevice.state_summary) {
            stats = litterboxPetkitDevice.state_summary
          }
          
          // 今日如厕次数
          litterboxDevice.today_visits = stats.today_visits || stats.used_times || 0
          
          // 猫砂余量百分比
          litterboxDevice.sand_level = stats.sand_percent || 0
        } else {
          litterboxDevice.today_visits = 0
          litterboxDevice.sand_level = 0
        }
        
        petDevices.push(litterboxDevice)
        userDevices.push(litterboxDevice)
      }
      
      this.setData({
        userDevices,
        petDevices,
        healthDevices
      })
    } catch (err) {
      console.error('加载设备列表失败:', err)
      wx.showToast({ 
        title: '加载失败，请重试', 
        icon: 'none' 
      })
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
