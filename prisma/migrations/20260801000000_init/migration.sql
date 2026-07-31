-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "public"."CertificateAsset" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertificateAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CertificateEmailSettings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "headingText" TEXT,
    "linkText" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertificateEmailSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CertificateStatusMessages" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "processingHeading" TEXT NOT NULL,
    "processingBody" TEXT NOT NULL,
    "delayedHeading" TEXT NOT NULL,
    "delayedBody" TEXT NOT NULL,
    "contactLink" TEXT,
    "contactLinkVisibility" TEXT NOT NULL DEFAULT 'delayed',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertificateStatusMessages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CertificateTemplate" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertificateTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GiftCode" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "code" TEXT,
    "accessCodeId" TEXT,
    "requestId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CertificateAsset_shop_key_key" ON "public"."CertificateAsset"("shop" ASC, "key" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CertificateEmailSettings_shop_key" ON "public"."CertificateEmailSettings"("shop" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CertificateStatusMessages_shop_key" ON "public"."CertificateStatusMessages"("shop" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CertificateTemplate_shop_key" ON "public"."CertificateTemplate"("shop" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "GiftCode_idempotencyKey_key" ON "public"."GiftCode"("idempotencyKey" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "GiftCode_shopifyOrderId_key" ON "public"."GiftCode"("shopifyOrderId" ASC);

