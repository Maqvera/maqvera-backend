import ReviewModel from "../models/ReviewModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

/**
 * PRD "CRM Feature Map by Phase" Phase 4 module 40 (Review & Rating
 * System). Scoped to what's honestly buildable today: the data model and
 * staff-side moderation (a staff member records feedback a customer gave
 * them — phone, email, in person — and moderates it before it's ever
 * shown publicly). A genuine customer-facing self-submission flow and the
 * public "published on website" read endpoint both depend on v1 Task 5's
 * public booking site, which doesn't exist yet — building a one-off
 * customer auth path just for this would be scope creep ahead of that
 * task, not a shortcut past it.
 */
export const createReview = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "review.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { bookingId, packageRating = null, hotelRating = null, guideRating = null, driverRating = null, comment = null } = req.body;
    if (!bookingId) return sendError(res, 400, "bookingId is required.", requestId);
    if (packageRating === null && hotelRating === null && guideRating === null && driverRating === null) {
      return sendError(res, 400, "At least one rating (packageRating, hotelRating, guideRating, driverRating) is required.", requestId);
    }

    const booking = await BookingHeaderModel.findOne({ _id: bookingId, ...scope }).lean();
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    const existing = await ReviewModel.findOne({ tenantId: scope.tenantId, bookingId });
    if (existing) return sendError(res, 409, "A review already exists for this booking.", requestId);

    const review = await ReviewModel.create({
      tenantId: scope.tenantId, bookingId, customerId: booking.customerId,
      packageRating, hotelRating, guideRating, driverRating, comment,
      createdBy: req.auth?.id || null
    });

    return sendSuccess(res, 201, "Review recorded successfully.", review.toJSON(), requestId);
  } catch (error) {
    console.error("createReview error:", error);
    return sendError(res, 500, error.message || "Failed to record review.", requestId);
  }
};

export const listReviews = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "review.read", "review.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const filter = { tenantId: scope.tenantId };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.bookingId) filter.bookingId = req.query.bookingId;
    if (req.query.customerId) filter.customerId = req.query.customerId;

    const items = await ReviewModel.find(filter).sort({ createdAt: -1 }).lean();
    return sendSuccess(res, 200, "Reviews retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listReviews error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve reviews.", requestId);
  }
};

export const moderateReview = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "review.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const { status } = req.body;
    if (!["published", "hidden"].includes(status)) return sendError(res, 400, 'status must be "published" or "hidden".', requestId);

    const review = await ReviewModel.findOne({ _id: req.params.reviewId, tenantId: scope.tenantId });
    if (!review) return sendError(res, 404, "Review not found.", requestId);

    review.status = status;
    review.moderatedBy = req.auth?.id || null;
    review.moderatedAt = new Date();
    await review.save();

    return sendSuccess(res, 200, "Review moderated successfully.", review.toJSON(), requestId);
  } catch (error) {
    console.error("moderateReview error:", error);
    return sendError(res, 500, error.message || "Failed to moderate review.", requestId);
  }
};
