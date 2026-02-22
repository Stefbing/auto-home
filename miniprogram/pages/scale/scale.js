const app = getApp();
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
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/users`,
      success: res => {
        this.setData({ users: res.data })
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
    
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/scale/record`,
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
        this.log("上传失败 " + JSON.stringify(err));
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
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/users`,
      method: 'POST',
      data: { name },
      success: res => {
        this.setData({ newUserName: "" })
        this.fetchUsers()
        wx.showToast({ title: '已新增' })
      }
    })
  },

  log(msg) {
    console.log(msg);
    const logs = this.data.logs;
    logs.unshift(new Date().toLocaleTimeString() + " " + msg);
    this.setData({ logs });
  },
  
  onUnload() {
    this.stopScan();
  }
});
