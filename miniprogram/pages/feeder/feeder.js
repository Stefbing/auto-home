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
      url: `${app.globalData.apiBaseUrl}/api/cloudpets/feed`,
      method: 'POST',
      data: { amount: 1 },
      success: res => {
        wx.showToast({ title: '已投喂 1 份' });
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
      url: `${app.globalData.apiBaseUrl}/api/cloudpets/plans`,
      success: res => {
        this.setData({ plans: res.data });
      }
    });
  },

  togglePlan(e) {
    const index = e.currentTarget.dataset.index;
    const plan = this.data.plans[index];
    
    // 立即更新UI
    const plans = this.data.plans.slice();
    plans[index].enabled = e.detail.value;
    this.setData({ plans });
    
    // 调用后端API更新计划
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/cloudpets/plans/${plan.id}`,
      method: 'PUT',
      data: plan,
      success: res => {
        wx.showToast({ 
          title: e.detail.value ? '已启用' : '已禁用',
          icon: 'success'
        });
      },
      fail: err => {
        // 如果失败，回滚UI状态
        plans[index].enabled = !e.detail.value;
        this.setData({ plans });
        wx.showToast({ 
          title: '操作失败', 
          icon: 'error' 
        });
      }
    });
  },

  // 由于CloudPets API是直接操作的，不需要批量保存
  savePlans() {
    wx.showToast({ title: '计划已实时保存' });
  }
});
