"""
配置加密工具 - 性能优先的简单加密方案
使用 XOR + Base64 编码，适合存储账号密码等敏感信息
"""
import base64
import os
from typing import Optional


class ConfigEncryptor:
    """配置加密器 - 轻量级实现"""
    
    # 固定密钥（可以从环境变量读取增加安全性）
    _key = os.getenv('CONFIG_ENCRYPTION_KEY', 'auto_home_secret_key_2024').encode('utf-8')
    
    @classmethod
    def encrypt(cls, plaintext: str) -> str:
        """
        加密字符串
        :param plaintext: 明文
        :return: Base64 编码的密文
        """
        if not plaintext:
            return ""
        
        try:
            # XOR 加密
            key_bytes = cls._key
            text_bytes = plaintext.encode('utf-8')
            
            # XOR 操作
            encrypted_bytes = bytes([
                text_bytes[i] ^ key_bytes[i % len(key_bytes)]
                for i in range(len(text_bytes))
            ])
            
            # Base64 编码
            return base64.b64encode(encrypted_bytes).decode('utf-8')
        except Exception as e:
            raise ValueError(f"Encryption failed: {str(e)}")
    
    @classmethod
    def decrypt(cls, ciphertext: str) -> str:
        """
        解密字符串
        :param ciphertext: Base64 编码的密文
        :return: 明文
        """
        if not ciphertext:
            return ""
        
        try:
            # Base64 解码
            encrypted_bytes = base64.b64decode(ciphertext.encode('utf-8'))
            
            # XOR 解密（与加密相同）
            key_bytes = cls._key
            decrypted_bytes = bytes([
                encrypted_bytes[i] ^ key_bytes[i % len(key_bytes)]
                for i in range(len(encrypted_bytes))
            ])
            
            return decrypted_bytes.decode('utf-8')
        except Exception as e:
            raise ValueError(f"Decryption failed: {str(e)}")
    
    @classmethod
    def set_key(cls, key: str):
        """设置自定义密钥"""
        cls._key = key.encode('utf-8')
