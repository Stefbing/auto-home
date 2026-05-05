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
 * 解析 8 字节简化格式 (常见于 Mi Scale 1)
 */
function parseShortFormat(data) {
  // 小端序获取体重原始值
  const weightRaw = (data[1] << 8) | data[0];
  // Mi Scale 1 默认单位通常由字节 0 的 Bit 0 控制，这里统一转换为 kg
  const isLbs = (data[0] & 0x01) !== 0;
  const isJin = (data[0] & 0x10) !== 0;

  let weight = weightRaw / 200.0; // 默认缩放
  if (isLbs) weight = weight * 0.453592;
  if (isJin) weight = weight * 0.5;

  const isStabilized = (data[0] & 0x20) !== 0;

  if (weight <= 0.1 || weight > 220) return null;

  return {
    weight: parseFloat(weight.toFixed(2)),
    impedance: 0,
    isStabilized,
    unit: 'kg',
    format: '8-byte'
  };
}

/**
 * 解析 13 字节完整格式 (小米体脂秤 2 标准协议)[cite: 7]
 */
function parseFullFormat(data) {
  const ctrl0 = data[0];
  const ctrl1 = data[1];

  // 1. 单位识别[cite: 7]
  const isLbs = (ctrl0 & 0x01) !== 0;
  const isJin = (ctrl0 & 0x10) !== 0;

  // 2. 状态识别[cite: 7]
  const isStabilized = (ctrl1 & 0x20) !== 0;
  const hasImpedance = (ctrl1 & 0x02) !== 0;
  const isMeasuring = (ctrl1 & 0x04) !== 0; // 正在测量中标志

  // 3. 体重解析 (Byte 11 & 12)[cite: 7]
  const weightRaw = (data[12] << 8) | data[11];
  let weight = weightRaw / 200.0;

  if (isLbs) {
    weight = weightRaw / 100.0 * 0.453592; // LBS 换算
  } else if (isJin) {
    weight = (weightRaw / 100.0) * 0.5;    // 斤换算[cite: 7]
  }

  // 4. 阻抗解析 (Byte 9 & 10)[cite: 7]
  let impedance = 0;
  if (hasImpedance) {
    const impRaw = (data[10] << 8) | data[9];
    // 阻抗为 0xFFFF 表示无效或正在测量[cite: 7]
    impedance = (impRaw > 0 && impRaw < 65535) ? impRaw : 0;
  }

  if (weight <= 0.1) return null;

  return {
    weight: parseFloat(weight.toFixed(2)),
    impedance,
    isStabilized,
    isMeasuring,
    unit: 'kg',
    format: '13-byte'
  };
}

module.exports = {
  parseScaleData
};
