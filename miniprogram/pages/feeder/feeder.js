const app = getApp();

Page({
  data: {
    plans: []
  },

  onLoad() {
    this.fetchPlans();
  },

  feedOne() {
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/petwant/feed`,
      method: 'POST',
      data: { amount: 1 },
      success: res => {
        if(res.data.status === 'success') {
          wx.showToast({ title: '已投喂 1 份' });
        }
      }
    });
  },

  toggleLight(e) {
    const on = e.detail.value;
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/petwant/light`,
      method: 'POST',
      data: { on: on },
      success: res => {
        wx.showToast({ title: on ? '灯已开' : '灯已关' });
      }
    });
  },

  fetchPlans() {
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/petwant/plans`,
      success: res => {
        this.setData({ plans: res.data });
      }
    });
  },

  togglePlan(e) {
    const index = e.currentTarget.dataset.index
    const plans = this.data.plans.slice()
    plans[index].enabled = e.detail.value
    this.setData({ plans })
  },

  savePlans() {
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/petwant/plans`,
      method: 'POST',
      data: this.data.plans,
      success: res => {
        wx.showToast({ title: '已保存计划' })
      }
    })
  }
});
