const app = getApp();

Page({
  data: {
    stats: { today_visits: 0, last_visit: '--:--', device_name: '', sand_percent: 0, deodorant_days: 0 },
    loading: false
  },

  onLoad(options) {
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
          wx.showLoading({
            title: '发送指令中...'
          });
          
          wx.request({
            url: `${app.globalData.apiBaseUrl}/api/petkit/clean`,
            method: 'POST',
            success: r => {
              wx.hideLoading();
              if(r.data && r.data.status === 'success') {
                wx.showToast({ 
                  title: '清理指令已发送',
                  icon: 'success'
                });
                // 清理后稍等片刻再刷新数据
                setTimeout(() => {
                  this.fetchStats();
                }, 3000);
              } else {
                wx.showToast({
                  title: '操作失败',
                  icon: 'error'
                });
              }
            },
            fail: err => {
              wx.hideLoading();
              console.error('清理请求失败:', err);
              wx.showToast({
                title: '网络错误',
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
      url: `${app.globalData.apiBaseUrl}/api/petkit/devices-stats`,
      success: res => {
        const devicesWithStats = res.data || [];
        
        // 从第一个猫厕所设备获取统计数据
        let stats = {};
        if (devicesWithStats.length > 0) {
          const firstDevice = devicesWithStats[0];
          // 统计数据在 state_summary 字段中（与 Web 端一致）
          const stateSummary = firstDevice.state_summary || {};
          stats = {
            device_name: firstDevice.name || '猫厕所',
            today_visits: stateSummary.today_visits || 0,
            avg_duration: stateSummary.avg_duration || 0,
            last_pet_weight: stateSummary.last_pet_weight || 0,
            sand_percent: stateSummary.sand_percent || 0,
            deodorant_days: stateSummary.deodorant_left_days || 0,
            frequent_restroom: stateSummary.frequent_restroom || false,
            box_full: stateSummary.box_full || false,
            sand_weight: stateSummary.sand_weight || 0,
            work_state: stateSummary.work_state || 0
          };
        }
        
        this.setData({ 
          stats: stats,
          loading: false 
        });
        
        // 如果有警告信息，显示给用户
        if (stats.warning) {
          wx.showModal({
            title: '数据提示',
            content: stats.warning,
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
