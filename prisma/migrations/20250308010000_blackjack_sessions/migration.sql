-- CreateTable
CREATE TABLE "blackjack_sessions" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "seatId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "buyInWei" BIGINT NOT NULL,
    "bankrollWei" BIGINT NOT NULL,
    "committedWei" BIGINT NOT NULL,
    "netPnlWei" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blackjack_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blackjack_settlements" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "betId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "netPnlWei" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blackjack_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blackjack_table_state" (
    "id" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blackjack_table_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blackjack_sessions_walletAddress_idx" ON "blackjack_sessions"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "blackjack_settlements_sessionId_key" ON "blackjack_settlements"("sessionId");

-- AddForeignKey
ALTER TABLE "blackjack_settlements" ADD CONSTRAINT "blackjack_settlements_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "blackjack_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
