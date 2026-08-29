import dotenv from "dotenv";

dotenv.config();

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
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

// PRD "CRM Feature Map by Phase" Phase 2 module 17 (Lead & Marketing
// Management) — config-driven enums, same env-override-with-JSON-fallback
// pattern as utils/packagePricingConfig.js/utils/financeConfig.js. Neither
// the source nor status vocabulary is hardcoded in the model/controller.
export const getLeadConfig = () => ({
  leadSources: parseStringList(process.env.LEAD_SOURCES_JSON, ["Website", "WalkIn", "Referral", "Campaign", "SocialMedia", "PhoneInquiry", "Other"]),
  defaultLeadSource: process.env.DEFAULT_LEAD_SOURCE || "Other",

  leadStatuses: parseStringList(process.env.LEAD_STATUSES_JSON, ["New", "Contacted", "Qualified", "Converted", "Lost"]),
  defaultLeadStatus: process.env.DEFAULT_LEAD_STATUS || "New",
  // A lead in one of these statuses is no longer actionable — excluded from
  // the pipeline's open-lead views and the follow-up reminder sweep.
  terminalLeadStatuses: parseStringList(process.env.TERMINAL_LEAD_STATUSES_JSON, ["Converted", "Lost"]),

  leadFollowUpReminderCronSchedule: process.env.LEAD_FOLLOWUP_REMINDER_CRON_SCHEDULE || "*/30 * * * *"
});
