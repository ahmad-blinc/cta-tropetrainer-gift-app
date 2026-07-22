-- CreateTable
CREATE TABLE "GiftCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "code" TEXT,
    "accessCodeId" TEXT,
    "requestId" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "GiftCode_shopifyOrderId_key" ON "GiftCode"("shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCode_idempotencyKey_key" ON "GiftCode"("idempotencyKey");
