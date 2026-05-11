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
    greeting: '',
    devicesLoaded: false  // 标记设备是否已加载
  },
  
  onLoad: function () {
    this.updateGreeting()
    // 只在onLoad时检查登录状态并加载设备，避免重复调用
    this.checkLoginStatus()
  },
  
  onShow: function() {
    this.updateGreeting()
    // onShow不再加载设备数据，只处理设备状态监听
    if (this.data.userInfo) {
      // 注册设备状态更新监听
      this.registerDeviceStatusListener();
    }
  },
  
  // 注册时间问候语
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
  
  /**
   * 注册设备状态更新监听
   */
  registerDeviceStatusListener() {
    // 在页面显示时检查设备状态
    this.checkCurrentDeviceStatus();
    
    // 设置定时器定期检查设备状态（每5秒）
    if (!this.deviceStatusTimer) {
      this.deviceStatusTimer = setInterval(() => {
        this.checkCurrentDeviceStatus();
      }, 5000);
    }
  },
  
  /**
   * 检查当前设备在线状态
   */
  checkCurrentDeviceStatus() {
    const app = getApp();
    const status = app.globalData.scaleConnectionStatus || 'offline';
    console.log('[首页] 检查设备状态:', status);
    
    const healthDevices = this.data.healthDevices.map(device => {
      if (device.device_type === 'scale') {
        // 对于体脂秤，使用全局扫描状态
        return {
          ...device,
          connectionStatus: status
        };
      }
      return device;
    });
    
    this.setData({ healthDevices });
  },
  
  /**
   * 更新设备在线状态
   */
  updateDeviceOnlineStatus(onlineStatusMap) {
    const app = getApp();
    const healthDevices = this.data.healthDevices.map(device => {
      if (device.device_type === 'scale') {
        // 使用全局扫描状态
        return {
          ...device,
          connectionStatus: app.globalData.scaleConnectionStatus || 'offline'
        };
      }
      return device;
    });
    
    this.setData({ healthDevices });
    console.log('[首页] 设备在线状态已更新:', healthDevices);
  },
  
  // 检查登录状态
  checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo')
    if (userInfo) {
      this.setData({ userInfo })
      // 只在有用户信息且设备未加载时才加载设备数据
      if (!this.data.devicesLoaded) {
        this.loadUserDevices()
      }
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
      
      // 先初始化蓝牙（会获取并缓存dashboard数据）
      const app = getApp()
      if (!app.globalData.bleAdapterInitialized) {
        console.log('[首页] 🚀 登录成功，开始初始化蓝牙')
        await app.checkAndInitBluetooth(userInfo.user_id)
      }
      
      // 然后加载设备列表（使用缓存的dashboard数据）
      if (!this.data.devicesLoaded) {
        await this.loadUserDevices()
      }
      
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
    
    // 防止重复请求
    if (this.isLoadingDevices) {
      console.log('[首页] 设备数据正在加载中，跳过重复请求')
      return
    }
    
    this.isLoadingDevices = true
    
    try {
      // 使用app.js中统一的fetchDashboardData方法（防重复请求）
      const app = getApp()
      const dashboardData = await app.fetchDashboardData(this.data.userInfo.user_id)
      
      console.log('[首页] 📦 获取到dashboard数据')
      const petDevices = []
      const healthDevices = []
      const userDevices = []
      
      // 处理 CloudPets 喂食机（仅当有实际配置数据时显示）
      const hasCloudPetsConfig = dashboardData.cloudpets_servings && 
                                 Object.keys(dashboardData.cloudpets_servings).length > 0
      if (hasCloudPetsConfig) {
        const feederDevice = {
          device_key: 'cloudpets_cloudpets',
          device_type: 'feeder',
          device_name: 'cloudpets',
          display_name: '喂食机',
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
          device_key: 'petkit_petkit',
          device_type: 'litterbox',
          device_name: 'petkit',
          display_name: '猫厕所',
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
          
          // 今日如厕次数 - 只使用 today_visits，不使用 used_times（累计值）
          litterboxDevice.today_visits = stats.today_visits !== undefined ? stats.today_visits : 0
          
          // 猫砂余量百分比
          litterboxDevice.sand_level = stats.sand_percent || 0
        } else {
          litterboxDevice.today_visits = 0
          litterboxDevice.sand_level = 0
        }
        
        petDevices.push(litterboxDevice)
        userDevices.push(litterboxDevice)
      }
      
      // 处理小米体脂秤（检查是否有配置）
      const hasXiaomiConfig = dashboardData.xiaomi_config || false
      if (hasXiaomiConfig) {
        const scaleDevice = {
          device_key: 'xiaomi_xiaomi',
          device_type: 'scale',
          device_name: 'xiaomi',
          display_name: 'MIBFS', // 首页显示短名称
          platform: 'xiaomi',
          status: 'active',
          online: false, // 默认离线，后续通过蓝牙状态更新
          today_measurements: 0, // 今日测量次数
          latest_body_fat: null // 最新体脂率
        }
        
        // 从 dashboardData 中获取体脂秤统计数据
        const scaleStats = dashboardData.scale_stats || {}
        console.log('[首页] 📊 体脂秤统计数据:', scaleStats)
        
        if (scaleStats) {
          scaleDevice.today_measurements = scaleStats.today_count || 0
          scaleDevice.latest_body_fat = scaleStats.latest_body_fat || null
          console.log('[首页] ✅ 体脂秤数据 - 今日测量:', scaleDevice.today_measurements, '体脂率:', scaleDevice.latest_body_fat)
        }
        
        healthDevices.push(scaleDevice)
        userDevices.push(scaleDevice)
      }
      
      this.setData({
        userDevices,
        petDevices,
        healthDevices,
        devicesLoaded: true  // 标记已加载
      })
    } catch (err) {
      console.error('加载设备列表失败:', err)
      wx.showToast({ 
        title: '加载失败，请重试', 
        icon: 'none' 
      })
    } finally {
      // 无论成功或失败，都重置加载状态
      this.isLoadingDevices = false
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
      
      // 如果是体脂秤，自动初始化“自己”成员
      if (selectedDeviceType === 'scale') {
        await this.initScaleSelfMember()
        
        // 体脂秤添加成功后，立即初始化蓝牙
        console.log('[首页] 体脂秤添加成功，立即初始化蓝牙')
        app.checkAndInitBluetooth()
      }
      
      wx.hideLoading()
      wx.showToast({ title: '添加成功', icon: 'success' })
      
      this.closeDeviceConfigModal()
      // 添加设备后刷新设备列表
      await this.loadUserDevices()
    } catch (err) {
      wx.hideLoading()
      console.error('添加设备失败:', err)
      wx.showToast({ title: '添加失败，请重试', icon: 'none' })
    }
  },

  // 初始化体脂秤的“自己”成员
  async initScaleSelfMember() {
    try {
      // 先检查是否已有“自己”成员
      const res = await cloudRequest.callContainer({
        path: `/api/family-members?user_id=${this.data.userInfo.user_id}`,
        method: 'GET'
      })
      
      const members = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : [])
      const hasSelf = members.some(m => m.relationship === 'self')
      
      // 如果没有“自己”成员，创建默认成员
      if (!hasSelf) {
        await cloudRequest.callContainer({
          path: `/api/family-members?user_id=${this.data.userInfo.user_id}`,
          method: 'POST',
          data: {
            name: this.data.userInfo.nickname || this.data.userInfo.phone_number || '我',
            gender: '',
            age: 0,
            height: 0,
            avatar_color: '',
            relationship: 'self'
          }
        })
        console.log('✓ 已自动初始化体脂秤“自己”成员')
      }
    } catch (err) {
      console.error('初始化体脂秤成员失败:', err)
      // 不阻断流程，仅记录错误
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

  // 长按设备卡片 - 删除确认
  onLongPressDevice(e) {
    const deviceKey = e.currentTarget.dataset.deviceKey
    const deviceName = e.currentTarget.dataset.deviceName
    
    wx.showModal({
      title: '删除设备',
      content: `确定要删除“${deviceName}”吗？\n删除后需要重新配置账号密码。`,
      confirmText: '删除',
      confirmColor: '#ff4d4f',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          this.deleteDevice(deviceKey, deviceName)
        }
      }
    })
  },

  // 删除设备
  async deleteDevice(deviceKey, deviceName) {
    wx.showLoading({ title: '删除中...' })
    
    try {
      // 解析deviceKey获取platform和device_type
      const parts = deviceKey.split('_')
      const platform = parts[0]
      const deviceType = parts[1]
      
      // 如果是体脂秤，先假删成员（软删除）并停止蓝牙扫描
      if (deviceType === 'scale') {
        await this.softDeleteScaleMembers()
        
        // 停止全局蓝牙定时扫描
        const app = getApp();
        if (app && app.stopPeriodicScan) {
          console.log('[首页] 删除体脂秤，停止蓝牙定时扫描');
          app.stopPeriodicScan();
          app.globalData.bleAdapterInitialized = false;
        }
      }
      
      // 删除设备配置
      await cloudRequest.callContainer({
        path: `/api/devices/${deviceKey}?user_id=${this.data.userInfo.user_id}`,
        method: 'DELETE'
      })
      
      // 更新本地userInfo的has_configured状态
      const userInfo = wx.getStorageSync('userInfo');
      if (userInfo) {
        userInfo.has_configured = false;
        wx.setStorageSync('userInfo', userInfo);
      }
      
      wx.hideLoading()
      wx.showToast({ title: '删除成功', icon: 'success' })
      
      // 刷新设备列表
      await this.loadUserDevices()
    } catch (err) {
      wx.hideLoading()
      console.error('删除设备失败:', err)
      wx.showToast({ 
        title: err.errMsg || '删除失败', 
        icon: 'error',
        duration: 2000
      })
    }
  },

  // 假删体脂秤成员（软删除）
  async softDeleteScaleMembers() {
    try {
      // 获取所有成员
      const membersRes = await cloudRequest.callContainer({
        path: `/api/family-members?user_id=${this.data.userInfo.user_id}`,
        method: 'GET'
      })
      
      const members = Array.isArray(membersRes.data) ? membersRes.data : (Array.isArray(membersRes) ? membersRes : [])
      
      // 逐个软删除（设置is_active=false）
      for (const member of members) {
        await cloudRequest.callContainer({
          path: `/api/family-members/${member.id}?user_id=${this.data.userInfo.user_id}`,
          method: 'PUT',
          data: {
            ...member,
            is_active: false
          }
        }).catch(err => {
          console.warn(`[假删成员] 成员 ${member.name} 删除失败:`, err)
        })
      }
      
      console.log('[假删成员] 已软删除', members.length, '个成员')
    } catch (err) {
      console.error('[假删成员] 失败:', err)
    }
  },

  // 退出登录
  logout() {
    wx.showModal({
      title: '确认退出',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          // 清除设备状态检查定时器
          if (this.deviceStatusTimer) {
            clearInterval(this.deviceStatusTimer);
            this.deviceStatusTimer = null;
          }
          
          // 停止蓝牙定时扫描
          const app = getApp();
          if (app && app.stopPeriodicScan) {
            console.log('[首页] 退出登录，停止蓝牙定时扫描');
            app.stopPeriodicScan();
          }
          
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
  },
  
  onHide() {
    // 页面隐藏时清除定时器
    if (this.deviceStatusTimer) {
      clearInterval(this.deviceStatusTimer);
      this.deviceStatusTimer = null;
    }
    
    // 注意：不在这里停止蓝牙扫描
    // 因为用户可能跳转到体脂秤页面，需要持续的蓝牙数据
    // 只在退出登录或删除设备时才停止扫描
  },
  
  onUnload() {
    // 页面卸载时清除定时器
    if (this.deviceStatusTimer) {
      clearInterval(this.deviceStatusTimer);
      this.deviceStatusTimer = null;
    }
    
    // 注意：不在这里停止蓝牙扫描
    // 保持扫描运行，供其他页面使用
  },
  
  // 下拉刷新
  async onPullDownRefresh() {
    console.log('[首页] 下拉刷新')
    
    if (!this.data.userInfo) {
      wx.stopPullDownRefresh()
      return
    }
    
    try {
      // 重新加载设备数据（用户主动刷新）
      await this.loadUserDevices()
      
      // 如果网络恢复，尝试初始化蓝牙
      const app = getApp()
      if (app && !app.globalData.bleAdapterInitialized && !app.globalData.bluetoothInitializing) {
        console.log('[首页] 🔄 下拉刷新成功，尝试初始化蓝牙')
        app.checkAndInitBluetooth(this.data.userInfo.user_id)
      }
      
      wx.showToast({
        title: '刷新成功',
        icon: 'success',
        duration: 1000
      })
    } catch (err) {
      console.error('刷新失败:', err)
      wx.showToast({
        title: '刷新失败',
        icon: 'none'
      })
    } finally {
      wx.stopPullDownRefresh()
    }
  }
})
