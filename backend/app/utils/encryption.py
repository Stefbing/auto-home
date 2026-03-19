import os
import base64
import hashlib
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
import logging

logger = logging.getLogger(__name__)

class EncryptionManager:
    """加密管理器 - 用于安全存储用户凭证"""
    
    def __init__(self):
        # 从环境变量获取主密钥
        self.master_key = os.getenv("ENCRYPTION_KEY")
        if not self.master_key:
            logger.warning("ENCRYPTION_KEY not set, using fallback (INSECURE)")
            self.master_key = "fallback_key_for_development_only_32b"
        
        # 确保密钥长度为 32 字节
        if len(self.master_key) < 32:
            self.master_key = self.master_key.ljust(32, '0')[:32]
        
        self._cipher = None
    
    def _get_cipher(self, salt: bytes) -> Fernet:
        """基于盐和主密钥派生加密密钥"""
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=100000,
        )
        key = base64.urlsafe_b64encode(kdf.derive(self.master_key.encode()))
        return Fernet(key)
    
    def encrypt(self, plaintext: str, salt: str = None) -> str:
        """加密字符串"""
        if salt is None:
            salt = os.urandom(16).hex()
        
        salt_bytes = bytes.fromhex(salt)
        cipher = self._get_cipher(salt_bytes)
        encrypted = cipher.encrypt(plaintext.encode())
        
        # 返回格式：salt$encrypted_data
        return f"{salt}${base64.urlsafe_b64encode(encrypted).decode()}"
    
    def decrypt(self, encrypted_data: str) -> str:
        """解密字符串"""
        try:
            parts = encrypted_data.split('$', 1)
            if len(parts) != 2:
                raise ValueError("Invalid encrypted data format")
            
            salt_hex, encrypted_b64 = parts
            salt_bytes = bytes.fromhex(salt_hex)
            encrypted_bytes = base64.urlsafe_b64decode(encrypted_b64)
            
            cipher = self._get_cipher(salt_bytes)
            decrypted = cipher.decrypt(encrypted_bytes)
            
            return decrypted.decode()
        except Exception as e:
            logger.error(f"Decryption failed: {e}")
            raise
    
    @staticmethod
    def hash_phone_number(phone: str) -> str:
        """对手机号进行哈希（用于快速查询）"""
        return hashlib.sha256(phone.encode()).hexdigest()


# 全局实例
encryption_manager = EncryptionManager()
