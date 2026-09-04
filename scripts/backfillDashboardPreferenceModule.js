import dotenv from "dotenv";
import mongoose from "mongoose";

import DashboardPreferenceModel from "../models/DashboardPreferenceModel.js";

dotenv.config();

// One-time backfill for the "Reporting Platform Part 4" change:
// DashboardPreferenceModel gained a required `module` field. Every
// existing row was written by FinanceAnalyticsEngine (the only caller
// to date — see services/FinanceAnalyticsEngine.js's getPreferences/
// savePreferences), so backfilling "Finance" is not a guess. Safe to
// re-run (idempotent — a second run finds nothing left to set). Run
// manually once per environment, only after this deploy has shipped:
// `node scripts/backfillDashboardPreferenceModule.js`.
const migrate = async () => {
  const uri = process.env.URI;
  if (!uri) throw new Error("URI is required for migration.");
  await mongoose.connect(uri);

  const result = await DashboardPreferenceModel.collection.updateMany(
    { module: { $exists: false } },
    { $set: { module: "Finance" } }
  );

  console.log(`dashboard_preference: backfilled module="Finance" on ${result.modifiedCount} document(s).`);
  await mongoose.disconnect();
};

migrate().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
