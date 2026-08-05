import dotenv from 'dotenv';

dotenv.config();

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }
  return value;
};

// Unlike the other Travel sub-modules (flightConfig/hotelConfig/transportConfig/
// itineraryConfig/attendanceConfig), Incident Management already has a real,
// more sophisticated per-tenant configuration system: IncidentPolicyModel,
// DB-seeded via scripts/seedIncidentPolicy.js, read through
// EnterpriseIncidentEngineService.getPolicy(). That per-tenant DB policy
// remains the source of truth and is NOT replaced here. This file exists
// only to give getPolicy() a real, honest, env-overridable FALLBACK — for a
// tenant that hasn't been seeded yet — instead of the previous behavior
// (hard-throwing "No active incident policy is configured for this
// tenant.", which blocked incident creation entirely, including medical
// emergencies, for any un-seeded tenant). Also used to build the seed
// script's default category list additively (Visa's existing categories
// are never removed — see scripts/seedIncidentPolicy.js).
export const getIncidentConfig = () => ({
  defaultAssignmentTeam: process.env.INCIDENT_DEFAULT_ASSIGNMENT_TEAM || 'Operations',

  // "Incident Categories... Categories are configurable." Part 8's 18
  // categories — the seed script merges these additively with Visa's
  // existing, differently-named categories (Documentation/Passport/Embassy/
  // etc.) rather than replacing them, since Visa incidents already depend
  // on those names existing and being active.
  defaultCategories: parseJson(process.env.INCIDENT_CATEGORIES_JSON, [
    'Medical', 'Security', 'Transport', 'Hotel', 'Flight', 'Immigration', 'Visa',
    'Payment', 'Customer Complaint', 'Lost Passport', 'Lost Luggage', 'Traveler Missing',
    'Natural Disaster', 'Operational Delay', 'Supplier Failure', 'Technical Issue', 'Custom'
  ]),

  // Categories that lock the associated Visa Case when active (mirrors the
  // existing seed script's own locksVisaCase choices for its categories —
  // Security carried over exactly; the rest are genuinely new Part 8
  // categories with no prior Visa-locking precedent to preserve).
  categoriesThatLockVisaCase: parseJson(process.env.INCIDENT_LOCKING_CATEGORIES_JSON, [
    'Security', 'Lost Passport', 'Traveler Missing', 'Natural Disaster'
  ]),

  // "Incident Severity... Severity controls SLA, escalation, and
  // notifications." Matches EnterpriseIncidentEngineService.calculateSLA's
  // existing hardcoded fallback table exactly — moved here so it's the same
  // config-driven default used both by that in-memory fallback and by
  // getPolicy()'s new un-seeded-tenant fallback, instead of two disconnected
  // hardcoded copies.
  defaultSeverities: parseJson(process.env.INCIDENT_SEVERITIES_JSON, [
    { name: 'Low', firstResponseMins: 720, resolutionHours: 48, isActive: true, locksVisaCase: false },
    { name: 'Medium', firstResponseMins: 240, resolutionHours: 24, isActive: true, locksVisaCase: false },
    { name: 'High', firstResponseMins: 60, resolutionHours: 6, isActive: true, locksVisaCase: false },
    { name: 'Critical', firstResponseMins: 30, resolutionHours: 2, isActive: true, locksVisaCase: true },
    { name: 'Emergency', firstResponseMins: 15, resolutionHours: 1, isActive: true, locksVisaCase: true }
  ]),

  // "Incident Sources" (12) — model's own enum already carries 3 extra
  // values (CRM/HR/Compliance) that KPIEngine's analytics aggregation
  // depends on; kept here for documentation/override purposes without
  // narrowing the model's real enum.
  incidentSources: parseJson(process.env.INCIDENT_SOURCES_JSON, [
    'Flight', 'Hotel', 'Transport', 'Attendance', 'Visa', 'Finance', 'Customer',
    'Supplier', 'Guide', 'Driver', 'Operations', 'AI Monitoring'
  ]),

  // "Escalation Chain ... Escalation configurable." Was previously just a
  // documented concept — no field tracked how far an incident had been
  // pushed up the chain and nothing ever moved it. Walked by
  // services/incidentSlaScheduler.js whenever an open incident's
  // resolution SLA breaches.
  escalationChain: parseJson(process.env.INCIDENT_ESCALATION_CHAIN_JSON, [
    'Officer', 'Supervisor', 'Branch Manager', 'Operations Manager', 'Executive Dashboard'
  ]),

  // Attachments — "Supported Files" list, used as a real MIME-type
  // allowlist (Part 8's Incident Attachments section) rather than accepting
  // any file type unchecked.
  attachmentAllowedMimeTypes: parseJson(process.env.INCIDENT_ATTACHMENT_MIME_TYPES_JSON, [
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'video/mp4', 'video/quicktime',
    'application/pdf',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]),
  attachmentMaxSizeBytes: parseInt(process.env.INCIDENT_ATTACHMENT_MAX_SIZE_BYTES || '26214400', 10)
});
