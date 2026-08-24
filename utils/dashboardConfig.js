import dotenv from "dotenv";

dotenv.config();

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }
  return value;
};

const parseStringList = (value, fallback) => {
  const parsed = parseJson(value, fallback);
  if (!Array.isArray(parsed)) return fallback;
  return parsed.map((item) => `${item}`.trim()).filter(Boolean);
};

/**
 * Reporting Platform Part 4 fix — Dashboard Management. Mirrors
 * utils/financeConfig.js's own pattern (env override with JSON fallback)
 * so the set of modules that may own a dashboard/preference/alert stays
 * admin-configurable rather than hardcoded. This intentionally does NOT
 * take over financeConfig.js's existing dashboardAlertTypes/
 * dashboardAlertSeverities/dashboardRefreshIntervals — those stay
 * Finance-scoped since no Travel/Visa alerting is being added here; this
 * file only owns the cross-module `module` discriminator and the
 * DashboardWidgetContract's `type` enum.
 */
export const getDashboardConfig = () => ({
  // Reuses/mirrors DashboardPreferenceModel.module and
  // DashboardAlertModel.module's valid values.
  dashboardModules: parseStringList(process.env.DASHBOARD_MODULES_JSON, ["Finance", "Travel", "Visa"]),
  // utils/dashboardWidgetContract.js's normalizeWidget() validates
  // `type` against this list.
  widgetTypes: parseStringList(process.env.DASHBOARD_WIDGET_TYPES_JSON, ["metric", "series", "table", "alert", "map"]),
  // Reporting Platform Part 2 fix — ReportCatalogModel.lifecycleState's
  // valid values, in forward-transition order (ReportCatalogService.
  // transitionLifecycle validates against this array's index order).
  reportLifecycleStates: parseStringList(process.env.REPORT_LIFECYCLE_STATES_JSON, ["draft", "review", "published", "deprecated", "archived", "retired"]),
});

export default getDashboardConfig;
