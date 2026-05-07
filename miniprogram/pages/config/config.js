const cloudRequest = require('../../utils/cloud_request.js');

Page({
  data: {
    // CloudPets
    cloudpetsAccount: '',
    cloudpetsPassword: '',
    cloudpetsSaving: false,

    // PetKit
    petkitAccount: '',
    petkitPassword: '',
    petkitSaving: false,

    // Xiaomi
    xiaomiAccount: '',
    xiaomiPassword: '',
    xiaomiSaving: false
  },

  onLoad() {
    this.loadConfig();
  },

  // 加载配置
  async loadConfig() {
    try {
      const config = await cloudRequest.callContainer({
        path: '/api/system/config',
        method: 'GET'
      });
      if (config) {
        this.setData({
          cloudpetsAccount: config.cloudpets_account || '',
          cloudpetsPassword: config.cloudpets_password || '',
          petkitAccount: config.petkit_account || '',
          petkitPassword: config.petkit_password || '',
          xiaomiAccount: config.xiaomi_account || '',
          xiaomiPassword: config.xiaomi_password || ''
        });
      }
    } catch (err) {
      console.error('加载配置失败:', err);
    }
  },

  // CloudPets 输入
  onCloudpetsAccountInput(e) {
    this.setData({ cloudpetsAccount: e.detail.value });
  },

  onCloudpetsPasswordInput(e) {
    this.setData({ cloudpetsPassword: e.detail.value });
  },

  // PetKit 输入
  onPetkitAccountInput(e) {
    this.setData({ petkitAccount: e.detail.value });
  },

  onPetkitPasswordInput(e) {
    this.setData({ petkitPassword: e.detail.value });
  },

  // Xiaomi 输入
  onXiaomiAccountInput(e) {
    this.setData({ xiaomiAccount: e.detail.value });
  },

  onXiaomiPasswordInput(e) {
    this.setData({ xiaomiPassword: e.detail.value });
  },

  // 保存 CloudPets 配置
  async saveCloudpetsConfig() {
    const { cloudpetsAccount, cloudpetsPassword } = this.data;

    if (!cloudpetsAccount || !cloudpetsPassword) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' });
      return;
    }

    this.setData({ cloudpetsSaving: true });

    try {
      await cloudRequest.callContainer({
        path: '/api/system/config',
        method: 'POST',
        data: {
          platform: 'cloudpets',
          account: cloudpetsAccount,
          password: cloudpetsPassword
        }
      });

      wx.showToast({ title: '保存成功', icon: 'success' });
      this.setData({ cloudpetsPassword: '********' });
    } catch (err) {
      console.error('保存失败:', err);
      wx.showToast({ title: '保存失败', icon: 'error' });
    } finally {
      this.setData({ cloudpetsSaving: false });
    }
  },

  // 保存 PetKit 配置
  async savePetkitConfig() {
    const { petkitAccount, petkitPassword } = this.data;

    if (!petkitAccount || !petkitPassword) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' });
      return;
    }

    this.setData({ petkitSaving: true });

    try {
      await cloudRequest.callContainer({
        path: '/api/system/config',
        method: 'POST',
        data: {
          platform: 'petkit',
          account: petkitAccount,
          password: petkitPassword
        }
      });

      wx.showToast({ title: '保存成功', icon: 'success' });
      this.setData({ petkitPassword: '********' });
    } catch (err) {
      console.error('保存失败:', err);
      wx.showToast({ title: '保存失败', icon: 'error' });
    } finally {
      this.setData({ petkitSaving: false });
    }
  },

  // 保存 Xiaomi 配置
  async saveXiaomiConfig() {
    const { xiaomiAccount, xiaomiPassword } = this.data;

    if (!xiaomiAccount || !xiaomiPassword) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' });
      return;
    }

    this.setData({ xiaomiSaving: true });

    try {
      await cloudRequest.callContainer({
        path: '/api/system/config',
        method: 'POST',
        data: {
          platform: 'xiaomi',
          account: xiaomiAccount,
          password: xiaomiPassword
        }
      });

      wx.showToast({ title: '保存成功', icon: 'success' });
      this.setData({ xiaomiPassword: '********' });
    } catch (err) {
      console.error('保存失败:', err);
      wx.showToast({ title: '保存失败', icon: 'error' });
    } finally {
      this.setData({ xiaomiSaving: false });
    }
  },
  
  // 下拉刷新
  async onPullDownRefresh() {
    console.log('[配置页] 下拉刷新')
    
    try {
      await this.loadConfig()
      
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
