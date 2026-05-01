/**
 * 体脂秤相关常量配置
 * 统一管理魔法数字，便于调整和维护
 */

export const SCALE_CONFIG = {
  // ========== 成员匹配 ==========
  /** 体重匹配容差（kg）- 在此范围内自动匹配成员 */
  WEIGHT_MATCH_TOLERANCE: 3.0,
  
  /** 数据去重误差阈值（kg）- 小于此值视为相同数据 */
  DATA_DEDUPLICATION_THRESHOLD: 0.05,
  
  // ========== 时间控制 ==========
  /** 数据防抖时间（ms）- 相同数据在此时间内跳过处理 */
  DATA_DEBOUNCE_TIME: 3000,
  
  /** 扫描超时时间（ms）- 无数据后自动断开连接 */
  SCAN_TIMEOUT: 60000,
  
  /** 跳转延迟时间（ms）- 检测到稳定体重后延迟跳转 */
  NAVIGATE_DELAY: 0,
  
  /** 图表绘制延迟（ms）- 数据加载完成后延迟绘制 */
  CHART_DRAW_DELAY: 300,
  
  /** 自动计算延迟（ms）- 成员加载完成后延迟计算体脂 */
  AUTO_CALCULATE_DELAY: 500,
  
  /** 数据新鲜度阈值（ms）- Service Data 时间戳超过此值视为过期数据 */
  DATA_FRESHNESS_THRESHOLD: 10000, // 10秒
  
  // ========== 稳定性检测 ==========
  /** 稳定性检测阈值（次数）- 连续N次相同值判定为稳定 */
  STABLE_THRESHOLD: 3,
  STABILITY_PROGRESS_STEPS: 5,
  
  // ========== 数据限制 ==========
  /** 最大历史记录数 - 保留最近N条用于稳定性检测 */
  MAX_HISTORY_RECORDS: 20,
  
  /** 图表最大数据点数 - 最多显示最近N次记录 */
  CHART_MAX_POINTS: 7,
  
  /** 日志最大条数 - 页面日志最多保留N条 */
  MAX_LOG_ENTRIES: 50,
  
  // ========== 体脂计算范围 ==========
  /** 体脂率最小值（%） */
  BODY_FAT_MIN: 5,
  
  /** 体脂率最大值（%） */
  BODY_FAT_MAX: 60,
  
  /** 水分率最小值（%） */
  WATER_MIN: 40,
  
  /** 水分率最大值（%） */
  WATER_MAX: 70,
  
  /** 蛋白质率最小值（%） */
  PROTEIN_MIN: 12,
  
  /** 蛋白质率最大值（%） */
  PROTEIN_MAX: 25,
  
  /** 内脏脂肪最小值 */
  VISCERAL_FAT_MIN: 1,
  
  /** 内脏脂肪最大值 */
  VISCERAL_FAT_MAX: 30,
  
  /** 骨重比例 */
  BONE_MASS_RATIO: 0.04,
  
  // ========== 体重范围 ==========
  /** 最小有效体重（kg）- 低于此值不触发跳转，过滤无效数据 */
  MIN_EFFECTIVE_WEIGHT: 30,
  MIN_NAVIGATE_WEIGHT: 20,
  
  /** 仪表盘最大体重（kg） */
  GAUGE_MAX_WEIGHT: 150,
  
  /** 自动保存体重波动阈值（kg）- 超过此值不自动保存 */
  AUTO_SAVE_WEIGHT_DIFF: 10,
  
  // ========== Canvas绘图 ==========
  /** 体重仪表盘Canvas宽度（rpx） */
  GAUGE_CANVAS_WIDTH: 750,
  
  /** 体重仪表盘Canvas高度（rpx） */
  GAUGE_CANVAS_HEIGHT: 400,
  
  /** 体重仪表盘半径（rpx） */
  GAUGE_RADIUS: 140,
  
  /** 趋势图Canvas宽度（rpx） */
  CHART_CANVAS_WIDTH: 650,
  
  /** 趋势图Canvas高度（rpx） */
  CHART_CANVAS_HEIGHT: 400,
  
  /** 趋势图上边距（rpx） */
  CHART_PADDING_TOP: 40,
  
  /** 趋势图右边距（rpx） */
  CHART_PADDING_RIGHT: 30,
  
  /** 趋势图下边距（rpx） */
  CHART_PADDING_BOTTOM: 60,
  
  /** 趋势图左边距（rpx） */
  CHART_PADDING_LEFT: 50,
  
  /** 趋势图网格线数量 */
  CHART_GRID_LINES: 4,
  
  // ========== 健康指标参考范围 ==========
  HEALTH_RANGES: {
    bmi: {
      normal: '18.5-23.9',
      low: '<18.5',
      high: '≥24'
    },
    bodyFat: {
      male: { normal: '10-20%', low: '<10%', high: '>25%' },
      female: { normal: '18-28%', low: '<18%', high: '>35%' }
    },
    water: {
      male: { normal: '55-65%', low: '<55%', high: '>65%' },
      female: { normal: '45-60%', low: '<45%', high: '>60%' }
    },
    visceralFat: {
      normal: '1-9',
      warning: '10-14',
      high: '≥15'
    }
  },
  
  // ========== 设备识别关键词 ==========
  SCALE_DEVICE_KEYWORDS: [
    'mi scale',
    'body',
    'scale',
    '米秤',
    '体脂',
    'mibfs'
  ],
  
  // ========== 颜色配置 ==========
  COLORS: {
    // 状态颜色
    connected: '#10B981',      // 绿色
    broadcasting: '#F59E0B',   // 橙色
    disconnected: '#94A3B8',   // 灰色
    
    // 图表颜色
    weightLine: '#10B981',     // 体重折线
    bodyFatLine: '#F59E0B',    // 体脂折线
    gridLine: '#E2E8F0',       // 网格线
    axisLabel: '#94A3B8',      // 坐标轴标签
    dateLabel: '#64748B',      // 日期标签
    
    // 渐变色
    gaugeStable: ['#10B981', '#059669'],      // 稳定时渐变
    gaugeWaiting: ['#3B82F6', '#2563EB']      // 等待时渐变
  },
  
  // ========== 头像颜色 ==========
  AVATAR_COLORS: [
    'linear-gradient(135deg, #667EEA 0%, #764BA2 100%)',
    'linear-gradient(135deg, #F093FB 0%, #F5576C 100%)',
    'linear-gradient(135deg, #4FACFE 0%, #00F2FE 100%)',
    'linear-gradient(135deg, #43E97B 0%, #38F9D7 100%)',
    'linear-gradient(135deg, #FA709A 0%, #FEE140 100%)',
    'linear-gradient(135deg, #FF9A9E 0%, #FECFEF 100%)'
  ]
};

// 导出常用子模块，方便引用
export const MATCHING = {
  TOLERANCE: SCALE_CONFIG.WEIGHT_MATCH_TOLERANCE,
  DEDUPLICATION_THRESHOLD: SCALE_CONFIG.DATA_DEDUPLICATION_THRESHOLD
};

export const TIMING = {
  DEBOUNCE: SCALE_CONFIG.DATA_DEBOUNCE_TIME,
  TIMEOUT: SCALE_CONFIG.SCAN_TIMEOUT,
  NAVIGATE_DELAY: SCALE_CONFIG.NAVIGATE_DELAY,
  CHART_DELAY: SCALE_CONFIG.CHART_DRAW_DELAY,
  CALCULATE_DELAY: SCALE_CONFIG.AUTO_CALCULATE_DELAY
};

export const LIMITS = {
  HISTORY: SCALE_CONFIG.MAX_HISTORY_RECORDS,
  CHART_POINTS: SCALE_CONFIG.CHART_MAX_POINTS,
  LOGS: SCALE_CONFIG.MAX_LOG_ENTRIES,
  MIN_WEIGHT: SCALE_CONFIG.MIN_EFFECTIVE_WEIGHT
};

export default SCALE_CONFIG;
