/**
 * 图表绘制模块
 * 负责体重仪表盘和趋势图的Canvas绘制
 */

const { SCALE_CONFIG } = require('../config/scale_constants.js');

/**
 * 绘制体重仪表盘
 * @param {Object} ctx - Canvas上下文
 * @param {number} weight - 当前体重(kg)
 * @param {boolean} isStabilized - 数据是否稳定
 * @param {Object} options - 可选配置
 */
function drawWeightGauge(ctx, weight, isStabilized, options = {}) {
  // 获取系统信息计算实际像素
  const sysInfo = wx.getSystemInfoSync();
  const rpxRatio = sysInfo.windowWidth / 750;
  
  // Canvas实际尺寸（根据容器宽度自适应）
  const canvasWidth = options.width || (sysInfo.windowWidth - 64 * rpxRatio); // 减去左右margin 32rpx*2
  const canvasHeight = 400 * rpxRatio;
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2 - 20 * rpxRatio;
  const radius = Math.min(140 * rpxRatio, canvasWidth / 3);
  
  // 清空画布
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  
  // 绘制背景圆环
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  ctx.setStrokeStyle('#E2E8F0');
  ctx.setLineWidth(20);
  ctx.stroke();
  
  // 计算进度角度（0-150kg范围）
  const maxWeight = SCALE_CONFIG.GAUGE_MAX_WEIGHT;
  const progress = Math.min(weight / maxWeight, 1);
  const endAngle = -Math.PI / 2 + (progress * 2 * Math.PI);
  
  // 绘制进度圆环（渐变色）
  const gradient = ctx.createLinearGradient(centerX - radius, centerY, centerX + radius, centerY);
  if (isStabilized) {
    gradient.addColorStop(0, SCALE_CONFIG.COLORS.gaugeStable[0]);
    gradient.addColorStop(1, SCALE_CONFIG.COLORS.gaugeStable[1]);
  } else {
    gradient.addColorStop(0, SCALE_CONFIG.COLORS.gaugeWaiting[0]);
    gradient.addColorStop(1, SCALE_CONFIG.COLORS.gaugeWaiting[1]);
  }
  
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, -Math.PI / 2, endAngle);
  ctx.setStrokeStyle(gradient);
  ctx.setLineWidth(20);
  ctx.setLineCap('round');
  ctx.stroke();
  
  // 绘制中心体重数字
  ctx.setFillStyle(isStabilized ? SCALE_CONFIG.COLORS.connected : '#2563EB');
  ctx.setFontSize(120 * rpxRatio);
  ctx.setTextAlign('center');
  ctx.setTextBaseline('middle');
  ctx.fillText(weight.toFixed(1), centerX, centerY);
  
  // 绘制单位
  ctx.setFillStyle(SCALE_CONFIG.COLORS.axisLabel);
  ctx.setFontSize(36 * rpxRatio);
  ctx.fillText('kg', centerX, centerY + 40 * rpxRatio);
  
  // 绘制完成
  ctx.draw();
}

/**
 * 绘制体重趋势折线图
 * @param {Object} ctx - Canvas上下文
 * @param {Array} history - 历史记录数组
 * @param {string} canvasId - Canvas ID
 */
function drawWeightChart(ctx, history, canvasId) {
  if (!history || history.length === 0) {
    console.log('[图表] 无历史数据，跳过绘制');
    return;
  }
  
  const canvasWidth = SCALE_CONFIG.CHART_CANVAS_WIDTH;
  const canvasHeight = SCALE_CONFIG.CHART_CANVAS_HEIGHT;
  
  // 边距
  const padding = {
    top: SCALE_CONFIG.CHART_PADDING_TOP,
    right: SCALE_CONFIG.CHART_PADDING_RIGHT,
    bottom: SCALE_CONFIG.CHART_PADDING_BOTTOM,
    left: SCALE_CONFIG.CHART_PADDING_LEFT
  };
  
  // 绘图区域
  const chartWidth = canvasWidth - padding.left - padding.right;
  const chartHeight = canvasHeight - padding.top - padding.bottom;
  
  // 计算体重范围
  const weights = history.map(h => h.weight);
  const minWeight = Math.min(...weights) - 0.5;
  const maxWeight = Math.max(...weights) + 0.5;
  const weightRange = maxWeight - minWeight;
  
  // 清空画布
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  
  // 绘制背景网格
  _drawGrid(ctx, padding, chartWidth, chartHeight, canvasWidth, maxWeight, weightRange, 'kg');
  
  // 绘制标题和单位
  _drawChartTitle(ctx, canvasWidth, '体重', 'kg', SCALE_CONFIG.COLORS.weightLine);
  
  // 绘制折线和数据点
  if (history.length > 1) {
    _drawWeightLine(ctx, history, padding, chartWidth, chartHeight, minWeight, weightRange);
    _drawDataPoints(ctx, history, padding, chartWidth, chartHeight, minWeight, weightRange, canvasHeight, 'kg');
  } else if (history.length === 1) {
    _drawSinglePoint(ctx, history[0], padding, chartWidth, chartHeight, canvasHeight, 'kg');
  }
  
  // 绘制完成
  ctx.draw();
  console.log('[图表] 体重趋势图绘制完成');
}

/**
 * 绘制体脂趋势折线图
 * @param {Object} ctx - Canvas上下文
 * @param {Array} history - 历史记录数组
 * @param {string} canvasId - Canvas ID
 */
function drawBodyFatChart(ctx, history, canvasId) {
  // 过滤出有体脂数据的记录
  const bodyFatHistory = history.filter(h => h.bodyFat && h.bodyFat > 0);
  
  if (!bodyFatHistory || bodyFatHistory.length === 0) {
    console.log('[图表] 无体脂数据，跳过绘制');
    return;
  }
  
  const canvasWidth = SCALE_CONFIG.CHART_CANVAS_WIDTH;
  const canvasHeight = SCALE_CONFIG.CHART_CANVAS_HEIGHT;
  
  // 边距
  const padding = {
    top: SCALE_CONFIG.CHART_PADDING_TOP,
    right: SCALE_CONFIG.CHART_PADDING_RIGHT,
    bottom: SCALE_CONFIG.CHART_PADDING_BOTTOM,
    left: SCALE_CONFIG.CHART_PADDING_LEFT
  };
  
  // 绘图区域
  const chartWidth = canvasWidth - padding.left - padding.right;
  const chartHeight = canvasHeight - padding.top - padding.bottom;
  
  // 计算体脂范围
  const bodyFats = bodyFatHistory.map(h => h.bodyFat);
  const minBodyFat = Math.min(...bodyFats) - 1;
  const maxBodyFat = Math.max(...bodyFats) + 1;
  const bodyFatRange = maxBodyFat - minBodyFat;
  
  // 清空画布
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  
  // 绘制背景网格
  _drawGrid(ctx, padding, chartWidth, chartHeight, canvasWidth, maxBodyFat, bodyFatRange, '%');
  
  // 绘制标题和单位
  _drawChartTitle(ctx, canvasWidth, '体脂率', '%', SCALE_CONFIG.COLORS.bodyFatLine);
  
  // 绘制折线和数据点
  if (bodyFatHistory.length > 1) {
    _drawBodyFatLine(ctx, bodyFatHistory, padding, chartWidth, chartHeight, minBodyFat, bodyFatRange);
    _drawDataPoints(ctx, bodyFatHistory, padding, chartWidth, chartHeight, minBodyFat, bodyFatRange, canvasHeight, '%');
  } else if (bodyFatHistory.length === 1) {
    _drawSinglePoint(ctx, bodyFatHistory[0], padding, chartWidth, chartHeight, canvasHeight, '%', 'bodyFat');
  }
  
  // 绘制完成
  ctx.draw();
  console.log('[图表] 体脂趋势图绘制完成');
}

/**
 * 绘制背景网格
 * @private
 */
function _drawGrid(ctx, padding, chartWidth, chartHeight, canvasWidth, maxValue, valueRange, unit) {
  ctx.setStrokeStyle(SCALE_CONFIG.COLORS.gridLine);
  ctx.setLineWidth(1);
  
  // 横向网格线
  for (let i = 0; i <= SCALE_CONFIG.CHART_GRID_LINES; i++) {
    const y = padding.top + (chartHeight / SCALE_CONFIG.CHART_GRID_LINES) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(canvasWidth - padding.right, y);
    ctx.stroke();
    
    // Y轴标签（带单位）
    const value = maxValue - (valueRange / SCALE_CONFIG.CHART_GRID_LINES) * i;
    ctx.setFillStyle(SCALE_CONFIG.COLORS.axisLabel);
    ctx.setFontSize(20);
    ctx.setTextAlign('right');
    ctx.fillText(value.toFixed(1) + unit, padding.left - 5, y + 3);
  }
}

/**
 * 绘制图表标题和单位
 * @private
 */
function _drawChartTitle(ctx, canvasWidth, title, unit, color) {
  ctx.setFontSize(24);
  ctx.setTextAlign('left');
  
  // 标题
  ctx.setFillStyle(color);
  ctx.fillText(title + ' (' + unit + ')', 10, 20);
}

/**
 * 绘制图例（已废弃，改用标题）
 * @private
 */
function _drawLegend(ctx, canvasWidth, hasBodyFatData) {
  ctx.setFontSize(22);
  ctx.setTextAlign('left');
  
  // 体重图例
  ctx.setFillStyle(SCALE_CONFIG.COLORS.weightLine);
  ctx.fillRect(canvasWidth - 180, 10, 20, 4);
  ctx.fillText('体重(kg)', canvasWidth - 155, 16);
  
  // 体脂图例（如果有数据）
  if (hasBodyFatData) {
    ctx.setFillStyle(SCALE_CONFIG.COLORS.bodyFatLine);
    ctx.fillRect(canvasWidth - 180, 30, 20, 4);
    ctx.fillText('体脂率(%)', canvasWidth - 155, 36);
  }
}

/**
 * 绘制体重折线
 * @private
 */
function _drawWeightLine(ctx, history, padding, chartWidth, chartHeight, minWeight, weightRange) {
  ctx.setStrokeStyle(SCALE_CONFIG.COLORS.weightLine);
  ctx.setLineWidth(4);
  ctx.setLineJoin('round');
  
  ctx.beginPath();
  
  history.forEach((item, index) => {
    const x = padding.left + (chartWidth / (history.length - 1)) * index;
    const y = padding.top + chartHeight - ((item.weight - minWeight) / weightRange) * chartHeight;
    
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  
  ctx.stroke();
}

/**
 * 绘制体脂折线
 * @private
 */
function _drawBodyFatLine(ctx, history, padding, chartWidth, chartHeight, minBodyFat, bodyFatRange) {
  ctx.setStrokeStyle(SCALE_CONFIG.COLORS.bodyFatLine);
  ctx.setLineWidth(4);
  ctx.setLineJoin('round');
  
  ctx.beginPath();
  
  history.forEach((item, index) => {
    const x = padding.left + (chartWidth / (history.length - 1)) * index;
    const y = padding.top + chartHeight - ((item.bodyFat - minBodyFat) / bodyFatRange) * chartHeight;
    
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  
  ctx.stroke();
}

/**
 * 绘制数据点
 * @private
 */
function _drawDataPoints(ctx, history, padding, chartWidth, chartHeight, minValue, valueRange, canvasHeight, unit, field = 'weight') {
  history.forEach((item, index) => {
    const x = padding.left + (chartWidth / (history.length - 1)) * index;
    const y = padding.top + chartHeight - ((item[field] - minValue) / valueRange) * chartHeight;
    
    // 外圈
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, 2 * Math.PI);
    ctx.setFillStyle('#FFFFFF');
    ctx.fill();
    ctx.setStrokeStyle(field === 'weight' ? SCALE_CONFIG.COLORS.weightLine : SCALE_CONFIG.COLORS.bodyFatLine);
    ctx.setLineWidth(3);
    ctx.stroke();
    
    // X轴日期标签
    ctx.setFillStyle(SCALE_CONFIG.COLORS.dateLabel);
    ctx.setFontSize(18);
    ctx.setTextAlign('center');
    ctx.fillText(item.date, x, canvasHeight - SCALE_CONFIG.CHART_PADDING_BOTTOM + 25);
  });
}

/**
 * 绘制单个数据点
 * @private
 */
function _drawSinglePoint(ctx, item, padding, chartWidth, chartHeight, canvasHeight, unit, field = 'weight') {
  const x = padding.left + chartWidth / 2;
  const y = padding.top + chartHeight / 2;
  
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, 2 * Math.PI);
  ctx.setFillStyle(field === 'weight' ? SCALE_CONFIG.COLORS.weightLine : SCALE_CONFIG.COLORS.bodyFatLine);
  ctx.fill();
  
  ctx.setFillStyle(SCALE_CONFIG.COLORS.dateLabel);
  ctx.setFontSize(18);
  ctx.setTextAlign('center');
  ctx.fillText(item.date, x, canvasHeight - SCALE_CONFIG.CHART_PADDING_BOTTOM + 25);
}

module.exports = {
  drawWeightGauge,
  drawWeightChart,
  drawBodyFatChart
};
