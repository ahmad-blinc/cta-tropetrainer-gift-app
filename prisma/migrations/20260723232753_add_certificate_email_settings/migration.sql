-- CreateTable
CREATE TABLE "CertificateEmailSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "headingText" TEXT,
    "linkText" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "CertificateEmailSettings_shop_key" ON "CertificateEmailSettings"("shop");
