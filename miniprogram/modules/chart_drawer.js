/**
 * 绘图模块 - draw_utils.js
 */
const { SCALE_CONFIG } = require('../config/scale_constants.js');

// 颜值升级必备的主题色
const THEME = {
  primary: '#4F46E5',    // 靛蓝
  secondary: '#10B981',  // 薄荷绿
  grid: '#F1F5F9',       // 浅灰网格
  textMain: '#1E293B',
  textSub: '#94A3B8',
  bgWeight: 'rgba(79, 70, 229, 0.1)'
};

/**
 * 绘制合并趋势图
 */
function drawCombinedChart(ctx, history, canvasId) {
  if (!history || history.length === 0) return;

  const canvasWidth = SCALE_CONFIG.CHART_CANVAS_WIDTH || 750;
  const canvasHeight = SCALE_CONFIG.CHART_CANVAS_HEIGHT || 400;
  const padding = { top: 60, right: 80, bottom: 60, left: 80 };
  const chartWidth = canvasWidth - padding.left - padding.right;
  const chartHeight = canvasHeight - padding.top - padding.bottom;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // --- 数据预处理 ---
  const weights = history.map(h => h.weight);
  let minW = Math.min(...weights) - 2;
  let maxW = Math.max(...weights) + 2;
  const bodyFatHistory = history.filter(h => h.body_fat > 0);
  const hasFat = bodyFatHistory.length > 0;
  let minF = 0, maxF = 0;
  if (hasFat) {
    const fats = bodyFatHistory.map(h => h.body_fat);
    minF = Math.min(...fats) - 3;
    maxF = Math.max(...fats) + 3;
  }

  // 1. 画网格和坐标轴
  _drawElegantGrid(ctx, padding, chartWidth, chartHeight, canvasWidth, maxW, minW, maxF, minF, hasFat);

  // 2. 画体重渐变面积图
  if (history.length >= 2) {
    _drawAreaLine(ctx, history, padding, chartWidth, chartHeight, minW, maxW - minW, THEME.primary, THEME.bgWeight, 'weight');
  }

  // 3. 画体脂虚线
  if (hasFat && bodyFatHistory.length >= 2) {
    _drawAreaLine(ctx, bodyFatHistory, padding, chartWidth, chartHeight, minF, maxF - minF, THEME.secondary, null, 'body_fat', true);
  }

  // 4. 画数据点和日期
  _drawSmartPoints(ctx, history, padding, chartWidth, chartHeight, minW, maxW - minW, canvasHeight, THEME.primary, 'weight');

  ctx.draw();
}

/**
 * 绘制仪表盘
 */
function drawWeightGauge(ctx, weight, isStabilized, options = {}) {
  const sysInfo = wx.getSystemInfoSync();
  const rpxRatio = sysInfo.windowWidth / 750;
  const canvasWidth = options.width || (sysInfo.windowWidth - 64 * rpxRatio);
  const canvasHeight = 440 * rpxRatio;
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;
  const radius = 150 * rpxRatio;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // 底圆
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0.75 * Math.PI, 2.25 * Math.PI);
  ctx.setStrokeStyle('#F1F5F9');
  ctx.setLineWidth(24 * rpxRatio);
  ctx.setLineCap('round');
  ctx.stroke();

  // 进度圆
  const progress = Math.min(weight / (SCALE_CONFIG.GAUGE_MAX_WEIGHT || 150), 1);
  const endAngle = 0.75 * Math.PI + (progress * 1.5 * Math.PI);

  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0.75 * Math.PI, endAngle);
  ctx.setStrokeStyle(isStabilized ? THEME.primary : '#CBD5E1');
  ctx.setLineWidth(24 * rpxRatio);
  ctx.setLineCap('round');
  ctx.stroke();

  // 文字
  ctx.setTextAlign('center');
  ctx.setFillStyle(THEME.textMain);
  ctx.setFontSize(100 * rpxRatio);
  ctx.fillText(weight.toFixed(1), centerX, centerY);

  ctx.draw();
}

/** 辅助函数 - 内部使用 (不需要导出) **/
function _drawElegantGrid(ctx, padding, chartWidth, chartHeight, canvasWidth, maxW, minW, maxF, minF, hasFat) {
  const lines = 4;
  ctx.setLineWidth(1);
  ctx.setStrokeStyle(THEME.grid);
  for (let i = 0; i <= lines; i++) {
    const y = padding.top + (chartHeight / lines) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(canvasWidth - padding.right, y);
    ctx.stroke();
  }
}

function _drawAreaLine(ctx, data, padding, width, height, minV, range, color, bgColor, field, isDashed = false) {
  const points = data.map((item, i) => ({
    x: padding.left + (width / (data.length - 1)) * i,
    y: padding.top + height - ((item[field] - minV) / range) * height
  }));
  
  ctx.beginPath();
  ctx.setStrokeStyle(color);
  ctx.setLineWidth(4);
  
  // 如果是虚线，设置虚线样式
  if (isDashed) {
    ctx.setLineDash([8, 4]);
  }
  
  points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.stroke();
  
  // 重置为实线
  if (isDashed) {
    ctx.setLineDash([]);
  }
}

function _drawSmartPoints(ctx, data, padding, width, height, minV, range, canvasHeight, color, field) {
  data.forEach((item, i) => {
    const x = padding.left + (width / (data.length - 1)) * i;
    const y = padding.top + height - ((item[field] - minV) / range) * height;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.setFillStyle(color);
    ctx.fill();
  });
}

// ==========================================
// 重要：确保这部分导出语句完整！
// ==========================================
module.exports = {
  drawWeightGauge: drawWeightGauge,
  drawCombinedChart: drawCombinedChart,
  // 如果你还需要体脂图函数，确保它也被定义并导出
  drawBodyFatChart: function() { console.warn("未实现体脂单独图表"); }
};
