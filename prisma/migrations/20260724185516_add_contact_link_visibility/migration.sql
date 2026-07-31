-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CertificateStatusMessages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "processingHeading" TEXT NOT NULL,
    "processingBody" TEXT NOT NULL,
    "delayedHeading" TEXT NOT NULL,
    "delayedBody" TEXT NOT NULL,
    "contactLink" TEXT,
    "contactLinkVisibility" TEXT NOT NULL DEFAULT 'delayed',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CertificateStatusMessages" ("contactLink", "delayedBody", "delayedHeading", "id", "processingBody", "processingHeading", "shop", "updatedAt") SELECT "contactLink", "delayedBody", "delayedHeading", "id", "processingBody", "processingHeading", "shop", "updatedAt" FROM "CertificateStatusMessages";
DROP TABLE "CertificateStatusMessages";
ALTER TABLE "new_CertificateStatusMessages" RENAME TO "CertificateStatusMessages";
CREATE UNIQUE INDEX "CertificateStatusMessages_shop_key" ON "CertificateStatusMessages"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
