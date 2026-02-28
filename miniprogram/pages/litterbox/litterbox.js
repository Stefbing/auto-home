const app = getApp();

Page({
  data: {
    stats: { today_visits: 0, last_visit: '--:--' },
    loading: false,
    deviceId: null
  },

  onLoad(options) {
    // 从参数获取设备ID（如果有的话）
    if (options.device_id) {
      this.setData({ deviceId: options.device_id });
    }
    this.fetchStats();
    
    // 设置定时刷新
    this.startAutoRefresh();
  },

  onUnload() {
    // 页面卸载时清除定时器
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  },

  startAutoRefresh() {
    // 每30秒自动刷新一次数据
    this.refreshTimer = setInterval(() => {
      this.fetchStats();
    }, 30000);
  },

  refreshData() {
    wx.vibrateShort(); // 震动反馈
    this.fetchStats();
    wx.showToast({
      title: '数据已刷新',
      icon: 'success',
      duration: 1000
    });
  },

  cleanNow() {
    wx.showModal({
      title: '确认清理',
      content: '确定要立即清理猫厕所吗？',
      success: (res) => {
        if (res.confirm) {
          this.setData({ loading: true });
          wx.request({
            url: `${app.globalData.apiBaseUrl}/api/petkit/clean`,
            method: 'POST',
            data: {
              device_id: this.data.deviceId
            },
            success: r => {
              if(r.data.status === 'success') {
                wx.showToast({ 
                  title: '清理指令已发送',
                  icon: 'success'
                });
                // 清理后稍等片刻再刷新数据
                setTimeout(() => {
                  this.fetchStats();
                }, 3000);
              }
            },
            fail: err => {
              wx.showToast({
                title: '操作失败',
                icon: 'error'
              });
            },
            complete: () => {
              this.setData({ loading: false });
            }
          });
        }
      }
    });
  },

  fetchStats() {
    this.setData({ loading: true });
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/petkit/stats`,
      data: {
        device_id: this.data.deviceId
      },
      success: res => {
        this.setData({ 
          stats: res.data,
          loading: false 
        });
        
        // 如果有警告信息，显示给用户
        if (res.data.warning) {
          wx.showModal({
            title: '数据提示',
            content: res.data.warning,
            showCancel: false
          });
        }
      },
      fail: err => {
        console.error('获取统计数据失败:', err);
        wx.showToast({
          title: '获取数据失败',
          icon: 'error'
        });
        this.setData({ loading: false });
      }
    });
  }
});
