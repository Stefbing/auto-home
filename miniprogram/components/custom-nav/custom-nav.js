Component({
  properties: {
    title: {
      type: String,
      value: ''
    },
    showBack: {
      type: Boolean,
      value: true
    },
    showClose: {
      type: Boolean,
      value: false  // 默认隐藏右侧关闭按钮
    }
  },

  data: {
    statusBarHeight: 0,
    navBarHeight: 44
  },

  attached() {
    // 获取系统信息
    const systemInfo = wx.getSystemInfoSync();
    this.setData({
      statusBarHeight: systemInfo.statusBarHeight || 0
    });
  },

  methods: {
    onBack() {
      wx.navigateBack({
        delta: 1
      });
    },

    onClose() {
      wx.navigateBack({
        delta: 1
      });
    }
  }
});
