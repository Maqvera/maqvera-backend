import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// One-time migration for the "bookingReference should be unique per tenant,
// not globally" schema bug (models/BookingHeaderModel.js). Run manually once
// per environment after deploying the tenant-scoped bookingReference change:
// `npm run migrate:booking-reference-scope`.
const migrate = async () => {
  const uri = process.env.URI;
  if (!uri) throw new Error("URI is required for migration.");
  await mongoose.connect(uri);

  const collection = mongoose.connection.db.collection("booking_headers");
  const existingIndexes = await collection.indexes();
  const staleIndex = existingIndexes.find((idx) => idx.name === "bookingReference_1" && idx.unique && Object.keys(idx.key).length === 1);
  if (staleIndex) {
    await collection.dropIndex("bookingReference_1");
    console.log("Dropped stale global-unique index booking_headers.bookingReference_1.");
  } else {
    console.log("No stale global-unique index booking_headers.bookingReference_1 found — nothing to drop.");
  }

  await collection.createIndex({ tenantId: 1, bookingReference: 1 }, { unique: true });
  console.log("Ensured compound tenant-scoped unique index booking_headers.{tenantId, bookingReference}.");

  console.log("Booking reference tenant-scope migration complete.");
  await mongoose.disconnect();
};

migrate().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
