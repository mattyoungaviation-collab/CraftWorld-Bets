import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function getOrCreateUser(loginAddress) {
  const existing = await prisma.user.findUnique({ where: { loginAddress } });
  if (existing) return existing;
  return prisma.user.create({ data: { loginAddress } });
}

export async function getGameWalletForUser(userId) {
  return prisma.gameWallet.findUnique({ where: { userId } });
}

export async function createGameWallet({ userId, address, encryptedPrivateKey }) {
  return prisma.gameWallet.create({
    data: {
      userId,
      address,
      encryptedPrivateKey,
    },
  });
}

export { prisma };
