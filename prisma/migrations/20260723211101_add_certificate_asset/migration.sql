-- CreateTable
CREATE TABLE "CertificateAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "CertificateAsset_shop_key_key" ON "CertificateAsset"("shop", "key");
