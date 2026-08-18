-- CreateTable
CREATE TABLE "VerifyWidgetSettings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "html" TEXT,
    "css" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerifyWidgetSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VerifyWidgetSettings_shop_key" ON "VerifyWidgetSettings"("shop");
