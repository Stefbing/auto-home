/**
 * 体脂计算模块
 * 基于体重、阻抗、用户信息计算8个健康指标
 */

const { SCALE_CONFIG } = require('../config/scale_constants.js');

/**
 * 计算BMI
 * @param {number} weight - 体重(kg)
 * @param {number} height - 身高(cm)
 * @returns {number|null} BMI值
 */
function calculateBMI(weight, height) {
  if (!weight || !height || weight <= 0 || height <= 0) {
    return null;
  }
  const heightInMeters = height / 100;
  return parseFloat((weight / (heightInMeters * heightInMeters)).toFixed(1));
}

/**
 * 计算体脂率
 * @param {Object} params - 计算参数
 * @param {number} params.weight - 体重(kg)
 * @param {number} params.impedance - 阻抗(Ω)
 * @param {number} params.age - 年龄
 * @param {string} params.gender - 性别(male/female)
 * @param {number} params.height - 身高(cm)
 * @param {number} params.bmi - BMI值
 * @returns {number} 体脂率(%)
 */
function calculateBodyFat({ weight, impedance, age, gender, height, bmi }) {
  let bodyFat = 0;
  const sex = gender === 'male' ? 1 : 0;
  
  if (impedance > 0 && height > 0) {
    // 有阻抗数据时使用更精确的公式
    // Deurenberg-Piersma 公式变体
    bodyFat = (1.20 * bmi) + (0.23 * age) - (10.8 * sex) - 5.4;
    
    // 阻抗修正（基于生物电阻抗分析 BIA）
    const impedanceIndex = (height * height) / impedance;
    const impedanceCorrection = impedanceIndex * 0.001;
    bodyFat += impedanceCorrection;
  } else {
    // 无阻抗数据时使用简化公式
    bodyFat = (1.20 * bmi) + (0.23 * age) - (10.8 * sex) - 5.4;
    // 微调系数（使结果更接近真实值）
    bodyFat += 1.0;
  }
  
  // 限制在合理范围内
  return Math.max(SCALE_CONFIG.BODY_FAT_MIN, Math.min(SCALE_CONFIG.BODY_FAT_MAX, bodyFat));
}

/**
 * 计算水分率
 * @param {number} bodyFat - 体脂率(%)
 * @param {string} gender - 性别(male/female)
 * @returns {number} 水分率(%)
 */
function calculateWater(bodyFat, gender) {
  let water;
  
  if (gender === 'male') {
    // 男性: 基准值与体脂率负相关
    water = 68 - (bodyFat - 10) * 0.7;
  } else {
    // 女性: 基准值略低
    water = 63 - (bodyFat - 15) * 0.7;
  }
  
  return Math.max(SCALE_CONFIG.WATER_MIN, Math.min(SCALE_CONFIG.WATER_MAX, water));
}

/**
 * 计算肌肉量
 * @param {number} weight - 体重(kg)
 * @param {number} bodyFat - 体脂率(%)
 * @returns {number} 肌肉量(kg)
 */
function calculateMuscleMass(weight, bodyFat) {
  const boneMassRatio = SCALE_CONFIG.BONE_MASS_RATIO;
  return weight * (1 - bodyFat / 100 - boneMassRatio);
}

/**
 * 计算蛋白质率
 * @param {number} bodyFat - 体脂率(%)
 * @param {string} gender - 性别(male/female)
 * @returns {number} 蛋白质率(%)
 */
function calculateProtein(bodyFat, gender) {
  let protein;
  
  if (gender === 'male') {
    // 男性: 基准22%，随体脂增加而减少
    protein = 22 - (bodyFat - 15) * 0.3;
  } else {
    // 女性: 基准20%
    protein = 20 - (bodyFat - 20) * 0.3;
  }
  
  return Math.max(SCALE_CONFIG.PROTEIN_MIN, Math.min(SCALE_CONFIG.PROTEIN_MAX, protein));
}

/**
 * 计算基础代谢(BMR)
 * @param {Object} params - 计算参数
 * @param {number} params.weight - 体重(kg)
 * @param {number} params.height - 身高(cm)
 * @param {number} params.age - 年龄
 * @param {string} params.gender - 性别(male/female)
 * @returns {number} 基础代谢(kcal)
 */
function calculateBMR({ weight, height, age, gender }) {
  let bmr;
  
  if (gender === 'male') {
    // Mifflin-St Jeor 公式
    bmr = 10 * weight + 6.25 * height - 5 * age + 5;
    // 根据实测数据校准：减去约80千卡
    bmr -= 80;
  } else {
    bmr = 10 * weight + 6.25 * height - 5 * age - 161;
    // 女性也需要适当调整
    bmr -= 60;
  }
  
  return Math.round(bmr);
}

/**
 * 计算骨重
 * @param {number} weight - 体重(kg)
 * @returns {number} 骨重(kg)
 */
function calculateBoneMass(weight) {
  return weight * SCALE_CONFIG.BONE_MASS_RATIO;
}

/**
 * 计算内脏脂肪等级
 * @param {Object} params - 计算参数
 * @param {number} params.bmi - BMI值
 * @param {number} params.age - 年龄
 * @param {string} params.gender - 性别(male/female)
 * @returns {number} 内脏脂肪等级
 */
function calculateVisceralFat({ bmi, age, gender }) {
  let visceralFat;
  
  if (gender === 'male') {
    // 男性: 基于BMI和年龄的综合评估
    visceralFat = (bmi - 20) * 2.5 + (age - 25) * 0.3;
  } else {
    // 女性: 基准值略低
    visceralFat = (bmi - 19) * 2.5 + (age - 25) * 0.3;
  }
  
  return Math.max(
    SCALE_CONFIG.VISCERAL_FAT_MIN, 
    Math.min(SCALE_CONFIG.VISCERAL_FAT_MAX, Math.round(visceralFat * 10) / 10)
  );
}

/**
 * 生成健康建议
 * @param {number} bmi - BMI值
 * @returns {string} 健康建议文本
 */
function generateHealthAdvice(bmi) {
  if (!bmi) return null;
  
  if (bmi < 18.5) {
    return '您的体重偏轻，建议增加营养摄入，适当进行力量训练。';
  } else if (bmi >= 18.5 && bmi < 24) {
    return '您的体重正常，请继续保持健康的生活方式！';
  } else if (bmi >= 24 && bmi < 28) {
    return '您的体重偏重，建议控制饮食，增加有氧运动。';
  } else {
    return '您的体重过重，建议咨询专业医生或营养师制定减重计划。';
  }
}

/**
 * 完整计算所有体脂指标
 * @param {Object} data - 输入数据
 * @param {number} data.weight - 体重(kg)
 * @param {number} data.impedance - 阻抗(Ω)
 * @param {Object} data.member - 成员信息
 * @param {number} data.member.age - 年龄
 * @param {number} data.member.height - 身高(cm)
 * @param {string} data.member.gender - 性别(male/female)
 * @returns {Object|null} 计算结果或null（数据不完整）
 */
function calculateAllMetrics(data) {
  const { weight, impedance, member } = data;
  
  if (!member || !weight || weight <= 0) {
    return null;
  }
  
  const { age, gender, height } = member;
  
  // 验证必填字段
  const missingFields = [];
  if (!age || age <= 0) missingFields.push('年龄');
  if (!height || height <= 0) missingFields.push('身高');
  if (!gender) missingFields.push('性别');
  
  if (missingFields.length > 0) {
    return {
      error: 'MISSING_FIELDS',
      missingFields,
      message: `请先完善${member.name}的${missingFields.join('、')}信息`
    };
  }
  
  // 逐步计算各项指标
  const bmi = calculateBMI(weight, height);
  const bodyFat = calculateBodyFat({ weight, impedance, age, gender, height, bmi });
  const water = calculateWater(bodyFat, gender);
  const muscleMass = calculateMuscleMass(weight, bodyFat);
  const protein = calculateProtein(bodyFat, gender);
  const bmr = calculateBMR({ weight, height, age, gender });
  const boneMass = calculateBoneMass(weight);
  const visceralFat = calculateVisceralFat({ bmi, age, gender });
  const advice = generateHealthAdvice(bmi);
  
  return {
    bmi: parseFloat(bmi.toFixed(1)),
    bodyFat: parseFloat(bodyFat.toFixed(1)),
    water: parseFloat(water.toFixed(1)),
    muscleMass: parseFloat(muscleMass.toFixed(2)),
    protein: parseFloat(protein.toFixed(1)),
    bmr,
    boneMass: parseFloat(boneMass.toFixed(2)),
    visceralFat,
    advice
  };
}

module.exports = {
  calculateBMI,
  calculateBodyFat,
  calculateWater,
  calculateMuscleMass,
  calculateProtein,
  calculateBMR,
  calculateBoneMass,
  calculateVisceralFat,
  generateHealthAdvice,
  calculateAllMetrics
};
