import mongoose from "mongoose";
import SearchIndexModel from "../models/SearchIndexModel.js";
import SavedSearchModel from "../models/SavedSearchModel.js";
import SearchHistoryModel from "../models/SearchHistoryModel.js";
import EmployeeProfileModel from "../models/EmployeeProfilemodel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import CacheManager from "../utils/cacheManager.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import EnterpriseDocumentModel from "../models/EnterpriseDocumentModel.js";
import EmbassySubmissionModel from "../models/EmbassySubmissionModel.js";
import VisaAppointmentModel from "../models/VisaAppointmentModel.js";
import PassportTrackingModel from "../models/PassportTrackingModel.js";
import TravelIncidentManagementModel from "../models/TravelIncidentManagementModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import CustomerModel from "../models/CustomerModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import TravelPlanModel from "../models/TravelPlanModel.js";
import TravelFlightAssignmentModel from "../models/TravelFlightAssignmentModel.js";
import TravelHotelAssignmentModel from "../models/TravelHotelAssignmentModel.js";
import TravelTransportAssignmentModel from "../models/TravelTransportAssignmentModel.js";
import TravelNoteModel from "../models/TravelNoteModel.js";
import TravelItineraryModel from "../models/TravelItineraryModel.js";
import TravelAttendanceModel from "../models/TravelAttendanceModel.js";
import BookingTaskModel from "../models/BookingTaskModel.js";
import { publishEvent, subscribeEvent } from "../utils/eventBus.js";

const MAX_PAGE_SIZE = Number.parseInt(process.env.ENTERPRISE_SEARCH_MAX_PAGE_SIZE || "100", 10) || 100;
const CACHE_TTL_SECONDS = Number.parseInt(process.env.SEARCH_CACHE_TTL_SECONDS || "30", 10) || 30;
const FUZZY_MAX_DISTANCE = Number.parseInt(process.env.SEARCH_FUZZY_MAX_DISTANCE || "2", 10) || 2;
const FUZZY_CANDIDATE_LIMIT = Number.parseInt(process.env.SEARCH_FUZZY_CANDIDATE_LIMIT || "500", 10) || 500;
const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeArray = (value) => Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
const maskPassport = (value) => value ? `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}` : null;

/** Search Highlighting — "Matched Text, Highlighted Keywords". */
const buildHighlight = (text, term) => {
  if (!text || !term) return null;
  const idx = String(text).toLowerCase().indexOf(String(term).toLowerCase());
  if (idx === -1) return null;
  const raw = String(text);
  return { text: raw, highlighted: `${raw.slice(0, idx)}<mark>${raw.slice(idx, idx + term.length)}</mark>${raw.slice(idx + term.length)}` };
};

/**
 * Advanced Search — Boolean Operators (AND/OR), NOT/exclusion, Exact Phrase.
 * A real, bounded query parser (not a fake pass-through): default AND
 * across space-separated terms, explicit " OR " splits alternative groups,
 * a leading "-" or "NOT " excludes a term, and a fully-quoted query is an
 * exact phrase. Wildcards/nested filters need a real search engine
 * (OpenSearch/Elasticsearch, per the doc's own "Search Performance"
 * section) and are intentionally not faked here.
 */
const parseSearchQuery = (raw) => {
  let term = String(raw || "").trim();
  if (!term) return { orGroups: [], excluded: [], phrase: null };
  const phraseMatch = term.match(/^"(.+)"$/);
  if (phraseMatch) return { orGroups: [], excluded: [], phrase: phraseMatch[1] };

  const excluded = [];
  term = term.replace(/(?:^|\s)(?:NOT\s+|-)("[^"]+"|\S+)/gi, (_, t) => {
    excluded.push(t.replace(/^"|"$/g, ""));
    return " ";
  }).trim();

  const orGroups = term.split(/\s+OR\s+/i)
    .map((segment) => (segment.match(/"[^"]+"|\S+/g) || [])
      .filter((t) => !/^AND$/i.test(t))
      .map((t) => t.replace(/^"|"$/g, "")))
    .filter((group) => group.length > 0);

  return { orGroups, excluded, phrase: null };
};

/** Fuzzy Search fallback — bounded Levenshtein distance, only when the
 * exact/boolean pass returns zero hits. Honest limitation: this scans a
 * capped candidate pool in JS, not a real fuzzy index — the doc's own
 * "Search Performance" section names OpenSearch/Elasticsearch as the
 * eventual real answer for typo-tolerant search at scale. */
const levenshteinDistance = (a, b) => {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
};

class SearchEngineService {
  static initialized = false;

  /** Register only asynchronous index writers. Search requests never touch source tables. */
  static init() {
    if (this.initialized) return;
    this.initialized = true;
    const handlers = {
      VisaCaseCreated: (p) => this.indexVisaCase(p),
      VisaCaseUpdated: (p) => this.indexVisaCase(p),
      VisaCaseArchived: (p) => this.removeEntity({ ...p, entityType: "VisaCase", entityId: p.visaCaseId }),
      CustomerCreated: (p) => this.indexTraveler(p),
      CustomerUpdated: (p) => this.indexTraveler(p),
      CustomerArchived: (p) => this.removeEntity({ ...p, entityType: "Traveler", entityId: p.customerId }),
      DocumentUploaded: (p) => this.indexDocument(p),
      DocumentVersionCreated: (p) => this.indexDocument(p),
      DocumentVerified: (p) => this.indexDocument(p),
      DocumentApproved: (p) => this.indexDocument(p),
      DocumentRejected: (p) => this.indexDocument(p),
      DocumentExpired: (p) => this.indexDocument(p),
      DocumentArchived: (p) => this.removeEntity({ ...p, entityType: "Document", entityId: p.documentId }),
      EmbassySubmissionCreated: (p) => this.indexEmbassySubmission(p),
      EmbassySubmissionUpdated: (p) => this.indexEmbassySubmission(p),
      VisaDecisionReceived: (p) => this.indexEmbassySubmission(p),
      AppointmentScheduled: (p) => this.indexAppointment(p),
      AppointmentUpdated: (p) => this.indexAppointment(p),
      AppointmentRescheduled: (p) => this.indexAppointment(p),
      AppointmentCompleted: (p) => this.indexAppointment(p),
      PassportReceived: (p) => this.indexPassport(p),
      PassportCustodyChanged: (p) => this.indexPassport(p),
      PassportDispatched: (p) => this.indexPassport(p),
      PassportReturned: (p) => this.indexPassport(p),
      PassportCollected: (p) => this.indexPassport(p),
      IncidentCreated: (p) => this.indexIncident(p),
      IncidentUpdated: (p) => this.indexIncident(p),
      IncidentResolved: (p) => this.indexIncident(p),
      TimelineEventCreated: (p) => this.indexTimelineEvent(p),
      // Travel Operations entities. Centralized here (rather than left as the
      // ad-hoc, no-permissionsRequired, create-only indexEntity calls that
      // used to live in TravelOrchestrationEngine) so every entity type gets
      // a real DB-backed lookup, a correct permissionsRequired gate, and
      // re-indexing on update — not just on first creation.
      TravelPlanCreated: (p) => this.indexTravelPlan(p),
      TravelPlanUpdated: (p) => this.indexTravelPlan(p),
      TravelPlanStatusChanged: (p) => this.indexTravelPlan(p),
      TravelPlanArchived: (p) => this.removeEntity({ ...p, entityType: "TravelPlan", entityId: p.travelPlanId }),
      FlightAssigned: (p) => this.indexFlight(p),
      FlightUpdated: (p) => this.indexFlight(p),
      FlightStatusUpdated: (p) => this.indexFlight(p),
      HotelAssigned: (p) => this.indexHotel(p),
      HotelUpdated: (p) => this.indexHotel(p),
      HotelStatusUpdated: (p) => this.indexHotel(p),
      TransportAssigned: (p) => this.indexTransport(p),
      TransportStatusUpdated: (p) => this.indexTransport(p),
      BookingCreated: (p) => this.indexBooking(p),
      BookingUpdated: (p) => this.indexBooking(p),
      BookingStatusChanged: (p) => this.indexBooking(p),
      BookingArchived: (p) => this.removeEntity({ ...p, entityType: "Booking", entityId: p.bookingId }),
      NoteCreated: (p) => this.indexNote(p),
      NoteUpdated: (p) => this.indexNote(p),
      NoteDeleted: (p) => this.removeEntity({ ...p, entityType: "Note", entityId: p.noteId }),
      ActivityScheduled: (p) => this.indexItineraryActivity(p),
      ActivityUpdated: (p) => this.indexItineraryActivity(p),
      ActivityRescheduled: (p) => this.indexItineraryActivity(p),
      AttendanceRecorded: (p) => this.indexAttendance(p),
      BookingTaskCreated: (p) => this.indexTask(p),
      BookingTaskAssigned: (p) => this.indexTask(p),
    };
    for (const [eventName, handler] of Object.entries(handlers)) {
      subscribeEvent(eventName, (payload) => queueMicrotask(() => handler(payload).catch((error) =>
        console.error(`Enterprise search index failed for ${eventName}:`, error.message)
      )));
    }
  }

  static async indexEntity({ tenantId, branchId = "main", entityType, entityId, title, description = "", keywords = [], matchedFields = [], module, status = "Active", navigationUrl, permissionsRequired = [], facets = {} }) {
    if (!tenantId || !entityType || !entityId || !title || !module || !navigationUrl) return null;
    const existedBefore = await SearchIndexModel.exists({ tenantId, entityType, entityId: String(entityId) });
    const index = await SearchIndexModel.findOneAndUpdate(
      { tenantId, entityType, entityId: String(entityId) },
      { $set: { tenantId, branchId, entityType, entityId: String(entityId), title, description, keywords, matchedFields, module, status, navigationUrl, permissionsRequired, facets, isSoftDeleted: false } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    publishEvent(existedBefore ? "SearchIndexUpdated" : "SearchIndexCreated", { tenantId, branchId, entityType, entityId: String(entityId) });
    await this._invalidateSearchCache(tenantId);
    return index;
  }

  static async removeEntity({ tenantId, entityType, entityId }) {
    if (!tenantId || !entityType || !entityId) return;
    await SearchIndexModel.updateOne({ tenantId, entityType, entityId: String(entityId) }, { $set: { isSoftDeleted: true } });
    publishEvent("SearchIndexDeleted", { tenantId, entityType, entityId: String(entityId) });
    await this._invalidateSearchCache(tenantId);
  }

  /** "Search Performance... Redis Cache" — a search index write must
   * invalidate any cached result pages for that tenant, or a just-created
   * entity would stay invisible in cached search results for up to
   * CACHE_TTL_SECONDS. */
  static async _invalidateSearchCache(tenantId) {
    await CacheManager.invalidatePattern(`enterprise-search:${tenantId}:*`);
    publishEvent("SearchCacheRefreshed", { tenantId });
  }

  static async indexVisaCase({ tenantId, visaCaseId, branchId }) {
    if (!tenantId || !visaCaseId) return;
    const item = await VisaCaseModel.findOne({ _id: visaCaseId, tenantId, isSoftDeleted: { $ne: true } }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "VisaCase", entityId: visaCaseId });
    const traveler = item.travelerSnapshot || {};
    return this.indexEntity({
      tenantId, branchId: item.branchId || branchId, entityType: "VisaCase", entityId: item._id,
      title: `${item.caseNumber} — ${traveler.fullName || [traveler.firstName, traveler.lastName].filter(Boolean).join(" ") || "Traveler"}`,
      description: `${item.visaType || "Visa"} application for ${item.destinationCountry || ""}`.trim(),
      keywords: [item.caseNumber, traveler.fullName, traveler.passportNumber, traveler.nationality, item.destinationCountry, item.visaType, item.bookingNumber].filter(Boolean),
      matchedFields: [{ field: "caseNumber", value: item.caseNumber }, { field: "traveler", value: traveler.fullName }, { field: "passportNumber", value: traveler.passportNumber }].filter((f) => f.value),
      module: "Visa", status: item.status, navigationUrl: `/visa-cases/${item._id}`,
      permissionsRequired: ["visa.read"],
      facets: { country: item.destinationCountry, visaType: item.visaType, officer: item.assignedTo, nationality: traveler.nationality, priority: item.priority, status: item.status },
    });
  }

  static async indexDocument({ tenantId, documentId, branchId }) {
    if (!tenantId || !documentId) return;
    const item = await EnterpriseDocumentModel.findOne({ _id: documentId, tenantId, isSoftDeleted: { $ne: true } }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "Document", entityId: documentId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "Document", entityId: item._id,
      title: item.title || item.documentType, description: item.remarks || "Visa document", keywords: [item.documentType, item.title, ...(item.tags || [])].filter(Boolean),
      matchedFields: [{ field: "documentType", value: item.documentType }, { field: "title", value: item.title }].filter((f) => f.value),
      module: item.module || "Visa", status: item.approvalStatus || item.verificationStatus, navigationUrl: `/documents/${item._id}`,
      permissionsRequired: ["visa.documents.read"], facets: { documentType: item.documentType, status: item.approvalStatus, verificationStatus: item.verificationStatus },
    });
  }

  static async indexTraveler({ tenantId, customerId, branchId }) {
    if (!tenantId || !customerId) return;
    const item = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "Traveler", entityId: customerId });
    const fullName = [item.firstName, item.middleName, item.lastName].filter(Boolean).join(" ");
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "Traveler", entityId: item._id,
      title: fullName || item.customerCode, description: item.customerCode || "Traveler",
      keywords: [fullName, item.customerCode, item.phone, item.email, item.nationalId, item.nationality].filter(Boolean),
      matchedFields: [{ field: "name", value: fullName }, { field: "customerCode", value: item.customerCode }, { field: "phone", value: item.phone }].filter((f) => f.value),
      module: "CRM", status: item.status, navigationUrl: `/customers/${item._id}`, permissionsRequired: ["customers.read"],
      facets: { nationality: item.nationality, customerType: item.type, status: item.status, priority: item.category },
    });
  }

  static async indexEmbassySubmission({ tenantId, submissionId, branchId }) {
    if (!tenantId || !submissionId) return;
    const item = await EmbassySubmissionModel.findOne({ _id: submissionId, tenantId, isSoftDeleted: { $ne: true } }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "EmbassySubmission", entityId: submissionId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "EmbassySubmission", entityId: item._id,
      title: `${item.submissionNumber} — ${item.embassyName}`, description: `Visa case ${item.caseNumber}`,
      keywords: [item.submissionNumber, item.caseNumber, item.embassyName, item.destinationCountry, item.courierTracking?.trackingNumber].filter(Boolean),
      matchedFields: [{ field: "submissionNumber", value: item.submissionNumber }, { field: "embassy", value: item.embassyName }],
      module: "Visa", status: item.status, navigationUrl: `/embassy-submissions/${item._id}`, permissionsRequired: ["visa.embassy.read"],
      facets: { embassy: item.embassyId || item.embassyName, country: item.destinationCountry, officer: item.assignedOfficer, status: item.status },
    });
  }

  static async indexAppointment({ tenantId, appointmentId, branchId }) {
    if (!tenantId || !appointmentId) return;
    const item = await VisaAppointmentModel.findOne({ _id: appointmentId, tenantId, isSoftDeleted: { $ne: true } }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "Appointment", entityId: appointmentId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "Appointment", entityId: item._id,
      title: `${item.appointmentType} — ${item.caseNumber}`, description: `${item.providerName || ""} ${item.location || ""}`.trim(),
      keywords: [item.appointmentNumber, item.caseNumber, item.appointmentType, item.providerName, item.location].filter(Boolean),
      matchedFields: [{ field: "appointmentNumber", value: item.appointmentNumber }, { field: "caseNumber", value: item.caseNumber }],
      module: "Visa", status: item.status, navigationUrl: `/appointments/${item._id}`, permissionsRequired: ["visa.appointments.read"],
      facets: { officer: item.assignedOfficer, appointmentType: item.appointmentType, status: item.status },
    });
  }

  static async indexPassport({ tenantId, passportId, branchId }) {
    if (!tenantId || !passportId) return;
    const item = await PassportTrackingModel.findOne({ _id: passportId, tenantId }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "Passport", entityId: passportId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "Passport", entityId: item._id,
      title: `Passport ${maskPassport(item.passportNumber)} — ${item.currentStatus}`, description: `${item.nationality || ""} ${item.embassyName || ""}`.trim(),
      keywords: [item.passportNumber, item.trackingNumber, item.nationality, item.embassyName].filter(Boolean),
      matchedFields: [{ field: "passportNumber", value: item.passportNumber }, { field: "trackingNumber", value: item.trackingNumber }].filter((f) => f.value),
      module: "Visa", status: item.currentStatus, navigationUrl: `/visa-cases/${item.visaCaseId}/passport`, permissionsRequired: ["visa.passports.read"],
      facets: { nationality: item.nationality, embassy: item.embassyName, status: item.currentStatus },
    });
  }

  static async indexIncident({ tenantId, incidentId, branchId }) {
    if (!tenantId || !incidentId) return;
    const item = await TravelIncidentManagementModel.findOne({ _id: incidentId, tenantId, isSoftDeleted: { $ne: true } }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "Incident", entityId: incidentId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "Incident", entityId: item._id,
      title: `[${item.severity}] ${item.incidentNumber} — ${item.title}`, description: item.description,
      keywords: [item.incidentNumber, item.title, item.description, item.category, item.visaCaseNumber].filter(Boolean),
      matchedFields: [{ field: "incidentNumber", value: item.incidentNumber }, { field: "title", value: item.title }],
      module: item.sourceModule || "Visa", status: item.status, navigationUrl: `/incidents/${item._id}`, permissionsRequired: ["incidents.read"],
      facets: { severity: item.severity, category: item.category, officer: item.assignedTo, status: item.status },
    });
  }

  static async indexTravelPlan({ tenantId, travelPlanId, branchId }) {
    if (!tenantId || !travelPlanId) return;
    const item = await TravelPlanModel.findOne({ _id: travelPlanId, tenantId }).lean();
    if (!item || item.isArchived) return this.removeEntity({ tenantId, entityType: "TravelPlan", entityId: travelPlanId });
    const customerName = item.bookingSnapshot?.customerName;
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "TravelPlan", entityId: item._id,
      title: `${item.travelPlanNumber} — ${customerName || "Traveler"}`, description: `${item.travelType || "Travel"} · ${item.status}`,
      keywords: [item.travelPlanNumber, item.bookingNumber, customerName, item.coordinator].filter(Boolean),
      matchedFields: [{ field: "travelPlanNumber", value: item.travelPlanNumber }, { field: "customerName", value: customerName }].filter((f) => f.value),
      module: "TravelOperations", status: item.status, navigationUrl: `/travel-plans/${item._id}`, permissionsRequired: ["travel.read", "travel_plans.read"],
      facets: { branch: item.branchId, status: item.status, travelType: item.travelType, priority: item.priority },
    });
  }

  static async indexFlight({ tenantId, travelPlanId, flightAssignmentId, branchId }) {
    if (!tenantId || !flightAssignmentId) return;
    const item = await TravelFlightAssignmentModel.findOne({ _id: flightAssignmentId, tenantId }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "Flight", entityId: flightAssignmentId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "Flight", entityId: item._id,
      title: `${item.airline} ${item.flightNumber} — ${item.originAirport} → ${item.destinationAirport}`, description: `Flight status: ${item.status}`,
      keywords: [item.airline, item.flightNumber, item.originAirport, item.destinationAirport].filter(Boolean),
      matchedFields: [{ field: "flightNumber", value: item.flightNumber }, { field: "airline", value: item.airline }].filter((f) => f.value),
      module: "FlightOperations", status: item.status, navigationUrl: `/travel-plans/${item.travelPlanId}/flights/${item._id}`, permissionsRequired: ["travel.read", "travel_plans.read"],
      facets: { status: item.status, airline: item.airline, priority: item.priority },
    });
  }

  static async indexHotel({ tenantId, travelPlanId, hotelAssignmentId, branchId }) {
    if (!tenantId || !hotelAssignmentId) return;
    const item = await TravelHotelAssignmentModel.findOne({ _id: hotelAssignmentId, tenantId }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "Hotel", entityId: hotelAssignmentId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "Hotel", entityId: item._id,
      title: `${item.hotelName} — ${item.city}`, description: `Hotel status: ${item.status}`,
      keywords: [item.hotelName, item.city, item.country].filter(Boolean),
      matchedFields: [{ field: "hotelName", value: item.hotelName }, { field: "city", value: item.city }].filter((f) => f.value),
      module: "HotelOperations", status: item.status, navigationUrl: `/travel-plans/${item.travelPlanId}/hotels/${item._id}`, permissionsRequired: ["travel.read", "travel_plans.read"],
      facets: { status: item.status, city: item.city, priority: item.priority },
    });
  }

  static async indexTransport({ tenantId, travelPlanId, transportAssignmentId, branchId }) {
    if (!tenantId || !transportAssignmentId) return;
    const item = await TravelTransportAssignmentModel.findOne({ _id: transportAssignmentId, tenantId }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "Transport", entityId: transportAssignmentId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "Transport", entityId: item._id,
      title: `${item.vehicleType} ${item.vehicleNumber} — ${item.journeySegment}`, description: `${item.pickupLocation} → ${item.dropoffLocation}`,
      keywords: [item.vehicleNumber, item.plateNumber, item.driverName, item.routeName, item.pickupLocation, item.dropoffLocation].filter(Boolean),
      matchedFields: [{ field: "vehicleNumber", value: item.vehicleNumber }, { field: "driverName", value: item.driverName }].filter((f) => f.value),
      module: "TransportOperations", status: item.status, navigationUrl: `/travel-plans/${item.travelPlanId}/transport/${item._id}`, permissionsRequired: ["travel.read", "travel_plans.read"],
      facets: { status: item.status, transportType: item.transportType, priority: item.priority },
    });
  }

  static async indexBooking({ tenantId, bookingId, branchId }) {
    if (!tenantId || !bookingId) return;
    const item = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
    if (!item || item.status === "archived") return this.removeEntity({ tenantId, entityType: "Booking", entityId: bookingId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "Booking", entityId: item._id,
      title: `${item.bookingNumber || item.bookingReference} — ${item.customerName || "Customer"}`, description: `${item.bookingType || "Booking"} · ${item.status}`,
      keywords: [item.bookingNumber, item.bookingReference, item.customerName, item.customerCode].filter(Boolean),
      matchedFields: [{ field: "bookingNumber", value: item.bookingNumber }, { field: "customerName", value: item.customerName }].filter((f) => f.value),
      module: "Booking", status: item.status, navigationUrl: `/bookings/${item._id}`, permissionsRequired: ["bookings.read", "booking.read"],
      facets: { branch: item.branchId, status: item.status, bookingType: item.bookingType, priority: item.priority },
    });
  }

  static async indexNote({ tenantId, noteId, branchId }) {
    if (!tenantId || !noteId) return;
    const item = await TravelNoteModel.findOne({ noteId, tenantId, isSoftDeleted: { $ne: true } }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "Note", entityId: noteId });
    // Private notes have no owner-scoped filter in the search index (only
    // coarse permissionsRequired matching), so indexing one would leak it to
    // every travel.read holder — skip indexing entirely rather than expose it.
    if (item.visibility === "Private") return this.removeEntity({ tenantId, entityType: "Note", entityId: item.noteId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "Note", entityId: item.noteId,
      title: item.title, description: item.content?.slice(0, 200) || "",
      keywords: [item.title, item.content, item.authorName].filter(Boolean),
      matchedFields: [{ field: "title", value: item.title }].filter((f) => f.value),
      module: "TravelOperations", status: item.visibility, navigationUrl: `/travel-plans/${item.travelPlanId}/notes/${item.noteId}`, permissionsRequired: ["travel.read", "travel_plans.read"],
      facets: { visibility: item.visibility, author: item.authorId },
    });
  }

  static async indexItineraryActivity({ tenantId, travelPlanId, activityId, branchId }) {
    if (!tenantId || !activityId) return;
    const item = await TravelItineraryModel.findOne({ _id: activityId, tenantId }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "ItineraryActivity", entityId: activityId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "ItineraryActivity", entityId: item._id,
      title: `Day ${item.day}: ${item.title}`, description: `${item.activityType} · ${item.status}`,
      keywords: [item.title, item.activityType, item.location?.name, item.resources?.guideName].filter(Boolean),
      matchedFields: [{ field: "title", value: item.title }, { field: "activityType", value: item.activityType }].filter((f) => f.value),
      module: "ItineraryOperations", status: item.status, navigationUrl: `/travel-plans/${item.travelPlanId}/itinerary/${item._id}`, permissionsRequired: ["travel.read", "travel_plans.read"],
      facets: { status: item.status, activityType: item.activityType, day: item.day, priority: item.priority },
    });
  }

  static async indexAttendance({ tenantId, travelPlanId, attendanceId, branchId }) {
    if (!tenantId || !attendanceId) return;
    const item = await TravelAttendanceModel.findOne({ _id: attendanceId, tenantId }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "Attendance", entityId: attendanceId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "Attendance", entityId: item._id,
      title: `${item.travelerName} — ${item.status}`, description: `Attendance check for Travel Plan ${item.travelPlanId}`,
      keywords: [item.travelerName, item.status].filter(Boolean),
      matchedFields: [{ field: "travelerName", value: item.travelerName }].filter((f) => f.value),
      module: "AttendanceOperations", status: item.status, navigationUrl: `/travel-plans/${item.travelPlanId}/attendance/${item._id}`, permissionsRequired: ["travel.read", "travel_plans.read"],
      facets: { status: item.status, verificationMethod: item.verificationMethod },
    });
  }

  static async indexTask({ tenantId, taskId, branchId }) {
    if (!tenantId || !taskId) return;
    const item = await BookingTaskModel.findOne({ _id: taskId, tenantId }).lean();
    if (!item || item.status !== "active") return this.removeEntity({ tenantId, entityType: "Task", entityId: taskId });
    return this.indexEntity({ tenantId, branchId, entityType: "Task", entityId: item._id,
      title: item.title, description: item.description || `${item.entityType} task`,
      keywords: [item.title, item.assignedToName, item.entityType].filter(Boolean),
      matchedFields: [{ field: "title", value: item.title }].filter((f) => f.value),
      module: "TaskManagement", status: item.workflowStatus, navigationUrl: `/bookings/${item.bookingId}/tasks/${item._id}`, permissionsRequired: ["bookings.read", "booking.read"],
      facets: { status: item.workflowStatus, priority: item.priority, entityType: item.entityType, assignedTo: item.assignedTo },
    });
  }

  static async indexTimelineEvent({ tenantId, eventId, branchId }) {
    if (!tenantId || !eventId) return;
    const item = await TravelTimelineModel.findOne({ _id: eventId, tenantId, archivedAt: null }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "TimelineEvent", entityId: eventId });
    // Private timeline entries (e.g. mirrored from a Private note) have the
    // same owner-scoping gap as Notes — skip indexing rather than leak them.
    if (item.visibility === "Private") return this.removeEntity({ tenantId, entityType: "TimelineEvent", entityId: eventId });
    const isTravelSourced = Boolean(item.travelPlanId);
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "TimelineEvent", entityId: item._id,
      title: item.title || item.eventType, description: item.description || "", keywords: [item.title, item.description, item.eventType, item.sourceModule].filter(Boolean),
      matchedFields: [{ field: "title", value: item.title }, { field: "description", value: item.description }].filter((f) => f.value),
      module: item.sourceModule || (isTravelSourced ? "TravelOperations" : "Visa"), status: "Active",
      navigationUrl: isTravelSourced ? `/travel-plans/${item.travelPlanId}/timeline/${item._id}` : `/visa-cases/${item.visaCaseId}/timeline/${item._id}`,
      permissionsRequired: isTravelSourced ? ["travel.read", "travel_plans.read"] : ["visa.timeline.read"],
      facets: { aggregateType: item.aggregateType, sourceModule: item.sourceModule, visibility: item.visibility },
    });
  }

  static async globalSearch({ tenantId, query = "", entityType, branchId, permissions = [], filters = {}, page = 1, pageSize = 20, sort = "score", order = "desc" }) {
    const safePage = Math.max(Number.parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(Number.parseInt(pageSize, 10) || 20, 1), MAX_PAGE_SIZE);
    const term = String(query || "").trim();
    const permissionList = normalizeArray(permissions).slice().sort();

    // Cache key includes the requester's permission set — search results are
    // role-filtered, so two users with different permissions must never
    // share a cached page.
    const cacheKey = [
      "enterprise-search", tenantId, branchId || "main",
      entityType ? normalizeArray(entityType).slice().sort().join(",") : "*",
      term, JSON.stringify(filters || {}), safePage, safePageSize, sort, order, permissionList.join(",")
    ].join(":");

    const { data, fromCache } = await CacheManager.getOrCompute(
      cacheKey,
      () => this._computeGlobalSearch({ tenantId, term, entityType, branchId, permissionList, filters, safePage, safePageSize, sort, order }),
      CACHE_TTL_SECONDS
    );
    return { results: data.results, meta: { ...data.meta, fromCache } };
  }

  static async _computeGlobalSearch({ tenantId, term, entityType, branchId, permissionList, filters, safePage, safePageSize, sort, order }) {
    const filter = { tenantId, isSoftDeleted: false };
    if (entityType) filter.entityType = { $in: normalizeArray(entityType) };
    if (branchId && branchId !== "all") filter.branchId = branchId;
    filter.$or = [{ permissionsRequired: { $size: 0 } }, { permissionsRequired: { $in: permissionList } }];
    for (const key of ["country", "embassy", "visaType", "status", "officer", "nationality", "priority", "severity"]) {
      if (filters[key]) filter[`facets.${key}`] = { $in: normalizeArray(filters[key]) };
    }
    if (filters.dateFrom || filters.dateTo) {
      filter.createdAt = {};
      if (filters.dateFrom) filter.createdAt.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) filter.createdAt.$lte = new Date(filters.dateTo);
    }

    const fieldMatch = (t) => {
      const expr = new RegExp(escapeRegex(t), "i");
      return { $or: [{ title: expr }, { description: expr }, { keywords: expr }, { "matchedFields.value": expr }] };
    };
    const parsed = parseSearchQuery(term);
    if (parsed.phrase) {
      filter.$and = [...(filter.$and || []), fieldMatch(parsed.phrase)];
    } else if (parsed.orGroups.length > 0) {
      filter.$and = [...(filter.$and || []), { $or: parsed.orGroups.map((group) => ({ $and: group.map(fieldMatch) })) }];
    }
    if (parsed.excluded.length > 0) {
      filter.$nor = parsed.excluded.map(fieldMatch);
    }

    let totalItems = await SearchIndexModel.countDocuments(filter);
    const dbSort = sort === "createdAt" ? { createdAt: order === "asc" ? 1 : -1 } : { relevanceBaseScore: -1, updatedAt: -1 };
    let documents = await SearchIndexModel.find(filter).sort(dbSort).skip((safePage - 1) * safePageSize).limit(safePageSize).lean();

    const queryLower = term.toLowerCase();
    let fuzzyApplied = false;
    if (totalItems === 0 && queryLower.length >= 3) {
      const candidateFilter = { tenantId, isSoftDeleted: false, $or: filter.$or };
      if (filter.branchId) candidateFilter.branchId = filter.branchId;
      if (filter.entityType) candidateFilter.entityType = filter.entityType;
      const candidates = await SearchIndexModel.find(candidateFilter).sort({ updatedAt: -1 }).limit(FUZZY_CANDIDATE_LIMIT).lean();
      const scored = candidates
        .map((doc) => {
          const titleWindow = doc.title.toLowerCase().slice(0, queryLower.length + FUZZY_MAX_DISTANCE);
          const keywordDistances = (doc.keywords || []).map((k) => levenshteinDistance(queryLower, String(k).toLowerCase().slice(0, queryLower.length + FUZZY_MAX_DISTANCE)));
          const distance = Math.min(levenshteinDistance(queryLower, titleWindow), ...(keywordDistances.length ? keywordDistances : [Infinity]));
          return { doc, distance };
        })
        .filter((item) => item.distance <= FUZZY_MAX_DISTANCE)
        .sort((a, b) => a.distance - b.distance);
      if (scored.length > 0) {
        fuzzyApplied = true;
        totalItems = scored.length;
        documents = scored.slice((safePage - 1) * safePageSize, safePage * safePageSize).map((item) => item.doc);
      }
    }

    // Search Ranking Algorithm: Exact(100) > Prefix(90) > Contains(75) >
    // Fuzzy fallback(50) > Phonetic/other(60). True phonetic matching needs a
    // real search engine — the tiers here are the closest honest analog with
    // the current MongoDB-regex/Levenshtein index.
    const results = documents.map((doc) => {
      const titleLower = doc.title.toLowerCase();
      const match = (doc.matchedFields || []).find((field) => String(field.value || "").toLowerCase().includes(queryLower));
      let score = doc.relevanceBaseScore ?? 70;
      if (fuzzyApplied) score = 50;
      else if (queryLower) {
        if (titleLower === queryLower) score = 100;
        else if (titleLower.startsWith(queryLower)) score = 90;
        else if (titleLower.includes(queryLower)) score = 75;
        else score = 60;
      }
      const highlightSource = match ? match.value : doc.title;
      const highlight = buildHighlight(highlightSource, term) || buildHighlight(doc.title, term);
      return {
        entityType: doc.entityType, entityId: doc.entityId, title: doc.title, description: doc.description,
        matchedField: match ? match.field : null, matchedText: highlight ? highlight.text : null,
        highlightedMatch: highlight ? highlight.highlighted : null,
        module: doc.module, status: doc.status, navigationUrl: doc.navigationUrl,
        score, confidenceScore: score, isFuzzyMatch: fuzzyApplied,
        createdDate: doc.createdAt, facets: doc.facets || {}
      };
    }).sort((a, b) => sort === "score" ? (order === "asc" ? a.score - b.score : b.score - a.score) : 0);

    // isFallback signals a cold/empty search index for this tenant (nothing
    // has been indexed yet) rather than "this particular query had 0 hits" —
    // lets the client distinguish "no matches" from "search isn't warmed up".
    let isFallback = false;
    if (totalItems === 0) {
      const tenantHasAnyIndex = await SearchIndexModel.exists({ tenantId, isSoftDeleted: false });
      isFallback = !tenantHasAnyIndex;
    }
    return { results, meta: { page: safePage, pageSize: safePageSize, totalItems, totalPages: Math.ceil(totalItems / safePageSize) || 1, isFallback, isFuzzyMatch: fuzzyApplied, source: "enterprise-search-index" } };
  }

  static async recordSearch({ tenantId, userId, query, filters, resultCount }) {
    if (!tenantId || !userId) return;
    await SearchHistoryModel.create({ tenantId, userId, query, filters, resultCount, accessedAt: new Date() });
    // Doc names this domain event "SearchRequested"; kept alongside the
    // existing "SearchPerformed" name so nothing already listening breaks.
    publishEvent("SearchRequested", { tenantId, userId, query, resultCount });
    publishEvent("SearchPerformed", { tenantId, userId, query, resultCount });

    // "Security... Search Audit Logging" — was entirely absent; every other
    // read-sensitive module in this codebase (dashboards, incidents, notes)
    // already writes an AuditLogModel entry for its access, search didn't.
    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({
        tenantId, userId, action: "SEARCH_QUERY", module: "EnterpriseSearch",
        details: { query, filters, resultCount }
      }).catch((err) => console.error("Search audit log error:", err));
    }
  }

  static async getSuggestions({ tenantId, userId, branchId, permissions = [] }) {
    const scope = { tenantId, ...(branchId && branchId !== "all" ? { branchId } : {}), isSoftDeleted: false, $or: [{ permissionsRequired: { $size: 0 } }, { permissionsRequired: { $in: normalizeArray(permissions) } }] };
    const [recentSearches, frequentlyAccessed] = await Promise.all([
      SearchHistoryModel.find({ tenantId, userId }).sort({ accessedAt: -1 }).limit(10).lean(),
      SearchIndexModel.find(scope).sort({ updatedAt: -1 }).limit(10).lean(),
    ]);
    publishEvent("SearchSuggestionGenerated", { tenantId, userId, count: recentSearches.length + frequentlyAccessed.length });
    return {
      recentSearches: recentSearches.map((item) => ({ query: item.query, filters: item.filters, accessedAt: item.accessedAt })),
      frequentlyAccessed: frequentlyAccessed.map((item) => ({ entityType: item.entityType, entityId: item.entityId, title: item.title, navigationUrl: item.navigationUrl })),
    };
  }

  static async saveSearch({ tenantId, userId, queryName, queryParams, visibility = "private", isPinned = false }) {
    const saved = await SavedSearchModel.create({ tenantId, userId, name: queryName, queryParams, visibility, isPinned });
    if (mongoose.connection?.readyState === 1) {
      AuditLogModel.create({ tenantId, userId, action: "CREATE_SAVED_SEARCH", module: "EnterpriseSearch", resourceId: saved._id.toString(), details: { name: queryName, visibility } })
        .catch((err) => console.error("Saved search audit log error:", err));
    }
    return saved;
  }

  /**
   * "Saved Searches... Department searches" — a `visibility: "department"`
   * saved search was persisted but never actually surfaced to anyone but its
   * own author (listSavedSearches only ever queried by userId). Resolves the
   * requester's department via EmployeeProfileModel and includes department-
   * visible searches from teammates in the same department.
   */
  static async listSavedSearches({ tenantId, userId }) {
    const own = await SavedSearchModel.find({ tenantId, userId, isSoftDeleted: false }).sort({ isPinned: -1, updatedAt: -1 }).lean();
    if (mongoose.connection?.readyState !== 1) return own;

    const profile = await EmployeeProfileModel.findOne({ tenantId, identityId: userId }).select("departmentId").lean();
    if (!profile?.departmentId) return own;

    const teammates = await EmployeeProfileModel.find({ tenantId, departmentId: profile.departmentId, identityId: { $ne: userId } }).select("identityId").lean();
    const teammateIds = teammates.map((t) => String(t.identityId)).filter(Boolean);
    if (teammateIds.length === 0) return own;

    const departmentShared = await SavedSearchModel.find({ tenantId, userId: { $in: teammateIds }, visibility: "department", isSoftDeleted: false }).sort({ updatedAt: -1 }).lean();
    return [...own, ...departmentShared.map((item) => ({ ...item, isOwnSearch: false }))];
  }

  static async deleteSavedSearch({ tenantId, userId, savedSearchId }) {
    const deleted = await SavedSearchModel.findOneAndUpdate({ _id: savedSearchId, tenantId, userId, isSoftDeleted: false }, { $set: { isSoftDeleted: true } }, { new: true });
    if (deleted && mongoose.connection?.readyState === 1) {
      AuditLogModel.create({ tenantId, userId, action: "DELETE_SAVED_SEARCH", module: "EnterpriseSearch", resourceId: savedSearchId })
        .catch((err) => console.error("Saved search audit log error:", err));
    }
    return deleted;
  }

  /**
   * "Search Indexing... Background Workers" / Domain Event "SearchRebuilt".
   * Reindexes every entity type covered by this Part's dedicated Entity
   * Specific Search endpoints (Visa Cases, Travelers, Passports, Documents,
   * Embassy Submissions, Appointments, Incidents) for a tenant, reusing the
   * same tested per-entity mapping methods the event-driven indexer uses —
   * no duplicated field-mapping logic. Batched sequentially to avoid
   * overwhelming the DB connection pool on large tenants.
   */
  static async rebuildIndexForTenant({ tenantId, branchId = null }) {
    if (!tenantId) return { indexed: 0 };
    const branchFilter = branchId && branchId !== "all" ? { branchId } : {};

    const [visaCases, travelers, documents, submissions, appointments, passports, incidents] = await Promise.all([
      VisaCaseModel.find({ tenantId, isSoftDeleted: { $ne: true }, ...branchFilter }).select("_id").lean(),
      CustomerModel.find({ tenantId, status: { $ne: "archived" }, ...branchFilter }).select("_id").lean(),
      EnterpriseDocumentModel.find({ tenantId, isSoftDeleted: { $ne: true }, ...branchFilter }).select("_id").lean(),
      EmbassySubmissionModel.find({ tenantId, isSoftDeleted: { $ne: true }, ...branchFilter }).select("_id").lean(),
      VisaAppointmentModel.find({ tenantId, isSoftDeleted: { $ne: true }, ...branchFilter }).select("_id").lean(),
      PassportTrackingModel.find({ tenantId, ...branchFilter }).select("_id").lean(),
      TravelIncidentManagementModel.find({ tenantId, isSoftDeleted: { $ne: true }, ...branchFilter }).select("_id").lean(),
    ]);

    const tasks = [
      ...visaCases.map((r) => () => this.indexVisaCase({ tenantId, visaCaseId: r._id })),
      ...travelers.map((r) => () => this.indexTraveler({ tenantId, customerId: r._id })),
      ...documents.map((r) => () => this.indexDocument({ tenantId, documentId: r._id })),
      ...submissions.map((r) => () => this.indexEmbassySubmission({ tenantId, submissionId: r._id })),
      ...appointments.map((r) => () => this.indexAppointment({ tenantId, appointmentId: r._id })),
      ...passports.map((r) => () => this.indexPassport({ tenantId, passportId: r._id })),
      ...incidents.map((r) => () => this.indexIncident({ tenantId, incidentId: r._id })),
    ];

    const BATCH_SIZE = 25;
    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      await Promise.allSettled(tasks.slice(i, i + BATCH_SIZE).map((task) => task()));
    }

    await this._invalidateSearchCache(tenantId);
    const entityCounts = {
      visaCases: visaCases.length, travelers: travelers.length, documents: documents.length,
      embassySubmissions: submissions.length, appointments: appointments.length,
      passports: passports.length, incidents: incidents.length
    };
    publishEvent("SearchRebuilt", { tenantId, branchId: branchId || "all", indexed: tasks.length, entityCounts });
    return { indexed: tasks.length, entityCounts };
  }
}

export default SearchEngineService;
