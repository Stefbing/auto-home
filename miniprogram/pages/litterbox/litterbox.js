const cloudRequest = require('../../utils/cloud_request.js');

function getDefaultStats() {
  return {
    device_name: '',
    today_visits: 0,
    avg_duration: 0,
    last_pet_weight: 0,
    sand_percent: 0,
    deodorant_days: 0,
    frequent_restroom: false,
    box_full: false,
    sand_weight: 0,
    work_state: 0,
    warning: ''
  };
}

Page({
  data: {
    stats: getDefaultStats(),
    loading: true,
    refreshing: true,
    actionLoading: false
  },

  onLoad() {
    this.fetchStats({ showSkeleton: true });
    this.startAutoRefresh();
  },

  onUnload() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  },

  startAutoRefresh() {
    this.refreshTimer = setInterval(() => {
      this.fetchStats({ silent: true });
    }, 30000);
  },

  refreshData() {
    wx.vibrateShort();
    this.fetchStats({ silent: false });
  },

  cleanNow() {
    wx.showModal({
      title: '确认清理',
      content: '确定要立即清理猫砂盆吗？',
      success: res => {
        if (!res.confirm) {
          return;
        }

        this.setData({ actionLoading: true });
        wx.showLoading({
          title: '发送指令中...'
        });

        const userInfo = wx.getStorageSync('userInfo');
        if (!userInfo || !userInfo.user_id) {
          wx.showToast({ title: '请先登录', icon: 'none' });
          return;
        }
        
        cloudRequest.callContainer({
          path: `/api/petkit/clean?user_id=${userInfo.user_id}`,
          method: 'POST',
          success: response => {
            wx.hideLoading();
            if (response.data && response.data.status === 'success') {
              wx.showToast({
                title: '清理指令已发送',
                icon: 'success'
              });

              setTimeout(() => {
                this.fetchStats({ silent: true });
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
            this.setData({ actionLoading: false });
          }
        });
      }
    });
  },

  fetchStats(options = {}) {
    const { showSkeleton = false, silent = true } = options;
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.user_id) return;

    this.setData({
      loading: showSkeleton,
      refreshing: true
    });

    cloudRequest.callContainer({
      path: `/api/petkit/devices-stats?user_id=${userInfo.user_id}`,
      success: res => {
        // callContainer 已返回业务数据
        const devicesWithStats = Array.isArray(res) ? res : [];
        let stats = { ...this.data.stats };

        if (devicesWithStats.length > 0) {
          const firstDevice = devicesWithStats[0];
          const stateSummary = firstDevice.state_summary || {};

          stats = {
            ...stats,
            device_name: firstDevice.name || stats.device_name || '猫厕所',
            today_visits: stateSummary.today_visits ?? stats.today_visits,
            avg_duration: stateSummary.avg_duration ?? stats.avg_duration,
            last_pet_weight: stateSummary.last_pet_weight ?? stats.last_pet_weight,
            sand_percent: stateSummary.sand_percent ?? stats.sand_percent,
            deodorant_days: stateSummary.deodorant_left_days ?? stats.deodorant_days,
            frequent_restroom: stateSummary.frequent_restroom ?? stats.frequent_restroom,
            box_full: stateSummary.box_full ?? stats.box_full,
            sand_weight: stateSummary.sand_weight ?? stats.sand_weight,
            work_state: stateSummary.work_state ?? stats.work_state,
            warning: stateSummary.warning ?? firstDevice.warning ?? stats.warning
          };
        } else if (showSkeleton) {
          stats = getDefaultStats();
        }

        this.setData({
          stats,
          loading: false,
          refreshing: false
        });

        if (!silent) {
          if (stats.warning) {
            wx.showModal({
              title: '数据提示',
              content: stats.warning,
              showCancel: false
            });
          } else {
            wx.showToast({
              title: '数据已刷新',
              icon: 'success',
              duration: 1000
            });
          }
        }
      },
      fail: err => {
        console.error('获取统计数据失败:', err);
        
        // 检查是否是 503 服务未初始化
        if (err.statusCode === 503) {
          wx.showModal({
            title: '服务未配置',
            content: 'PetKit 猫厕所功能需要配置账号密码\n\n请在首页完成初始配置',
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
            title: '获取数据失败',
            icon: 'error'
          });
        }
        
        this.setData({
          loading: false,
          refreshing: false
        });
      }
    });
  },
  
  // 下拉刷新
  async onPullDownRefresh() {
    console.log('[猫厕所] 下拉刷新')
    
    try {
      await this.fetchStats({ silent: true })
      
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
