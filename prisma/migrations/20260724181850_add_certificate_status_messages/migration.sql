-- CreateTable
CREATE TABLE "CertificateStatusMessages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "processingHeading" TEXT NOT NULL,
    "processingBody" TEXT NOT NULL,
    "delayedHeading" TEXT NOT NULL,
    "delayedBody" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "CertificateStatusMessages_shop_key" ON "CertificateStatusMessages"("shop");
