import SearchIndexModel from "../models/SearchIndexModel.js";
import SavedSearchModel from "../models/SavedSearchModel.js";
import SearchHistoryModel from "../models/SearchHistoryModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import EnterpriseDocumentModel from "../models/EnterpriseDocumentModel.js";
import EmbassySubmissionModel from "../models/EmbassySubmissionModel.js";
import VisaAppointmentModel from "../models/VisaAppointmentModel.js";
import PassportTrackingModel from "../models/PassportTrackingModel.js";
import TravelIncidentManagementModel from "../models/TravelIncidentManagementModel.js";
import TravelTimelineModel from "../models/TravelTimelineModel.js";
import CustomerModel from "../models/CustomerModel.js";
import { publishEvent, subscribeEvent } from "../utils/eventBus.js";

const MAX_PAGE_SIZE = Number.parseInt(process.env.ENTERPRISE_SEARCH_MAX_PAGE_SIZE || "100", 10) || 100;
const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeArray = (value) => Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
const maskPassport = (value) => value ? `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}` : null;

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
    };
    for (const [eventName, handler] of Object.entries(handlers)) {
      subscribeEvent(eventName, (payload) => queueMicrotask(() => handler(payload).catch((error) =>
        console.error(`Enterprise search index failed for ${eventName}:`, error.message)
      )));
    }
  }

  static async indexEntity({ tenantId, branchId = "main", entityType, entityId, title, description = "", keywords = [], matchedFields = [], module, status = "Active", navigationUrl, permissionsRequired = [], facets = {} }) {
    if (!tenantId || !entityType || !entityId || !title || !module || !navigationUrl) return null;
    const index = await SearchIndexModel.findOneAndUpdate(
      { tenantId, entityType, entityId: String(entityId) },
      { $set: { tenantId, branchId, entityType, entityId: String(entityId), title, description, keywords, matchedFields, module, status, navigationUrl, permissionsRequired, facets, isSoftDeleted: false } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    publishEvent("SearchIndexUpdated", { tenantId, branchId, entityType, entityId: String(entityId) });
    return index;
  }

  static async removeEntity({ tenantId, entityType, entityId }) {
    if (!tenantId || !entityType || !entityId) return;
    await SearchIndexModel.updateOne({ tenantId, entityType, entityId: String(entityId) }, { $set: { isSoftDeleted: true } });
    publishEvent("SearchIndexDeleted", { tenantId, entityType, entityId: String(entityId) });
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

  static async indexTimelineEvent({ tenantId, eventId, branchId }) {
    if (!tenantId || !eventId) return;
    const item = await TravelTimelineModel.findOne({ _id: eventId, tenantId, isArchived: { $ne: true } }).lean();
    if (!item) return this.removeEntity({ tenantId, entityType: "TimelineEvent", entityId: eventId });
    return this.indexEntity({ tenantId, branchId: item.branchId || branchId, entityType: "TimelineEvent", entityId: item._id,
      title: item.title || item.eventType, description: item.description || "", keywords: [item.title, item.description, item.eventType].filter(Boolean),
      matchedFields: [{ field: "title", value: item.title }, { field: "description", value: item.description }].filter((f) => f.value),
      module: item.module || "Visa", status: item.status || "Active", navigationUrl: `/visa-cases/${item.aggregateId}/timeline/${item._id}`, permissionsRequired: ["visa.timeline.read"],
      facets: { aggregateType: item.aggregateType, status: item.status },
    });
  }

  static async globalSearch({ tenantId, query = "", entityType, branchId, permissions = [], filters = {}, page = 1, pageSize = 20, sort = "score", order = "desc" }) {
    const safePage = Math.max(Number.parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(Number.parseInt(pageSize, 10) || 20, 1), MAX_PAGE_SIZE);
    const filter = { tenantId, isSoftDeleted: false };
    if (entityType) filter.entityType = { $in: normalizeArray(entityType) };
    if (branchId && branchId !== "all") filter.branchId = branchId;
    const permissionList = normalizeArray(permissions);
    filter.$or = [{ permissionsRequired: { $size: 0 } }, { permissionsRequired: { $in: permissionList } }];
    for (const key of ["country", "embassy", "visaType", "status", "officer", "nationality", "priority", "severity"]) {
      if (filters[key]) filter[`facets.${key}`] = { $in: normalizeArray(filters[key]) };
    }
    if (filters.dateFrom || filters.dateTo) {
      filter.createdAt = {};
      if (filters.dateFrom) filter.createdAt.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) filter.createdAt.$lte = new Date(filters.dateTo);
    }
    const term = String(query || "").trim();
    if (term) {
      const expression = new RegExp(escapeRegex(term), "i");
      filter.$and = [{ $or: [{ title: expression }, { description: expression }, { keywords: expression }, { "matchedFields.value": expression }] }];
    }
    const totalItems = await SearchIndexModel.countDocuments(filter);
    const dbSort = sort === "createdAt" ? { createdAt: order === "asc" ? 1 : -1 } : { relevanceBaseScore: -1, updatedAt: -1 };
    const documents = await SearchIndexModel.find(filter).sort(dbSort).skip((safePage - 1) * safePageSize).limit(safePageSize).lean();
    const queryLower = term.toLowerCase();
    const results = documents.map((doc) => {
      const exact = queryLower && doc.title.toLowerCase() === queryLower;
      const prefix = queryLower && doc.title.toLowerCase().startsWith(queryLower);
      const score = Math.min(100, (doc.relevanceBaseScore || 70) + (exact ? 30 : prefix ? 20 : term ? 10 : 0));
      const match = (doc.matchedFields || []).find((field) => String(field.value || "").toLowerCase().includes(queryLower));
      return { entityType: doc.entityType, entityId: doc.entityId, title: doc.title, subtitle: doc.description, highlightedMatch: match ? { field: match.field, value: match.value } : null, score, createdDate: doc.createdAt, currentStatus: doc.status, navigationUrl: doc.navigationUrl, facets: doc.facets || {} };
    }).sort((a, b) => sort === "score" ? (order === "asc" ? a.score - b.score : b.score - a.score) : 0);
    return { results, meta: { page: safePage, pageSize: safePageSize, totalItems, totalPages: Math.ceil(totalItems / safePageSize) || 1, source: "enterprise-search-index" } };
  }

  static async recordSearch({ tenantId, userId, query, filters, resultCount }) {
    if (!tenantId || !userId) return;
    await SearchHistoryModel.create({ tenantId, userId, query, filters, resultCount, accessedAt: new Date() });
    publishEvent("SearchRequested", { tenantId, userId, query, resultCount });
  }

  static async getSuggestions({ tenantId, userId, branchId, permissions = [] }) {
    const scope = { tenantId, ...(branchId && branchId !== "all" ? { branchId } : {}), isSoftDeleted: false, $or: [{ permissionsRequired: { $size: 0 } }, { permissionsRequired: { $in: normalizeArray(permissions) } }] };
    const [recentSearches, frequentlyAccessed] = await Promise.all([
      SearchHistoryModel.find({ tenantId, userId }).sort({ accessedAt: -1 }).limit(10).lean(),
      SearchIndexModel.find(scope).sort({ updatedAt: -1 }).limit(10).lean(),
    ]);
    return {
      recentSearches: recentSearches.map((item) => ({ query: item.query, filters: item.filters, accessedAt: item.accessedAt })),
      frequentlyAccessed: frequentlyAccessed.map((item) => ({ entityType: item.entityType, entityId: item.entityId, title: item.title, navigationUrl: item.navigationUrl })),
    };
  }

  static async saveSearch({ tenantId, userId, queryName, queryParams, visibility = "private", isPinned = false }) {
    return SavedSearchModel.create({ tenantId, userId, name: queryName, queryParams, visibility, isPinned });
  }
  static async listSavedSearches({ tenantId, userId }) { return SavedSearchModel.find({ tenantId, userId, isSoftDeleted: false }).sort({ isPinned: -1, updatedAt: -1 }).lean(); }
  static async deleteSavedSearch({ tenantId, userId, savedSearchId }) { return SavedSearchModel.findOneAndUpdate({ _id: savedSearchId, tenantId, userId, isSoftDeleted: false }, { $set: { isSoftDeleted: true } }, { new: true }); }
}

export default SearchEngineService;
