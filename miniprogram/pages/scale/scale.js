const cloudRequest = require('../../utils/cloud_request.js');
const bleUtils = require('../../utils/ble_scale.js');

Page({
  data: {
    scanning: false,
    device: null,
    weight: 0,
    isStabilized: false,
    logs: [],
    users: [],
    selectedUserIndex: -1,
    newUserName: ""
  },

  onLoad() {
    this.fetchUsers()
  },

  fetchUsers() {
    cloudRequest.callContainer({
      path: '/api/users',
      success: res => {
        // callContainer 已返回业务数据
        this.setData({ users: res })
      },
      fail: err => {
        console.error('获取用户列表失败:', err);
        
        // 检查是否是 503 服务未初始化
        if (err.statusCode === 503) {
          wx.showModal({
            title: '服务未配置',
            content: '体重秤功能需要配置账号密码\n\n请在首页完成初始配置',
            showCancel: true,
            cancelText: '取消',
            confirmText: '去配置',
            success: (res) => {
              if (res.confirm) {
                // 跳转到首页进行配置
                wx.switchTab({
                  url: '/pages/index/index'
                });
              }
            }
          });
        } else {
          wx.showToast({
            title: '加载失败',
            icon: 'error'
          });
        }
      }
    })
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
    const idx = this.data.selectedUserIndex
    const userId = idx >= 0 && this.data.users[idx] ? this.data.users[idx].id : null
    
    cloudRequest.callContainer({
      path: '/api/scale/record',
      method: 'POST',
      data: {
        weight: this.data.weight,
        timestamp: Date.now(),
        user_id: userId
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
            content: '体重秤功能需要配置账号密码\n\n请在首页完成初始配置',
            showCancel: true,
            cancelText: '取消',
            confirmText: '去配置',
            success: (res) => {
              if (res.confirm) {
                // 跳转到首页进行配置
                wx.switchTab({
                  url: '/pages/index/index'
                });
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
    this.setData({ selectedUserIndex: e.detail.value })
  },

  bindNewUserInput(e) {
    this.setData({ newUserName: e.detail.value })
  },

  createUser() {
    const name = this.data.newUserName.trim()
    if (!name) {
      wx.showToast({ title: '请输入姓名', icon: 'none' })
      return
    }
    cloudRequest.callContainer({
      path: '/api/users',
      method: 'POST',
      data: { name },
      success: res => {
        this.setData({ newUserName: "" })
        this.fetchUsers()
        wx.showToast({ title: '已新增' })
      },
      fail: err => {
        console.error('创建用户失败:', err);
        
        // 检查是否是 503 服务未初始化
        if (err.statusCode === 503) {
          wx.showModal({
            title: '服务未配置',
            content: '体重秤功能需要配置账号密码\n\n请在首页完成初始配置',
            showCancel: true,
            cancelText: '取消',
            confirmText: '去配置',
            success: (res) => {
              if (res.confirm) {
                // 跳转到首页进行配置
                wx.switchTab({
                  url: '/pages/index/index'
                });
              }
            }
          });
        } else {
          wx.showToast({
            title: '操作失败',
            icon: 'error'
          });
        }
      }
    })
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
