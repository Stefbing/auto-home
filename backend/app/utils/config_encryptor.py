"""
配置加密工具 - 性能优先的简单加密方案
使用 XOR + Base64 编码，适合存储账号密码等敏感信息

⚠️ 安全警告: XOR 加密仅用于轻度混淆，不具备强安全性。
   生产环境建议使用 Fernet 或 AES 等标准加密算法。
"""
import base64
import os
import logging
from typing import Optional

logger = logging.getLogger(__name__)


class ConfigEncryptor:
    """配置加密器 - 轻量级实现 (XOR + Base64)"""
    
    # 固定密钥（可以从环境变量读取增加安全性）
    # 注意: 如果未设置环境变量，将使用默认密钥，这在生产环境中是不安全的
    _default_key = 'auto_home_secret_key_2024'
    _key = os.getenv('CONFIG_ENCRYPTION_KEY', _default_key).encode('utf-8')
    
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
            key_bytes = cls._key
            text_bytes = plaintext.encode('utf-8')
            key_len = len(key_bytes)
            
            # 使用 bytearray 提高性能
            encrypted_bytearray = bytearray(len(text_bytes))
            for i in range(len(text_bytes)):
                encrypted_bytearray[i] = text_bytes[i] ^ key_bytes[i % key_len]
            
            # Base64 编码
            return base64.b64encode(bytes(encrypted_bytearray)).decode('utf-8')
        except UnicodeEncodeError as e:
            raise ValueError(f"Encryption failed (encoding error): {str(e)}")
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
            encrypted_bytes = base64.b64decode(ciphertext.encode('utf-8'), validate=True)
            
            # XOR 解密（与加密相同）
            key_bytes = cls._key
            key_len = len(key_bytes)
            
            # 使用 bytearray 提高性能
            decrypted_bytearray = bytearray(len(encrypted_bytes))
            for i in range(len(encrypted_bytes)):
                decrypted_bytearray[i] = encrypted_bytes[i] ^ key_bytes[i % key_len]
            
            return bytes(decrypted_bytearray).decode('utf-8')
        except base64.binascii.Error as e:
            raise ValueError(f"Decryption failed (invalid base64): {str(e)}")
        except UnicodeDecodeError as e:
            raise ValueError(f"Decryption failed (decoding error, possibly wrong key): {str(e)}")
        except Exception as e:
            raise ValueError(f"Decryption failed: {str(e)}")
    
    @classmethod
    def set_key(cls, key: str):
        """设置自定义密钥"""
        if not key:
            raise ValueError("Key cannot be empty")
        cls._key = key.encode('utf-8')
        logger.warning("ConfigEncryptor key has been changed. This is not thread-safe.")
