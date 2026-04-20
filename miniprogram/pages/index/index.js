const app = getApp()
const cloudRequest = require('../../utils/cloud_request.js')

Page({
  data: {
    userInfo: null,
    hasConfigured: false,
    account: '',
    password: '',
    phoneNumber: '' // 用于登录
  },
  
  onLoad: function (options) {
    this.checkLoginStatus()
  },
  
  onShow: function() {
    // 每次显示页面时检查配置状态
    if (this.data.userInfo) {
      this.checkConfigStatus()
    }
  },
  
  // 检查登录状态
  checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo')
    if (userInfo) {
      this.setData({ userInfo })
      this.checkConfigStatus()
    }
  },
  
  // 检查配置状态
  async checkConfigStatus() {
    try {
      const res = await cloudRequest.callContainer({
        path: '/api/auth/check-config',
        method: 'GET'
      })
      
      // callContainer 已返回 res.data
      this.setData({ hasConfigured: res.has_configured })
    } catch (err) {
      console.error('检查配置失败:', err)
    }
  },
  
  // 手机号登录/注册
  async onLogin() {
    const { phoneNumber } = this.data
    
    if (!phoneNumber || phoneNumber.length !== 11) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' })
      return
    }
    
    console.log('开始登录，手机号:', phoneNumber)
    
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
      
      console.log('登录响应:', res)
      
      // callContainer 已返回 res.data，直接使用
      const userInfo = res
      console.log('用户信息:', userInfo)
      wx.setStorageSync('userInfo', userInfo)
      this.setData({ userInfo, hasConfigured: userInfo.has_configured })
      
      wx.hideLoading()
      wx.showToast({ title: '登录成功', icon: 'success' })
      
      // 如果未配置，引导配置
      if (!userInfo.has_configured) {
        setTimeout(() => {
          wx.showToast({ 
            title: '请完成初始配置', 
            icon: 'none',
            duration: 2000
          })
        }, 1500)
      }
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
  
  // 提交配置
  async onSubmitConfig() {
    const { account, password } = this.data
    
    if (!account || !password) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' })
      return
    }
    
    wx.showLoading({ title: '保存中...' })
    
    try {
      // 保存 ACCOUNT
      await cloudRequest.callContainer({
        path: '/api/config',
        method: 'POST',
        data: {
          key: 'ACCOUNT',
          value: account,
          is_encrypted: true
        }
      })
      
      // 保存 PASSWORD
      await cloudRequest.callContainer({
        path: '/api/config',
        method: 'POST',
        data: {
          key: 'PASSWORD',
          value: password,
          is_encrypted: true
        }
      })
      
      // 重新初始化服务
      await cloudRequest.callContainer({
        path: '/api/auth/reinit-services',
        method: 'POST'
      })
      
      wx.hideLoading()
      wx.showToast({ title: '配置成功', icon: 'success' })
      
      // 更新状态
      this.setData({ hasConfigured: true })
      
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: '配置失败，请重试', icon: 'none' })
      console.error('配置错误:', err)
    }
  }
})
