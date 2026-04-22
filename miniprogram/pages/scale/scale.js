const cloudRequest = require('../../utils/cloud_request.js');
const bleUtils = require('../../utils/ble_scale.js');

Page({
  data: {
    scanning: false,
    device: null,
    weight: 0,
    isStabilized: false,
    logs: [],
    userInfo: null,  // 当前登录用户
    selectedUserIndex: -1,  // 保留字段但不再使用多用户选择
    users: [{ id: null, name: '当前用户' }]  // 简化为单用户
  },

  onLoad() {
    this.checkLoginStatus()
  },

  checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo')
    if (!userInfo) {
      wx.showModal({
        title: '未登录',
        content: '请先在首页登录',
        showCancel: false,
        confirmText: '去登录',
        success: () => {
          wx.reLaunch({ url: '/pages/index/index' })
        }
      })
      return
    }
    this.setData({ userInfo })
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
    
    if (!this.data.userInfo || !this.data.userInfo.user_id) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    
    cloudRequest.callContainer({
      path: '/api/scale/record',
      method: 'POST',
      data: {
        weight: this.data.weight,
        timestamp: Date.now(),
        user_id: parseInt(this.data.userInfo.user_id)
      },
      success: (res) => {
        wx.showToast({ title: '上传成功' });
      },
      fail: (err) => {
        console.error('上传体重记录失败:', err);
        
        // 检查是否是 503 服务未初始化
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

  bindUserChange(e) {
    // 保留方法但不执行任何操作（兼容旧代码）
  },

  createUser() {
    // 废弃：现在直接使用登录用户
    wx.showToast({ title: '请使用首页登录', icon: 'none' })
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
