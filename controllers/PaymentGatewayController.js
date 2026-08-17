import PaymentGatewayService from "../services/PaymentGatewayService.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";
import logger from "../utils/logger.js";

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("not found")) return 404;
  if (message.includes("already has") || message.includes("already exists")) return 409;
  if (message.includes("required") || message.includes("not configured") || message.includes("Invalid") || message.includes("has not connected") || message.includes("cannot accept charges") || message.includes("no outstanding balance")) return 400;
  return 500;
};

/** GET /api/v1/payment-gateways/connect/stripe */
export const GetConnectUrl = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("payments.connect")) return sendError(res, 403, "Permission denied.", requestId);

    const url = await PaymentGatewayService.getStripeOAuthUrl(scope.tenantId);
    return sendSuccess(res, 200, "Stripe Connect URL generated successfully.", { url }, requestId);
  } catch (error) {
    console.error("GetConnectUrl error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate Stripe Connect URL.", requestId);
  }
};

/**
 * GET /api/v1/payment-gateways/oauth/stripe/callback — Stripe redirects
 * the BROWSER here after the agency completes the OAuth consent screen.
 * No `authenticateAccessToken` on this route (Stripe cannot send a JWT) —
 * identity comes entirely from the signed `state` param, verified inside
 * `handleOAuthCallback`. Always redirects (never returns a JSON API
 * response) since the caller is a browser tab, not an API client.
 */
export const OAuthCallback = async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  try {
    const { code, state, error: stripeError } = req.query;
    if (stripeError) {
      logger.warn("Stripe Connect OAuth denied by user.", { error: stripeError });
      return res.redirect(`${frontendUrl}/settings/payments?status=error&reason=denied`);
    }
    if (!code || !state) {
      return res.redirect(`${frontendUrl}/settings/payments?status=error&reason=missing_params`);
    }

    await PaymentGatewayService.handleOAuthCallback(code, state);
    return res.redirect(`${frontendUrl}/settings/payments?status=connected`);
  } catch (error) {
    logger.error("Stripe Connect OAuth callback failed.", { error: error.message });
    return res.redirect(`${frontendUrl}/settings/payments?status=error`);
  }
};

/** POST /api/v1/payment-gateways/disconnect */
export const DisconnectGateway = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("payments.disconnect")) return sendError(res, 403, "Permission denied.", requestId);

    const userId = req.auth?.userId || req.auth?.id || null;
    const provider = req.body.provider || "stripe";
    const result = await PaymentGatewayService.disconnectGateway(scope.tenantId, provider, userId);
    return sendSuccess(res, 200, "Payment gateway disconnected successfully.", result, requestId);
  } catch (error) {
    console.error("DisconnectGateway error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to disconnect payment gateway.", requestId);
  }
};

/** GET /api/v1/payment-gateways */
export const ListGateways = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("payments.view")) return sendError(res, 403, "Permission denied.", requestId);

    const gateways = await PaymentGatewayService.listGateways(scope.tenantId);
    return sendSuccess(res, 200, "Payment gateways retrieved successfully.", { items: gateways }, requestId);
  } catch (error) {
    console.error("ListGateways error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve payment gateways.", requestId);
  }
};

/**
 * POST /api/v1/payment-gateways/checkout — the endpoint the AGENCY's own
 * booking flow calls (not the customer directly): staff generate the
 * link/QR after chatting with the customer on WhatsApp and share it
 * manually, exactly matching the PRD's own described flow. A real
 * WhatsApp Business API auto-send is a separate, later integration — this
 * endpoint's only job is to create a genuine, working Stripe Checkout URL.
 * Charges the booking's real remaining `outstandingBalance` (not the full
 * `totalAmount` again) — a booking that already received a prior manual
 * partial payment must never be double-charged via this new link.
 */
export const CreateCheckout = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("bookings.update") && !permissions.includes("booking.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { bookingId } = req.body;
    if (!bookingId) return sendError(res, 400, "bookingId is required.", requestId);

    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId: scope.tenantId }).select("bookingReference bookingNumber financialSnapshot totalAmount currency").lean();
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    const amount = booking.financialSnapshot?.outstandingBalance ?? (booking.financialSnapshot?.totalAmount || booking.totalAmount || 0);
    if (!(amount > 0)) return sendError(res, 400, "This booking has no outstanding balance to collect.", requestId);

    const result = await PaymentGatewayService.createCheckoutSession({
      tenantId: scope.tenantId,
      bookingId: booking._id,
      bookingReference: booking.bookingNumber || booking.bookingReference,
      amount,
      currency: booking.financialSnapshot?.currency || booking.currency || "USD"
    });

    return sendSuccess(res, 200, "Checkout session created successfully.", result, requestId);
  } catch (error) {
    console.error("CreateCheckout error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create checkout session.", requestId);
  }
};
