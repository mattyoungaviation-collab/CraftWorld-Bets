DROP TABLE IF EXISTS "blackjack_settlements";
DROP TABLE IF EXISTS "blackjack_table_state";
DROP TABLE IF EXISTS "blackjack_sessions";

DROP TYPE IF EXISTS "BlackjackSessionStatus";
DROP TYPE IF EXISTS "BlackjackHandOutcome";

CREATE TYPE "BlackjackSessionStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "BlackjackHandOutcome" AS ENUM (
  'PENDING',
  'PLAYER_WIN',
  'DEALER_WIN',
  'PUSH',
  'BLACKJACK',
  'BUST',
  'SURRENDER'
);

CREATE TABLE "blackjack_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "walletAddress" TEXT NOT NULL,
  "seatId" INTEGER NOT NULL,
  "buyInAmountWei" TEXT NOT NULL,
  "bankrollWei" TEXT NOT NULL,
  "status" "BlackjackSessionStatus" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "blackjack_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "blackjack_hands" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "sessionId" UUID NOT NULL,
  "betAmountWei" TEXT NOT NULL,
  "stateJson" JSONB NOT NULL,
  "outcome" "BlackjackHandOutcome" NOT NULL,
  "payoutWei" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "blackjack_hands_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "blackjack_sessions_walletAddress_idx" ON "blackjack_sessions"("walletAddress");
CREATE INDEX "blackjack_hands_sessionId_idx" ON "blackjack_hands"("sessionId");

ALTER TABLE "blackjack_hands"
ADD CONSTRAINT "blackjack_hands_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "blackjack_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
