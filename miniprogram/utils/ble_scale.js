// utils/ble_scale.js

/**
 * 解析小米体脂秤2 (Mi Body Composition Scale 2) 的广播数据
 * 
 * 支持两种数据格式：
 * 1. 完整格式 (13字节): Service Data, UUID: 0x181D
 * 2. 简化格式 (8字节): Manufacturer Data
 * 
 * @param {ArrayBuffer} buffer - 蓝牙广播数据 (advertisData)
 * @returns {Object|null} 解析结果 {weight, impedance, isStabilized, unit}
 */
function parseScaleData(buffer) {
  try {
    const data = new Uint8Array(buffer);
    
    console.log('[BLE] 收到数据长度:', data.length);
    console.log('[BLE] 原始数据:', Array.from(data));
    
    // 最小长度校验
    if (data.length < 8) {
      console.log('[BLE] 数据长度不足:', data.length);
      return null;
    }
    
    // 尝试解析8字节的简化格式（MIBFS广播）
    if (data.length === 8) {
      return parseShortFormat(data);
    }
    
    // 尝试解析13字节的完整格式
    if (data.length >= 13) {
      return parseFullFormat(data);
    }
    
    console.log('[BLE] 不支持的数据长度:', data.length);
    return null;
    
  } catch (err) {
    console.error('[BLE] 解析失败:', err);
    return null;
  }
}

/**
 * 解析8字节简化格式
 * 数据示例: [87, 1, 12, 149, 65, 175, 101, 159]
 * 
 * 根据实际测试数据分析：
 * - 原始值 343 对应实际体重 68.75kg
 * - 系数约为 5 (343 / 68.75 ≈ 4.99)
 */
function parseShortFormat(data) {
  console.log('[BLE] 尝试解析8字节格式');
  
  // 提取前2字节作为体重原始值 (Little Endian)
  const weightRaw = data[0] | (data[1] << 8);
  
  console.log('[BLE] 体重原始值:', weightRaw);
  console.log('[BLE] 字节0:', data[0], '(二进制:', data[0].toString(2).padStart(8, '0') + ')');
  console.log('[BLE] 字节1:', data[1], '(二进制:', data[1].toString(2).padStart(8, '0') + ')');
  
  // 根据实测数据：343 -> 68.75kg
  // 系数 = 343 / 68.75 = 4.989 ≈ 5
  // 所以公式：weight = weightRaw / 5.0
  
  let weight = weightRaw / 5.0;
  let unit = 'kg';
  
  // 判断稳定标志（从字节0的Bit 5）
  const isStabilized = (data[0] & 0x20) !== 0;
  
  console.log('[BLE] 计算体重:', weight.toFixed(2), unit);
  console.log('[BLE] 稳定标志:', isStabilized);
  
  // 合理性校验
  if (weight <= 0 || weight > 300) {
    console.log('[BLE] ⚠️ 体重超出合理范围:', weight);
    return null;
  }
  
  const result = {
    weight: parseFloat(weight.toFixed(2)),
    impedance: 0, // 8字节格式不包含阻抗数据
    isStabilized: isStabilized,
    unit: unit,
    format: '8-byte'
  };
  
  console.log('[BLE] ✅ 8字节格式解析成功:', JSON.stringify(result));
  return result;
}

/**
 * 解析13字节完整格式
 */
function parseFullFormat(data) {
  console.log('[BLE] 尝试解析13字节完整格式');
  
  // 提取控制位
  const ctrlByte0 = data[0];
  const ctrlByte1 = data[1];
  
  // 判断单位
  const isJin = (ctrlByte0 & 0x01) !== 0;      // 斤模式
  const isPound = (ctrlByte0 & 0x10) !== 0;     // 磅模式
  const isStabilized = (ctrlByte1 & 0x20) !== 0; // 稳定标志
  
  // 提取时间戳（用于验证数据有效性）
  const year = data[2] | (data[3] << 8);
  const month = data[4];
  const day = data[5];
  
  // 简单验证：年份应该在合理范围内
  if (year < 2020 || year > 2030) {
    console.log('[BLE] 年份异常:', year);
    return null;
  }
  
  // 提取阻抗 (Byte 9-10, Little Endian)
  const impedance = data[9] | (data[10] << 8);
  
  // 提取体重 (Byte 11-12, Little Endian)
  let weightRaw = data[11] | (data[12] << 8);
  
  // 单位转换
  let weight = 0;
  let unit = 'kg';
  
  if (isJin) {
    // 斤模式: raw / 100 = 斤, 再转换为公斤
    weight = (weightRaw / 100.0) * 0.5;
    unit = 'jin';
  } else if (isPound) {
    // 磅模式: raw / 100 = 磅, 再转换为公斤
    weight = (weightRaw / 100.0) * 0.453592;
    unit = 'lb';
  } else {
    // 公斤模式: raw / 200 = 公斤 (精度0.005kg)
    weight = weightRaw / 200.0;
    unit = 'kg';
  }
  
  // 合理性校验
  if (weight <= 0 || weight > 300) {
    console.log('[BLE] 体重异常:', weight);
    return null;
  }
  
  // 阻抗合理性校验（0表示未测量或无效）
  const validImpedance = impedance > 0 && impedance < 3000;
  
  const result = {
    weight: parseFloat(weight.toFixed(2)),
    impedance: validImpedance ? impedance : 0,
    isStabilized: isStabilized,
    unit: unit,
    timestamp: new Date(year, month - 1, day, data[6], data[7], data[8]).getTime()
  };
  
  console.log('[BLE] 解析成功:', JSON.stringify(result));
  return result;
}

module.exports = {
  parseScaleData
};
