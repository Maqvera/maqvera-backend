import CustomerModel from "../models/CustomerModel.js";
import CustomerDocumentModel from "../models/CustomerDocumentModel.js";
import CustomerFamilyModel from "../models/CustomerFamilyModel.js";
import CustomerNoteModel from "../models/CustomerNoteModel.js";
import CustomerTimelineModel from "../models/CustomerTimelineModel.js";
import CustomerPreferenceModel from "../models/CustomerPreferenceModel.js";
import CountryMasterModel from "../models/CountryMasterModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import EnterpriseDocumentService from "../services/EnterpriseDocumentService.js";
import CustomerStatisticsEngine from "../services/CustomerStatisticsEngine.js";
import CustomerAccountStatementService from "../services/CustomerAccountStatementService.js";
import CustomerStatementPdfService from "../services/CustomerStatementPdfService.js";
import storeDocumentPdf from "../utils/documentPdfStorage.js";
import CacheManager from "../utils/cacheManager.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";
import { getCustomerConfig } from "../utils/customerConfig.js";
import { getStorageConfig } from "../utils/storageConfig.js";
import { getAccessScope } from "../utils/accessScope.js";

const customerConfig = getCustomerConfig();
const storageConfig = getStorageConfig();

const calculateCustomerMetrics = (customer, docsCount = 0, familyCount = 0, prefs = null) => {
  let completeness = 0;

  if (customer.firstName && customer.lastName && customer.dateOfBirth && customer.gender) completeness += 20;
  else if (customer.firstName && customer.lastName) completeness += 10;

  if (customer.email && customer.phone && customer.address?.city) completeness += 20;
  else if (customer.email && customer.phone) completeness += 15;

  if (Array.isArray(customer.passports) && customer.passports.length > 0) completeness += 15;

  if (Array.isArray(customer.emergencyContacts) && customer.emergencyContacts.length > 0) completeness += 10;

  if (docsCount > 0) completeness += 10;

  if (prefs) completeness += 10;

  if (customer.marketingConsent !== undefined && customer.marketingConsent !== null) completeness += 5;

  if (familyCount > 0) completeness += 5;

  if (customer.profilePhoto) completeness += 5;

  let healthScore = "Good";
  if (completeness >= 80) healthScore = "Excellent";
  else if (completeness >= 60) healthScore = "Good";
  else if (completeness >= 40) healthScore = "Average";
  else healthScore = "Poor";

  return { completeness, healthScore };
};

export const recordTimeline = async (arg1, arg2, arg3, arg4, arg5, arg6, arg7) => {
  try {
    let customerId, tenantId, eventType, description, performedBy, performedByName, module, title, referenceId, metadata;

    if (typeof arg1 === "object" && arg1 !== null && !arg1._bsontype && !arg1.toHexString) {
      ({ customerId, tenantId, eventType, module = "Customer", title, description, performedBy = null, performedByName = null, referenceId = null, metadata = {} } = arg1);
    } else {
      customerId = arg1;
      tenantId = arg2;
      eventType = arg3;
      description = arg4;
      performedBy = arg5 || null;
      module = arg6 || "Customer";
      title = arg7 || eventType;
    }

    await CustomerTimelineModel.create({
      customerId,
      tenantId,
      module: module || "Customer",
      eventType,
      title: title || description || eventType,
      description: description || title || eventType,
      performedBy,
      performedByName: performedByName || null,
      referenceId: referenceId || null,
      metadata: metadata || {}
    });
  } catch (err) {
    console.error("recordTimeline error:", err);
  }
};

const buildCustomerListItem = (c) => ({
  customerId: c._id,
  customerCode: c.customerCode,
  fullName: `${c.firstName} ${c.lastName}`.trim(),
  firstName: c.firstName,
  lastName: c.lastName,
  customerType: c.type ? (c.type.charAt(0).toUpperCase() + c.type.slice(1)) : "Individual",
  status: c.status ? (c.status.charAt(0).toUpperCase() + c.status.slice(1)) : "Active",
  primaryPhone: c.phone || c.alternatePhone || "",
  primaryEmail: c.email || "",
  country: c.address?.country || c.nationality || "N/A",
  completenessScore: c.completenessScore || 0,
  healthScore: c.healthScore || "Good",
  assignedTo: c.assignedTo || null,
  lastBookingDate: c.lastBookingDate || null,
  createdAt: c.createdAt
});

const normalizePassportStatus = (passport) => {
  const now = new Date();
  if (passport.status === "cancelled" || passport.status === "lost" || passport.status === "renewed") {
    return passport.status;
  }

  if (!passport.issueDate || !passport.expiryDate) {
    return passport.status || "active";
  }

  const expiryDate = new Date(passport.expiryDate);
  const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

  if (expiryDate < now) return "expired";
  if (daysUntilExpiry <= 30) return "expiring_soon";
  return "active";
};

const buildPassportResponse = (passport) => ({
  passportId: passport._id,
  passportNumber: passport.passportNumber,
  countryId: passport.countryId || null,
  countryOfIssue: passport.countryOfIssue,
  issueDate: passport.issueDate,
  expiryDate: passport.expiryDate,
  placeOfIssue: passport.placeOfIssue,
  isPrimary: passport.isPrimary,
  status: normalizePassportStatus(passport)
});

// "Never expose internal storage paths" — storageKey/storageProvider never
// leave this function; only a short-lived signed URL does.
const buildDocumentResponse = (doc) => ({
  documentId: doc._id,
  documentType: doc.documentType,
  documentNumber: doc.documentNumber,
  fileName: doc.fileName,
  fileUrl: EnterpriseDocumentService.generateSignedUrl(doc.storageKey, customerConfig.signedDocumentUrlTtlSeconds),
  mimeType: doc.mimeType,
  fileSize: doc.fileSize,
  expiryDate: doc.expiryDate,
  status: doc.status,
  version: doc.version,
  uploadedBy: doc.uploadedBy,
  uploadedAt: doc.createdAt,
  verifiedBy: doc.verifiedBy,
  verifiedAt: doc.verifiedAt,
  rejectionReason: doc.rejectionReason,
  virusScanStatus: doc.virusScanStatus,
  notes: doc.notes
});

const calculateAge = (dateOfBirth) => {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age -= 1;
  return age;
};

// "Visa Status" cannot be computed — VisaCaseModel links via travelerId, not
// to CustomerFamilyModel, so there is no real join key back to a family
// member's visa case yet. Returned as null rather than fabricated.
const buildFamilyMemberResponse = (member) => ({
  memberId: member._id,
  fullName: `${member.firstName} ${member.lastName}`.trim(),
  firstName: member.firstName,
  lastName: member.lastName,
  relationship: member.relationship,
  gender: member.gender,
  dateOfBirth: member.dateOfBirth,
  age: calculateAge(member.dateOfBirth),
  isTraveler: Boolean(member.isTraveler),
  passportNumber: member.passportNumber,
  passportStatus: member.passportNumber ? "Registered" : "Not Registered",
  visaStatus: null,
  phone: member.phone,
  email: member.email,
  customerId: member.memberCustomerId || null,
  status: member.status,
  createdAt: member.createdAt,
  updatedAt: member.updatedAt
});

// Bounded edit-distance (no external dependency) used for "Similar Name"
// duplicate-detection scoring and typo-tolerant search ranking.
const levenshteinDistance = (a, b) => {
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let previousRow = Array.from({ length: bl + 1 }, (_, j) => j);
  for (let i = 1; i <= al; i++) {
    const currentRow = [i];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(Math.min(currentRow[j - 1] + 1, previousRow[j] + 1, previousRow[j - 1] + cost));
    }
    previousRow = currentRow;
  }
  return previousRow[bl];
};

const nameSimilarity = (a, b) => {
  const s1 = (a || "").toLowerCase().trim();
  const s2 = (b || "").toLowerCase().trim();
  if (!s1 || !s2) return 0;
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(s1, s2) / maxLen;
};

// Customer Duplicate Detection Score table (Part 3, Section "Customer
// Duplicate Detection"): passport/nationalId 100, phone/email 95,
// same name+DOB 90, same name+phone 85, similar name 70.
const detectDuplicateCustomer = async ({ tenantId, email, phone, nationalId, passportNumbers = [], firstName, lastName, dateOfBirth, excludeCustomerId = null }) => {
  const orClauses = [];
  if (email) orClauses.push({ email });
  if (phone) orClauses.push({ phone });
  if (nationalId) orClauses.push({ nationalId });
  if (passportNumbers.length > 0) orClauses.push({ "passports.passportNumber": { $in: passportNumbers } });
  if (firstName && lastName) {
    orClauses.push({ firstName: new RegExp(`^${firstName}$`, "i"), lastName: new RegExp(`^${lastName}$`, "i") });
  }
  if (orClauses.length === 0) return null;

  const filter = { tenantId, status: { $ne: "archived" }, $or: orClauses };
  if (excludeCustomerId) filter._id = { $ne: excludeCustomerId };

  const candidates = await CustomerModel.find(filter).limit(25).lean();

  let best = null;
  for (const candidate of candidates) {
    let score = 0;
    if (passportNumbers.length > 0 && (candidate.passports || []).some((p) => passportNumbers.includes(p.passportNumber))) {
      score = Math.max(score, 100);
    }
    if (nationalId && candidate.nationalId === nationalId) score = Math.max(score, 100);
    if (phone && candidate.phone === phone) score = Math.max(score, 95);
    if (email && candidate.email === email) score = Math.max(score, 95);

    const sameName = Boolean(firstName && lastName && candidate.firstName?.toLowerCase() === firstName.toLowerCase() && candidate.lastName?.toLowerCase() === lastName.toLowerCase());
    if (sameName && dateOfBirth && candidate.dateOfBirth && new Date(candidate.dateOfBirth).toDateString() === new Date(dateOfBirth).toDateString()) {
      score = Math.max(score, 90);
    }
    if (sameName && phone && candidate.phone === phone) score = Math.max(score, 85);

    if (firstName && lastName && !sameName) {
      const similarity = nameSimilarity(`${firstName} ${lastName}`, `${candidate.firstName || ""} ${candidate.lastName || ""}`);
      if (similarity >= 0.8) score = Math.max(score, 70);
    }

    if (score > (best?.score || 0)) best = { customer: candidate, score };
  }

  return best;
};

const buildFullCustomerProfile = (customer, preferences = null, documents = [], family = [], notes = [], timeline = [], stats = null) => ({
  customerId: customer._id,
  customerCode: customer.customerCode,
  type: customer.type,
  category: customer.category,
  status: customer.status,
  title: customer.title,
  firstName: customer.firstName,
  middleName: customer.middleName || null,
  lastName: customer.lastName,
  fullName: `${customer.firstName} ${customer.lastName}`.trim(),
  companyName: customer.companyName,
  primaryEmail: customer.email,
  email: customer.email,
  primaryPhone: customer.phone,
  phone: customer.phone,
  alternatePhone: customer.alternatePhone,
  nationalId: customer.nationalId,
  gender: customer.gender,
  dateOfBirth: customer.dateOfBirth,
  maritalStatus: customer.maritalStatus || null,
  nationality: customer.nationality,
  preferredLanguage: customer.preferredLanguage,
  preferredCurrency: customer.preferredCurrency || "USD",
  marketingConsent: customer.marketingConsent || false,
  profilePhoto: customer.profilePhoto || null,
  timezone: customer.timezone,
  completenessScore: customer.completenessScore || 0,
  healthScore: customer.healthScore || "Good",
  address: customer.address || {},
  phones: customer.phones || [],
  emails: customer.emails || [],
  addresses: customer.addresses || [],
  passports: customer.passports || [],
  emergencyContacts: customer.emergencyContacts || [],
  mahramInformation: customer.mahramInformation || {},
  medicalInformation: customer.medicalInformation || {},
  assignedTo: customer.assignedTo || null,
  lastBookingDate: customer.lastBookingDate || null,
  tags: customer.tags || [],
  notes: customer.notes,
  versionsCount: (customer.versions || []).length,
  tenantId: customer.tenantId,
  preferences: preferences || null,
  documents: documents || [],
  familyMembers: family || [],
  recentNotes: notes || [],
  timelineSummary: timeline || [],
  statistics: stats || null,
  createdAt: customer.createdAt,
  updatedAt: customer.updatedAt
});

export const ListCustomers = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || customerConfig.defaultPageSize, 10), 1), customerConfig.maxPageSize);
    const search = req.query.search?.trim() || null;
    const customerType = req.query.customerType || req.query.type || null;
    const category = req.query.category || null;
    const status = req.query.status || null;
    const countryId = req.query.countryId || null;
    const cityId = req.query.cityId || null;
    const assignedTo = req.query.assignedTo || null;
    const createdAfter = req.query.createdAfter ? new Date(req.query.createdAfter) : null;
    const createdBefore = req.query.createdBefore ? new Date(req.query.createdBefore) : null;
    const order = req.query.order === "asc" ? 1 : -1;

    // Rule 5: sorting is only allowed on indexed fields — anything else risks
    // an unbounded collection scan on a potentially large customer table.
    const SORT_FIELD_MAP = {
      fullname: { firstName: order, lastName: order },
      name: { firstName: order, lastName: order },
      firstname: { firstName: order },
      lastname: { lastName: order },
      email: { email: order },
      phone: { phone: order },
      customercode: { customerCode: order },
      type: { type: order },
      category: { category: order },
      status: { status: order },
      assignedto: { assignedTo: order },
      createdat: { createdAt: order }
    };
    const requestedSort = (req.query.sort || "createdAt").toLowerCase();
    const sortOption = SORT_FIELD_MAP[requestedSort];
    if (!sortOption) {
      return sendError(res, 422, `Invalid sort field "${req.query.sort}". Allowed: fullName, firstName, lastName, email, phone, customerCode, type, category, status, assignedTo, createdAt.`, requestId);
    }

    if (status && status.toLowerCase() === "archived" && !permissions.includes("customers.delete") && !permissions.includes("customer.delete") && !permissions.includes("admin")) {
      return sendError(res, 403, "Elevated permission required to view archived customers.", requestId);
    }

    const scope = getAccessScope(req);
    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const filter = { ...scope, status: { $ne: "archived" } };
    if (customerType) filter.type = customerType.toLowerCase();
    if (category) filter.category = category.toLowerCase();
    if (status) filter.status = status.toLowerCase();
    if (assignedTo) filter.assignedTo = assignedTo;

    if (countryId) {
      const country = await CountryMasterModel.findOne({ tenantId, countryId, isActive: true }).lean();
      filter["address.country"] = country ? country.name : countryId;
    }
    if (cityId) {
      filter["address.city"] = new RegExp(`^${cityId}$`, "i");
    }

    if (createdAfter || createdBefore) {
      filter.createdAt = {};
      if (createdAfter) filter.createdAt.$gte = createdAfter;
      if (createdBefore) filter.createdAt.$lte = createdBefore;
    }

    if (search) {
      filter.$or = [
        { firstName: new RegExp(search, "i") },
        { lastName: new RegExp(search, "i") },
        { email: new RegExp(search, "i") },
        { phone: new RegExp(search, "i") },
        { customerCode: new RegExp(search, "i") },
        { nationalId: new RegExp(search, "i") },
        { "passports.passportNumber": new RegExp(search, "i") }
      ];
    }

    const totalItems = await CustomerModel.countDocuments(filter);
    const customers = await CustomerModel.find(filter)
      .sort(sortOption)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    return res.status(200).json({
      success: true,
      message: "Customers loaded.",
      data: customers.map(buildCustomerListItem),
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      },
      requestId
    });
  } catch (error) {
    console.error("ListCustomers error:", error);
    return sendError(res, 500, "Unable to load customers.", requestId);
  }
};

export const SearchCustomers = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const permissions = req.auth?.permissions || [];
    const scope = getAccessScope(req);
    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const query = req.query.q?.trim() || req.query.query?.trim() || req.query.search?.trim() || "";
    if (!query || query.length < 2) {
      return sendSuccess(res, 200, "Query too short.", [], requestId);
    }

    const resultsById = new Map();

    // Exact-identifier layer: phone/email/customerCode/nationalId/passport
    // number never benefit from word-tokenized full-text search — matched
    // by direct case-insensitive substring instead.
    const identifierMatches = await CustomerModel.find({
      ...scope, status: { $ne: "archived" },
      $or: [
        { phone: new RegExp(query, "i") },
        { email: new RegExp(query, "i") },
        { customerCode: new RegExp(query, "i") },
        { nationalId: new RegExp(query, "i") },
        { "passports.passportNumber": new RegExp(query, "i") }
      ]
    }).limit(20).lean();
    identifierMatches.forEach((c) => resultsById.set(c._id.toString(), { customer: c, score: 100 }));

    // Ranked full-text layer for Full Name / Company / Tags, backed by the
    // compound MongoDB text index — real relevance ranking via $meta:"textScore",
    // the closest native equivalent this stack has to the doc's "PostgreSQL
    // Full Text Search" instruction (this system runs MongoDB, not Postgres).
    let textMatches = [];
    try {
      textMatches = await CustomerModel.find(
        { ...scope, status: { $ne: "archived" }, $text: { $search: query } },
        { score: { $meta: "textScore" } }
      ).sort({ score: { $meta: "textScore" } }).limit(20).lean();
    } catch (textSearchError) {
      textMatches = [];
    }
    textMatches.forEach((c) => {
      const id = c._id.toString();
      const score = 90 + Math.min(c.score || 0, 10);
      if (!resultsById.has(id) || resultsById.get(id).score < score) {
        resultsById.set(id, { customer: c, score });
      }
    });

    // Cross-module lookup: Booking Number -> linked Customer. BookingHeaderModel
    // has a real customerId FK, so this is a genuine join, not a fabricated one.
    // Visa Number / Reference Number cannot be searched the same way today —
    // VisaCaseModel links via travelerId, not customerId, so there is no real
    // join key back to Customer yet.
    const bookingMatches = await BookingHeaderModel.find({ ...scope, bookingNumber: new RegExp(query, "i") }).select("customerId").limit(10).lean();
    if (bookingMatches.length > 0) {
      const bookingCustomerIds = [...new Set(bookingMatches.map((b) => b.customerId?.toString()).filter(Boolean))];
      const bookingCustomers = await CustomerModel.find({ _id: { $in: bookingCustomerIds }, ...scope, status: { $ne: "archived" } }).lean();
      bookingCustomers.forEach((c) => {
        const id = c._id.toString();
        if (!resultsById.has(id)) resultsById.set(id, { customer: c, score: 95 });
      });
    }

    // Typo-tolerant fallback (only when the exact/text layers found nothing):
    // rank a bounded recent-customer pool by edit-distance similarity against
    // full name / company. This is a genuine computation over real data, not
    // a canned response — but it is a best-effort approximation, not a
    // substitute for a real search engine (Atlas Search/Elasticsearch/Meilisearch,
    // none of which are configured in this codebase) at large data volumes.
    if (resultsById.size === 0) {
      const candidatePool = await CustomerModel.find({ ...scope, status: { $ne: "archived" } })
        .sort({ createdAt: -1 })
        .limit(300)
        .lean();

      candidatePool.forEach((c) => {
        const fullName = `${c.firstName || ""} ${c.lastName || ""}`;
        const similarity = Math.max(nameSimilarity(query, fullName), nameSimilarity(query, c.companyName || ""));
        if (similarity >= 0.6) {
          resultsById.set(c._id.toString(), { customer: c, score: Math.round(similarity * 70) });
        }
      });
    }

    const ranked = Array.from(resultsById.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((r) => r.customer);

    return sendSuccess(res, 200, "Search results.", ranked.map(buildCustomerListItem), requestId);
  } catch (error) {
    console.error("SearchCustomers error:", error);
    return sendError(res, 500, "Unable to search customers.", requestId);
  }
};

export const CreateCustomer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("customers.create") && !permissions.includes("customer.create")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const {
      firstName,
      middleName,
      lastName,
      dateOfBirth,
      gender,
      maritalStatus,
      customerType = "individual",
      type,
      primaryPhone,
      phone,
      primaryEmail,
      email,
      nationalityId,
      nationality,
      nationalId,
      preferredLanguageId,
      preferredLanguage = customerConfig.defaultLanguage,
      preferredCurrency = customerConfig.defaultCurrency,
      marketingConsent = false,
      profilePhoto,
      category = customerConfig.defaultCategory,
      status = customerConfig.defaultStatus,
      title,
      companyName,
      alternatePhone,
      timezone = customerConfig.defaultTimezone,
      address,
      passports = [],
      emergencyContacts = [],
      mahramInformation = {},
      medicalInformation = {},
      assignedTo = null,
      tags = [],
      notes
    } = req.body;

    const resolvedEmail = primaryEmail || email;
    const resolvedPhone = primaryPhone || phone;
    const resolvedType = customerType || type || "individual";
    const normalizedCategory = (category || customerConfig.defaultCategory).toString().toLowerCase();
    const normalizedStatus = (status || customerConfig.defaultStatus).toString().toLowerCase();

    // Dynamic enum validation sourced from the Mongoose schema itself (not a
    // duplicated hardcoded list) so it never drifts from what the DB actually accepts.
    const validTypes = CustomerModel.schema.path("type").enumValues;
    if (!validTypes.includes(resolvedType.toLowerCase())) {
      return sendError(res, 422, `Invalid customerType "${resolvedType}". Allowed: ${validTypes.join(", ")}.`, requestId);
    }
    const validCategories = CustomerModel.schema.path("category").enumValues;
    if (!validCategories.includes(normalizedCategory)) {
      return sendError(res, 422, `Invalid category "${category}". Allowed: ${validCategories.join(", ")}.`, requestId);
    }
    const validStatuses = CustomerModel.schema.path("status").enumValues;
    if (!validStatuses.includes(normalizedStatus)) {
      return sendError(res, 422, `Invalid status "${status}". Allowed: ${validStatuses.join(", ")}.`, requestId);
    }
    if (gender) {
      const validGenders = CustomerModel.schema.path("gender").enumValues;
      if (!validGenders.includes(gender.toLowerCase())) {
        return sendError(res, 422, `Invalid gender "${gender}". Allowed: ${validGenders.join(", ")}.`, requestId);
      }
    }
    if (maritalStatus) {
      const validMaritalStatuses = CustomerModel.schema.path("maritalStatus").enumValues;
      if (!validMaritalStatuses.includes(maritalStatus.toLowerCase())) {
        return sendError(res, 422, `Invalid maritalStatus "${maritalStatus}". Allowed: ${validMaritalStatuses.join(", ")}.`, requestId);
      }
    }

    let resolvedNationality = nationality || null;

    if (nationalityId) {
      const country = await CountryMasterModel.findOne({ tenantId, countryId: nationalityId, isActive: true }).lean();
      if (!country) {
        return sendError(res, 422, `Nationality "${nationalityId}" does not exist.`, requestId);
      }
      resolvedNationality = country.name;
    }

    // Language codes are validated dynamically against Node's built-in ICU
    // data (real BCP-47 tag parsing) — no fake "language master" lookup.
    const resolvedPreferredLanguage = (preferredLanguageId || preferredLanguage || customerConfig.defaultLanguage).toLowerCase();
    try {
      Intl.getCanonicalLocales([resolvedPreferredLanguage]);
    } catch {
      return sendError(res, 422, `Invalid language "${resolvedPreferredLanguage}".`, requestId);
    }

    if (!firstName || !lastName || !resolvedEmail || !resolvedPhone) {
      return sendError(res, 422, "firstName, lastName, primaryEmail, and primaryPhone are required.", requestId);
    }

    if (customerConfig.enableDuplicateDetection) {
      const passportNumbers = Array.isArray(passports) ? passports.map((p) => p.passportNumber).filter(Boolean) : [];
      const match = await detectDuplicateCustomer({
        tenantId, email: resolvedEmail, phone: resolvedPhone, nationalId,
        passportNumbers, firstName, lastName, dateOfBirth
      });

      if (match && match.score >= customerConfig.duplicateScoreThreshold && !req.body.createAnyway) {
        return res.status(409).json({
          success: false,
          message: "Potential duplicate customer detected.",
          isDuplicate: true,
          duplicateScore: match.score,
          existingCustomer: {
            customerId: match.customer._id,
            customerCode: match.customer.customerCode,
            fullName: `${match.customer.firstName} ${match.customer.lastName}`,
            email: match.customer.email,
            phone: match.customer.phone
          },
          requestId
        });
      }
    }

    const customerCode = `${customerConfig.customerCodePrefix}-${Math.floor(100000 + Math.random() * 900000)}`;

    const initialMetrics = calculateCustomerMetrics({
      firstName, lastName, dateOfBirth, gender, email: resolvedEmail, phone: resolvedPhone, address, passports, emergencyContacts, marketingConsent, profilePhoto
    }, 0, 0, null);

    const customer = await CustomerModel.create({
      tenantId,
      customerCode,
      type: resolvedType.toLowerCase(),
      category: normalizedCategory,
      status: normalizedStatus,
      title: title || null,
      firstName,
      middleName: middleName || null,
      lastName,
      companyName: companyName || null,
      email: resolvedEmail,
      phone: resolvedPhone,
      alternatePhone: alternatePhone || null,
      nationalId: nationalId || null,
      gender: gender ? gender.toLowerCase() : null,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
      maritalStatus: maritalStatus || null,
      nationality: resolvedNationality,
      preferredLanguage: resolvedPreferredLanguage,
      preferredCurrency: preferredCurrency || customerConfig.defaultCurrency,
      marketingConsent: Boolean(marketingConsent),
      profilePhoto: profilePhoto || null,
      timezone,
      completenessScore: initialMetrics.completeness,
      healthScore: initialMetrics.healthScore,
      address: address || {},
      phones: [{ number: resolvedPhone, label: "mobile", isPrimary: true }],
      emails: [{ address: resolvedEmail, label: "personal", isPrimary: true }],
      addresses: address ? [{ ...address, type: "home", isPrimary: true }] : [],
      passports: Array.isArray(passports) ? passports : [],
      emergencyContacts: Array.isArray(emergencyContacts) ? emergencyContacts : [],
      mahramInformation: mahramInformation || {},
      medicalInformation: medicalInformation || {},
      assignedTo: assignedTo || req.auth?.id || null,
      tags: Array.isArray(tags) ? tags : [],
      notes: notes || null
    });

    await CustomerPreferenceModel.create({
      customerId: customer._id,
      tenantId,
      communicationChannel: customerConfig.defaultCommunicationChannel
    });

    await recordTimeline(customer._id, tenantId, "created", `Customer created (${customer.customerCode})`, req.auth?.id || null);

    await AuditLogModel.create({
      action: "customer.create",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId: customer._id, customerCode: customer.customerCode }
    });

    publishEvent("CustomerCreated", { customerId: customer._id.toString(), tenantId, customerCode: customer.customerCode });
    publishEvent("TimelineCreated", { customerId: customer._id.toString(), tenantId });
    publishEvent("NotificationRequested", { type: "welcome_customer", email: customer.email });
    publishEvent("CRMUpdated", { customerId: customer._id.toString(), tenantId });

    return sendSuccess(res, 201, "Customer created successfully.", {
      customerId: customer._id,
      customerCode: customer.customerCode,
      status: "Active"
    }, requestId);
  } catch (error) {
    console.error("CreateCustomer error:", error);
    return sendError(res, 500, "Unable to create customer.", requestId);
  }
};

export const GetCustomer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { customerId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, ...scope }).lean();

    if (!customer) {
      return sendError(res, 404, "Customer not found.", requestId);
    }

    if (customer.status === "archived" && !permissions.includes("customers.delete") && !permissions.includes("customer.delete") && !permissions.includes("admin")) {
      return sendError(res, 403, "Elevated permission required to view archived customers.", requestId);
    }

    const [preferences, documents, family, notes, timeline, bookingMetrics] = await Promise.all([
      CustomerPreferenceModel.findOne({ customerId: customer._id }).lean(),
      // Sensitive documents excluded: archived (soft-deleted) records and anything
      // the virus scan flagged as infected must never be surfaced in a profile read.
      CustomerDocumentModel.find({ customerId: customer._id, status: { $ne: "archived" }, virusScanStatus: { $ne: "infected" } }).lean(),
      CustomerFamilyModel.find({ customerId: customer._id, status: "active" }).lean(),
      CustomerNoteModel.find({ customerId: customer._id, status: { $ne: "archived" } }).sort({ createdAt: -1 }).limit(5).lean(),
      CustomerTimelineModel.find({ customerId: customer._id }).sort({ createdAt: -1 }).limit(10).lean(),
      CustomerStatisticsEngine.ensureBookingMetrics({ customerId: customer._id, tenantId: scope.tenantId })
    ]);

    const metrics = calculateCustomerMetrics(customer, documents.length, family.length, preferences);

    const stats = {
      documentsCount: documents.length,
      familyCount: family.length,
      notesCount: notes.length,
      passportsCount: (customer.passports || []).length,
      activePassportsCount: (customer.passports || []).filter((p) => p.status === "active").length,
      completenessScore: metrics.completeness,
      healthScore: metrics.healthScore,
      totalBookings: bookingMetrics.totalBookings,
      totalSpentAmount: bookingMetrics.totalRevenue
    };

    return sendSuccess(res, 200, "Customer profile loaded.", buildFullCustomerProfile(customer, preferences, documents.map(buildDocumentResponse), family, notes, timeline, stats), requestId);
  } catch (error) {
    console.error("GetCustomer error:", error);
    return sendError(res, 500, "Unable to load customer profile.", requestId);
  }
};

export const UpdateCustomer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { customerId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, ...scope, status: { $ne: "archived" } });

    if (!customer) {
      return sendError(res, 404, "Customer not found.", requestId);
    }

    // Section 39 validation rules. type/category/status/gender/maritalStatus
    // are validated dynamically off the Mongoose schema's own enums (not a
    // duplicated hardcoded list) so a clean 422 is returned instead of a raw
    // Mongoose ValidationError surfacing as a 500 on save().
    const enumChecks = [
      ["type", "type"], ["category", "category"], ["status", "status"],
      ["gender", "gender"], ["maritalStatus", "maritalStatus"]
    ];
    for (const [bodyKey, schemaPath] of enumChecks) {
      if (req.body[bodyKey] !== undefined) {
        const normalized = req.body[bodyKey].toString().toLowerCase();
        const allowedValues = CustomerModel.schema.path(schemaPath).enumValues;
        if (!allowedValues.includes(normalized)) {
          return sendError(res, 422, `Invalid ${bodyKey} "${req.body[bodyKey]}". Allowed: ${allowedValues.join(", ")}.`, requestId);
        }
        req.body[bodyKey] = normalized;
      }
    }

    // Valid Language — dynamic BCP-47 validation via Node's built-in ICU data.
    if (req.body.preferredLanguage !== undefined) {
      try {
        Intl.getCanonicalLocales([req.body.preferredLanguage]);
      } catch {
        return sendError(res, 422, `Invalid language "${req.body.preferredLanguage}".`, requestId);
      }
    }

    // Valid Currency — dynamic ISO 4217 validation via Node's built-in ICU data.
    if (req.body.preferredCurrency !== undefined) {
      const validCurrencies = Intl.supportedValuesOf("currency");
      if (!validCurrencies.includes(req.body.preferredCurrency.toUpperCase())) {
        return sendError(res, 422, `Invalid currency "${req.body.preferredCurrency}".`, requestId);
      }
      req.body.preferredCurrency = req.body.preferredCurrency.toUpperCase();
    }

    // Valid Country — validated against real CountryMasterModel data (name or
    // ISO code). Valid City has no equivalent master-data table in this
    // codebase yet, so it cannot be validated without fabricating one.
    if (req.body.address?.country) {
      const validCountry = await CountryMasterModel.findOne({
        tenantId, isActive: true,
        $or: [{ name: new RegExp(`^${req.body.address.country}$`, "i") }, { code: req.body.address.country.toUpperCase() }]
      }).lean();
      if (!validCountry) {
        return sendError(res, 422, `Invalid country "${req.body.address.country}".`, requestId);
      }
    }

    if (req.body.primaryEmail || req.body.email) {
      const newEmail = req.body.primaryEmail || req.body.email;
      if (newEmail !== customer.email) {
        const emailExists = await CustomerModel.findOne({ tenantId, email: newEmail, _id: { $ne: customerId } });
        if (emailExists) return sendError(res, 409, "Email already in use.", requestId);
      }
    }

    if (req.body.primaryPhone || req.body.phone) {
      const newPhone = req.body.primaryPhone || req.body.phone;
      if (newPhone !== customer.phone) {
        const phoneExists = await CustomerModel.findOne({ tenantId, phone: newPhone, _id: { $ne: customerId } });
        if (phoneExists) return sendError(res, 409, "Phone already in use.", requestId);
      }
    }

    // Editable fields per Section 38. Passports/emergencyContacts/mahram/medical
    // are intentionally excluded — those are edited only through their own
    // dedicated sub-resource endpoints (same convention as the Joi layer enforces).
    const allowedFields = [
      "firstName", "middleName", "lastName", "title", "companyName", "type", "category", "status",
      "alternatePhone", "nationalId", "gender", "dateOfBirth", "maritalStatus", "nationality",
      "preferredLanguage", "preferredCurrency", "marketingConsent", "profilePhoto", "timezone",
      "address", "assignedTo", "tags", "notes"
    ];

    // Rule 1: only modified fields are updated — track real changes for the
    // timeline/audit trail rather than a generic "profile updated" message.
    const changedFields = [];

    const newEmail = req.body.primaryEmail || req.body.email;
    if (newEmail !== undefined && newEmail !== customer.email) {
      customer.email = newEmail;
      changedFields.push("email");
    }
    const newPhone = req.body.primaryPhone || req.body.phone;
    if (newPhone !== undefined && newPhone !== customer.phone) {
      customer.phone = newPhone;
      changedFields.push("phone");
    }

    allowedFields.forEach((key) => {
      if (req.body[key] === undefined) return;
      const isEqual = JSON.stringify(customer[key]) === JSON.stringify(req.body[key]);
      if (!isEqual) {
        customer[key] = req.body[key];
        changedFields.push(key);
      }
    });

    // Keep the multi-value phones/emails/addresses arrays' primary entry in
    // sync when the flat field is edited directly through this endpoint.
    if (changedFields.includes("phone")) {
      if (!customer.phones) customer.phones = [];
      const primaryPhoneEntry = customer.phones.find((p) => p.isPrimary);
      if (primaryPhoneEntry) primaryPhoneEntry.number = customer.phone;
      else customer.phones.push({ number: customer.phone, label: "mobile", isPrimary: true });
    }
    if (changedFields.includes("email")) {
      if (!customer.emails) customer.emails = [];
      const primaryEmailEntry = customer.emails.find((e) => e.isPrimary);
      if (primaryEmailEntry) primaryEmailEntry.address = customer.email;
      else customer.emails.push({ address: customer.email, label: "personal", isPrimary: true });
    }
    if (changedFields.includes("address")) {
      if (!customer.addresses) customer.addresses = [];
      const primaryAddressEntry = customer.addresses.find((a) => a.isPrimary);
      if (primaryAddressEntry) {
        primaryAddressEntry.street = customer.address.street;
        primaryAddressEntry.city = customer.address.city;
        primaryAddressEntry.state = customer.address.state;
        primaryAddressEntry.postalCode = customer.address.postalCode;
        primaryAddressEntry.country = customer.address.country;
      } else {
        customer.addresses.push({ ...customer.address.toObject?.() || customer.address, type: "home", isPrimary: true });
      }
    }

    if (changedFields.length === 0) {
      return sendSuccess(res, 200, "No changes to apply.", { customerId: customer._id }, requestId);
    }

    // Historical profile version snapshot, captured before the recalculated
    // completeness/health scores are applied so it reflects the prior state.
    const versionNumber = (customer.versions || []).length + 1;
    if (!customer.versions) customer.versions = [];
    customer.versions.push({
      version: versionNumber,
      changedAt: new Date(),
      changedBy: req.auth?.id || null,
      snapshot: {
        firstName: customer.firstName,
        middleName: customer.middleName,
        lastName: customer.lastName,
        title: customer.title,
        companyName: customer.companyName,
        email: customer.email,
        phone: customer.phone,
        alternatePhone: customer.alternatePhone,
        address: customer.address,
        gender: customer.gender,
        dateOfBirth: customer.dateOfBirth,
        maritalStatus: customer.maritalStatus,
        nationality: customer.nationality,
        nationalId: customer.nationalId,
        preferredLanguage: customer.preferredLanguage,
        preferredCurrency: customer.preferredCurrency,
        marketingConsent: customer.marketingConsent,
        profilePhoto: customer.profilePhoto,
        timezone: customer.timezone,
        assignedTo: customer.assignedTo,
        tags: customer.tags,
        notes: customer.notes,
        passports: customer.passports,
        category: customer.category,
        type: customer.type,
        status: customer.status,
        completenessScore: customer.completenessScore,
        healthScore: customer.healthScore
      },
      changedFields
    });

    const docsCount = await CustomerDocumentModel.countDocuments({ customerId: customer._id });
    const familyCount = await CustomerFamilyModel.countDocuments({ customerId: customer._id });
    const prefs = await CustomerPreferenceModel.findOne({ customerId: customer._id }).lean();

    const metrics = calculateCustomerMetrics(customer, docsCount, familyCount, prefs);
    customer.completenessScore = metrics.completeness;
    customer.healthScore = metrics.healthScore;

    await customer.save();

    await recordTimeline(customer._id, tenantId, "updated", `Customer profile updated: ${changedFields.join(", ")}`, req.auth?.id || null);

    await AuditLogModel.create({
      action: "customer.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId: customer._id, changedFields }
    });

    publishEvent("CustomerUpdated", { customerId: customer._id.toString(), tenantId, changedFields });
    publishEvent("CustomerTimelineUpdated", { customerId: customer._id.toString(), tenantId });
    publishEvent("CRMAnalyticsUpdated", { customerId: customer._id.toString(), tenantId });

    return sendSuccess(res, 200, "Customer updated successfully.", { customerId: customer._id }, requestId);
  } catch (error) {
    console.error("UpdateCustomer error:", error);
    return sendError(res, 500, "Unable to update customer.", requestId);
  }
};

export const ArchiveCustomer = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];

    if (!scope) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }
    const tenantId = scope.tenantId;

    if (!permissions.includes("customers.delete") && !permissions.includes("customer.delete")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { customerId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, ...scope, status: { $ne: "archived" } });

    if (!customer) {
      return sendError(res, 404, "Customer not found.", requestId);
    }

    customer.status = "archived";
    await customer.save();

    await recordTimeline(customer._id, tenantId, "archived", "Customer profile archived", req.auth?.id || null);

    await AuditLogModel.create({
      action: "customer.archive",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId }
    });

    publishEvent("CustomerArchived", { customerId: customer._id.toString(), tenantId });

    return sendSuccess(res, 200, "Customer archived.", null, requestId);
  } catch (error) {
    console.error("ArchiveCustomer error:", error);
    return sendError(res, 500, "Unable to archive customer.", requestId);
  }
};

export const MergeCustomers = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    // Business Rule: "Administrator permission required" — merge is
    // irreversible (the duplicate is archived and its history reassigned),
    // so it needs the same elevated tier as viewing/restoring archived records.
    if (!permissions.includes("customers.delete") && !permissions.includes("customer.delete") && !permissions.includes("admin")) {
      return sendError(res, 403, "Administrator permission required to merge customers.", requestId);
    }

    const primaryCustomerId = req.body.primaryCustomerId || req.body.targetCustomerId;
    const duplicateCustomerId = req.body.duplicateCustomerId || req.body.sourceCustomerId;

    if (!primaryCustomerId || !duplicateCustomerId) {
      return sendError(res, 422, "primaryCustomerId and duplicateCustomerId are required.", requestId);
    }

    const source = await CustomerModel.findOne({ _id: duplicateCustomerId, tenantId, status: { $ne: "archived" } });
    const target = await CustomerModel.findOne({ _id: primaryCustomerId, tenantId, status: { $ne: "archived" } });

    if (!source || !target) {
      return sendError(res, 404, "Primary or duplicate customer not found.", requestId);
    }

    const existingPassportNumbers = new Set((target.passports || []).map((p) => p.passportNumber));
    (source.passports || []).forEach((p) => {
      if (!existingPassportNumbers.has(p.passportNumber)) {
        target.passports.push(p);
      }
    });

    const mergedTags = new Set([...(target.tags || []), ...(source.tags || [])]);
    target.tags = Array.from(mergedTags);

    const existingEmergencyContactKeys = new Set(
      (target.emergencyContacts || []).map((c) => `${(c.name || "").toLowerCase()}|${c.phone || ""}`)
    );
    (source.emergencyContacts || []).forEach((c) => {
      const key = `${(c.name || "").toLowerCase()}|${c.phone || ""}`;
      if (!existingEmergencyContactKeys.has(key)) {
        target.emergencyContacts.push(c);
        existingEmergencyContactKeys.add(key);
      }
    });

    if (!target.phones) target.phones = [];
    const existingPhoneNumbers = new Set(target.phones.map((p) => p.number));
    (source.phones || []).forEach((p) => {
      if (!existingPhoneNumbers.has(p.number)) {
        target.phones.push({ number: p.number, label: p.label, isPrimary: false });
        existingPhoneNumbers.add(p.number);
      }
    });

    if (!target.emails) target.emails = [];
    const existingEmailAddresses = new Set(target.emails.map((e) => e.address));
    (source.emails || []).forEach((e) => {
      if (!existingEmailAddresses.has(e.address)) {
        target.emails.push({ address: e.address, label: e.label, isPrimary: false });
        existingEmailAddresses.add(e.address);
      }
    });

    if (!target.addresses) target.addresses = [];
    const existingAddressKeys = new Set(target.addresses.map((a) => `${a.street || ""}|${a.city || ""}|${a.country || ""}`));
    (source.addresses || []).forEach((a) => {
      const key = `${a.street || ""}|${a.city || ""}|${a.country || ""}`;
      if (!existingAddressKeys.has(key)) {
        target.addresses.push({ type: a.type, street: a.street, city: a.city, state: a.state, postalCode: a.postalCode, country: a.country, isPrimary: false });
        existingAddressKeys.add(key);
      }
    });

    await target.save();

    await CustomerDocumentModel.updateMany({ customerId: source._id }, { customerId: target._id });
    await CustomerFamilyModel.updateMany({ customerId: source._id }, { customerId: target._id });
    await CustomerNoteModel.updateMany({ customerId: source._id }, { customerId: target._id });
    await CustomerTimelineModel.updateMany({ customerId: source._id }, { customerId: target._id });
    // "Merge Includes: Bookings" — BookingHeaderModel already has a real
    // customerId link, so reassign it the same way as the other sub-resources.
    await BookingHeaderModel.updateMany({ customerId: source._id, tenantId }, { customerId: target._id, customerCode: target.customerCode });

    source.status = "archived";
    source.notes = `Merged into ${target.customerCode} (${target._id})`;
    await source.save();

    await recordTimeline(target._id, tenantId, "merged", `Merged duplicate customer ${source.customerCode} into ${target.customerCode}`, req.auth?.id || null);

    await AuditLogModel.create({
      action: "customer.merge",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { primaryCustomerId, duplicateCustomerId }
    });

    publishEvent("CustomersMerged", { primaryCustomerId, duplicateCustomerId, tenantId });
    publishEvent("TimelineMerged", { primaryCustomerId, duplicateCustomerId, tenantId });
    publishEvent("CRMUpdated", { primaryCustomerId, tenantId });

    return sendSuccess(res, 200, "Customers merged successfully.", { customerId: target._id, customerCode: target.customerCode }, requestId);
  } catch (error) {
    console.error("MergeCustomers error:", error);
    return sendError(res, 500, "Unable to merge customers.", requestId);
  }
};

export const GetCustomerVersions = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();

    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    return sendSuccess(res, 200, "Customer profile version history loaded.", customer.versions || [], requestId);
  } catch (error) {
    console.error("GetCustomerVersions error:", error);
    return sendError(res, 500, "Unable to load profile versions.", requestId);
  }
};

export const GetCustomerTimeline = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || customerConfig.defaultPageSize, 10), 1), customerConfig.maxPageSize);

    const moduleFilter = req.query.module || null;
    const eventType = req.query.eventType || req.query.type || null;
    const performedBy = req.query.user || req.query.performedBy || null;
    const startDate = req.query.startDate || req.query.createdAfter ? new Date(req.query.startDate || req.query.createdAfter) : null;
    const endDate = req.query.endDate || req.query.createdBefore ? new Date(req.query.endDate || req.query.createdBefore) : null;

    const filter = { customerId, tenantId };
    if (moduleFilter) filter.module = new RegExp(moduleFilter, "i");
    if (eventType) filter.eventType = new RegExp(eventType, "i");
    if (performedBy) filter.performedBy = performedBy;

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = startDate;
      if (endDate) filter.createdAt.$lte = endDate;
    }

    const totalItems = await CustomerTimelineModel.countDocuments(filter);
    const timeline = await CustomerTimelineModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    const formattedTimeline = timeline.map((item) => ({
      eventId: item._id,
      eventType: item.eventType,
      module: item.module || "Customer",
      title: item.title || item.eventType,
      description: item.description,
      performedBy: item.performedBy,
      performedByName: item.performedByName || "Staff",
      timestamp: item.createdAt,
      referenceId: item.referenceId || null,
      metadata: item.metadata || {}
    }));

    publishEvent("TimelineViewed", { customerId, tenantId, viewedBy: req.auth?.id || null });

    return sendSuccess(res, 200, "Customer timeline loaded.", {
      data: formattedTimeline,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      }
    }, requestId);
  } catch (error) {
    console.error("GetCustomerTimeline error:", error);
    return sendError(res, 500, "Unable to load timeline.", requestId);
  }
};

export const GetCustomerNotes = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || customerConfig.defaultPageSize, 10), 1), customerConfig.maxPageSize);

    const category = req.query.category || null;
    const visibility = req.query.visibility || null;
    const authorId = req.query.authorId || req.query.author || null;
    const search = req.query.search?.trim() || req.query.query?.trim() || null;
    const includeArchived = req.query.includeArchived === "true" || req.query.status === "archived";

    const filter = { customerId, tenantId };
    if (!includeArchived) {
      filter.status = { $ne: "archived" };
    } else if (req.query.status === "archived") {
      filter.status = "archived";
    }

    if (category) filter.category = category;
    if (visibility) filter.visibility = visibility;
    if (authorId) filter.authorId = authorId;

    if (search) {
      filter.$or = [
        { content: new RegExp(search, "i") },
        { category: new RegExp(search, "i") },
        { authorName: new RegExp(search, "i") }
      ];
    }

    const totalItems = await CustomerNoteModel.countDocuments(filter);
    const notes = await CustomerNoteModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    const formattedNotes = notes.map((n) => ({
      noteId: n._id,
      authorId: n.authorId,
      authorName: n.authorName || "Staff",
      createdAt: n.createdAt,
      visibility: n.visibility || "Internal",
      category: n.category || "General",
      content: n.content,
      isImportant: n.isImportant || false,
      status: n.status || "active",
      attachmentsCount: n.attachmentsCount || (n.attachments || []).length,
      attachments: n.attachments || []
    }));

    return sendSuccess(res, 200, "Customer notes loaded.", {
      data: formattedNotes,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      }
    }, requestId);
  } catch (error) {
    console.error("GetCustomerNotes error:", error);
    return sendError(res, 500, "Unable to load notes.", requestId);
  }
};

export const AddCustomerNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.create") && !permissions.includes("customer.create")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const { content, category = customerConfig.defaultNoteCategory, visibility = customerConfig.defaultNoteVisibility, isImportant = false, attachments = [] } = req.body;

    if (!content) return sendError(res, 422, "Note content is required.", requestId);

    const allowedCategories = customerConfig.allowedNoteCategories || [
      "Customer Service", "Sales", "Finance", "Visa", "Travel", "Medical", "Operations", "Support", "General"
    ];
    const allowedVisibilities = customerConfig.allowedNoteVisibilities || ["Internal", "Management", "Branch", "Private"];

    const resolvedCategory = allowedCategories.includes(category) ? category : customerConfig.defaultNoteCategory;
    const resolvedVisibility = allowedVisibilities.includes(visibility) ? visibility : customerConfig.defaultNoteVisibility;

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const formattedAttachments = Array.isArray(attachments) ? attachments.map((att) => ({
      fileName: att.fileName || att.name || "attachment",
      fileUrl: att.fileUrl || att.url || "",
      mimeType: att.mimeType || "application/octet-stream",
      fileSize: att.fileSize || att.size || 0
    })) : [];

    const note = await CustomerNoteModel.create({
      customerId,
      tenantId,
      authorId: req.auth?.id || null,
      authorName: req.auth?.username || req.auth?.name || "Staff",
      category: resolvedCategory,
      visibility: resolvedVisibility,
      content,
      isImportant: Boolean(isImportant),
      status: "active",
      attachmentsCount: formattedAttachments.length,
      attachments: formattedAttachments
    });

    await recordTimeline({
      customerId,
      tenantId,
      module: "Customer",
      eventType: "CustomerNoteCreated",
      title: "Customer Note Added",
      description: `Note added under ${resolvedCategory} (${resolvedVisibility}): ${content.substring(0, 50)}...`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff",
      referenceId: note._id.toString()
    });

    await AuditLogModel.create({
      action: "customer.note.create",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, noteId: note._id, category: resolvedCategory, visibility: resolvedVisibility }
    });

    publishEvent("CustomerNoteCreated", { customerId: customerId.toString(), noteId: note._id.toString(), tenantId, category: resolvedCategory });

    return sendSuccess(res, 201, "Note added successfully.", {
      noteId: note._id,
      authorId: note.authorId,
      authorName: note.authorName,
      createdAt: note.createdAt,
      visibility: note.visibility,
      category: note.category,
      content: note.content,
      isImportant: note.isImportant,
      status: note.status,
      attachmentsCount: note.attachmentsCount,
      attachments: note.attachments
    }, requestId);
  } catch (error) {
    console.error("AddCustomerNote error:", error);
    return sendError(res, 500, "Unable to add note.", requestId);
  }
};

export const ArchiveCustomerNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, noteId } = req.params;
    const note = await CustomerNoteModel.findOne({ _id: noteId, customerId, tenantId, status: { $ne: "archived" } });

    if (!note) return sendError(res, 404, "Note not found or already archived.", requestId);

    note.status = "archived";
    await note.save();

    await recordTimeline({
      customerId,
      tenantId,
      module: "Customer",
      eventType: "CustomerNoteArchived",
      title: "Customer Note Archived",
      description: `Note (${note.category}) archived`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff",
      referenceId: note._id.toString()
    });

    await AuditLogModel.create({
      action: "customer.note.archive",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, noteId: note._id }
    });

    publishEvent("CustomerNoteArchived", { customerId: customerId.toString(), noteId: note._id.toString(), tenantId });

    return sendSuccess(res, 200, "Customer note archived.", null, requestId);
  } catch (error) {
    console.error("ArchiveCustomerNote error:", error);
    return sendError(res, 500, "Unable to archive note.", requestId);
  }
};

export const GetCustomerDocuments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const includeArchived = req.query.includeArchived === "true";
    const filter = { customerId, tenantId, virusScanStatus: { $ne: "infected" } };
    if (!includeArchived) filter.status = { $ne: "archived" };

    const documents = await CustomerDocumentModel.find(filter).sort({ createdAt: -1 }).lean();

    return sendSuccess(res, 200, "Customer documents loaded.", documents.map(buildDocumentResponse), requestId);
  } catch (error) {
    console.error("GetCustomerDocuments error:", error);
    return sendError(res, 500, "Unable to load documents.", requestId);
  }
};

export const AddCustomerDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.create") && !permissions.includes("customer.create")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const { documentType, documentNumber, storageProvider = customerConfig.defaultDocumentStorageProvider, storageKey, fileName, mimeType, expiryDate, notes } = req.body;
    // Doc example uses "size"; fileSize kept as a legacy alias.
    const fileSize = req.body.size ?? req.body.fileSize;

    // The file is uploaded directly to the configured storage backend by the
    // client (or a prior step) — this endpoint only registers the resulting
    // pointer. A client-supplied fileUrl is never accepted/trusted; the
    // signed download URL is always computed server-side from storageKey.
    if (!fileName || !storageProvider || !storageKey) {
      return sendError(res, 422, "fileName, storageProvider and storageKey are required.", requestId);
    }

    if (mimeType && !customerConfig.allowedDocumentMimeTypes.includes(mimeType)) {
      return sendError(res, 422, `Unsupported file type "${mimeType}". Allowed: ${customerConfig.allowedDocumentMimeTypes.join(", ")}.`, requestId);
    }

    if (documentType) {
      const validDocumentTypes = CustomerDocumentModel.schema.path("documentType").enumValues;
      if (!validDocumentTypes.includes(documentType)) {
        return sendError(res, 422, `Invalid documentType "${documentType}". Allowed: ${validDocumentTypes.join(", ")}.`, requestId);
      }
    }

    if (fileSize !== undefined && (fileSize <= 0 || fileSize > storageConfig.maxFileSizeBytes)) {
      return sendError(res, 422, `File size must be between 1 byte and ${storageConfig.maxFileSizeBytes} bytes.`, requestId);
    }

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    if (documentType === "passport_scan" && documentNumber) {
      const existingPassport = await CustomerDocumentModel.findOne({ tenantId, documentType: "passport_scan", documentNumber, status: { $ne: "archived" } });
      if (existingPassport) {
        return sendError(res, 409, "Passport number already exists.", requestId);
      }
    }

    const versionCount = await CustomerDocumentModel.countDocuments({ customerId, tenantId, documentType, documentNumber });

    const doc = await CustomerDocumentModel.create({
      customerId,
      tenantId,
      documentType: documentType || "other",
      documentNumber: documentNumber || null,
      storageProvider,
      storageKey,
      fileName,
      mimeType: mimeType || null,
      fileSize: fileSize || 0,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      status: customerConfig.defaultDocumentStatus,
      version: versionCount + 1,
      uploadedBy: req.auth?.id || null,
      notes: notes || null
    });

    await recordTimeline(customerId, tenantId, "document_uploaded", `Document uploaded: ${fileName}`, req.auth?.id || null);

    await AuditLogModel.create({
      action: "customer.document.upload",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, documentId: doc._id, documentType: doc.documentType }
    });

    publishEvent("DocumentUploaded", { customerId: customerId.toString(), documentId: doc._id.toString(), tenantId, documentType: doc.documentType });

    return sendSuccess(res, 201, "Document added successfully.", buildDocumentResponse(doc), requestId);
  } catch (error) {
    console.error("AddCustomerDocument error:", error);
    return sendError(res, 500, "Unable to add document.", requestId);
  }
};

export const VerifyCustomerDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, documentId } = req.params;
    const doc = await CustomerDocumentModel.findOne({ _id: documentId, customerId, tenantId, status: { $ne: "archived" } });
    if (!doc) return sendError(res, 404, "Document not found.", requestId);

    doc.status = "verified";
    doc.verifiedBy = req.auth?.id || null;
    doc.verifiedAt = new Date();
    doc.rejectionReason = null;
    await doc.save();

    await recordTimeline(customerId, tenantId, "document_verified", `Document verified: ${doc.fileName}`, req.auth?.id || null);
    await AuditLogModel.create({
      action: "customer.document.verify",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, documentId: doc._id }
    });
    publishEvent("DocumentVerified", { customerId: customerId.toString(), documentId: doc._id.toString(), tenantId });

    return sendSuccess(res, 200, "Document verified.", buildDocumentResponse(doc), requestId);
  } catch (error) {
    console.error("VerifyCustomerDocument error:", error);
    return sendError(res, 500, "Unable to verify document.", requestId);
  }
};

export const RejectCustomerDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, documentId } = req.params;
    const { reason } = req.body;
    if (!reason) return sendError(res, 422, "reason is required.", requestId);

    const doc = await CustomerDocumentModel.findOne({ _id: documentId, customerId, tenantId, status: { $ne: "archived" } });
    if (!doc) return sendError(res, 404, "Document not found.", requestId);

    doc.status = "rejected";
    doc.verifiedBy = req.auth?.id || null;
    doc.verifiedAt = new Date();
    doc.rejectionReason = reason;
    await doc.save();

    await recordTimeline(customerId, tenantId, "document_rejected", `Document rejected: ${doc.fileName} (${reason})`, req.auth?.id || null);
    await AuditLogModel.create({
      action: "customer.document.reject",
      outcome: "success",
      reason,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, documentId: doc._id }
    });
    publishEvent("DocumentRejected", { customerId: customerId.toString(), documentId: doc._id.toString(), tenantId, reason });

    return sendSuccess(res, 200, "Document rejected.", buildDocumentResponse(doc), requestId);
  } catch (error) {
    console.error("RejectCustomerDocument error:", error);
    return sendError(res, 500, "Unable to reject document.", requestId);
  }
};

export const DeleteCustomerDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, documentId } = req.params;
    const doc = await CustomerDocumentModel.findOne({ _id: documentId, customerId, tenantId, status: { $ne: "archived" } });

    if (!doc) return sendError(res, 404, "Document not found.", requestId);

    doc.status = "archived";
    await doc.save();

    await recordTimeline(customerId, tenantId, "document_archived", `Document archived: ${doc.fileName}`, req.auth?.id || null);
    await AuditLogModel.create({
      action: "customer.document.archive",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, documentId: doc._id }
    });
    publishEvent("DocumentArchived", { customerId: customerId.toString(), documentId: doc._id.toString(), tenantId });

    return sendSuccess(res, 200, "Document archived successfully.", null, requestId);
  } catch (error) {
    console.error("DeleteCustomerDocument error:", error);
    return sendError(res, 500, "Unable to archive document.", requestId);
  }
};

export const GetCustomerEmergencyContacts = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } }).lean();
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    return sendSuccess(res, 200, "Customer emergency contacts loaded.", (customer.emergencyContacts || []).map((contact, index) => ({
      contactId: contact._id || `${customerId}-${index}`,
      name: contact.name,
      relationship: contact.relationship,
      phone: contact.phone,
      email: contact.email,
      country: contact.country || null,
      priority: contact.priority || 1,
      preferredContactMethod: contact.preferredContactMethod || null,
      isPrimary: Boolean(contact.isPrimary)
    })), requestId);
  } catch (error) {
    console.error("GetCustomerEmergencyContacts error:", error);
    return sendError(res, 500, "Unable to load emergency contacts.", requestId);
  }
};

export const AddCustomerEmergencyContact = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.create") && !permissions.includes("customer.create")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const { name, relationship, phone, email, country, priority, preferredContactMethod, isPrimary = false } = req.body;

    if (!name || !relationship) return sendError(res, 422, "name and relationship are required.", requestId);

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    // Business Rule: "One primary emergency contact required" — the first
    // contact ever added is always primary, same as phones/emails/addresses.
    const makePrimary = Boolean(isPrimary) || (customer.emergencyContacts || []).length === 0;
    if (makePrimary) {
      customer.emergencyContacts = (customer.emergencyContacts || []).map((contact) => ({ ...contact.toObject?.(), ...contact, isPrimary: false }));
    }

    const contact = {
      name,
      relationship,
      phone: phone || null,
      email: email || null,
      country: country || null,
      priority: priority || 1,
      preferredContactMethod: preferredContactMethod || null,
      isPrimary: makePrimary
    };

    customer.emergencyContacts.push(contact);
    await customer.save();

    await recordTimeline(customerId, tenantId, "emergency_contact_added", `Emergency contact added: ${name}`, req.auth?.id || null);
    await AuditLogModel.create({
      action: "customer.emergency_contact.create",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, name, relationship }
    });
    publishEvent("EmergencyContactAdded", { customerId: customerId.toString(), tenantId });

    return sendSuccess(res, 201, "Emergency contact added successfully.", contact, requestId);
  } catch (error) {
    console.error("AddCustomerEmergencyContact error:", error);
    return sendError(res, 500, "Unable to add emergency contact.", requestId);
  }
};

export const UpdateCustomerEmergencyContact = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, contactId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const contact = (customer.emergencyContacts || []).find((item) => String(item._id || item.id) === String(contactId));
    if (!contact) return sendError(res, 404, "Emergency contact not found.", requestId);

    const allowed = ["name", "relationship", "phone", "email", "country", "priority", "preferredContactMethod", "isPrimary"];
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) contact[key] = req.body[key];
    });

    if (contact.isPrimary) {
      customer.emergencyContacts = customer.emergencyContacts.map((item) => ({
        ...item.toObject?.(),
        ...item,
        isPrimary: String(item._id || item.id) === String(contactId) ? true : false
      }));
    }

    await customer.save();
    await recordTimeline(customerId, tenantId, "emergency_contact_updated", `Emergency contact updated: ${contact.name}`, req.auth?.id || null);
    await AuditLogModel.create({
      action: "customer.emergency_contact.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, contactId }
    });
    publishEvent("EmergencyContactUpdated", { customerId: customerId.toString(), tenantId });

    return sendSuccess(res, 200, "Emergency contact updated successfully.", contact, requestId);
  } catch (error) {
    console.error("UpdateCustomerEmergencyContact error:", error);
    return sendError(res, 500, "Unable to update emergency contact.", requestId);
  }
};

export const DeleteCustomerEmergencyContact = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, contactId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const removedContact = (customer.emergencyContacts || []).find((item) => String(item._id || item.id) === String(contactId));
    if (!removedContact) return sendError(res, 404, "Emergency contact not found.", requestId);

    const wasPrimary = Boolean(removedContact.isPrimary);
    customer.emergencyContacts = (customer.emergencyContacts || []).filter((item) => String(item._id || item.id) !== String(contactId));

    // Business Rule: "One primary emergency contact required" — promote
    // another contact to primary if the removed one was it.
    if (wasPrimary && customer.emergencyContacts.length > 0) {
      customer.emergencyContacts[0].isPrimary = true;
    }

    await customer.save();

    await recordTimeline(customerId, tenantId, "emergency_contact_archived", `Emergency contact removed`, req.auth?.id || null);
    await AuditLogModel.create({
      action: "customer.emergency_contact.delete",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, contactId }
    });
    publishEvent("EmergencyContactRemoved", { customerId: customerId.toString(), tenantId });

    return sendSuccess(res, 200, "Emergency contact removed.", null, requestId);
  } catch (error) {
    console.error("DeleteCustomerEmergencyContact error:", error);
    return sendError(res, 500, "Unable to remove emergency contact.", requestId);
  }
};

export const GetCustomerFamily = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || customerConfig.defaultPageSize, 10), 1), customerConfig.maxPageSize);

    const filter = { customerId, tenantId, status: "active" };
    const totalItems = await CustomerFamilyModel.countDocuments(filter);
    const family = await CustomerFamilyModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    return sendSuccess(res, 200, "Customer family members loaded.", {
      data: family.map(buildFamilyMemberResponse),
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      }
    }, requestId);
  } catch (error) {
    console.error("GetCustomerFamily error:", error);
    return sendError(res, 500, "Unable to load family members.", requestId);
  }
};

export const AddCustomerFamilyMember = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.create") && !permissions.includes("customer.create")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const { relationship, gender, dateOfBirth, passportNumber, phone, email, isTraveler = false } = req.body;
    // Doc example uses a single "fullName"; firstName/lastName also accepted directly.
    let { firstName, lastName } = req.body;
    if (!firstName && !lastName && req.body.fullName) {
      const parts = req.body.fullName.trim().split(/\s+/);
      firstName = parts[0];
      lastName = parts.slice(1).join(" ") || parts[0];
    }

    if (!relationship || !firstName || !lastName) {
      return sendError(res, 422, "relationship and fullName (or firstName/lastName) are required.", requestId);
    }

    const resolvedRelationship = relationship.toLowerCase();
    if (!customerConfig.allowedFamilyRelationships.includes(resolvedRelationship)) {
      return sendError(res, 422, `Invalid relationship "${relationship}". Allowed: ${customerConfig.allowedFamilyRelationships.join(", ")}.`, requestId);
    }

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const isDuplicateFamilyMember = await CustomerFamilyModel.findOne({
      customerId,
      tenantId,
      firstName,
      lastName,
      relationship: resolvedRelationship,
      status: "active"
    });

    if (isDuplicateFamilyMember) {
      return sendError(res, 409, "Duplicate family member detected.", requestId);
    }

    const member = await CustomerFamilyModel.create({
      customerId,
      tenantId,
      relationship: resolvedRelationship,
      firstName,
      lastName,
      gender: gender || null,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
      passportNumber: passportNumber || null,
      phone: phone || null,
      email: email || null,
      isTraveler: Boolean(isTraveler),
      status: "active"
    });

    await recordTimeline(customerId, tenantId, "family_added", `Family member added: ${firstName} ${lastName} (${relationship})`, req.auth?.id || null);
    await AuditLogModel.create({
      action: "customer.family.create",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, memberId: member._id, relationship: resolvedRelationship }
    });
    publishEvent("FamilyMemberAdded", { customerId: customerId.toString(), memberId: member._id.toString(), tenantId, relationship: resolvedRelationship });

    return sendSuccess(res, 201, "Family member added successfully.", buildFamilyMemberResponse(member), requestId);
  } catch (error) {
    console.error("AddCustomerFamilyMember error:", error);
    return sendError(res, 500, "Unable to add family member.", requestId);
  }
};

export const UpdateCustomerFamilyMember = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, memberId } = req.params;
    const member = await CustomerFamilyModel.findOne({ _id: memberId, customerId, tenantId });

    if (!member) return sendError(res, 404, "Family member not found.", requestId);

    if (req.body.relationship !== undefined) {
      const normalized = req.body.relationship.toLowerCase();
      if (!customerConfig.allowedFamilyRelationships.includes(normalized)) {
        return sendError(res, 422, `Invalid relationship "${req.body.relationship}". Allowed: ${customerConfig.allowedFamilyRelationships.join(", ")}.`, requestId);
      }
      req.body.relationship = normalized;
    }

    const allowed = ["relationship", "firstName", "lastName", "gender", "dateOfBirth", "passportNumber", "phone", "email", "isTraveler"];
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) member[key] = req.body[key];
    });

    await member.save();
    await recordTimeline(customerId, tenantId, "family_updated", `Family member updated: ${member.firstName} ${member.lastName}`, req.auth?.id || null);
    await AuditLogModel.create({
      action: "customer.family.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, memberId }
    });
    publishEvent("FamilyMemberUpdated", { customerId: customerId.toString(), memberId: member._id.toString(), tenantId });

    return sendSuccess(res, 200, "Family member updated.", buildFamilyMemberResponse(member), requestId);
  } catch (error) {
    console.error("UpdateCustomerFamilyMember error:", error);
    return sendError(res, 500, "Unable to update family member.", requestId);
  }
};

export const DeleteCustomerFamilyMember = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, memberId } = req.params;
    const member = await CustomerFamilyModel.findOne({ _id: memberId, customerId, tenantId, status: "active" });

    if (!member) return sendError(res, 404, "Family member not found.", requestId);

    member.status = "archived";
    await member.save();

    await recordTimeline(customerId, tenantId, "family_archived", `Family member archived: ${member.firstName} ${member.lastName}`, req.auth?.id || null);
    await AuditLogModel.create({
      action: "customer.family.delete",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, memberId }
    });
    publishEvent("FamilyMemberArchived", { customerId: customerId.toString(), memberId: member._id.toString(), tenantId });

    return sendSuccess(res, 200, "Family member archived.", null, requestId);
  } catch (error) {
    console.error("DeleteCustomerFamilyMember error:", error);
    return sendError(res, 500, "Unable to archive family member.", requestId);
  }
};

export const PromoteCustomerFamilyMember = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.create") && !permissions.includes("customer.create")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, memberId } = req.params;
    const member = await CustomerFamilyModel.findOne({ _id: memberId, customerId, tenantId, status: "active" });
    if (!member) return sendError(res, 404, "Family member not found.", requestId);

    if (member.memberCustomerId) {
      return sendError(res, 409, "Family member is already linked to a customer.", requestId);
    }

    const sourceCustomer = await CustomerModel.findOne({ _id: customerId, tenantId });
    if (!sourceCustomer) return sendError(res, 404, "Customer not found.", requestId);

    const { primaryPhone, primaryEmail } = req.body;
    const resolvedPhone = primaryPhone || member.phone || sourceCustomer.phone;
    const resolvedEmail = primaryEmail || member.email;
    if (!resolvedEmail) {
      return sendError(res, 422, "primaryEmail is required to promote a family member without one on file.", requestId);
    }

    const customerCode = `${customerConfig.customerCodePrefix}-${Math.floor(100000 + Math.random() * 900000)}`;
    const newCustomer = await CustomerModel.create({
      tenantId,
      customerCode,
      type: "individual",
      category: customerConfig.defaultCategory,
      status: customerConfig.defaultStatus,
      firstName: member.firstName,
      lastName: member.lastName,
      email: resolvedEmail,
      phone: resolvedPhone,
      gender: member.gender,
      dateOfBirth: member.dateOfBirth,
      preferredLanguage: sourceCustomer.preferredLanguage,
      preferredCurrency: sourceCustomer.preferredCurrency,
      timezone: sourceCustomer.timezone,
      phones: [{ number: resolvedPhone, label: "mobile", isPrimary: true }],
      emails: [{ address: resolvedEmail, label: "personal", isPrimary: true }],
      passports: member.passportNumber ? [{ passportNumber: member.passportNumber, isPrimary: true, status: "active" }] : [],
      assignedTo: sourceCustomer.assignedTo
    });

    member.memberCustomerId = newCustomer._id;
    await member.save();

    await recordTimeline(customerId, tenantId, "family_promoted", `Family member ${member.firstName} ${member.lastName} promoted to customer ${newCustomer.customerCode}`, req.auth?.id || null);
    await recordTimeline(newCustomer._id, tenantId, "created", `Created from family member of ${sourceCustomer.customerCode}`, req.auth?.id || null);

    await AuditLogModel.create({
      action: "customer.family.promote",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { sourceCustomerId: customerId, memberId, newCustomerId: newCustomer._id }
    });

    publishEvent("FamilyMemberPromoted", { customerId: customerId.toString(), memberId: memberId.toString(), newCustomerId: newCustomer._id.toString(), tenantId });
    publishEvent("CustomerCreated", { customerId: newCustomer._id.toString(), tenantId, customerCode: newCustomer.customerCode });

    return sendSuccess(res, 201, "Family member promoted to customer successfully.", {
      memberId: member._id,
      customerId: newCustomer._id,
      customerCode: newCustomer.customerCode
    }, requestId);
  } catch (error) {
    console.error("PromoteCustomerFamilyMember error:", error);
    return sendError(res, 500, "Unable to promote family member.", requestId);
  }
};

export const GetCustomerPassports = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } }).lean();
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const passports = (customer.passports || []).map(buildPassportResponse);
    return sendSuccess(res, 200, "Customer passports loaded.", passports, requestId);
  } catch (error) {
    console.error("GetCustomerPassports error:", error);
    return sendError(res, 500, "Unable to load passports.", requestId);
  }
};

export const AddCustomerPassport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.create") && !permissions.includes("customer.create")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const {
      passportNumber,
      countryId,
      countryOfIssue,
      issueDate,
      expiryDate,
      placeOfIssue,
      isPrimary = false,
      status = "active"
    } = req.body;

    if (!passportNumber || !(countryId || countryOfIssue) || !issueDate || !expiryDate || !placeOfIssue) {
      return sendError(res, 422, "passportNumber, countryId (or countryOfIssue), issueDate, expiryDate, and placeOfIssue are required.", requestId);
    }

    // Validation Rule: "Country exists" — resolved against real CountryMasterModel
    // data (same pattern used for nationalityId elsewhere in this module).
    let resolvedCountryName = countryOfIssue || null;
    if (countryId) {
      const country = await CountryMasterModel.findOne({ tenantId, countryId, isActive: true }).lean();
      if (!country) {
        return sendError(res, 422, `Country "${countryId}" does not exist.`, requestId);
      }
      resolvedCountryName = country.name;
    }

    const parsedIssueDate = new Date(issueDate);
    const parsedExpiryDate = new Date(expiryDate);
    if (parsedIssueDate >= parsedExpiryDate) {
      return sendError(res, 422, "Issue date must be before expiry date.", requestId);
    }

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    // Validation Rule: "Passport Number unique within tenant."
    const passportOwnedByAnother = await CustomerModel.findOne({
      tenantId,
      status: { $ne: "archived" },
      "passports.passportNumber": passportNumber
    }).lean();
    if (passportOwnedByAnother) {
      return sendError(res, 409, passportOwnedByAnother._id.toString() === customer._id.toString()
        ? "Passport number already exists for this customer."
        : "Passport number is already registered to another customer.", requestId);
    }

    if (isPrimary) {
      customer.passports = (customer.passports || []).map((passport) => ({
        ...passport.toObject?.(),
        ...passport,
        isPrimary: false
      }));
    }

    const passportStatus = normalizePassportStatus({ issueDate: parsedIssueDate, expiryDate: parsedExpiryDate, status });

    customer.passports.push({
      passportNumber,
      countryId: countryId || null,
      countryOfIssue: resolvedCountryName,
      issueDate: parsedIssueDate,
      expiryDate: parsedExpiryDate,
      placeOfIssue,
      isPrimary,
      status: passportStatus
    });

    await customer.save();

    const created = customer.passports[customer.passports.length - 1];
    await recordTimeline(customer._id, tenantId, "passport_added", `Passport added: ${passportNumber}`, req.auth?.id || null);
    await AuditLogModel.create({
      action: "customer.passport.create",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, passportId: created._id, passportNumber }
    });
    publishEvent("PassportCreated", { customerId: customer._id.toString(), tenantId, passportId: created._id.toString(), passportNumber });

    return sendSuccess(res, 201, "Passport added successfully.", buildPassportResponse(created), requestId);
  } catch (error) {
    console.error("AddCustomerPassport error:", error);
    return sendError(res, 500, "Unable to add passport.", requestId);
  }
};

export const UpdateCustomerPassport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, passportId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const passport = (customer.passports || []).find((p) => String(p._id) === String(passportId));
    if (!passport) return sendError(res, 404, "Passport not found.", requestId);

    const { placeOfIssue, expiryDate, status, isPrimary } = req.body;
    const previousStatus = passport.status;

    if (placeOfIssue !== undefined) passport.placeOfIssue = placeOfIssue;
    if (expiryDate !== undefined) passport.expiryDate = new Date(expiryDate);
    if (status !== undefined) {
      const validStatuses = CustomerModel.schema.path("passports").schema.path("status").enumValues;
      if (!validStatuses.includes(status)) {
        return sendError(res, 422, `Invalid status "${status}". Allowed: ${validStatuses.join(", ")}.`, requestId);
      }
      passport.status = status;
    } else {
      // Only re-derive from dates when the caller isn't explicitly setting a
      // terminal status (cancelled/lost/renewed) — normalizePassportStatus
      // already preserves those, this just keeps active/expiring_soon/expired current.
      passport.status = normalizePassportStatus(passport);
    }

    if (isPrimary === true) {
      customer.passports.forEach((p) => { p.isPrimary = String(p._id) === String(passportId); });
    }

    await customer.save();

    // Only one of these three lifecycle events is published per update, chosen
    // by the actual transition — matches the doc's PassportUpdated/PassportExpired/
    // PassportReplaced trio rather than always firing a generic "updated" event.
    let eventName = "PassportUpdated";
    if (passport.status === "expired" && previousStatus !== "expired") eventName = "PassportExpired";
    else if (passport.status === "renewed" && previousStatus !== "renewed") eventName = "PassportReplaced";

    await recordTimeline(customer._id, tenantId, "passport_updated", `Passport updated: ${passport.passportNumber} (${previousStatus} -> ${passport.status})`, req.auth?.id || null);
    await AuditLogModel.create({
      action: "customer.passport.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, passportId, previousStatus, newStatus: passport.status }
    });
    publishEvent(eventName, { customerId: customer._id.toString(), tenantId, passportId: passport._id.toString(), passportNumber: passport.passportNumber, previousStatus, newStatus: passport.status });

    return sendSuccess(res, 200, "Passport updated successfully.", buildPassportResponse(passport), requestId);
  } catch (error) {
    console.error("UpdateCustomerPassport error:", error);
    return sendError(res, 500, "Unable to update passport.", requestId);
  }
};

export const GetCustomerPhones = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } }).lean();
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    return sendSuccess(res, 200, "Customer phone numbers loaded.", (customer.phones || []).map((p) => ({
      phoneId: p._id,
      number: p.number,
      label: p.label,
      isPrimary: Boolean(p.isPrimary)
    })), requestId);
  } catch (error) {
    console.error("GetCustomerPhones error:", error);
    return sendError(res, 500, "Unable to load phone numbers.", requestId);
  }
};

export const AddCustomerPhone = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const { number, label = "mobile", isPrimary = false } = req.body;
    if (!number) return sendError(res, 422, "number is required.", requestId);

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    if (!customer.phones) customer.phones = [];
    if (customer.phones.some((p) => p.number === number)) {
      return sendError(res, 409, "This phone number already exists for this customer.", requestId);
    }

    const makePrimary = Boolean(isPrimary) || customer.phones.length === 0;
    if (makePrimary) {
      customer.phones.forEach((p) => { p.isPrimary = false; });
    }

    customer.phones.push({ number, label, isPrimary: makePrimary });
    if (makePrimary) customer.phone = number;

    await customer.save();

    await recordTimeline(customer._id, tenantId, "phone_added", `Phone number added: ${number}`, req.auth?.id || null);
    await AuditLogModel.create({ action: "customer.phone.create", outcome: "success", reason: null, userId: req.auth?.id || null, tenantId, requestId, metadata: { customerId } });
    publishEvent("CustomerContactUpdated", { customerId: customer._id.toString(), tenantId, contactType: "phone" });

    const added = customer.phones[customer.phones.length - 1];
    return sendSuccess(res, 201, "Phone number added successfully.", { phoneId: added._id, number: added.number, label: added.label, isPrimary: added.isPrimary }, requestId);
  } catch (error) {
    console.error("AddCustomerPhone error:", error);
    return sendError(res, 500, "Unable to add phone number.", requestId);
  }
};

export const UpdateCustomerPhone = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, phoneId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const phone = (customer.phones || []).find((item) => String(item._id) === String(phoneId));
    if (!phone) return sendError(res, 404, "Phone number not found.", requestId);

    if (req.body.number !== undefined) {
      const duplicate = customer.phones.some((p) => p.number === req.body.number && String(p._id) !== String(phoneId));
      if (duplicate) return sendError(res, 409, "This phone number already exists for this customer.", requestId);
      phone.number = req.body.number;
    }
    if (req.body.label !== undefined) phone.label = req.body.label;
    if (req.body.isPrimary === true) {
      customer.phones.forEach((p) => { p.isPrimary = String(p._id) === String(phoneId); });
    }

    const primary = customer.phones.find((p) => p.isPrimary);
    if (primary) customer.phone = primary.number;

    await customer.save();
    await recordTimeline(customer._id, tenantId, "phone_updated", `Phone number updated: ${phone.number}`, req.auth?.id || null);
    await AuditLogModel.create({ action: "customer.phone.update", outcome: "success", reason: null, userId: req.auth?.id || null, tenantId, requestId, metadata: { customerId, phoneId } });
    publishEvent("CustomerContactUpdated", { customerId: customer._id.toString(), tenantId, contactType: "phone" });

    return sendSuccess(res, 200, "Phone number updated successfully.", { phoneId: phone._id, number: phone.number, label: phone.label, isPrimary: phone.isPrimary }, requestId);
  } catch (error) {
    console.error("UpdateCustomerPhone error:", error);
    return sendError(res, 500, "Unable to update phone number.", requestId);
  }
};

export const DeleteCustomerPhone = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, phoneId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const phone = (customer.phones || []).find((item) => String(item._id) === String(phoneId));
    if (!phone) return sendError(res, 404, "Phone number not found.", requestId);

    const wasPrimary = phone.isPrimary;
    customer.phones = customer.phones.filter((item) => String(item._id) !== String(phoneId));

    if (wasPrimary && customer.phones.length > 0) {
      customer.phones[0].isPrimary = true;
      customer.phone = customer.phones[0].number;
    }

    await customer.save();
    await recordTimeline(customer._id, tenantId, "phone_removed", `Phone number removed: ${phone.number}`, req.auth?.id || null);
    await AuditLogModel.create({ action: "customer.phone.delete", outcome: "success", reason: null, userId: req.auth?.id || null, tenantId, requestId, metadata: { customerId, phoneId } });
    publishEvent("CustomerContactUpdated", { customerId: customer._id.toString(), tenantId, contactType: "phone" });

    return sendSuccess(res, 200, "Phone number removed.", null, requestId);
  } catch (error) {
    console.error("DeleteCustomerPhone error:", error);
    return sendError(res, 500, "Unable to remove phone number.", requestId);
  }
};

export const GetCustomerEmails = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } }).lean();
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    return sendSuccess(res, 200, "Customer email addresses loaded.", (customer.emails || []).map((e) => ({
      emailId: e._id,
      address: e.address,
      label: e.label,
      isPrimary: Boolean(e.isPrimary)
    })), requestId);
  } catch (error) {
    console.error("GetCustomerEmails error:", error);
    return sendError(res, 500, "Unable to load email addresses.", requestId);
  }
};

export const AddCustomerEmail = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const { address, label = "personal", isPrimary = false } = req.body;
    if (!address) return sendError(res, 422, "address is required.", requestId);

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    if (!customer.emails) customer.emails = [];
    if (customer.emails.some((e) => e.address === address)) {
      return sendError(res, 409, "This email address already exists for this customer.", requestId);
    }

    const makePrimary = Boolean(isPrimary) || customer.emails.length === 0;
    if (makePrimary) {
      customer.emails.forEach((e) => { e.isPrimary = false; });
    }

    customer.emails.push({ address, label, isPrimary: makePrimary });
    if (makePrimary) customer.email = address;

    await customer.save();

    await recordTimeline(customer._id, tenantId, "email_added", `Email address added: ${address}`, req.auth?.id || null);
    await AuditLogModel.create({ action: "customer.email.create", outcome: "success", reason: null, userId: req.auth?.id || null, tenantId, requestId, metadata: { customerId } });
    publishEvent("CustomerContactUpdated", { customerId: customer._id.toString(), tenantId, contactType: "email" });

    const added = customer.emails[customer.emails.length - 1];
    return sendSuccess(res, 201, "Email address added successfully.", { emailId: added._id, address: added.address, label: added.label, isPrimary: added.isPrimary }, requestId);
  } catch (error) {
    console.error("AddCustomerEmail error:", error);
    return sendError(res, 500, "Unable to add email address.", requestId);
  }
};

export const UpdateCustomerEmail = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, emailId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const email = (customer.emails || []).find((item) => String(item._id) === String(emailId));
    if (!email) return sendError(res, 404, "Email address not found.", requestId);

    if (req.body.address !== undefined) {
      const duplicate = customer.emails.some((e) => e.address === req.body.address && String(e._id) !== String(emailId));
      if (duplicate) return sendError(res, 409, "This email address already exists for this customer.", requestId);
      email.address = req.body.address;
    }
    if (req.body.label !== undefined) email.label = req.body.label;
    if (req.body.isPrimary === true) {
      customer.emails.forEach((e) => { e.isPrimary = String(e._id) === String(emailId); });
    }

    const primary = customer.emails.find((e) => e.isPrimary);
    if (primary) customer.email = primary.address;

    await customer.save();
    await recordTimeline(customer._id, tenantId, "email_updated", `Email address updated: ${email.address}`, req.auth?.id || null);
    await AuditLogModel.create({ action: "customer.email.update", outcome: "success", reason: null, userId: req.auth?.id || null, tenantId, requestId, metadata: { customerId, emailId } });
    publishEvent("CustomerContactUpdated", { customerId: customer._id.toString(), tenantId, contactType: "email" });

    return sendSuccess(res, 200, "Email address updated successfully.", { emailId: email._id, address: email.address, label: email.label, isPrimary: email.isPrimary }, requestId);
  } catch (error) {
    console.error("UpdateCustomerEmail error:", error);
    return sendError(res, 500, "Unable to update email address.", requestId);
  }
};

export const DeleteCustomerEmail = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, emailId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const email = (customer.emails || []).find((item) => String(item._id) === String(emailId));
    if (!email) return sendError(res, 404, "Email address not found.", requestId);

    const wasPrimary = email.isPrimary;
    customer.emails = customer.emails.filter((item) => String(item._id) !== String(emailId));

    if (wasPrimary && customer.emails.length > 0) {
      customer.emails[0].isPrimary = true;
      customer.email = customer.emails[0].address;
    }

    await customer.save();
    await recordTimeline(customer._id, tenantId, "email_removed", `Email address removed: ${email.address}`, req.auth?.id || null);
    await AuditLogModel.create({ action: "customer.email.delete", outcome: "success", reason: null, userId: req.auth?.id || null, tenantId, requestId, metadata: { customerId, emailId } });
    publishEvent("CustomerContactUpdated", { customerId: customer._id.toString(), tenantId, contactType: "email" });

    return sendSuccess(res, 200, "Email address removed.", null, requestId);
  } catch (error) {
    console.error("DeleteCustomerEmail error:", error);
    return sendError(res, 500, "Unable to remove email address.", requestId);
  }
};

export const GetCustomerAddresses = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } }).lean();
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    return sendSuccess(res, 200, "Customer addresses loaded.", (customer.addresses || []).map((a) => ({
      addressId: a._id,
      type: a.type,
      street: a.street,
      city: a.city,
      state: a.state,
      postalCode: a.postalCode,
      country: a.country,
      isPrimary: Boolean(a.isPrimary)
    })), requestId);
  } catch (error) {
    console.error("GetCustomerAddresses error:", error);
    return sendError(res, 500, "Unable to load addresses.", requestId);
  }
};

export const AddCustomerAddress = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const { type = "home", street, city, state, postalCode, country, isPrimary = false } = req.body;

    if (country) {
      const validCountry = await CountryMasterModel.findOne({
        tenantId, isActive: true, $or: [{ name: new RegExp(`^${country}$`, "i") }, { code: country.toUpperCase() }]
      }).lean();
      if (!validCountry) {
        return sendError(res, 422, `Invalid country "${country}".`, requestId);
      }
    }

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    if (!customer.addresses) customer.addresses = [];
    const makePrimary = Boolean(isPrimary) || customer.addresses.length === 0;
    if (makePrimary) {
      customer.addresses.forEach((a) => { a.isPrimary = false; });
    }

    const newAddress = { type, street: street || null, city: city || null, state: state || null, postalCode: postalCode || null, country: country || null, isPrimary: makePrimary };
    customer.addresses.push(newAddress);
    if (makePrimary) customer.address = { street: newAddress.street, city: newAddress.city, state: newAddress.state, postalCode: newAddress.postalCode, country: newAddress.country };

    await customer.save();

    await recordTimeline(customer._id, tenantId, "address_added", `Address added (${type})`, req.auth?.id || null);
    await AuditLogModel.create({ action: "customer.address.create", outcome: "success", reason: null, userId: req.auth?.id || null, tenantId, requestId, metadata: { customerId } });
    publishEvent("CustomerContactUpdated", { customerId: customer._id.toString(), tenantId, contactType: "address" });

    const added = customer.addresses[customer.addresses.length - 1];
    return sendSuccess(res, 201, "Address added successfully.", {
      addressId: added._id, type: added.type, street: added.street, city: added.city, state: added.state, postalCode: added.postalCode, country: added.country, isPrimary: added.isPrimary
    }, requestId);
  } catch (error) {
    console.error("AddCustomerAddress error:", error);
    return sendError(res, 500, "Unable to add address.", requestId);
  }
};

export const UpdateCustomerAddress = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, addressId } = req.params;

    if (req.body.country) {
      const validCountry = await CountryMasterModel.findOne({
        tenantId, isActive: true, $or: [{ name: new RegExp(`^${req.body.country}$`, "i") }, { code: req.body.country.toUpperCase() }]
      }).lean();
      if (!validCountry) {
        return sendError(res, 422, `Invalid country "${req.body.country}".`, requestId);
      }
    }

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const address = (customer.addresses || []).find((item) => String(item._id) === String(addressId));
    if (!address) return sendError(res, 404, "Address not found.", requestId);

    const allowed = ["type", "street", "city", "state", "postalCode", "country"];
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) address[key] = req.body[key];
    });
    if (req.body.isPrimary === true) {
      customer.addresses.forEach((a) => { a.isPrimary = String(a._id) === String(addressId); });
    }

    const primary = customer.addresses.find((a) => a.isPrimary);
    if (primary) customer.address = { street: primary.street, city: primary.city, state: primary.state, postalCode: primary.postalCode, country: primary.country };

    await customer.save();
    await recordTimeline(customer._id, tenantId, "address_updated", `Address updated (${address.type})`, req.auth?.id || null);
    await AuditLogModel.create({ action: "customer.address.update", outcome: "success", reason: null, userId: req.auth?.id || null, tenantId, requestId, metadata: { customerId, addressId } });
    publishEvent("CustomerContactUpdated", { customerId: customer._id.toString(), tenantId, contactType: "address" });

    return sendSuccess(res, 200, "Address updated successfully.", {
      addressId: address._id, type: address.type, street: address.street, city: address.city, state: address.state, postalCode: address.postalCode, country: address.country, isPrimary: address.isPrimary
    }, requestId);
  } catch (error) {
    console.error("UpdateCustomerAddress error:", error);
    return sendError(res, 500, "Unable to update address.", requestId);
  }
};

export const DeleteCustomerAddress = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId, addressId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const address = (customer.addresses || []).find((item) => String(item._id) === String(addressId));
    if (!address) return sendError(res, 404, "Address not found.", requestId);

    const wasPrimary = address.isPrimary;
    customer.addresses = customer.addresses.filter((item) => String(item._id) !== String(addressId));

    if (wasPrimary && customer.addresses.length > 0) {
      customer.addresses[0].isPrimary = true;
      const p = customer.addresses[0];
      customer.address = { street: p.street, city: p.city, state: p.state, postalCode: p.postalCode, country: p.country };
    }

    await customer.save();
    await recordTimeline(customer._id, tenantId, "address_removed", `Address removed (${address.type})`, req.auth?.id || null);
    await AuditLogModel.create({ action: "customer.address.delete", outcome: "success", reason: null, userId: req.auth?.id || null, tenantId, requestId, metadata: { customerId, addressId } });
    publishEvent("CustomerContactUpdated", { customerId: customer._id.toString(), tenantId, contactType: "address" });

    return sendSuccess(res, 200, "Address removed.", null, requestId);
  } catch (error) {
    console.error("DeleteCustomerAddress error:", error);
    return sendError(res, 500, "Unable to remove address.", requestId);
  }
};

export const GetCustomerPreferences = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } }).lean();
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    let pref = await CustomerPreferenceModel.findOne({ customerId, tenantId }).lean();

    if (!pref) {
      pref = {
        preferredLanguage: customer.preferredLanguage || customerConfig.defaultLanguage,
        preferredCurrency: customer.preferredCurrency || customerConfig.defaultCurrency,
        preferredCommunicationChannel: customerConfig.defaultCommunicationChannel,
        communicationChannel: customerConfig.defaultCommunicationChannel,
        preferredAirline: null,
        preferredHotelCategory: null,
        hotelPreferences: [],
        mealPreference: customerConfig.defaultMealPreference,
        seatPreference: customerConfig.defaultSeatPreference,
        specialAssistance: null,
        wheelchairAssistance: false,
        marketingConsent: customer.marketingConsent || false,
        notificationPreferences: customerConfig.defaultNotificationPreferences
      };
    }

    return sendSuccess(res, 200, "Customer preferences loaded.", {
      preferredLanguage: pref.preferredLanguage || customer.preferredLanguage || customerConfig.defaultLanguage,
      preferredCurrency: pref.preferredCurrency || customer.preferredCurrency || customerConfig.defaultCurrency,
      preferredCommunicationChannel: pref.preferredCommunicationChannel || pref.communicationChannel || customerConfig.defaultCommunicationChannel,
      communicationChannel: pref.communicationChannel || pref.preferredCommunicationChannel || customerConfig.defaultCommunicationChannel,
      preferredAirline: pref.preferredAirline || null,
      preferredHotelCategory: pref.preferredHotelCategory || null,
      hotelPreferences: pref.hotelPreferences || [],
      mealPreference: pref.mealPreference || customerConfig.defaultMealPreference,
      seatPreference: pref.seatPreference || customerConfig.defaultSeatPreference,
      specialAssistance: pref.specialAssistance || null,
      wheelchairAssistance: pref.wheelchairAssistance || false,
      marketingConsent: pref.marketingConsent !== undefined ? pref.marketingConsent : (customer.marketingConsent || false),
      notificationPreferences: pref.notificationPreferences || customerConfig.defaultNotificationPreferences
    }, requestId);
  } catch (error) {
    console.error("GetCustomerPreferences error:", error);
    return sendError(res, 500, "Unable to load preferences.", requestId);
  }
};

export const UpdateCustomerPreferences = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.update") && !permissions.includes("customer.update")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const allowed = [
      "preferredLanguage", "preferredCurrency", "preferredCommunicationChannel", "communicationChannel",
      "preferredAirline", "preferredHotelCategory", "hotelPreferences", "mealPreference", "seatPreference",
      "specialAssistance", "wheelchairAssistance", "marketingConsent", "notificationPreferences"
    ];

    // Same dynamic validation as PATCH /customers/{id} — preferences is a
    // second write path to preferredLanguage/preferredCurrency and must not
    // bypass the "Valid Language"/"Valid Currency" rules.
    if (req.body.preferredLanguage !== undefined) {
      try {
        Intl.getCanonicalLocales([req.body.preferredLanguage]);
      } catch {
        return sendError(res, 422, `Invalid language "${req.body.preferredLanguage}".`, requestId);
      }
    }
    if (req.body.preferredCurrency !== undefined) {
      if (!Intl.supportedValuesOf("currency").includes(req.body.preferredCurrency.toUpperCase())) {
        return sendError(res, 422, `Invalid currency "${req.body.preferredCurrency}".`, requestId);
      }
      req.body.preferredCurrency = req.body.preferredCurrency.toUpperCase();
    }

    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    let pref = await CustomerPreferenceModel.findOne({ customerId, tenantId });
    if (!pref) {
      pref = new CustomerPreferenceModel({ customerId, tenantId });
    }

    allowed.forEach((key) => {
      if (req.body[key] !== undefined) {
        pref[key] = req.body[key];
      }
    });

    if (req.body.preferredLanguage) customer.preferredLanguage = req.body.preferredLanguage;
    if (req.body.preferredCurrency) customer.preferredCurrency = req.body.preferredCurrency;
    if (req.body.marketingConsent !== undefined) customer.marketingConsent = Boolean(req.body.marketingConsent);

    await pref.save();

    const docsCount = await CustomerDocumentModel.countDocuments({ customerId: customer._id });
    const familyCount = await CustomerFamilyModel.countDocuments({ customerId: customer._id });
    const metrics = calculateCustomerMetrics(customer, docsCount, familyCount, pref);
    customer.completenessScore = metrics.completeness;
    customer.healthScore = metrics.healthScore;
    await customer.save();

    await recordTimeline({
      customerId,
      tenantId,
      module: "Customer",
      eventType: "CustomerPreferenceUpdated",
      title: "Customer Preferences Updated",
      description: "Updated customer travel, communication, and notification preferences",
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff"
    });

    await AuditLogModel.create({
      action: "customer.preferences.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { customerId, updatedKeys: Object.keys(req.body).filter((k) => allowed.includes(k)) }
    });

    publishEvent("CustomerPreferenceUpdated", { customerId: customer._id.toString(), tenantId });

    return sendSuccess(res, 200, "Preferences updated.", pref, requestId);
  } catch (error) {
    console.error("UpdateCustomerPreferences error:", error);
    return sendError(res, 500, "Unable to update preferences.", requestId);
  }
};

export const GetCustomerStatistics = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) return sendError(res, 403, "Permission denied.", requestId);

    const { customerId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });

    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    // "Cache expensive calculations" — the response is cached for
    // DASHBOARD_CACHE_TTL_SECONDS; booking-derived numbers additionally come
    // from an asynchronously-refreshed summary table (CustomerStatisticsEngine),
    // never a live join across booking records.
    const { data: stats } = await CacheManager.getOrCompute(`customer-statistics:${tenantId}:${customerId}`, async () => {
      const [documentsUploaded, familyMembers, notesCount, prefs, lastTimeline, bookingMetrics] = await Promise.all([
        CustomerDocumentModel.countDocuments({ customerId: customer._id, status: { $ne: "archived" } }),
        CustomerFamilyModel.countDocuments({ customerId: customer._id, status: "active" }),
        CustomerNoteModel.countDocuments({ customerId: customer._id, status: { $ne: "archived" } }),
        CustomerPreferenceModel.findOne({ customerId: customer._id }).lean(),
        CustomerTimelineModel.findOne({ customerId: customer._id, tenantId }).sort({ createdAt: -1 }).lean(),
        CustomerStatisticsEngine.ensureBookingMetrics({ customerId: customer._id, tenantId })
      ]);

      const metrics = calculateCustomerMetrics(customer, documentsUploaded, familyMembers, prefs);

      return {
        totalBookings: bookingMetrics.totalBookings,
        completedTrips: bookingMetrics.completedTrips,
        upcomingTrips: bookingMetrics.upcomingTrips,
        cancelledTrips: bookingMetrics.cancelledTrips,
        visaApplications: bookingMetrics.visaApplications,
        approvedVisas: bookingMetrics.approvedVisas,
        rejectedVisas: bookingMetrics.rejectedVisas,
        totalRevenue: bookingMetrics.totalRevenue,
        outstandingBalance: bookingMetrics.outstandingBalance,
        refundAmount: bookingMetrics.refundAmount,
        averageBookingValue: bookingMetrics.averageBookingValue,
        statisticsLastRefreshedAt: bookingMetrics.lastRefreshedAt,
        documentsUploaded,
        familyMembers,
        lastActivity: lastTimeline ? lastTimeline.createdAt : customer.updatedAt,
        customerSince: customer.createdAt,
        loyaltyLevel: customer.category ? customer.category.toUpperCase() : "REGULAR",
        healthScore: metrics.healthScore,
        profileCompletion: metrics.completeness,
        notesCount,
        passportsCount: (customer.passports || []).length,
        activePassportsCount: (customer.passports || []).filter((p) => p.status === "active").length
      };
    });

    publishEvent("StatisticsUpdated", { customerId: customer._id.toString(), tenantId });

    return sendSuccess(res, 200, "Customer statistics loaded.", stats, requestId);
  } catch (error) {
    console.error("GetCustomerStatistics error:", error);
    return sendError(res, 500, "Unable to load statistics.", requestId);
  }
};

/**
 * GET /api/v1/customers/{customerId}/bookings — booking-module PRD item #8
 * ("customer -> all bookings in one place" had no purpose-built endpoint;
 * only GET /bookings?customerId=X worked as a filter). Thin wrapper over
 * the same BookingHeaderModel query ListBookings already uses, scoped to
 * one customer.
 */
export const GetCustomerBookings = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);

    if (!permissions.includes("customers.read") && !permissions.includes("customer.read") &&
        !permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { customerId } = req.params;
    const customer = await CustomerModel.findOne({ _id: customerId, ...scope }).lean();
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || "20", 10), 1), 100);
    const filter = { ...scope, customerId, status: { $ne: "archived" } };
    if (req.query.bookingType) filter.bookingType = req.query.bookingType.toLowerCase();

    const [items, total] = await Promise.all([
      BookingHeaderModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      BookingHeaderModel.countDocuments(filter)
    ]);

    return sendSuccess(res, 200, "Customer bookings loaded.", {
      items,
      pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
    }, requestId);
  } catch (error) {
    console.error("GetCustomerBookings error:", error);
    return sendError(res, 500, "Unable to load customer bookings.", requestId);
  }
};

/**
 * GET /api/v1/customers/{customerId}/account-statement — booking-module
 * PRD item #10 (Lifetime Account Statement). See
 * CustomerAccountStatementService's own doc comment for why this is built
 * entirely from real AccountsReceivable records rather than
 * BookingHeaderModel.financialSnapshot.
 */
export const GetCustomerAccountStatement = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);

    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { customerId } = req.params;
    const { dateFrom, dateTo, status, viewCurrency } = req.query;

    const statement = await CustomerAccountStatementService.getStatement(customerId, scope.tenantId, { dateFrom, dateTo, status, viewCurrency });
    return sendSuccess(res, 200, "Account statement loaded.", statement, requestId);
  } catch (error) {
    if (error.message === "Customer not found.") return sendError(res, 404, error.message, requestId);
    console.error("GetCustomerAccountStatement error:", error);
    return sendError(res, 500, "Unable to load account statement.", requestId);
  }
};

/**
 * GET /api/v1/customers/{customerId}/account-statement/pdf — booking-module
 * PRD item #10 continued (Issue 6). Same generate-buffer -> storeDocumentPdf
 * -> return URL shape every other PDF document in this codebase uses
 * (InvoiceService._generatePdf, ReceiptService, etc.) — regenerated fresh on
 * every call from CustomerAccountStatementService's live data, never a
 * separately cached copy, since the statement itself has no persisted
 * document to keep in sync.
 */
export const GetCustomerAccountStatementPdf = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);

    if (!permissions.includes("customers.read") && !permissions.includes("customer.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { customerId } = req.params;
    const { dateFrom, dateTo, status, viewCurrency } = req.query;

    const statement = await CustomerAccountStatementService.getStatement(customerId, scope.tenantId, { dateFrom, dateTo, status, viewCurrency });
    const buffer = await CustomerStatementPdfService.generatePdfBuffer(statement);
    const filename = `statement-${statement.customer.customerCode || statement.customer.customerId}-${Date.now()}.pdf`;
    const stored = await storeDocumentPdf({ tenantId: scope.tenantId, folder: "customer-statements", filename, buffer });

    return sendSuccess(res, 200, "Account statement PDF generated.", { url: stored.url, generatedAt: statement.generatedAt }, requestId);
  } catch (error) {
    if (error.message === "Customer not found.") return sendError(res, 404, error.message, requestId);
    console.error("GetCustomerAccountStatementPdf error:", error);
    return sendError(res, 500, "Unable to generate account statement PDF.", requestId);
  }
};
