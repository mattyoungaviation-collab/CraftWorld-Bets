import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function getOrCreateUser(loginAddress) {
  const existing = await prisma.user.findUnique({ where: { loginAddress } });
  if (existing) return existing;
  return prisma.user.create({ data: { loginAddress } });
}

export { prisma };
