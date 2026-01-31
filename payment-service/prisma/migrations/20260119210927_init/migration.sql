-- CreateEnum
CREATE TYPE "public"."PaymentStatus" AS ENUM ('PENDING', 'REQUIRES_ACTION', 'AWAITING_CAPTURE', 'SUCCEEDED', 'FAILED', 'CANCELED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "public"."PaymentProvider" AS ENUM ('STRIPE', 'YOOKASSA', 'TINKOFF');

-- CreateTable
CREATE TABLE "public"."payments" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "status" "public"."PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "provider" "public"."PaymentProvider" NOT NULL DEFAULT 'STRIPE',
    "providerPaymentId" TEXT,
    "requiresAction" BOOLEAN NOT NULL DEFAULT false,
    "clientSecret" TEXT,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_orderId_key" ON "public"."payments"("orderId");
