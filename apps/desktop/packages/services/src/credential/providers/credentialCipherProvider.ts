import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { CREDENTIAL_DECRYPT_ERROR_CODE, CREDENTIAL_DECRYPT_ERROR_PREFIX } from "@fcode/shared";
import { LEGACY_BRAND, normalizeLegacyFCodeEnv } from "@fcode/shared/branding-compatibility";

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const CREDENTIAL_CIPHER_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_CIPHER_IV_BYTES = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
const CREDENTIAL_SECRET_ENV_KEY = "FCODE_CREDENTIAL_SECRET";

export interface CredentialCipherProvider {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface CredentialCipherProviderOptions {
  env?: NodeJS.ProcessEnv;
}

function deriveCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function defaultCredentialSecret(brand: string): string {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // 部分运行环境可能拿不到系统用户，失败时退回默认占位值。
  }

  return `${brand}-credential-fallback:${platform()}:${homedir()}:${username}`;
}

function base64urlToBuffer(raw: string): Buffer {
  return Buffer.from(raw, "base64url");
}

function bufferToBase64url(raw: Buffer): string {
  return raw.toString("base64url");
}

function createCredentialDecryptError(
  reason: string,
): Error & { code: typeof CREDENTIAL_DECRYPT_ERROR_CODE } {
  return Object.assign(new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}${reason}`), {
    code: CREDENTIAL_DECRYPT_ERROR_CODE,
  });
}

export function createCredentialCipherProvider(
  options: CredentialCipherProviderOptions = {},
): CredentialCipherProvider {
  const env = normalizeLegacyFCodeEnv(options.env ?? process.env);
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY];
  const key = deriveCipherKey(configuredSecret || defaultCredentialSecret("fcode"));
  // 品牌改名不能使已有密文失效；只有未显式配置密钥时才允许历史默认密钥读取。
  const decryptKeys =
    configuredSecret !== undefined
      ? [key]
      : [key, deriveCipherKey(defaultCredentialSecret(LEGACY_BRAND))];

  return {
    encrypt(value: string): string {
      const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
      const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return [
        ENCRYPTED_VALUE_PREFIX,
        bufferToBase64url(iv),
        ".",
        bufferToBase64url(authTag),
        ".",
        bufferToBase64url(encrypted),
      ].join("");
    },

    decrypt(value: string): string {
      if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) {
        return value;
      }

      const payload = value.slice(ENCRYPTED_VALUE_PREFIX.length);
      const parts = payload.split(".");
      const [ivRaw, authTagRaw, cipherRaw] = parts;

      if (!ivRaw || !authTagRaw || !cipherRaw || parts.length !== 3) {
        throw createCredentialDecryptError("密文格式非法");
      }

      const iv = base64urlToBuffer(ivRaw);
      const authTag = base64urlToBuffer(authTagRaw);
      const cipherText = base64urlToBuffer(cipherRaw);

      if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
        throw createCredentialDecryptError("IV 长度非法");
      }

      if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
        throw createCredentialDecryptError("AuthTag 长度非法");
      }

      for (const decryptKey of decryptKeys) {
        try {
          const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, decryptKey, iv);
          decipher.setAuthTag(authTag);
          const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
          return plainText.toString("utf-8");
        } catch {
          // GCM 认证失败后尝试允许的历史密钥，绝不返回未认证内容。
        }
      }
      throw createCredentialDecryptError("密钥不匹配或密文已损坏");
    },
  };
}
