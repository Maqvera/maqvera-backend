import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// Review & Rating System (PRD "CRM Feature Map by Phase" Phase 4 module 40)
// — data model + staff-side moderation only (public display/customer
// self-submission depend on v1 Task 5's public site, not built yet).

let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}

const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

const makeRes = () => ({
  statusCode: null,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const authAdmin = (tenantId) => ({ tenantId, id: "tester", userId: "tester", permissions: ["admin"] });
const authReadOnly = (tenantId) => ({ tenantId, id: "agent", userId: "agent", permissions: ["review.read"] });

test("Review: create/list/moderate lifecycle, one-per-booking, permission gate, tenant scope", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const ctrl = await import("../controllers/ReviewController.js");
  const ReviewModel = (await import("../models/ReviewModel.js")).default;
  const BookingHeaderModel = (await import("../models/BookingHeaderModel.js")).default;
  const CustomerModel = (await import("../models/CustomerModel.js")).default;

  const suffix = Date.now();
  const tenantId = `test-review-${suffix}`;

  t.after(async () => {
    await Promise.all([
      ReviewModel.deleteMany({ tenantId }),
      BookingHeaderModel.deleteMany({ tenantId }),
      CustomerModel.deleteMany({ tenantId })
    ]);
  });

  const customer = await CustomerModel.create({ tenantId, customerCode: `CUST-${suffix}`, firstName: "R", lastName: "Vw", email: `r.${suffix}@example.com`, phone: `+92300${suffix}`.slice(0, 15) });
  const booking = await BookingHeaderModel.create({ tenantId, bookingReference: `BK-${suffix}`, customerId: customer._id, totalAmount: 100, currency: "USD" });

  // ---- Permission gate ----
  const noPermRes = makeRes();
  await ctrl.createReview({ auth: { tenantId, id: "x", userId: "x", permissions: [] }, body: { bookingId: booking._id.toString(), packageRating: 5 } }, noPermRes);
  assert.equal(noPermRes.statusCode, 403);

  // ---- No rating at all -> 400 ----
  const noRatingRes = makeRes();
  await ctrl.createReview({ auth: authAdmin(tenantId), body: { bookingId: booking._id.toString(), comment: "great" } }, noRatingRes);
  assert.equal(noRatingRes.statusCode, 400);

  // ---- Unknown booking -> 404 ----
  const noBookingRes = makeRes();
  await ctrl.createReview({ auth: authAdmin(tenantId), body: { bookingId: new mongoose.Types.ObjectId().toString(), packageRating: 5 } }, noBookingRes);
  assert.equal(noBookingRes.statusCode, 404);

  // ---- Create ----
  const createRes = makeRes();
  await ctrl.createReview({ auth: authAdmin(tenantId), body: { bookingId: booking._id.toString(), packageRating: 5, hotelRating: 4, comment: "Excellent trip" } }, createRes);
  assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body));
  assert.equal(createRes.body.data.status, "pending", "a new review must default to pending, not auto-published");
  assert.equal(createRes.body.data.customerId.toString(), customer._id.toString());
  const reviewId = createRes.body.data._id.toString();

  // ---- Duplicate for the same booking rejected ----
  const dupRes = makeRes();
  await ctrl.createReview({ auth: authAdmin(tenantId), body: { bookingId: booking._id.toString(), packageRating: 3 } }, dupRes);
  assert.equal(dupRes.statusCode, 409);

  // ---- List (read-only role) ----
  const listRes = makeRes();
  await ctrl.listReviews({ auth: authReadOnly(tenantId), query: { status: "pending" } }, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.data.items.length, 1);

  // ---- Read-only role cannot moderate ----
  const noModPermRes = makeRes();
  await ctrl.moderateReview({ auth: authReadOnly(tenantId), params: { reviewId }, body: { status: "published" } }, noModPermRes);
  assert.equal(noModPermRes.statusCode, 403);

  // ---- Invalid status value rejected ----
  const badStatusRes = makeRes();
  await ctrl.moderateReview({ auth: authAdmin(tenantId), params: { reviewId }, body: { status: "pending" } }, badStatusRes);
  assert.equal(badStatusRes.statusCode, 400);

  // ---- Moderate: publish ----
  const moderateRes = makeRes();
  await ctrl.moderateReview({ auth: authAdmin(tenantId), params: { reviewId }, body: { status: "published" } }, moderateRes);
  assert.equal(moderateRes.statusCode, 200, JSON.stringify(moderateRes.body));
  assert.equal(moderateRes.body.data.status, "published");
  assert.ok(moderateRes.body.data.moderatedAt);

  // ---- Unknown review -> 404 ----
  const notFoundRes = makeRes();
  await ctrl.moderateReview({ auth: authAdmin(tenantId), params: { reviewId: new mongoose.Types.ObjectId().toString() }, body: { status: "hidden" } }, notFoundRes);
  assert.equal(notFoundRes.statusCode, 404);
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
