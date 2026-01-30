import crypto from "crypto";

function parseMasterKey(masterKey) {
  if (!masterKey) {
    throw new Error("MASTER_KEY is required");
  }
  const trimmed = masterKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length === 32) {
    return base64;
  }
  throw new Error("MASTER_KEY must be 32 bytes (hex or base64)");
}

export function encryptPrivateKey(privateKey, masterKey) {
  const key = parseMasterKey(masterKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptPrivateKey(record, masterKey) {
  const key = parseMasterKey(masterKey);
  const payload = typeof record === "string" ? JSON.parse(record) : record;
  if (!payload?.ciphertext || !payload?.iv || !payload?.tag) {
    throw new Error("Encrypted private key record is invalid");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
