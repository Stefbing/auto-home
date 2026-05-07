const cloudRequest = require('../../utils/cloud_request.js');

Page({
  data: {
    plans: [],
    loading: true,
    actionLoading: false,
    feedAmount: 1, // 投喂份量
    todayServings: 0, // 今日已喂次数
    deviceName: '云宠喂食器', // 设备名称
    showAddPlanDialog: false, // 显示添加计划弹窗
    planTime: '', // 计划时间
    planAmount: 1, // 计划份量
    planAmountIndex: 0 // 计划份量索引
  },

  onLoad() {
    this.fetchPlans();
    this.fetchTodayServings();
  },

  onShow() {
    // 页面显示时刷新数据
    this.fetchTodayServings();
  },

  // 设置投喂份量
  setFeedAmount(e) {
    const amount = parseInt(e.currentTarget.dataset.amount);
    this.setData({ feedAmount: amount });
  },

  // 获取今日喂食次数
  fetchTodayServings() {
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.user_id) return;
    
    cloudRequest.callContainer({
      path: `/api/cloudpets/servings_today?user_id=${userInfo.user_id}`,
      method: 'GET',
      success: res => {
        if (res && typeof res === 'object' && res.result !== undefined) {
          this.setData({ todayServings: res.result });
        } else if (typeof res === 'number') {
          this.setData({ todayServings: res });
        }
      },
      fail: err => {
        console.error('获取今日喂食次数失败:', err);
      }
    });
  },

  feedOne() {
    const { feedAmount } = this.data;
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.user_id) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    
    this.setData({ actionLoading: true });
    wx.showLoading({
      title: '正在投喂...'
    });

    cloudRequest.callContainer({
      path: `/api/cloudpets/feed?user_id=${userInfo.user_id}`,
      method: 'POST',
      data: { amount: feedAmount },
      success: res => {
        wx.hideLoading();
        this.setData({ actionLoading: false });
        wx.showToast({
          title: `已投喂 ${feedAmount} 份`,
          icon: 'success'
        });
        // 刷新今日喂食次数
        this.fetchTodayServings();
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
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.user_id) return;
    
    this.setData({ loading: true });
    cloudRequest.callContainer({
      path: `/api/cloudpets/plans?user_id=${userInfo.user_id}`,
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
      path: `/api/cloudpets/plans/${plan.id}?user_id=${wx.getStorageSync('userInfo').user_id}`,
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
  },

  // 显示添加计划弹窗
  showAddPlanModal() {
    this.setData({
      showAddPlanDialog: true,
      planTime: '',
      planAmount: 1,
      planAmountIndex: 0
    });
  },

  // 关闭添加计划弹窗
  closeAddPlanModal() {
    this.setData({ showAddPlanDialog: false });
  },

  // 阻止事件冒泡
  stopPropagation() {},

  // 选择计划时间
  onPlanTimeChange(e) {
    this.setData({ planTime: e.detail.value });
  },

  // 选择计划份量
  onPlanAmountChange(e) {
    const index = parseInt(e.detail.value);
    const amounts = [1, 2, 3, 4, 5];
    this.setData({
      planAmountIndex: index,
      planAmount: amounts[index]
    });
  },

  // 提交新计划
  submitPlan() {
    const { planTime, planAmount } = this.data;

    if (!planTime) {
      wx.showToast({ title: '请选择时间', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '添加中...' });

    const newPlan = {
      time: planTime,
      amount: planAmount,
      enabled: true,
      weekdays: [1, 2, 3, 4, 5, 6, 7] // 默认每天
    };

    cloudRequest.callContainer({
      path: `/api/cloudpets/plans?user_id=${wx.getStorageSync('userInfo').user_id}`,
      method: 'POST',
      data: newPlan,
      success: () => {
        wx.hideLoading();
        wx.showToast({ title: '添加成功', icon: 'success' });
        this.closeAddPlanModal();
        this.fetchPlans(); // 刷新计划列表
      },
      fail: err => {
        wx.hideLoading();
        console.error('添加计划失败:', err);
        
        if (err.statusCode === 503) {
          wx.showModal({
            title: '服务未配置',
            content: 'CloudPets 喂食器功能需要配置账号密码\n\n请在首页完成初始配置',
            showCancel: true,
            cancelText: '取消',
            confirmText: '去配置',
            success: (res) => {
              if (res.confirm) {
                wx.switchTab({ url: '/pages/index/index' });
              }
            }
          });
        } else {
          wx.showToast({ title: '添加失败', icon: 'error' });
        }
      }
    });
  },

  // 删除计划
  deletePlan(e) {
    const planId = e.currentTarget.dataset.id;

    wx.showModal({
      title: '确认删除',
      content: '确定要删除这个喂食计划吗？',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '删除中...' });

          cloudRequest.callContainer({
            path: `/api/cloudpets/plans/${planId}?user_id=${wx.getStorageSync('userInfo').user_id}`,
            method: 'DELETE',
            success: () => {
              wx.hideLoading();
              wx.showToast({ title: '删除成功', icon: 'success' });
              this.fetchPlans(); // 刷新计划列表
            },
            fail: err => {
              wx.hideLoading();
              console.error('删除计划失败:', err);
              
              if (err.statusCode === 503) {
                wx.showModal({
                  title: '服务未配置',
                  content: 'CloudPets 喂食器功能需要配置账号密码\n\n请在首页完成初始配置',
                  showCancel: true,
                  cancelText: '取消',
                  confirmText: '去配置',
                  success: (res) => {
                    if (res.confirm) {
                      wx.switchTab({ url: '/pages/index/index' });
                    }
                  }
                });
              } else {
                wx.showToast({ title: '删除失败', icon: 'error' });
              }
            }
          });
        }
      }
    });
  },
  
  // 下拉刷新
  async onPullDownRefresh() {
    console.log('[喂食器] 下拉刷新')
    
    try {
      await this.fetchPlans()
      await this.fetchStatus()
      
      wx.showToast({
        title: '刷新成功',
        icon: 'success',
        duration: 1000
      })
    } catch (err) {
      console.error('刷新失败:', err)
      wx.showToast({
        title: '刷新失败',
        icon: 'none'
      })
    } finally {
      wx.stopPullDownRefresh()
    }
  }
});
