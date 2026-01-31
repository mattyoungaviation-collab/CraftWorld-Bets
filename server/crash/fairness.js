import crypto from "crypto";
import { concat, getBytes, keccak256, toUtf8Bytes } from "ethers";

const MAX_HASH = 2n ** 256n;

function toDecimalString(value, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  return `${whole}.${fraction.toString().padStart(decimals, "0")}`;
}

export function generateServerSeed() {
  return `0x${crypto.randomBytes(32).toString("hex")}`;
}

export function buildCommitHash(serverSeed) {
  return keccak256(serverSeed);
}

export function deriveRoundHash(serverSeed, roundId) {
  return keccak256(concat([getBytes(serverSeed), toUtf8Bytes(roundId)]));
}

export function hashToUniform(hashHex) {
  const value = BigInt(hashHex);
  let fixed = (value * 10n ** 18n) / MAX_HASH;
  if (fixed == 0n) {
    fixed = 1n;
  }
  const u = Number(fixed) / 1e18;
  return {
    fixed,
    u,
    uString: toDecimalString(fixed, 18),
  };
}

export function computeCrashPoint({ serverSeed, roundId, houseEdgeBps }) {
  const derivedHash = deriveRoundHash(serverSeed, roundId);
  const { fixed, u, uString } = hashToUniform(derivedHash);
  const edge = Math.max(0, houseEdgeBps) / 10_000;
  const rawCrash = (1 - edge) / u;
  const clamped = Math.min(50, Math.max(0.5, rawCrash));
  return {
    crashPoint: clamped,
    crashPointDisplay: Math.round(clamped * 100) / 100,
    derivedHash,
    u,
    uFixed: fixed,
    uString,
  };
}
