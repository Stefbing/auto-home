const cloudRequest = require('../../utils/cloud_request.js');

Page({
  data: {
    plans: [],
    loading: true,
    actionLoading: false
  },

  onLoad() {
    this.fetchPlans();
  },

  feedOne() {
    this.setData({ actionLoading: true });
    wx.showLoading({
      title: '正在投喂...'
    });

    cloudRequest.callContainer({
      path: '/api/cloudpets/feed',
      method: 'POST',
      data: { amount: 1 },
      success: res => {
        wx.hideLoading();
        this.setData({ actionLoading: false });
        if (res.statusCode === 200) {
          wx.showToast({
            title: '已投喂 1 份',
            icon: 'success'
          });
        } else {
          wx.showToast({
            title: '投喂失败',
            icon: 'error'
          });
        }
      },
      fail: err => {
        wx.hideLoading();
        this.setData({ actionLoading: false });
        console.error('投喂请求失败:', err);
        wx.showToast({
          title: '网络错误',
          icon: 'error'
        });
      }
    });
  },

  fetchPlans() {
    this.setData({ loading: true });
    cloudRequest.callContainer({
      path: '/api/cloudpets/plans',
      success: res => {
        this.setData({
          plans: res.data || [],
          loading: false
        });
      },
      fail: err => {
        console.error('获取喂食计划失败:', err);
        this.setData({ loading: false });
        wx.showToast({
          title: '加载失败',
          icon: 'error'
        });
      }
    });
  },

  togglePlan(e) {
    const index = e.currentTarget.dataset.index;
    const plans = this.data.plans.slice();
    const plan = {
      ...plans[index],
      enabled: e.detail.value
    };

    plans[index] = plan;
    this.setData({ plans });

    cloudRequest.callContainer({
      path: `/api/cloudpets/plans/${plan.id}`,
      method: 'PUT',
      data: plan,
      success: () => {
        wx.showToast({
          title: e.detail.value ? '已启用' : '已禁用',
          icon: 'success'
        });
      },
      fail: err => {
        console.error('更新喂食计划失败:', err);
        plans[index] = {
          ...plan,
          enabled: !e.detail.value
        };
        this.setData({ plans });
        wx.showToast({
          title: '操作失败',
          icon: 'error'
        });
      }
    });
  },

  savePlans() {
    wx.showToast({
      title: '计划已实时保存',
      icon: 'success'
    });
  }
});
