import test from "node:test";
import assert from "node:assert/strict";

// Per-Tenant Payment Gateway Integration audit — Stripe rejects reusing a
// PaymentMethod that's already attached to a Customer (which
// setup_future_usage: "off_session" does at signup) unless the resulting
// PaymentIntent also carries that same `customer`. Proves, with no network
// call and no live Stripe key, that authorize() actually forwards
// `customer`/`off_session` to the Stripe SDK when given, and omits them
// (unchanged, backward-compatible shape) when not — covering both
// TenantSubscriptionService.chargeAutoDebit's new call shape and
// PaymentService's pre-existing one-off-payment-method call shape.
test("StripeGatewayAdapter.authorize forwards customer + off_session when provided (subscription auto-debit)", async () => {
  const { default: StripeGatewayAdapter } = await import("../services/gateways/StripeGatewayAdapter.js");
  const adapter = new StripeGatewayAdapter();

  let capturedParams = null;
  adapter._requireClient = async () => ({
    paymentIntents: {
      create: async (params) => {
        capturedParams = params;
        return { id: "pi_fake_123", status: "requires_capture" };
      }
    }
  });

  const result = await adapter.authorize({
    amount: 49,
    currency: "USD",
    reference: "INV-0001",
    paymentMethodId: "pm_fake_saved_card",
    customerId: "cus_fake_customer",
    offSession: true
  });

  assert.equal(result.status, "Authorized");
  assert.equal(capturedParams.customer, "cus_fake_customer");
  assert.equal(capturedParams.off_session, true);
  assert.equal(capturedParams.payment_method, "pm_fake_saved_card");
});

test("StripeGatewayAdapter.authorize omits customer + off_session when not provided (Finance's one-off payment path, unchanged)", async () => {
  const { default: StripeGatewayAdapter } = await import("../services/gateways/StripeGatewayAdapter.js");
  const adapter = new StripeGatewayAdapter();

  let capturedParams = null;
  adapter._requireClient = async () => ({
    paymentIntents: {
      create: async (params) => {
        capturedParams = params;
        return { id: "pi_fake_456", status: "requires_capture" };
      }
    }
  });

  const result = await adapter.authorize({
    amount: 100,
    currency: "USD",
    reference: "PAY-0001",
    paymentMethodId: "pm_fake_one_off"
  });

  assert.equal(result.status, "Authorized");
  assert.equal(capturedParams.customer, undefined);
  assert.equal(capturedParams.off_session, undefined);
});

test("TenantSubscriptionService.chargeAutoDebit honestly fails when stripeCustomerId is missing, even with a saved payment method", async () => {
  const dotenv = await import("dotenv");
  dotenv.default.config();
  const mongoose = (await import("mongoose")).default;

  const uri = process.env.URI || process.env.MONGO_URI;
  if (!uri) {
    return; // no reachable MongoDB configured — skip, matching this suite's own dbAvailable convention
  }
  if (mongoose.connection.readyState !== 1) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    } catch {
      return;
    }
  }

  const TenantModel = (await import("../models/Tenantmodel.js")).default;
  const PlatformPlanModel = (await import("../models/PlatformPlanModel.js")).default;
  const TenantSubscriptionModel = (await import("../models/TenantSubscriptionModel.js")).default;
  const TenantBillingAccountModel = (await import("../models/TenantBillingAccountModel.js")).default;
  const SubscriptionInvoiceModel = (await import("../models/SubscriptionInvoiceModel.js")).default;
  const TenantSubscriptionService = (await import("../services/TenantSubscriptionService.js")).default;

  const suffix = `nocust-${Date.now()}`;
  const tenantId = `test-${suffix}`;

  try {
    await TenantModel.create({ tenantKey: tenantId, name: `Test Tenant ${suffix}`, status: "active" });
    const plan = await PlatformPlanModel.create({ planCode: `TESTPLAN-${suffix}`, name: "Paid Plan", tier: "Starter", pricing: { currency: "USD", monthly: 49 } });
    // stripePaymentMethodId IS set, but stripeCustomerId is NOT — this is
    // exactly the pre-fix bug's real-world shape (a billing account
    // created before the customerId fix, or a corrupt/partial write).
    await TenantBillingAccountModel.create({
      tenantId, billingContactName: "Test Contact", billingContactEmail: "billing@example.com",
      paymentMethod: "Stripe", stripePaymentMethodId: "pm_fake_orphaned", status: "Active"
    });
    const subscription = await TenantSubscriptionModel.create({
      tenantId, planId: plan._id, planTier: plan.tier, planCode: plan.planCode, billingCycle: "Monthly", amount: 49, currency: "USD",
      status: "PastDue", autoRenew: true, currentPeriodStart: new Date(Date.now() - 30 * 86400000), currentPeriodEnd: new Date()
    });
    const invoice = await SubscriptionInvoiceModel.create({
      tenantId, subscriptionId: subscription._id, invoiceNumber: `INV-${suffix}`, amount: 49, currency: "USD", status: "Sent",
      billingPeriodStart: new Date(Date.now() - 30 * 86400000), billingPeriodEnd: new Date(), dueDate: new Date()
    });

    const result = await TenantSubscriptionService.chargeAutoDebit(invoice._id, "system");
    assert.equal(result.status, "Sent");
    assert.equal(result.failureReason, "No Stripe payment method on file for auto-debit.");
  } finally {
    await TenantModel.deleteMany({ tenantKey: tenantId });
    await PlatformPlanModel.deleteMany({ planCode: `TESTPLAN-${suffix}` });
    await TenantSubscriptionModel.deleteMany({ tenantId });
    await TenantBillingAccountModel.deleteMany({ tenantId });
    await SubscriptionInvoiceModel.deleteMany({ tenantId });
    if (mongoose.connection.readyState === 1) await mongoose.disconnect();
  }
});
