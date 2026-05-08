/**
 * 小米体脂秤 BLE 广播数据解析器
 * 基于 openScale 和 ble-in-xiaomi 逆向工程
 *
 * Mi Body Composition Scale 2 (XMTZC05HM) 协议:
 * - 13字节 Payload (不含4字节UUID 0xFE95)
 * - 控制字节16位，小端序 (LSB first)
 * - 体重/阻抗均为小端序
 */

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

    if (len >= 13 && len <= 14) {
      console.log('[BLE] 📄 使用 13字节格式 (Mi Body Composition Scale 2)');
      result = parseFull(data);
    } else {
      // 忽略非13字节的数据包（可能是干扰信号或其他设备）
      console.log('[BLE] ⚠️ 忽略非标准数据包，长度:', len);
      return null;
    }

    if (result) {
      result.receivedAt = timestamp;
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
 * 控制字节 (data[0]):
 * - bit 0: lbs unit
 * - bit 4: jin unit
 * - bit 5: stabilized
 * - bit 7: weight removed
 */
function parseShort(data) {
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
    isStabilized,
    impedance: 0,
    impedanceValid: false,
    deviceTimestamp: null
  };
}

/**
 * 彻底修正后的 13字节解析 (针对小米体脂秤 2)
 */
function parseFull(data) {
  // 1. 提取控制字节 (小端序)
  const ctrl = (data[1] << 8) | data[0]; // 例如: 0xa602

  /**
   * 2. 正确的位掩码定义 (小米 2 代官方协议逆向)
   * Bit 0: 英镑 (LBS)
   * Bit 1: 斤 (Jin)
   * Bit 7: 下秤 (Weight Removed)
   * Bit 9: 阻抗有效 (Impedance Valid) - 极其重要！
   * Bit 10: 体重稳定 (Stabilized)
   * Bit 13: 测量完成 (Readied)
   */
  const isLbs = (ctrl & 0x0001) !== 0;
  const isJin = (ctrl & 0x0002) !== 0;
  const hasImpedance = (ctrl & 0x0200) !== 0; // 必须是 0x0200
  const isStabilized = (ctrl & 0x2000) !== 0 || (ctrl & 0x0400) !== 0;
  const weightRemoved = (ctrl & 0x0080) !== 0;

  // 3. 解析体重 (Index 11, 12)
  const weightRaw = (data[12] << 8) | data[11];
  // 小米协议：Raw 数据除以 200 始终等于 KG（无论秤上显示什么单位）
  const weightKg = weightRaw / 200.0;

  // 4. 解析阻抗 (Index 9, 10)
  let impedance = 0;
  let impedanceValid = false;
  if (hasImpedance) {
    // 阻抗在第 9, 10 字节
    const impedanceRaw = (data[10] << 8) | data[9];
    if (impedanceRaw > 0 && impedanceRaw < 3000) {
      impedance = impedanceRaw;
      impedanceValid = true;
    }
  }

  // 过滤掉下秤或无效的小体重
  if (weightKg <= 1.0 || weightRemoved) return null;

  // 5. 解析设备时间（UTC时间）
  const year = (data[3] << 8) | data[2];
  const month = data[4];
  const day = data[5];
  const hour = data[6];
  const minute = data[7];
  const second = data[8];
  
  // 使用 Date.UTC 生成 UTC 时间戳
  const deviceTimestamp = Date.UTC(year, month - 1, day, hour, minute, second);

  return {
    weight: Math.round(weightKg * 100) / 100, // 统一输出 KG
    impedance,
    impedanceValid,
    isStabilized,
    unit: isLbs ? 'lbs' : (isJin ? 'jin' : 'kg'),
    deviceTimestamp: isNaN(deviceTimestamp) ? null : deviceTimestamp
  };
}

module.exports = {
  parse
};
