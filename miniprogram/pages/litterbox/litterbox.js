const app = getApp();

Page({
  data: {
    stats: { today_visits: 0, last_visit: '--:--' }
  },

  onLoad() {
    this.fetchStats();
  },

  cleanNow() {
    wx.showModal({
      title: '确认清理',
      content: '确定要立即清理猫厕所吗？',
      success: (res) => {
        if (res.confirm) {
          wx.request({
            url: `${app.globalData.apiBaseUrl}/api/petkit/clean`,
            method: 'POST',
            success: r => {
              if(r.data.status === 'success') {
                wx.showToast({ title: '指令已发送' });
              }
            }
          });
        }
      }
    });
  },

  fetchStats() {
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/petkit/stats`,
      success: res => {
        this.setData({ stats: res.data });
      }
    });
  }
});
