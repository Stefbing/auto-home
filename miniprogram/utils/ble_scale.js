/**
 * 解析小米体脂秤广播数据
 * 支持 13字节 (Service Data) 和 8字节 (Short/Manufacturer Data) 格式
 */
function parseScaleData(buffer) {
  if (!buffer || buffer.byteLength < 8) return null;

  try {
    const data = new Uint8Array(buffer);
    const len = data.length;

    // 根据长度分发解析逻辑
    if (len === 8) {
      return parseShortFormat(data);
    } else if (len >= 13) {
      return parseFullFormat(data);
    }

    return null;
  } catch (err) {
    console.error('[BLE Scale] 解析异常:', err);
    return null;
  }
}

/**
 * 解析 8 字节简化格式
 * 常见于 Mi Scale 1 或特定的广播段
 */
function parseShortFormat(data) {
  // 小端序获取体重原始值
  const weightRaw = data[0] | (data[1] << 8);
  const weight = parseFloat((weightRaw / 5.0).toFixed(2)); // 根据实测系数 5.0

  // 稳定标志 (Byte 0, Bit 5)
  const isStabilized = (data[0] & 0x20) !== 0;

  if (weight <= 0.1 || weight > 200) return null;

  const result = {
    weight,
    impedance: 0,
    isStabilized,
    unit: 'kg',
    format: '8-byte'
  };

  console.log(`[BLE Scale] 8字节数据: ${weight}kg, 稳定: ${isStabilized}`);
  return result;
}

/**
 * 解析 13 字节完整格式 (小米体脂秤 2 标准协议)
 */
function parseFullFormat(data) {
  const ctrl0 = data[0];
  const ctrl1 = data[1];

  // 1. 单位识别[cite: 7]
  const isLbs = (ctrl0 & 0x01) !== 0;
  const isJin = (ctrl0 & 0x10) !== 0;
  const isKg = !isLbs && !isJin;

  // 2. 状态识别[cite: 7]
  const isStabilized = (ctrl1 & 0x20) !== 0;
  const hasImpedance = (ctrl1 & 0x02) !== 0;

  // 3. 体重解析 (Byte 11 & 12)[cite: 7]
  const weightRaw = data[11] | (data[12] << 8);
  let weight = isKg ? weightRaw / 200.0 : weightRaw / 100.0;

  // 如果是斤，转换为 kg 统一存储[cite: 7]
  if (isJin) weight = weight * 0.5;
  weight = parseFloat(weight.toFixed(2));

  // 4. 阻抗解析 (Byte 9 & 10)[cite: 7]
  const impedance = hasImpedance ? (data[9] | (data[10] << 8)) : 0;

  if (weight <= 0.1) return null;

  const result = {
    weight,
    impedance,
    isStabilized,
    unit: 'kg', // 内部统一使用 kg
    format: '13-byte'
  };

  // 只输出关键业务数据
  console.log(`[BLE Scale] 13字节数据: ${weight}kg, 阻抗: ${impedance}, 稳定: ${isStabilized}`);
  return result;
}

module.exports = {
  parseScaleData
};
