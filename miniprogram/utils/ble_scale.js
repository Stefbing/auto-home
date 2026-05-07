/**
 * 小米体脂秤 BLE 广播数据解析器
 * 基于 openScale 逆向工程和小米官方协议
 */

// 控制字节标志位
const FLAGS = {
  STABILIZED: 0x20,
  HAS_IMPEDANCE: 0x02,
  IS_MEASURING: 0x04,
  WEIGHT_REMOVED: 0x80
};

/**
 * 主解析入口
 */
function parse(buffer, macAddress = '') {
  console.log('[BLE] 🔍 开始解析:', {
    bufferLength: buffer ? buffer.byteLength : 0,
    macAddress
  });
  
  if (!buffer || buffer.byteLength < 8) {
    console.log('[BLE] ⚠️ 数据长度不足:', buffer ? buffer.byteLength : 0);
    return null;
  }
  
  try {
    const data = new Uint8Array(buffer);
    const len = data.length;
    const timestamp = Date.now();
    let result = null;
    
    console.log('[BLE] 📦 原始字节:', Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' '));
    
    if (len === 8) {
      console.log('[BLE] 📄 使用 8字节格式 (Mi Scale 1)');
      result = parseShort(data, timestamp);
    } else if (len >= 13 && len < 16) {
      console.log('[BLE] 📄 使用 13字节格式 (Mi Body Scale 2)');
      result = parseFull(data, timestamp);
    } else if (len >= 16) {
      console.log('[BLE] 📄 使用 16字节扩展格式');
      result = parseExtended(data, timestamp);
    } else {
      console.log('[BLE] ⚠️ 未知数据长度:', len);
    }
    
    if (result) {
      result.macAddress = macAddress;
      result.receivedAt = timestamp;
      result.quality = calcQuality(result);
      console.log('[BLE] ✅ 解析成功:', result);
    } else {
      console.log('[BLE] ❌ 解析结果为 null');
    }
    return result;
  } catch (err) {
    console.error('[BLE] ❌ 解析异常:', err);
    return null;
  }
}

/**
 * 8字节格式（Mi Scale 1）
 */
function parseShort(data, ts) {
  const ctrl = data[0];
  const weightRaw = (data[1] << 8) | data[0];
  const isLbs = (ctrl & 0x01) !== 0;
  const isJin = (ctrl & 0x10) !== 0;
  const isStabilized = (ctrl & 0x20) !== 0;
  const weightRemoved = (ctrl & 0x80) !== 0;
  
  let scaleFactor = (isLbs || isJin) ? 100.0 : 200.0;
  let weight = weightRaw / scaleFactor;
  if (isLbs) weight *= 0.453592;
  else if (isJin) weight *= 0.5;
  
  if (weight <= 0.5 || weight > 220 || weightRemoved) return null;
  
  return {
    weight: Math.round(weight * 100) / 100,
    weightRaw, impedance: 0, impedanceRaw: 0,
    impedanceValid: false, isStabilized, isMeasuring: false,
    weightRemoved, hasImpedance: false, unit: 'kg', format: 'short'
  };
}

/**
 * 13字节格式（Mi Body Composition Scale 2）
 */
function parseFull(data, ts) {
  const ctrl = (data[1] << 8) | data[0];
  const isLbs = (ctrl & 0x0080) !== 0;
  const isJin = (ctrl & 0x0200) !== 0;
  const isStabilized = (ctrl & 0x0400) !== 0;
  const weightRemoved = (ctrl & 0x0100) !== 0;
  const hasImpedance = (ctrl & 0x4000) !== 0;
  const isMeasuring = (ctrl & 0x0800) !== 0;
  
  const weightRaw = (data[12] << 8) | data[11];
  let scaleFactor = (isLbs || isJin) ? 100.0 : 200.0;
  let weight = weightRaw / scaleFactor;
  if (isLbs) weight *= 0.453592;
  else if (isJin) weight *= 0.5;
  
  let impedance = 0, impedanceRaw = 0, impedanceValid = false;
  if (hasImpedance) {
    impedanceRaw = (data[10] << 8) | data[9];
    if (impedanceRaw > 0 && impedanceRaw < 65535) {
      impedance = impedanceRaw;
      impedanceValid = true;
    }
  }
  
  if (weight <= 0.5 || weight > 220 || weightRemoved) return null;
  
  return {
    weight: Math.round(weight * 100) / 100,
    weightRaw, impedance, impedanceRaw, impedanceValid,
    isStabilized, isMeasuring, weightRemoved, hasImpedance,
    unit: 'kg', format: 'full',
    dateTime: { year: (data[3] << 8) | data[2], month: data[4], day: data[5], hour: data[6], minute: data[7], second: data[8] },
    ctrlRaw: ctrl.toString(16).padStart(4, '0')
  };
}

/**
 * 16字节扩展格式
 */
function parseExtended(data, ts) {
  const base = parseFull(data.slice(0, 13), ts);
  if (!base) return null;
  return { ...base, format: 'extended', extended: { batteryLevel: data[13] || 0 } };
}

/**
 * 数据质量评分（0-100）
 */
function calcQuality(data) {
  let score = 100;
  if (data.weight < 20 || data.weight > 150) score -= 25;
  else if (data.weight < 30 || data.weight > 120) score -= 10;
  if (data.impedance > 0) {
    if (data.impedance < 100 || data.impedance > 1000) score -= 20;
    else if (data.impedance < 200 || data.impedance > 800) score -= 10;
  }
  if (!data.isStabilized) score -= 15;
  if (data.isMeasuring) score -= 10;
  if (data.weightRemoved) score = 0;
  return Math.max(0, score);
}

/**
 * 快速稳定检测
 */
function checkStability(history) {
  if (!history || history.length < 3) {
    return { isStable: false, confidence: 0, avgWeight: 0, stdDev: 0 };
  }
  const recent = history.slice(-3);
  const weights = recent.map(h => h.weight);
  const avgWeight = weights.reduce((a, b) => a + b, 0) / weights.length;
  const variance = weights.reduce((sum, w) => sum + Math.pow(w - avgWeight, 2), 0) / weights.length;
  const stdDev = Math.sqrt(variance);
  const maxDiff = Math.max(...weights) - Math.min(...weights);
  const isStable = maxDiff < 0.3 && recent[recent.length - 1].isStabilized;
  const confidence = isStable ? Math.min(100, Math.round(100 - stdDev * 200)) : Math.max(0, Math.round(100 - maxDiff * 50));
  return { isStable, confidence, avgWeight: Math.round(avgWeight * 100) / 100, stdDev: Math.round(stdDev * 1000) / 1000 };
}

/**
 * EWMA 平滑
 */
function smooth(current, previous, alpha = 0.6) {
  if (!previous || previous <= 0) return current;
  return Math.round((alpha * current + (1 - alpha) * previous) * 100) / 100;
}

/**
 * 体重趋势检测
 */
function detectTrend(history) {
  if (!history || history.length < 2) return 'stable';
  const recent = history.slice(-3);
  if (recent.length < 2) return 'stable';
  const diff = recent[recent.length - 1].weight - recent[0].weight;
  if (diff > 0.5) return 'rising';
  if (diff < -0.5) return 'falling';
  return 'stable';
}

module.exports = {
  parse,
  checkStability,
  smooth,
  detectTrend,
  FLAGS
};
