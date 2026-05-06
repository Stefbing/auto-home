/**
 * 小米体脂秤 BLE 广播数据解析器（最终优化版）
 * 基于 openScale 逆向工程 [^14^] 和小米官方协议 [^15^]
 *
 * 关键修正：
 * - 体重缩放：kg 单位 /200，lbs/jin 单位 /100 [^14^][^15^]
 * - 控制字节位定义与官方对齐
 * - 增加数据质量评分和噪声过滤
 */

// 广播格式类型
const FORMAT = {
  SHORT: '8-byte',      // Mi Scale 1
  FULL: '13-byte',      // Mi Body Composition Scale 2 (MIBCS)
  EXTENDED: '16-byte'   // 扩展格式
};

// 控制字节标志位（与小米协议精确对齐）[^15^]
const FLAGS = {
  // 字节 0 (LSB)
  UNIT_LBS: 0x01,       // bit 0: 英制单位 (但实际控制位在 bit 7/8/9)
  UNIT_JIN: 0x10,       // bit 4: 市斤单位

  // 字节 1
  STABILIZED: 0x20,     // bit 5: 体重已稳定（LED 停止闪烁）
  HAS_IMPEDANCE: 0x02,  // bit 1: 包含有效阻抗数据
  IS_MEASURING: 0x04,   // bit 2: 正在测量中（光脚检测）
  WEIGHT_REMOVED: 0x80, // bit 7: 体重已移除（下秤）

  // 13字节格式控制字节位定义 [^15^]
  CTRL1_IS_STABILIZED: 0x20,
  CTRL1_HAS_IMPEDANCE: 0x02,
  CTRL1_IS_MEASURING: 0x04
};

/**
 * 主解析入口
 * @param {ArrayBuffer} buffer - BLE 广播原始数据
 * @param {string} macAddress - 设备 MAC
 * @returns {Object|null} 解析后的测量数据
 */
function parseScaleData(buffer, macAddress = '') {
  if (!buffer || buffer.byteLength < 8) return null;

  try {
    const data = new Uint8Array(buffer);
    const len = data.length;
    const timestamp = Date.now();

    let result = null;
    if (len === 8) {
      result = parseShortFormat(data, timestamp);
    } else if (len >= 13 && len < 16) {
      result = parseFullFormat(data, timestamp);
    } else if (len >= 16) {
      result = parseExtendedFormat(data, timestamp);
    }

    if (result) {
      result.macAddress = macAddress;
      result.receivedAt = timestamp;
      result.quality = calculateDataQuality(result);
    }

    return result;
  } catch (err) {
    console.error('[BLE Scale] 解析异常:', err);
    return null;
  }
}

/**
 * 8字节简化格式（Mi Scale 1）[^14^]
 * 控制字节 0：
 *   bit 0: lbs 单位
 *   bit 4: jin 单位
 *   bit 5: stabilized
 *   bit 7: weight removed
 */
function parseShortFormat(data, timestamp) {
  const ctrl0 = data[0];

  // 体重原始值（小端序，Byte 0-1）
  const weightRaw = (data[1] << 8) | data[0];

  // 单位判断
  const isLbs = (ctrl0 & 0x01) !== 0;
  const isJin = (ctrl0 & 0x10) !== 0;
  const isStabilized = (ctrl0 & 0x20) !== 0;
  const weightRemoved = (ctrl0 & 0x80) !== 0;

  // 体重缩放：lbs/jin 用 /100，kg 用 /200 [^14^]
  let scaleFactor = (isLbs || isJin) ? 100.0 : 200.0;
  let weight = weightRaw / scaleFactor;

  // 单位转换到 kg
  if (isLbs) {
    weight = weight * 0.453592;
  } else if (isJin) {
    weight = weight * 0.5;  // 斤 → kg
  }

  // 过滤异常值
  if (weight <= 0.5 || weight > 220 || weightRemoved) {
    return null;
  }

  return {
    weight: round(weight, 2),
    weightRaw,
    impedance: 0,
    impedanceRaw: 0,
    impedanceValid: false,
    isStabilized,
    isMeasuring: false,
    weightRemoved,
    hasImpedance: false,
    unit: 'kg',
    format: FORMAT.SHORT,
    source: 'short'
  };
}

/**
 * 13字节完整格式（Mi Body Composition Scale 2）[^15^]
 *
 * Payload 格式（小端序）：
 * bytes 0-1: 控制字节
 * bytes 2-3: 年份
 * byte 4: 月份
 * byte 5: 日期
 * byte 6: 小时
 * byte 7: 分钟
 * byte 8: 秒
 * bytes 9-10: 阻抗
 * bytes 11-12: 体重
 *
 * 控制字节位定义（LSB first）：
 * bit 7: is pounds
 * bit 8: is empty load (no weight)
 * bit 9: is catty (jin)
 * bit 10: is stabilized
 * bit 14: have impedance
 */
function parseFullFormat(data, timestamp) {
  const ctrl0 = data[0];
  const ctrl1 = data[1];

  // 组合控制字节（16位，小端序）
  const ctrl = (ctrl1 << 8) | ctrl0;

  // 单位判断（位定义与官方对齐）[^15^]
  const isLbs = (ctrl & 0x0080) !== 0;      // bit 7
  const isJin = (ctrl & 0x0200) !== 0;      // bit 9
  const isStabilized = (ctrl & 0x0400) !== 0; // bit 10
  const weightRemoved = (ctrl & 0x0100) !== 0;  // bit 8
  const hasImpedance = (ctrl & 0x4000) !== 0;   // bit 14
  const isMeasuring = (ctrl & 0x0800) !== 0;    // bit 11 (推测)

  console.log('[BLE Scale] 📦 原始数据:', Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' '));
  console.log('[BLE Scale] 🔧 控制字节:', ctrl.toString(16).padStart(4, '0'), {
    isLbs, isJin, isStabilized, weightRemoved, hasImpedance, isMeasuring
  });

  // 体重解析（Byte 11 & 12，小端序）
  const weightRaw = (data[12] << 8) | data[11];
  console.log('[BLE Scale] ⚖️ 体重原始值:', weightRaw, 'bytes:', data[11], data[12]);

  // 体重缩放：kg 用 /200，lbs/jin 用 /100 [^14^][^15^]
  let scaleFactor = (isLbs || isJin) ? 100.0 : 200.0;
  let weight = weightRaw / scaleFactor;

  // 单位转换到 kg
  if (isLbs) {
    weight = weight * 0.453592;
  } else if (isJin) {
    weight = weight * 0.5;
  }

  // 阻抗解析（Byte 9 & 10）
  let impedance = 0;
  let impedanceRaw = 0;
  let impedanceValid = false;

  if (hasImpedance) {
    impedanceRaw = (data[10] << 8) | data[9];
    // 0xFFFF 表示无效或测量中
    if (impedanceRaw > 0 && impedanceRaw < 65535) {
      impedance = impedanceRaw;
      impedanceValid = true;
    }
  }

  // 日期时间解析（可选）
  const year = (data[3] << 8) | data[2];
  const month = data[4];
  const day = data[5];
  const hour = data[6];
  const minute = data[7];
  const second = data[8];

  // 过滤异常值
  if (weight <= 0.5 || weight > 220 || weightRemoved) {
    return null;
  }

  return {
    weight: round(weight, 2),
    weightRaw,
    impedance,
    impedanceRaw,
    impedanceValid,
    isStabilized,
    isMeasuring,
    weightRemoved,
    hasImpedance,
    unit: 'kg',
    format: FORMAT.FULL,
    source: 'full',
    dateTime: { year, month, day, hour, minute, second },
    ctrlRaw: ctrl.toString(16).padStart(4, '0')
  };
}

/**
 * 16字节扩展格式
 */
function parseExtendedFormat(data, timestamp) {
  const base = parseFullFormat(data.slice(0, 13), timestamp);
  if (!base) return null;

  return {
    ...base,
    format: FORMAT.EXTENDED,
    source: 'extended',
    extended: {
      batteryLevel: data[13] || 0,
      reserved: data[14] || 0,
      checksum: data[15] || 0
    }
  };
}

/**
 * 数据质量评分（0-100）
 * 基于 InBody 研究的标准化协议 [^5^][^7^]
 */
function calculateDataQuality(data) {
  let score = 100;

  // 体重范围合理性（成人正常 30-150kg）
  if (data.weight < 20 || data.weight > 150) score -= 25;
  else if (data.weight < 30 || data.weight > 120) score -= 10;

  // 阻抗合理性（成人正常 200-800Ω，基于 BIA 研究 [^5^]）
  if (data.impedance > 0) {
    if (data.impedance < 100 || data.impedance > 1000) score -= 20;
    else if (data.impedance < 200 || data.impedance > 800) score -= 10;
  }

  // 稳定状态加分
  if (!data.isStabilized) score -= 15;

  // 测量中状态扣分（数据可能不完整）
  if (data.isMeasuring) score -= 10;

  // 下秤状态直接归零
  if (data.weightRemoved) score = 0;

  return Math.max(0, score);
}

/**
 * 快速稳定检测算法
 * 优化：连续 3 次差异 < 0.3kg 即视为稳定
 * @param {Array} history - 最近体重记录 [{weight, timestamp, isStabilized}]
 * @returns {Object} { isStable, confidence, avgWeight, stdDev }
 */
function fastStabilityCheck(history) {
  if (!history || history.length < 3) {
    return { isStable: false, confidence: 0, avgWeight: 0, stdDev: 0 };
  }

  const recent = history.slice(-3);
  const weights = recent.map(h => h.weight);
  const avgWeight = weights.reduce((a, b) => a + b, 0) / weights.length;

  // 计算标准差
  const variance = weights.reduce((sum, w) => sum + Math.pow(w - avgWeight, 2), 0) / weights.length;
  const stdDev = Math.sqrt(variance);

  // 最大差异
  const maxDiff = Math.max(...weights) - Math.min(...weights);

  // 快速稳定条件：最大差异 < 0.3kg 且最新数据标记稳定
  const isStable = maxDiff < 0.3 && recent[recent.length - 1].isStabilized;

  // 置信度：基于标准差（越小越稳定）
  const confidence = isStable
      ? Math.min(100, Math.round(100 - stdDev * 200))
      : Math.max(0, Math.round(100 - maxDiff * 50));

  return {
    isStable,
    confidence,
    avgWeight: round(avgWeight, 2),
    stdDev: round(stdDev, 3)
  };
}

/**
 * 指数加权移动平均（EWMA）平滑
 * 比简单平均更适合处理蓝牙广播的随机抖动
 */
function smoothWeight(current, previous, alpha = 0.6) {
  if (!previous || previous <= 0) return current;
  // EWMA: S_t = α * Y_t + (1-α) * S_{t-1}
  return round(alpha * current + (1 - alpha) * previous, 2);
}

/**
 * 检测体重趋势（上升/下降/稳定）
 * 用于判断用户是否正在上秤或下秤
 */
function detectWeightTrend(history) {
  if (!history || history.length < 2) return 'stable';

  const recent = history.slice(-3);
  if (recent.length < 2) return 'stable';

  const first = recent[0].weight;
  const last = recent[recent.length - 1].weight;
  const diff = last - first;

  if (diff > 0.5) return 'rising';      // 正在上秤
  if (diff < -0.5) return 'falling';    // 正在下秤
  return 'stable';
}

// 工具函数
function round(num, decimals) {
  return parseFloat(num.toFixed(decimals));
}

module.exports = {
  parseScaleData,
  fastStabilityCheck,
  smoothWeight,
  detectWeightTrend,
  FORMAT,
  FLAGS
};
