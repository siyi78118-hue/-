# AL Android 正式签名身份

本文件记录公开证书身份，用于每次正式 APK 发布前核验能否覆盖安装。它不包含私钥或密码。

- 应用包名：`com.siyi.al`
- 证书主体：`C=CN, O=AL, CN=AL`
- SHA-256：`5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`
- SHA-1：`a8dd34425dbe211eb04296248cbc1cf79f90d45d`
- MD5：`85170fe0cfb129a7e2d9c2fe92f32e18`
- 公钥：RSA 3072 位
- 当前正式 APK 签名方案：v2

## 发布硬性要求

1. 新 APK 的包名必须为 `com.siyi.al`。
2. `apksigner verify --print-certs` 输出的 SHA-256 必须与上述 SHA-256 完全一致。
3. 只有持有对应私钥的 `.p12`、`.jks` 或 `.keystore` 才能生成这一签名；旧 APK 和证书摘要不能还原私钥。
4. 私钥文件、KeyStore 密码、Key Alias 和 Key 密码不得提交到 Git、文档或安装包。
5. 指纹不一致的 APK 不得作为覆盖安装包交付。
