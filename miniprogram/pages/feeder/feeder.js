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
        // callContainer 已返回业务数据，直接显示成功
        wx.showToast({
          title: '已投喂 1 份',
          icon: 'success'
        });
      },
      fail: err => {
        wx.hideLoading();
        this.setData({ actionLoading: false });
        console.error('投喂请求失败:', err);
        
        // 检查是否是 503 服务未初始化
        if (err.statusCode === 503) {
          wx.showModal({
            title: '服务未配置',
            content: 'CloudPets 喂食器功能需要配置账号密码\n\n请在首页完成初始配置',
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
            title: '网络错误',
            icon: 'error'
          });
        }
      }
    });
  },

  fetchPlans() {
    this.setData({ loading: true });
    cloudRequest.callContainer({
      path: '/api/cloudpets/plans',
      success: res => {
        // callContainer 已返回业务数据
        this.setData({
          plans: res || [],
          loading: false
        });
      },
      fail: err => {
        console.error('获取喂食计划失败:', err);
        this.setData({ loading: false });
        
        // 检查是否是 503 服务未初始化
        if (err.statusCode === 503) {
          wx.showModal({
            title: '服务未配置',
            content: 'CloudPets 喂食器功能需要配置账号密码\n\n请在首页完成初始配置',
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
        
        // 检查是否是 503 服务未初始化
        if (err.statusCode === 503) {
          wx.showModal({
            title: '服务未配置',
            content: 'CloudPets 喂食器功能需要配置账号密码\n\n请在首页完成初始配置',
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
    });
  },

  savePlans() {
    wx.showToast({
      title: '计划已实时保存',
      icon: 'success'
    });
  }
});
