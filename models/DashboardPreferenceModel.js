import mongoose from "mongoose";

// Enterprise Financial Dashboard — Finance Module Part 25.
// "Personalization: Saved Layouts, Favorite Widgets, Role Defaults,
// Custom Filters, Theme, Widget Preferences." One row per (user,
// dashboardType) — "Role Defaults" is satisfied by simply not having a
// saved preference yet (the dashboard falls back to its own real
// computed data with no layout override), not a separate stored
// default record. Tenant-scoped only — no branchId.
const DashboardPreferenceSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  // Config-driven (financeDashboardTypes).
  dashboardType: { type: String, required: true },
  layout: { type: mongoose.Schema.Types.Mixed, default: null },
  favoriteWidgets: { type: [String], default: [] },
  filters: { type: mongoose.Schema.Types.Mixed, default: {} },
  theme: { type: String, default: null },
  // Config-driven (dashboardRefreshIntervals).
  refreshInterval: { type: String, default: null }
}, { timestamps: true });

DashboardPreferenceSchema.index({ tenantId: 1, userId: 1, dashboardType: 1 }, { unique: true });

DashboardPreferenceSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const DashboardPreferenceModel = mongoose.model("dashboard_preference", DashboardPreferenceSchema);

export default DashboardPreferenceModel;
