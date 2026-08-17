import PaymentGatewayService, { getStripeClient } from "../services/PaymentGatewayService.js";
import BookingPaymentService from "../services/BookingPaymentService.js";
import TenantProvisioningService from "../services/TenantProvisioningService.js";
import TenantSubscriptionService from "../services/TenantSubscriptionService.js";
import PaymentWebhookEventModel from "../models/PaymentWebhookEventModel.js";
import PendingTenantSetupModel from "../models/PendingTenantSetupModel.js";
import TenantBillingAccountModel from "../models/TenantBillingAccountModel.js";
import TenantModel from "../models/Tenantmodel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import logger from "../utils/logger.js";

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Real, atomic idempotency claim — separate from `middleware/idempotency.js`
 * (that one is for a CLIENT retrying its own request with a self-generated
 * `Idempotency-Key`; this is for STRIPE retrying delivery of the exact
 * same event, identified by Stripe's own real `event.id`). Distinguishes
 * "already fully processed" (a genuine duplicate delivery — never
 * reprocess) from "previously errored" (a genuine transient failure —
 * safe, correct to retry): a plain `findOneAndUpdate` upsert-on-first-seen
 * would NOT make this distinction and would silently swallow every retry
 * of a request that failed the first time, including ones Stripe expects
 * to eventually succeed once whatever broke is fixed.
 *
 * Returns `null` when this call must NOT process the event (already
 * genuinely done, or lost a real concurrent race to another in-flight
 * delivery of the same event) — otherwise the real, now-`"Processing"`
 * row this call now owns.
 */
const claimWebhookEvent = async (event) => {
  const now = new Date();
  try {
    const reclaimed = await PaymentWebhookEventModel.findOneAndUpdate(
      { stripeEventId: event.id, status: "Error" },
      { $set: { eventType: event.type, accountId: event.account || null, status: "Processing", receivedAt: now } },
      { new: true }
    );
    if (reclaimed) return reclaimed;

    return await PaymentWebhookEventModel.create({ stripeEventId: event.id, eventType: event.type, accountId: event.account || null, status: "Processing", receivedAt: now });
  } catch (error) {
    if (error.code === 11000) return null; // a real duplicate delivery (or a genuinely concurrent race this call lost) — never reprocessed
    throw error;
  }
};

/**
 * "Route the event by `event.type`." Real business handlers for
 * `payment_intent.succeeded`/`charge.refunded` wire in as Issue 6 lands
 * (`BookingPaymentService`); `checkout.session.completed` as Issue 12
 * lands (tenant provisioning); `invoice.paid`/`invoice.payment_failed` as
 * Issue 13 lands (recurring billing). Every other event type is honestly
 * acknowledged as a genuine no-op — Stripe requires a 2xx for any event
 * type a receiver doesn't explicitly act on, or it keeps retrying
 * indefinitely.
 */
const routeStripeEvent = async (event, tenantId) => {
  switch (event.type) {
    case "account.updated": {
      const account = event.data.object;
      await PaymentGatewayService.syncAccountCapabilities(account.id, { chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled });
      logger.info(`Synced Stripe account capabilities for tenant ${tenantId}.`, { tenantId, accountId: account.id, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled });
      return "Processed";
    }
    // "Invoice Paid -> Booking Confirmed -> Balance Updated ->
    // Notification." `bookingId` is read from the real Stripe metadata a
    // Checkout Session attaches at creation time (Issue 10's own
    // `payment_intent_data.metadata`) — the standard, idiomatic way to
    // correlate a webhook event back to a domain object, never guessed.
    case "payment_intent.succeeded": {
      const paymentIntent = event.data.object;
      const bookingId = paymentIntent.metadata?.bookingId;
      if (!bookingId) {
        logger.warn(`payment_intent.succeeded for tenant ${tenantId} has no bookingId in metadata — cannot correlate to a booking.`, { tenantId, paymentIntentId: paymentIntent.id });
        return "Ignored";
      }
      const amountReceived = (paymentIntent.amount_received ?? paymentIntent.amount) / 100;
      await BookingPaymentService.markPaid({
        tenantId, bookingId, amountPaid: amountReceived,
        currency: (paymentIntent.currency || "usd").toUpperCase(),
        stripePaymentIntentId: paymentIntent.id, performedBy: "system"
      });
      return "Processed";
    }
    // Stripe's own `charge.amount_refunded` is the CUMULATIVE total
    // refunded on this charge so far, not this specific refund event's own
    // amount — a second partial refund on the same charge would otherwise
    // double-count. The real delta is computed against what this booking
    // already has recorded before calling the (additive) service method.
    case "charge.refunded": {
      const charge = event.data.object;
      const bookingId = charge.metadata?.bookingId;
      if (!bookingId) {
        logger.warn(`charge.refunded for tenant ${tenantId} has no bookingId in metadata — cannot correlate to a booking.`, { tenantId, chargeId: charge.id });
        return "Ignored";
      }
      const cumulativeRefunded = round2((charge.amount_refunded || 0) / 100);
      const existing = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).select("financialSnapshot.refundAmount").lean();
      const alreadyRecorded = round2(existing?.financialSnapshot?.refundAmount || 0);
      const delta = round2(Math.max(0, cumulativeRefunded - alreadyRecorded));
      if (delta <= 0) {
        logger.info(`charge.refunded for tenant ${tenantId} has nothing new to record (already reflected).`, { tenantId, chargeId: charge.id });
        return "Ignored";
      }
      await BookingPaymentService.markRefunded({ tenantId, bookingId, refundAmount: delta, stripeChargeId: charge.id, performedBy: "system" });
      return "Processed";
    }
    case "invoice.paid":
    case "invoice.payment_failed":
      logger.info(`Stripe webhook event ${event.id} (${event.type}) acknowledged — handler not yet wired for this event type.`, { tenantId, eventType: event.type });
      return "Ignored";
    default:
      logger.info(`Stripe webhook event ${event.id} (${event.type}) acknowledged — no handler needed for this event type.`, { tenantId, eventType: event.type });
      return "Ignored";
  }
};

/**
 * "checkout.session.completed" for a real tenant-provisioning signup (PRD
 * Issue 12) — deliberately NOT routed through `routeStripeEvent` above,
 * because that function requires an already-resolved `tenantId`, and by
 * definition NO tenant exists yet for a signup nobody has paid for until
 * this very event fires. This is the ONLY code path (besides
 * `controllers/Auth.js`'s own now-removed inline logic) that creates a
 * real `TenantModel` document — via the shared `TenantProvisioningService`,
 * never a second, duplicated creation flow.
 */
const handleTenantProvisioningCheckout = async (event) => {
  const session = event.data.object;
  const setupToken = session.metadata?.setupToken;
  if (!setupToken) return "Ignored"; // a real checkout session unrelated to tenant setup (shouldn't normally reach here, but never assumed)

  const pending = await PendingTenantSetupModel.findOne({ setupToken });
  if (!pending) {
    logger.info(`checkout.session.completed setupToken ${setupToken} has no pending record — already provisioned or genuinely expired, acknowledged as a no-op.`, { setupToken });
    return "Ignored";
  }

  let provisioned;
  try {
    provisioned = await TenantProvisioningService.provisionTenant({
      companyName: pending.companyName, tenantKey: pending.tenantKey, username: pending.username,
      email: pending.email, passwordHash: pending.passwordHash
    });
  } catch (error) {
    // A genuine duplicate delivery that slipped past the outer
    // `claimWebhookEvent` idempotency check some other way (e.g. Stripe
    // sent two DIFFERENT event ids for the same underlying session) must
    // never be treated as a real processing failure worth retrying.
    if (error.message.includes("already in use") || error.message.includes("already exists")) {
      logger.info(`Tenant setup for ${pending.tenantKey} was already provisioned — ignoring a duplicate checkout.session.completed.`, { tenantKey: pending.tenantKey });
      await PendingTenantSetupModel.deleteOne({ _id: pending._id }).catch(() => null);
      return "Ignored";
    }
    throw error;
  }

  const provisionedTenantId = provisioned.tenant.tenantKey;

  // The real Stripe payment method used for this one-time Checkout
  // Session — saved via `setup_future_usage: "off_session"`
  // (controllers/Auth.js#SetupTenantIntent) so the EXISTING Enterprise
  // Subscription Platform's own recurring billing (`chargeAutoDebit`)
  // can reuse it for every future renewal — this record-keeping step
  // deliberately never depends on Stripe's own native Subscription
  // object (see SetupTenantIntent's own doc comment for why).
  const client = await getStripeClient();
  let stripePaymentMethodId = null;
  if (client && session.payment_intent) {
    try {
      const paymentIntent = await client.paymentIntents.retrieve(session.payment_intent);
      stripePaymentMethodId = paymentIntent.payment_method || null;
    } catch (error) {
      logger.error(`Failed to retrieve PaymentIntent for provisioning checkout session ${session.id}.`, { error: error.message });
    }
  }

  await TenantBillingAccountModel.create({
    tenantId: provisionedTenantId, billingContactName: pending.companyName, billingContactEmail: pending.email,
    paymentMethod: "Stripe", stripeCustomerId: session.customer || null, stripePaymentMethodId, status: "Verified"
  });

  // Real, existing service — its own validation, timeline, and
  // `SubscriptionCreated` event all fire correctly, exactly as for any
  // other subscription creation; never a hand-constructed
  // TenantSubscriptionModel document.
  const { invoice } = await TenantSubscriptionService.createSubscription(provisionedTenantId, {
    planId: pending.planId, billingCycle: pending.billingCycle, userId: null
  });

  // The customer already genuinely paid via this real Checkout Session —
  // `recordManualPayment` ("a human/system confirms money already
  // arrived externally") is the correct real chokepoint here, NOT
  // `chargeAutoDebit` (which would attempt a SECOND, real charge against
  // the same customer). This flips the subscription PastDue -> Active
  // via `_onPaymentReceived`'s own already-real logic.
  if (invoice) {
    await TenantSubscriptionService.recordManualPayment(invoice._id, {
      reference: session.payment_intent || session.id, userId: null, paymentMethod: "Stripe"
    });
  }

  await PendingTenantSetupModel.deleteOne({ _id: pending._id });

  logger.info(`Tenant ${provisionedTenantId} fully provisioned via real Stripe Checkout payment.`, { tenantId: provisionedTenantId });
  return "Processed";
};

/**
 * POST /api/v1/webhooks/stripe — the real Stripe Connect webhook
 * receiver. Requires the raw, unparsed request body (`express.raw()`,
 * mounted in `server.js` BEFORE the global `express.json()`) — Stripe
 * signature verification needs the exact bytes Stripe signed, which
 * `express.json()` would have already consumed and reserialized.
 */
export const HandleStripeWebhook = async (req, res) => {
  const signature = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logger.error("Stripe webhook received but STRIPE_WEBHOOK_SECRET is not configured — refusing to process an unverifiable payload.");
    return res.status(500).send("Webhook not configured.");
  }
  if (!signature) {
    return res.status(400).send("Missing Stripe-Signature header.");
  }

  const client = await getStripeClient();
  if (!client) {
    logger.error("Stripe webhook received but STRIPE_SECRET_KEY is not configured.");
    return res.status(500).send("Webhook not configured.");
  }

  let event;
  try {
    event = client.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (error) {
    logger.warn("Stripe webhook signature verification failed.", { error: error.message });
    return res.status(400).send(`Webhook signature verification failed: ${error.message}`);
  }

  const eventRecord = await claimWebhookEvent(event);
  if (!eventRecord) {
    logger.info(`Stripe webhook event ${event.id} already processed or currently being processed — acknowledging duplicate delivery.`, { eventId: event.id, eventType: event.type });
    return res.status(200).send();
  }

  try {
    // "checkout.session.completed" for a real tenant-provisioning signup
    // (PRD Issue 12) is the ONE real event type that must run BEFORE
    // tenant resolution below — by definition, no tenant exists yet for a
    // signup nobody has paid for until this exact event. Every other
    // event type still requires a real, already-existing tenant.
    if (event.type === "checkout.session.completed" && event.data.object?.metadata?.setupToken) {
      eventRecord.status = await handleTenantProvisioningCheckout(event);
      await eventRecord.save();
      return res.status(200).send();
    }

    // Tenant resolution — "This is the tenant resolution step and must
    // never be skipped or assumed." A webhook with no matching tenant is
    // logged and acknowledged (200, so Stripe stops retrying) without
    // taking any action.
    let tenant = null;
    if (event.account) {
      tenant = await TenantModel.findOne({ "paymentGateways.accountId": event.account }).select("tenantKey").lean();
    }

    if (!tenant) {
      eventRecord.status = "Ignored";
      await eventRecord.save();
      logger.warn(`Stripe webhook event ${event.id} (${event.type}) has no matching tenant for account ${event.account || "none"} — ignored.`, { eventId: event.id, eventType: event.type, accountId: event.account });
      return res.status(200).send();
    }

    eventRecord.tenantId = tenant.tenantKey;
    eventRecord.status = await routeStripeEvent(event, tenant.tenantKey);
    await eventRecord.save();

    return res.status(200).send();
  } catch (error) {
    eventRecord.status = "Error";
    eventRecord.errorMessage = error.message;
    await eventRecord.save().catch((saveError) => logger.error("Failed to record webhook processing error.", { eventId: event.id, error: saveError.message }));
    logger.error(`Stripe webhook event ${event.id} (${event.type}) processing failed.`, { eventId: event.id, error: error.message });
    // A genuine processing failure (not "no handler yet") returns 500 so
    // Stripe's own retry schedule gives this event another real attempt —
    // `claimWebhookEvent`'s own Error-status re-claim is exactly what
    // makes that retry safe rather than silently dropped.
    return res.status(500).send("Webhook processing failed.");
  }
};
