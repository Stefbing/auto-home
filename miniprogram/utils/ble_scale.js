// utils/ble_scale.js

/**
 * 解析小米体脂秤2的广播数据
 * 参考开源实现逻辑
 * @param {ArrayBuffer} buffer - 蓝牙广播数据
 */
function parseScaleData(buffer) {
  const data = new Uint8Array(buffer);
  
  // 简单校验（实际协议可能更复杂，这里仅作体重解析示例）
  // 假设 Service Data 符合小米协议
  // 字节序通常是 Little Endian
  
  // 提取控制位 (Byte 0 & 1)
  const ctrlByte0 = data[0];
  const ctrlByte1 = data[1];
  
  const isStabilized = (ctrlByte1 & 0x20) !== 0; // 是否稳定
  const isLbs = (ctrlByte0 & 0x01) !== 0; // 是否为磅
  const isCatty = (ctrlByte0 & 0x10) !== 0; // 是否为斤
  
  // 提取体重 (Byte 11-12 for Misc Scale or depending on version)
  // 注意：不同版本的小米秤数据格式不同。
  // Mi Scale 2 (Body Composition) 格式通常如下：
  // Byte 0-1: Control
  // Byte 2-3: Year
  // Byte 4: Month
  // Byte 5: Day
  // Byte 6: Hour
  // Byte 7: Min
  // Byte 8: Sec
  // Byte 9-10: Impedance (阻抗)
  // Byte 11-12: Weight (体重) * 200 or similar scaling
  
  // 这里假设是 Mi Body Composition Scale 2 的格式
  // 体重在 11-12 字节 (Little Endian)
  if (data.length < 13) return null;
  
  let weight = (data[12] << 8) | data[11];
  
  // 单位转换
  if (isCatty) {
    // 斤转公斤
    weight = weight / 200.0; // 假设 raw unit is 0.01 jin
    weight = weight * 0.5; 
  } else if (isLbs) {
    // 磅转公斤
    weight = weight * 0.005; // 假设 raw
    weight = weight * 0.453592;
  } else {
    // 公斤 (Raw / 200)
    weight = weight / 200.0;
  }
  
  // 阻抗
  let impedance = (data[10] << 8) | data[9];
  
  return {
    weight: parseFloat(weight.toFixed(2)),
    impedance: impedance,
    isStabilized: isStabilized
  };
}

module.exports = {
  parseScaleData
};
