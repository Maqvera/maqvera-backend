import mongoose from "mongoose";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import BookingTravelerModel from "../models/BookingTravelerModel.js";
import BookingServiceModel from "../models/BookingServiceModel.js";
import TravelerServiceAssignmentModel from "../models/TravelerServiceAssignmentModel.js";
import BookingDocumentModel from "../models/BookingDocumentModel.js";
import BookingTaskModel from "../models/BookingTaskModel.js";
import BookingTimelineModel from "../models/BookingTimelineModel.js";
import BookingNoteModel from "../models/BookingNoteModel.js";
import BookingWorkflowModel from "../models/BookingWorkflowModel.js";
import CustomerModel from "../models/CustomerModel.js";
import BranchModel from "../models/Branchmodel.js";
import EmployeeProfileModel from "../models/EmployeeProfilemodel.js";
import FlightCatalogModel from "../models/FlightCatalogModel.js";
import HotelCatalogModel from "../models/HotelCatalogModel.js";
import HotelRoomInventoryModel from "../models/HotelRoomInventoryModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import EnterpriseDocumentService from "../services/EnterpriseDocumentService.js";
import { sendError, sendSuccess } from "../utils/apiResponse.js";
import { publishEvent } from "../utils/eventBus.js";
import { createRequestId } from "../utils/authTokens.js";
import { handleBookingCreatedSaga } from "../utils/BookingSagaManager.js";
import { getBookingConfig } from "../utils/bookingConfig.js";
import { getStorageConfig } from "../utils/storageConfig.js";
import { saveBookingDocumentFile, resolveBookingDocumentUrl } from "../utils/fileStorage.js";
import CacheManager from "../utils/cacheManager.js";
import {
  getOrCreateWorkflowInstance,
  getAllowedNextActions,
  executeWorkflowTransition,
  getWorkflowDefinitionForEntity
} from "../utils/WorkflowEngine.js";

const bookingConfig = getBookingConfig();
const storageConfig = getStorageConfig();

// "Signed URLs generated" — storageKey/the internal path never leave this
// function; only a short-lived signed URL does (falls back to the legacy
// stored fileUrl for documents registered before storageKey existed).
const buildBookingDocumentResponse = (doc) => ({
  documentId: doc._id,
  bookingId: doc.bookingId,
  fileName: doc.fileName,
  fileUrl: doc.storageKey ? (EnterpriseDocumentService.generateSignedUrl(doc.storageKey) || doc.fileUrl) : doc.fileUrl,
  fileType: doc.fileType,
  fileSize: doc.fileSize,
  category: doc.category,
  version: doc.version,
  status: doc.status,
  virusScanStatus: doc.virusScanStatus,
  verifiedBy: doc.verifiedBy,
  verifiedAt: doc.verifiedAt,
  rejectionReason: doc.rejectionReason,
  uploadedBy: doc.uploadedBy,
  uploadedByName: doc.uploadedByName,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt
});

const recordBookingTimeline = async ({ bookingId, tenantId, eventType, title, description, performedBy = null, performedByName = null, metadata = {} }) => {
  try {
    await BookingTimelineModel.create({
      bookingId,
      tenantId,
      eventType,
      title: title || eventType,
      description: description || title || eventType,
      performedBy,
      performedByName: performedByName || "Staff",
      metadata
    });
  } catch (err) {
    console.error("recordBookingTimeline error:", err);
  }
};

// Rule 4 ("Search supports... Passport Number, Phone") — passport/phone
// live on BookingTravelerModel (top-level passportNumber, or the
// customerSnapshot taken at traveler-add time), not on BookingHeaderModel,
// so matching bookings are resolved via a real traveler lookup rather than
// querying non-existent fields on the header.
const findBookingIdsMatchingTravelerQuery = async (tenantId, query) => {
  const regex = new RegExp(query, "i");
  const travelers = await BookingTravelerModel.find({
    tenantId,
    $or: [
      { passportNumber: regex },
      { "customerSnapshot.snapshotPassportNumber": regex },
      { "customerSnapshot.snapshotPhone": regex }
    ]
  }).select("bookingId").limit(50).lean();
  return [...new Set(travelers.map((t) => t.bookingId.toString()))];
};

// Search Field "Email" — not a field on BookingHeaderModel itself, but real
// and resolvable via the customer the booking belongs to (CustomerModel.email
// is a required, indexed field), the same join pattern used above for
// passport/phone.
const findBookingIdsMatchingCustomerEmail = async (tenantId, query) => {
  const regex = new RegExp(query, "i");
  const customers = await CustomerModel.find({ tenantId, email: regex }).select("_id").limit(50).lean();
  if (customers.length === 0) return [];
  const customerIds = customers.map((c) => c._id);
  const bookings = await BookingHeaderModel.find({ tenantId, customerId: { $in: customerIds } }).select("_id").limit(50).lean();
  return bookings.map((b) => b._id.toString());
};

// Search Field "Supplier" — BookingServiceModel.supplierId/supplierName are
// real free-text fields (no Supplier catalog model exists to validate
// against, per the Part 4 audit, but the fields themselves are genuine and
// queryable).
const findBookingIdsMatchingSupplierQuery = async (tenantId, query) => {
  const regex = new RegExp(query, "i");
  const services = await BookingServiceModel.find({
    tenantId,
    status: { $ne: "cancelled" },
    $or: [{ supplierId: regex }, { supplierName: regex }]
  }).select("bookingId").limit(50).lean();
  return [...new Set(services.map((s) => s.bookingId.toString()))];
};

export const ListBookings = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) {
      return sendError(res, 403, "Tenant context is required.", requestId);
    }

    if (!permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || "20", 10), 1), 100);

    const search = req.query.search?.trim() || req.query.q?.trim() || null;
    const customerId = req.query.customerId || null;
    const bookingType = req.query.bookingType || req.query.type || null;
    const bookingStatus = req.query.bookingStatus || req.query.status || null;
    const paymentStatus = req.query.paymentStatus || null;
    const visaStatus = req.query.visaStatus || null;
    const branchId = req.query.branchId || null;
    const consultantId = req.query.consultantId || req.query.assignedTo || null;
    
    const travelDateFrom = req.query.travelDateFrom ? new Date(req.query.travelDateFrom) : null;
    const travelDateTo = req.query.travelDateTo ? new Date(req.query.travelDateTo) : null;
    const createdAfter = req.query.createdAfter ? new Date(req.query.createdAfter) : null;
    const createdBefore = req.query.createdBefore ? new Date(req.query.createdBefore) : null;

    const sortField = req.query.sort || "createdAt";
    const order = req.query.order === "asc" ? 1 : -1;

    const filter = { tenantId, status: { $ne: "archived" } };

    if (branchId) filter.branchId = branchId;
    if (customerId) filter.customerId = customerId;
    if (bookingType) filter.bookingType = bookingType.toLowerCase();
    if (bookingStatus) filter.status = bookingStatus.toLowerCase();
    if (paymentStatus) filter.paymentStatus = paymentStatus.toLowerCase();
    if (visaStatus) filter.visaStatus = visaStatus.toLowerCase();
    if (consultantId) filter.assignedConsultant = consultantId;

    if (travelDateFrom || travelDateTo) {
      filter.travelDate = {};
      if (travelDateFrom) filter.travelDate.$gte = travelDateFrom;
      if (travelDateTo) filter.travelDate.$lte = travelDateTo;
    }

    if (createdAfter || createdBefore) {
      filter.createdAt = {};
      if (createdAfter) filter.createdAt.$gte = createdAfter;
      if (createdBefore) filter.createdAt.$lte = createdBefore;
    }

    if (search) {
      // Invoice Number / Reference Number are not searchable: no Invoice or
      // Payment model exists anywhere in this codebase yet (Finance module
      // not built), so there is nothing real to query.
      const matchedBookingIds = await findBookingIdsMatchingTravelerQuery(tenantId, search);
      filter.$or = [
        { bookingReference: new RegExp(search, "i") },
        { bookingNumber: new RegExp(search, "i") },
        { customerName: new RegExp(search, "i") },
        { customerCode: new RegExp(search, "i") },
        ...(matchedBookingIds.length > 0 ? [{ _id: { $in: matchedBookingIds } }] : [])
      ];
    }

    const sortOption = { [sortField]: order };
    const totalItems = await BookingHeaderModel.countDocuments(filter);
    const bookings = await BookingHeaderModel.find(filter)
      .sort(sortOption)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    const formattedBookings = await Promise.all(bookings.map(async (b) => {
      const travelerCount = await BookingTravelerModel.countDocuments({ bookingId: b._id, status: "active" });
      return {
        bookingId: b._id,
        bookingNumber: b.bookingNumber || b.bookingReference,
        customerName: b.customerName || "N/A",
        bookingType: b.bookingType ? (b.bookingType.charAt(0).toUpperCase() + b.bookingType.slice(1)) : "Umrah",
        status: b.status ? (b.status.charAt(0).toUpperCase() + b.status.slice(1)) : "Draft",
        travelDate: b.travelDate ? b.travelDate.toISOString().split("T")[0] : null,
        travelerCount,
        totalAmount: b.financialSnapshot?.totalAmount || b.totalAmount || 0,
        paidAmount: b.financialSnapshot?.paidAmount || b.paidAmount || 0,
        paymentStatus: b.paymentStatus ? (b.paymentStatus.charAt(0).toUpperCase() + b.paymentStatus.slice(1)) : "Unpaid",
        assignedConsultant: b.assignedConsultant || b.assignedTo || "Unassigned"
      };
    }));

    return sendSuccess(res, 200, "Bookings loaded.", {
      data: formattedBookings,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      }
    }, requestId);
  } catch (error) {
    console.error("ListBookings error:", error);
    return sendError(res, 500, "Unable to load bookings.", requestId);
  }
};

export const SearchBookings = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const query = req.query.q?.trim() || req.query.query?.trim() || req.query.search?.trim() || "";
    if (query && query.length < 2) {
      return sendSuccess(res, 200, "Query too short.", [], requestId);
    }

    // Search Filters (Part 7) — same filter set ListBookings already
    // supports, applied here too so a search can be narrowed by them
    // (independently of, or combined with, the free-text query below).
    const bookingStatus = req.query.bookingStatus || req.query.status || req.query.workflowState || null;
    const paymentStatus = req.query.paymentStatus || null;
    const visaStatus = req.query.visaStatus || null;
    const branchId = req.query.branchId || null;
    const consultantId = req.query.consultantId || req.query.assignedTo || null;
    const bookingType = req.query.bookingType || req.query.type || null;
    const packageId = req.query.packageId || null;
    const travelDateFrom = req.query.travelDateFrom ? new Date(req.query.travelDateFrom) : null;
    const travelDateTo = req.query.travelDateTo ? new Date(req.query.travelDateTo) : null;
    const bookingDateFrom = req.query.bookingDateFrom ? new Date(req.query.bookingDateFrom) : null;
    const bookingDateTo = req.query.bookingDateTo ? new Date(req.query.bookingDateTo) : null;
    const travelerCountMin = req.query.travelerCountMin ? parseInt(req.query.travelerCountMin, 10) : null;
    const travelerCountMax = req.query.travelerCountMax ? parseInt(req.query.travelerCountMax, 10) : null;

    const filter = { tenantId, status: { $ne: "archived" } };
    if (bookingStatus) filter.status = bookingStatus.toLowerCase();
    if (paymentStatus) filter.paymentStatus = paymentStatus.toLowerCase();
    if (visaStatus) filter.visaStatus = visaStatus.toLowerCase();
    if (branchId) filter.branchId = branchId;
    if (consultantId) filter.assignedConsultant = consultantId;
    if (bookingType) filter.bookingType = bookingType.toLowerCase();
    if (packageId) filter.packageId = packageId;
    if (travelDateFrom || travelDateTo) {
      filter.travelDate = {};
      if (travelDateFrom) filter.travelDate.$gte = travelDateFrom;
      if (travelDateTo) filter.travelDate.$lte = travelDateTo;
    }
    if (bookingDateFrom || bookingDateTo) {
      filter.createdAt = {};
      if (bookingDateFrom) filter.createdAt.$gte = bookingDateFrom;
      if (bookingDateTo) filter.createdAt.$lte = bookingDateTo;
    }

    // Search Field "Supplier" narrows by bookingId set (no direct field on
    // BookingHeaderModel), same join pattern as passport/phone/email below.
    const supplierQuery = req.query.supplier || req.query.supplierId || null;
    if (supplierQuery) {
      const supplierBookingIds = await findBookingIdsMatchingSupplierQuery(tenantId, supplierQuery);
      filter._id = { $in: supplierBookingIds };
    }

    // Search Fields: Booking Number, Customer Name, Passport Number, Phone
    // Number, Email, Assigned Consultant, Branch, Reference Number, Remarks.
    // Not implemented — no backing model/field exists anywhere in this
    // codebase (Finance/Package/Ticketing/Supplier-catalog modules aren't
    // built), flagged rather than faked: Invoice Number, Visa Number,
    // Ticket Number, Hotel Voucher, Package Name, Tags.
    if (query) {
      const regex = new RegExp(query, "i");
      const [travelerBookingIds, emailBookingIds] = await Promise.all([
        findBookingIdsMatchingTravelerQuery(tenantId, query),
        findBookingIdsMatchingCustomerEmail(tenantId, query)
      ]);
      const matchedBookingIds = [...new Set([...travelerBookingIds, ...emailBookingIds])];
      filter.$or = [
        { bookingReference: regex },
        { bookingNumber: regex },
        { customerName: regex },
        { customerCode: regex },
        { assignedConsultant: regex },
        { branchId: regex },
        { remarks: regex },
        ...(matchedBookingIds.length > 0 ? [{ _id: { $in: matchedBookingIds } }] : [])
      ];
    }

    const maxResults = Math.min(parseInt(req.query.limit || "10", 10), parseInt(process.env.ENTERPRISE_SEARCH_MAX_PAGE_SIZE || "100", 10));
    let results = await BookingHeaderModel.find(filter).limit(Math.max(maxResults * 3, maxResults)).lean();

    // Search Filter "Traveler Count" — no indexed field to filter on
    // directly (traveler count is derived from the child BookingTravelerModel
    // collection), so it's applied as a bounded post-filter over the
    // already-matched candidate set rather than a separate heavy aggregation
    // on every search request.
    if (travelerCountMin !== null || travelerCountMax !== null) {
      const counted = await Promise.all(results.map(async (b) => ({
        booking: b,
        travelerCount: await BookingTravelerModel.countDocuments({ bookingId: b._id, status: "active" })
      })));
      results = counted
        .filter(({ travelerCount }) =>
          (travelerCountMin === null || travelerCount >= travelerCountMin) &&
          (travelerCountMax === null || travelerCount <= travelerCountMax))
        .map(({ booking }) => booking);
    }

    // Business Rule "Supports ranking" — a lightweight relevance sort
    // without a search engine: exact/prefix matches on the primary
    // identifiers outrank matches found only via a joined field.
    if (query) {
      const lowerQuery = query.toLowerCase();
      const rank = (b) => {
        if (`${b.bookingNumber || ""}`.toLowerCase().startsWith(lowerQuery)) return 0;
        if (`${b.bookingReference || ""}`.toLowerCase().startsWith(lowerQuery)) return 1;
        if (`${b.customerName || ""}`.toLowerCase().includes(lowerQuery)) return 2;
        return 3;
      };
      results = results.sort((a, b) => rank(a) - rank(b));
    }

    results = results.slice(0, maxResults);

    return sendSuccess(res, 200, "Booking search results.", results, requestId);
  } catch (error) {
    console.error("SearchBookings error:", error);
    return sendError(res, 500, "Unable to search bookings.", requestId);
  }
};

export const CreateBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);

    if (!permissions.includes("bookings.create") && !permissions.includes("booking.create")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const {
      customerId,
      bookingType = bookingConfig.defaultBookingType,
      packageId = null,
      branchId = req.auth?.branchId || bookingConfig.defaultBranchId,
      travelDate,
      returnDate,
      assignedConsultant = req.auth?.id || null,
      currencyId = bookingConfig.defaultCurrency,
      remarks = null,
      totalAmount = 0,
      priority = bookingConfig.defaultPriority,
      paymentStatus = bookingConfig.defaultPaymentStatus,
      visaStatus = bookingConfig.defaultVisaStatus
    } = req.body;

    if (!customerId) return sendError(res, 422, "customerId is required.", requestId);

    // Validation Rule: "Customer Exists"
    const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
    if (!customer) return sendError(res, 404, "Customer not found.", requestId);

    // Validation Rule: "Branch Exists" — same branchKey/tenantKey lookup
    // pattern already used by Customer/User Management.
    const branch = await BranchModel.findOne({ branchKey: branchId, tenantKey: tenantId, status: "active" });
    if (!branch) return sendError(res, 422, `Branch "${branchId}" does not exist or is inactive.`, requestId);

    // Validation Rule: "Currency Exists" — validated dynamically against the
    // config-driven supported currency list (utils/bookingConfig.js), not a
    // hardcoded list duplicated here.
    if (!bookingConfig.supportedCurrencies.includes(currencyId.toLowerCase())) {
      return sendError(res, 422, `Currency "${currencyId}" is not supported. Allowed: ${bookingConfig.supportedCurrencies.join(", ")}.`, requestId);
    }

    // Validation Rule: "Travel Date Valid"
    let parsedTravelDate = null;
    if (travelDate !== undefined && travelDate !== null) {
      parsedTravelDate = new Date(travelDate);
      if (Number.isNaN(parsedTravelDate.getTime())) {
        return sendError(res, 422, `Invalid travelDate "${travelDate}".`, requestId);
      }
    }
    let parsedReturnDate = null;
    if (returnDate !== undefined && returnDate !== null) {
      parsedReturnDate = new Date(returnDate);
      if (Number.isNaN(parsedReturnDate.getTime())) {
        return sendError(res, 422, `Invalid returnDate "${returnDate}".`, requestId);
      }
      if (parsedTravelDate && parsedReturnDate < parsedTravelDate) {
        return sendError(res, 422, "returnDate cannot be before travelDate.", requestId);
      }
    }

    // Validation Rule: "Consultant Exists" — only checked when an explicit
    // consultant is provided; the default (the creating user's own ID) is
    // trivially valid since it came off the verified access token.
    if (req.body.assignedConsultant) {
      if (!mongoose.Types.ObjectId.isValid(assignedConsultant)) {
        return sendError(res, 422, `Consultant "${assignedConsultant}" does not exist.`, requestId);
      }
      const consultant = await EmployeeProfileModel.findOne({
        tenantId, status: { $ne: "archived" },
        $or: [{ _id: assignedConsultant }, { identityId: assignedConsultant }]
      });
      if (!consultant) return sendError(res, 422, `Consultant "${assignedConsultant}" does not exist.`, requestId);
    }

    // Validation Rule: "Package Exists" — flagged, not enforced: no package
    // catalog model exists anywhere in this codebase yet (packages are
    // currently only represented as BookingServiceModel line items with
    // serviceType:"package", not a standalone catalog with its own IDs), so
    // there is nothing real to validate packageId against without fabricating
    // a catalog. Left as an unvalidated optional reference, same as before.

    const bookingNumber = `BK-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;

    const initialAmount = Number(totalAmount) || 0;

    const booking = await BookingHeaderModel.create({
      tenantId,
      branchId,
      bookingReference: bookingNumber,
      bookingNumber,
      customerId: customer._id,
      customerCode: customer.customerCode,
      customerName: `${customer.firstName} ${customer.lastName}`.trim(),
      packageId: packageId || null,
      bookingType: bookingType.toLowerCase(),
      status: bookingConfig.defaultBookingStatus,
      priority,
      paymentStatus,
      visaStatus,
      assignedTo: assignedConsultant,
      assignedConsultant: assignedConsultant,
      travelDate: parsedTravelDate,
      returnDate: parsedReturnDate,
      totalAmount: initialAmount,
      paidAmount: 0,
      currency: currencyId,
      remarks: remarks || null,
      financialSnapshot: {
        packagePrice: initialAmount,
        discounts: 0,
        taxes: 0,
        serviceCharges: 0,
        totalAmount: initialAmount,
        paidAmount: 0,
        outstandingBalance: initialAmount,
        refundAmount: 0,
        currency: currencyId,
        paymentStatus,
        lastCalculatedAt: new Date()
      }
    });

    await BookingWorkflowModel.create({
      bookingId: booking._id,
      tenantId,
      currentStep: "draft",
      history: [{
        step: "draft",
        changedBy: req.auth?.id || null,
        changedByName: req.auth?.username || "Staff",
        timestamp: new Date(),
        comments: "Booking created in Draft status"
      }]
    });

    await recordBookingTimeline({
      bookingId: booking._id,
      tenantId,
      eventType: "BookingCreated",
      title: "Booking Created",
      description: `Booking ${booking.bookingNumber} created for ${booking.customerName}`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff"
    });

    await AuditLogModel.create({
      action: "booking.create",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId,
      requestId,
      metadata: { bookingId: booking._id, bookingNumber: booking.bookingNumber }
    });

    publishEvent("BookingCreated", { bookingId: booking._id.toString(), tenantId, bookingNumber: booking.bookingNumber });
    publishEvent("WorkflowCreated", { bookingId: booking._id.toString(), tenantId, currentStep: "draft" });
    publishEvent("TimelineCreated", { bookingId: booking._id.toString(), tenantId });
    publishEvent("BookingAnalyticsUpdated", { bookingId: booking._id.toString(), tenantId });

    // Execute Booking Saga Process Manager asynchronously
    handleBookingCreatedSaga({ booking, tenantId, requestId, authUser: req.auth }).catch((err) => console.error("Saga error:", err));

    return sendSuccess(res, 201, "Booking created successfully.", {
      bookingId: booking._id,
      bookingNumber: booking.bookingNumber,
      status: bookingConfig.defaultBookingStatus.charAt(0).toUpperCase() + bookingConfig.defaultBookingStatus.slice(1)
    }, requestId);
  } catch (error) {
    console.error("CreateBooking error:", error);
    return sendError(res, 500, "Unable to create booking.", requestId);
  }
};

export const GetBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);

    if (!permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();

    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    if (booking.status === "archived" && !permissions.includes("bookings.delete") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied to view archived booking.", requestId);
    }

    const [customer, travelers, services, workflow, notesCount, documentsCount, tasksCount, timelineSummary] = await Promise.all([
      CustomerModel.findOne({ _id: booking.customerId, tenantId }).lean(),
      BookingTravelerModel.find({ bookingId, tenantId, status: "active" }).lean(),
      BookingServiceModel.find({ bookingId, tenantId }).lean(),
      BookingWorkflowModel.findOne({ bookingId, tenantId }).lean(),
      BookingNoteModel.countDocuments({ bookingId, tenantId, status: "active" }),
      BookingDocumentModel.countDocuments({ bookingId, tenantId, status: { $ne: "archived" } }),
      BookingTaskModel.countDocuments({ bookingId, tenantId, status: "active" }),
      BookingTimelineModel.find({ bookingId, tenantId }).sort({ createdAt: -1 }).limit(10).lean()
    ]);

    return sendSuccess(res, 200, "Booking aggregate profile loaded.", {
      bookingHeader: {
        bookingId: booking._id,
        bookingNumber: booking.bookingNumber || booking.bookingReference,
        bookingType: booking.bookingType,
        status: booking.status,
        priority: booking.priority || "normal",
        paymentStatus: booking.paymentStatus || "unpaid",
        visaStatus: booking.visaStatus || "pending",
        travelDate: booking.travelDate,
        returnDate: booking.returnDate,
        assignedConsultant: booking.assignedConsultant || booking.assignedTo,
        remarks: booking.remarks,
        internalNotes: booking.internalNotes,
        preferredContactTime: booking.preferredContactTime,
        tenantId: booking.tenantId,
        branchId: booking.branchId,
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt
      },
      customerSummary: customer ? {
        customerId: customer._id,
        customerCode: customer.customerCode,
        fullName: `${customer.firstName} ${customer.lastName}`.trim(),
        email: customer.email,
        phone: customer.phone,
        category: customer.category
      } : null,
      travelerSummary: {
        travelerCount: travelers.length,
        travelers: travelers.map((t) => ({
          travelerId: t._id,
          fullName: `${t.firstName} ${t.lastName}`.trim(),
          travelerType: t.travelerType,
          isPrimary: t.isPrimary,
          passportNumber: t.passportNumber
        }))
      },
      bookedServices: services.map((s) => ({
        serviceId: s._id,
        serviceType: s.serviceType,
        serviceName: s.serviceName,
        sellingPrice: s.sellingPrice,
        status: s.status
      })),
      financialSummary: booking.financialSnapshot || {
        totalAmount: booking.totalAmount || 0,
        paidAmount: booking.paidAmount || 0,
        outstandingBalance: (booking.totalAmount || 0) - (booking.paidAmount || 0),
        currency: booking.currency || "USD",
        paymentStatus: booking.paymentStatus || "unpaid"
      },
      currentWorkflow: workflow ? {
        currentStep: workflow.currentStep,
        lastChangedAt: workflow.updatedAt,
        history: workflow.history || []
      } : null,
      timelineSummary: timelineSummary.map((t) => ({
        eventId: t._id,
        eventType: t.eventType,
        title: t.title,
        description: t.description,
        performedByName: t.performedByName || "Staff",
        timestamp: t.createdAt
      })),
      counts: {
        notesCount,
        documentsCount,
        tasksCount
      }
    }, requestId);
  } catch (error) {
    console.error("GetBooking error:", error);
    return sendError(res, 500, "Unable to load booking profile.", requestId);
  }
};

export const UpdateBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);

    if (!permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId, status: { $ne: "archived" } });

    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    // Business Rule: "Only Draft and Reserved bookings are freely editable.
    // Confirmed bookings require approval for critical changes." — schedule/
    // ownership fields are "critical"; remarks/notes/contact-time/priority
    // are not and stay freely editable at any status. No dedicated approval
    // endpoint exists for field-level edits (unlike workflow transitions),
    // so this is enforced as an elevated-permission gate, matching the same
    // convention already used for archived-record access.
    const criticalFields = ["travelDate", "returnDate", "branchId", "assignedConsultant", "assignedTo"];
    const freelyEditableStatuses = ["draft", "reserved"];
    const touchesCriticalField = criticalFields.some((key) => req.body[key] !== undefined);
    if (touchesCriticalField && !freelyEditableStatuses.includes(booking.status)) {
      if (!permissions.includes("bookings.delete") && !permissions.includes("admin")) {
        return sendError(res, 403, `Elevated permission required to change schedule/ownership fields on a "${booking.status}" booking.`, requestId);
      }
    }

    // Editable-field validation — same rules as POST /bookings, since these
    // are equally real field changes.
    if (req.body.branchId !== undefined) {
      const branch = await BranchModel.findOne({ branchKey: req.body.branchId, tenantKey: tenantId, status: "active" });
      if (!branch) return sendError(res, 422, `Branch "${req.body.branchId}" does not exist or is inactive.`, requestId);
    }
    if (req.body.assignedConsultant !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(req.body.assignedConsultant)) {
        return sendError(res, 422, `Consultant "${req.body.assignedConsultant}" does not exist.`, requestId);
      }
      const consultant = await EmployeeProfileModel.findOne({
        tenantId, status: { $ne: "archived" },
        $or: [{ _id: req.body.assignedConsultant }, { identityId: req.body.assignedConsultant }]
      });
      if (!consultant) return sendError(res, 422, `Consultant "${req.body.assignedConsultant}" does not exist.`, requestId);
    }
    if (req.body.travelDate !== undefined && req.body.travelDate !== null && Number.isNaN(new Date(req.body.travelDate).getTime())) {
      return sendError(res, 422, `Invalid travelDate "${req.body.travelDate}".`, requestId);
    }
    if (req.body.returnDate !== undefined && req.body.returnDate !== null && Number.isNaN(new Date(req.body.returnDate).getTime())) {
      return sendError(res, 422, `Invalid returnDate "${req.body.returnDate}".`, requestId);
    }

    const oldTravelDate = booking.travelDate ? booking.travelDate.toISOString() : null;
    const oldPriority = booking.priority;

    // totalAmount is intentionally NOT editable here (Section 31's "Editable
    // Fields" list doesn't include it) — per the Financial Snapshot
    // architecture, totals are derived from real BookingServiceModel line
    // items via recalculateBookingFinancials, never set by hand through a
    // generic PATCH.
    const allowedFields = ["travelDate", "returnDate", "assignedConsultant", "assignedTo", "remarks", "priority", "internalNotes", "preferredContactTime", "branchId"];

    allowedFields.forEach((key) => {
      if (req.body[key] !== undefined) {
        if (key === "travelDate" || key === "returnDate") {
          booking[key] = req.body[key] ? new Date(req.body[key]) : null;
        } else {
          booking[key] = req.body[key];
        }
      }
    });

    if (req.body.assignedConsultant) booking.assignedTo = req.body.assignedConsultant;

    await booking.save();

    await recordBookingTimeline({
      bookingId: booking._id,
      tenantId,
      eventType: "BookingUpdated",
      title: "Booking Updated",
      description: `Updated booking information`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff"
    });

    const newTravelDate = booking.travelDate ? booking.travelDate.toISOString() : null;
    if (oldTravelDate !== newTravelDate) {
      publishEvent("BookingRescheduled", { bookingId: booking._id.toString(), tenantId, newTravelDate });
    }

    if (oldPriority !== booking.priority) {
      publishEvent("BookingPriorityChanged", { bookingId: booking._id.toString(), tenantId, newPriority: booking.priority });
    }

    await AuditLogModel.create({
      action: "booking.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: booking.branchId,
      requestId,
      metadata: { bookingId: booking._id }
    });

    publishEvent("BookingUpdated", { bookingId: booking._id.toString(), tenantId });

    return sendSuccess(res, 200, "Booking updated successfully.", { bookingId: booking._id, bookingNumber: booking.bookingNumber }, requestId);
  } catch (error) {
    console.error("UpdateBooking error:", error);
    return sendError(res, 500, "Unable to update booking.", requestId);
  }
};

export const ArchiveBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);

    if (!permissions.includes("bookings.delete") && !permissions.includes("booking.delete")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId, status: { $ne: "archived" } });

    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    booking.status = "archived";
    await booking.save();

    await recordBookingTimeline({
      bookingId: booking._id,
      tenantId,
      eventType: "BookingArchived",
      title: "Booking Archived",
      description: "Booking profile archived",
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff"
    });

    await AuditLogModel.create({
      action: "booking.archive",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: booking.branchId,
      requestId,
      metadata: { bookingId: booking._id }
    });

    publishEvent("BookingArchived", { bookingId: booking._id.toString(), tenantId });

    return sendSuccess(res, 200, "Booking archived.", null, requestId);
  } catch (error) {
    console.error("ArchiveBooking error:", error);
    return sendError(res, 500, "Unable to archive booking.", requestId);
  }
};

export const ConfirmBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId, status: { $ne: "archived" } });

    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    booking.status = "confirmed";
    await booking.save();

    let workflow = await BookingWorkflowModel.findOne({ bookingId: booking._id, tenantId });
    if (workflow) {
      workflow.currentStep = "confirmed";
      workflow.history.push({
        step: "confirmed",
        changedBy: req.auth?.id || null,
        changedByName: req.auth?.username || "Staff",
        timestamp: new Date(),
        comments: req.body.reason || "Booking confirmed"
      });
      await workflow.save();
    }

    await recordBookingTimeline({
      bookingId: booking._id,
      tenantId,
      eventType: "BookingConfirmed",
      title: "Booking Confirmed",
      description: `Booking ${booking.bookingNumber || booking.bookingReference} confirmed`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff"
    });

    await AuditLogModel.create({
      action: "booking.confirm",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: booking.branchId,
      requestId,
      metadata: { bookingId: booking._id }
    });

    publishEvent("BookingConfirmed", { bookingId: booking._id.toString(), tenantId });

    return sendSuccess(res, 200, "Booking confirmed.", booking, requestId);
  } catch (error) {
    console.error("ConfirmBooking error:", error);
    return sendError(res, 500, "Unable to confirm booking.", requestId);
  }
};

export const CancelBooking = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const { reason, category = "Customer Request", remarks = null } = req.body;

    if (!reason || !reason.trim()) {
      return sendError(res, 422, "Cancellation reason is mandatory.", requestId);
    }

    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId, status: { $ne: "archived" } });
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);
    if (booking.status === "cancelled") {
      return sendError(res, 422, "Booking is already cancelled.", requestId);
    }

    const cancelComments = `[${category}] ${reason.trim()}${remarks ? ` - ${remarks}` : ""}`;

    // Validation Rules: "Cancellation allowed by workflow" / "Required
    // approval completed" — previously this endpoint flipped booking.status
    // directly, bypassing transition-validity checks, approval gating, AND
    // leaving the generic WorkflowInstanceModel (used by GET/PATCH
    // /workflow) completely out of sync with the header/legacy workflow
    // record. Routed through the same engine PATCH /workflow uses instead.
    const transitionResult = await executeWorkflowTransition({
      tenantId,
      entityType: "Booking",
      entityId: booking._id,
      action: "Cancel Booking",
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff",
      userRoles: req.auth?.roles || (req.auth?.role ? [req.auth.role] : []),
      comments: cancelComments
    });

    if (transitionResult.requiresApproval) {
      return sendSuccess(res, 202, transitionResult.message, {
        currentState: transitionResult.currentState,
        requiresApproval: true,
        approvalRole: transitionResult.approvalRole
      }, requestId);
    }

    booking.status = transitionResult.currentState;
    await booking.save();

    await BookingServiceModel.updateMany(
      { bookingId: booking._id, tenantId, status: { $ne: "cancelled" } },
      { status: "cancelled", workflowStatus: "cancelled" }
    );

    let workflow = await BookingWorkflowModel.findOne({ bookingId: booking._id, tenantId });
    if (workflow) {
      workflow.currentStep = "cancelled";
      workflow.history.push({
        step: "cancelled",
        changedBy: req.auth?.id || null,
        changedByName: req.auth?.username || "Staff",
        timestamp: new Date(),
        comments: cancelComments
      });
      await workflow.save();
    }

    await recordBookingTimeline({
      bookingId: booking._id,
      tenantId,
      eventType: "BookingCancelled",
      title: "Booking Cancelled",
      description: `Booking cancelled: ${reason.trim()} (${category})`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff",
      metadata: { reason, category, remarks }
    });

    await AuditLogModel.create({
      action: "booking.cancel",
      outcome: "success",
      reason: reason.trim(),
      userId: req.auth?.id || null,
      tenantId,
      branchId: booking.branchId,
      requestId,
      metadata: { bookingId: booking._id, category }
    });

    publishEvent("BookingCancelled", { bookingId: booking._id.toString(), tenantId, reason: reason.trim(), category });

    // Business Workflow: "Generate Refund Request (if applicable)" — only
    // when something was actually paid; nothing to refund otherwise.
    const paidAmount = booking.financialSnapshot?.paidAmount || booking.paidAmount || 0;
    if (paidAmount > 0) {
      publishEvent("RefundRequested", { bookingId: booking._id.toString(), tenantId, paidAmount });
    }

    publishEvent("SupplierNotificationRequested", { bookingId: booking._id.toString(), tenantId, action: "release_resources" });
    publishEvent("NotificationRequested", { bookingId: booking._id.toString(), tenantId, event: "BookingCancelled" });

    return sendSuccess(res, 200, "Booking cancelled successfully.", { bookingId: booking._id, status: "Cancelled" }, requestId);
  } catch (error) {
    console.error("CancelBooking error:", error);
    return sendError(res, 400, error.message || "Unable to cancel booking.", requestId);
  }
};

// ==========================================
// Part 3 — Booking Travelers APIs
// ==========================================

export const ListBookingTravelers = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || bookingConfig.defaultPageSize, 10), 1), bookingConfig.maxPageSize);

    // "Supports sorting" — whitelisted to genuinely present/indexable fields.
    const SORT_FIELD_MAP = {
      name: "firstName",
      firstname: "firstName",
      lastname: "lastName",
      travelertype: "travelerType",
      travelerstatus: "travelerStatus",
      visastatus: "visaStatus",
      createdat: "createdAt"
    };
    const order = req.query.order === "desc" ? -1 : 1;
    const requestedSort = (req.query.sort || "").toLowerCase();
    const sortOption = requestedSort && SORT_FIELD_MAP[requestedSort]
      ? { isPrimary: -1, [SORT_FIELD_MAP[requestedSort]]: order }
      : { isPrimary: -1, createdAt: 1 };

    const filter = { bookingId, tenantId, status: { $ne: "archived" } };

    const totalItems = await BookingTravelerModel.countDocuments(filter);
    const travelers = await BookingTravelerModel.find(filter)
      .sort(sortOption)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    const formattedTravelers = travelers.map((t) => ({
      travelerId: t._id,
      bookingId: t.bookingId,
      customerId: t.customerId,
      isPrimary: t.isPrimary || t.isPrimaryTraveler || false,
      isPrimaryTraveler: t.isPrimary || t.isPrimaryTraveler || false,
      travelerType: t.travelerType || "adult",
      travelerStatus: t.travelerStatus || "registered",
      fullName: t.customerSnapshot?.snapshotName || `${t.firstName} ${t.lastName}`.trim(),
      passportNumber: t.customerSnapshot?.snapshotPassportNumber || t.passportNumber || null,
      passportExpiry: t.customerSnapshot?.snapshotPassportExpiry || t.passportExpiry || null,
      nationality: t.customerSnapshot?.snapshotNationality || t.nationality || null,
      gender: t.customerSnapshot?.snapshotGender || t.gender || null,
      dateOfBirth: t.customerSnapshot?.snapshotDateOfBirth || t.dateOfBirth || null,
      visaStatus: t.visaStatus || "pending",
      mealPreference: t.mealPreference || null,
      wheelchairRequired: t.wheelchairRequired || false,
      specialAssistance: t.specialAssistance || null,
      emergencyContact: t.emergencyContact || null,
      roomPreference: t.roomPreference || null,
      seatPreference: t.seatPreference || null,
      roomAssignment: t.roomAssignment || null,
      seatAssignment: t.seatAssignment || null,
      customerSnapshot: t.customerSnapshot || null
    }));

    return sendSuccess(res, 200, "Booking travelers loaded.", {
      data: formattedTravelers,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      }
    }, requestId);
  } catch (error) {
    console.error("ListBookingTravelers error:", error);
    return sendError(res, 500, "Unable to load booking travelers.", requestId);
  }
};

export const AddBookingTravelers = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.create") && !permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId, status: { $ne: "archived" } });

    if (!booking) return sendError(res, 404, "Booking not found.", requestId);
    if (booking.status === "completed" || booking.status === "cancelled") {
      return sendError(res, 422, "Cannot add travelers to completed or cancelled bookings.", requestId);
    }

    let travelerInputs = [];
    if (Array.isArray(req.body.travelers)) {
      travelerInputs = req.body.travelers;
    } else if (req.body.customerId) {
      travelerInputs = [req.body];
    }

    if (travelerInputs.length === 0) {
      return sendError(res, 422, "At least one traveler (customerId) is required.", requestId);
    }

    const existingTravelersCount = await BookingTravelerModel.countDocuments({ bookingId: booking._id, tenantId, status: { $ne: "cancelled" } });
    let existingPrimary = await BookingTravelerModel.findOne({ bookingId: booking._id, tenantId, isPrimary: true, status: { $ne: "cancelled" } });

    // Validation Rule: "Maximum Travelers (Package Rules)" — no package
    // catalog exists yet to derive a per-package limit from, so this is a
    // configurable tenant-wide safety cap (MAX_TRAVELERS_PER_BOOKING) instead.
    if (existingTravelersCount + travelerInputs.length > bookingConfig.maxTravelersPerBooking) {
      return sendError(res, 422, `This booking cannot exceed ${bookingConfig.maxTravelersPerBooking} travelers.`, requestId);
    }

    const createdTravelers = [];

    for (const input of travelerInputs) {
      const {
        customerId,
        isPrimaryTraveler = false,
        isPrimary = false,
        travelerType = bookingConfig.defaultTravelerType,
        mealPreference = null,
        wheelchairRequired = false,
        specialAssistance = null,
        roomPreference = null,
        seatPreference = null,
        medicalNotes = null,
        baggageRequirement = null,
        priority = "normal"
      } = input;

      if (!customerId) continue;

      const customer = await CustomerModel.findOne({ _id: customerId, tenantId, status: { $ne: "archived" } });
      if (!customer) {
        return sendError(res, 404, `Customer ${customerId} not found.`, requestId);
      }

      const normalizedTravelerType = `${travelerType || bookingConfig.defaultTravelerType}`.trim().toLowerCase();
      const normalizedTravelerStatus = bookingConfig.defaultTravelerStatus;

      const duplicate = await BookingTravelerModel.findOne({
        bookingId: booking._id,
        tenantId,
        customerId: customer._id,
        status: { $ne: "cancelled" }
      });

      if (duplicate) {
        return sendError(res, 409, `Customer ${customer.firstName} ${customer.lastName} is already assigned to this booking.`, requestId);
      }

      const markPrimary = (isPrimaryTraveler || isPrimary) || (!existingPrimary && existingTravelersCount === 0 && createdTravelers.length === 0);

      if (markPrimary && existingPrimary) {
        existingPrimary.isPrimary = false;
        existingPrimary.isPrimaryTraveler = false;
        await existingPrimary.save();
        existingPrimary = null;
      }

      // customer.passportNumber/passportExpiry do not exist as flat fields —
      // passports live in customer.passports[] (a customer can have several,
      // e.g. renewals). Snapshot the one currently marked primary, falling
      // back to the most recently issued one if none is marked.
      const primaryPassport = (customer.passports || []).find((p) => p.isPrimary)
        || [...(customer.passports || [])].sort((a, b) => new Date(b.issueDate || 0) - new Date(a.issueDate || 0))[0]
        || null;

      const snapshotName = `${customer.firstName} ${customer.lastName}`.trim();
      // "Don't copy customer information into the traveler table. Instead
      // use a snapshot." — the snapshot below is the sole source of the
      // customer's PII at booking time; it is intentionally NOT duplicated
      // onto top-level traveler fields (only firstName/lastName are, since
      // those are required identity fields for direct display/queries and
      // carry none of the staleness risk the doc's passport-renewal example
      // is concerned with).
      const customerSnapshot = {
        snapshotName,
        snapshotPassportNumber: primaryPassport?.passportNumber || null,
        snapshotPassportExpiry: primaryPassport?.expiryDate || null,
        snapshotNationality: customer.nationality || null,
        snapshotDateOfBirth: customer.dateOfBirth || null,
        snapshotGender: customer.gender || null,
        snapshotEmail: customer.email || null,
        snapshotPhone: customer.phone || null,
        snapshotCreatedAt: new Date()
      };

      const newTraveler = await BookingTravelerModel.create({
        bookingId: booking._id,
        tenantId,
        customerId: customer._id,
        isPrimary: markPrimary,
        isPrimaryTraveler: markPrimary,
        travelerType: bookingConfig.travelerTypes.includes(normalizedTravelerType) ? normalizedTravelerType : bookingConfig.defaultTravelerType,
        travelerStatus: bookingConfig.travelerStatuses.includes(normalizedTravelerStatus) ? normalizedTravelerStatus : bookingConfig.defaultTravelerStatus,
        customerSnapshot,
        firstName: customer.firstName,
        lastName: customer.lastName,
        mealPreference,
        wheelchairRequired: Boolean(wheelchairRequired),
        specialAssistance,
        roomPreference,
        seatPreference,
        medicalNotes,
        baggageRequirement,
        priority,
        status: "active"
      });

      if (markPrimary) existingPrimary = newTraveler;
      createdTravelers.push(newTraveler);
    }

    await recordBookingTimeline({
      bookingId: booking._id,
      tenantId,
      eventType: "TravelerAdded",
      title: "Travelers Added",
      description: `Added ${createdTravelers.length} traveler(s) to booking`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff"
    });

    await AuditLogModel.create({
      action: "booking.traveler.add",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: booking.branchId,
      requestId,
      metadata: { bookingId: booking._id, addedCount: createdTravelers.length }
    });

    publishEvent("TravelerAdded", { bookingId: booking._id.toString(), tenantId, count: createdTravelers.length });
    publishEvent("BookingUpdated", { bookingId: booking._id.toString(), tenantId });
    publishEvent("TravelerWorkflowInitialized", { bookingId: booking._id.toString(), tenantId });

    return sendSuccess(res, 201, "Travelers added successfully.", {
      added: createdTravelers.length,
      travelers: createdTravelers.map((t) => ({
        travelerId: t._id,
        fullName: t.customerSnapshot?.snapshotName || `${t.firstName} ${t.lastName}`.trim(),
        isPrimary: t.isPrimary
      }))
    }, requestId);
  } catch (error) {
    console.error("AddBookingTravelers error:", error);
    return sendError(res, 500, "Unable to add travelers.", requestId);
  }
};

export const UpdateBookingTraveler = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId, travelerId } = req.params;
    const traveler = await BookingTravelerModel.findOne({ _id: travelerId, bookingId, tenantId, status: { $ne: "cancelled" } });

    if (!traveler) return sendError(res, 404, "Traveler not found.", requestId);

    // Section "Editable Fields" for this endpoint — exactly these 9.
    // roomAssignment/seatAssignment (operational assignments, not
    // preferences), visaStatus, travelerStatus, and travelerType each have
    // their own real lifecycle (Traveler Status diagram; travelerType
    // "affects pricing and operational workflows") and are deliberately
    // excluded here, matching the same discipline already applied to
    // Booking's own PATCH endpoint (status changes go through a dedicated
    // transition path, not a generic field PATCH).
    const allowedFields = [
      "mealPreference", "wheelchairRequired", "specialAssistance",
      "emergencyContact", "roomPreference", "seatPreference",
      "medicalNotes", "baggageRequirement", "priority"
    ];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        traveler[field] = req.body[field];
      }
    });

    if (req.body.isPrimary !== undefined || req.body.isPrimaryTraveler !== undefined) {
      const makePrimary = Boolean(req.body.isPrimary || req.body.isPrimaryTraveler);
      if (makePrimary && !traveler.isPrimary) {
        await BookingTravelerModel.updateMany(
          { bookingId, tenantId, _id: { $ne: traveler._id } },
          { isPrimary: false, isPrimaryTraveler: false }
        );
        traveler.isPrimary = true;
        traveler.isPrimaryTraveler = true;
      }
    }

    await traveler.save();

    await recordBookingTimeline({
      bookingId,
      tenantId,
      eventType: "TravelerUpdated",
      title: "Traveler Updated",
      description: `Updated preferences/status for ${traveler.customerSnapshot?.snapshotName || traveler.firstName}`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff"
    });

    await AuditLogModel.create({
      action: "booking.traveler.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { bookingId, travelerId }
    });

    publishEvent("TravelerUpdated", { bookingId, travelerId: traveler._id.toString(), tenantId });

    return sendSuccess(res, 200, "Traveler updated successfully.", traveler, requestId);
  } catch (error) {
    console.error("UpdateBookingTraveler error:", error);
    return sendError(res, 500, "Unable to update traveler.", requestId);
  }
};

export const RemoveBookingTraveler = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.update") && !permissions.includes("bookings.delete") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId, travelerId } = req.params;
    const traveler = await BookingTravelerModel.findOne({ _id: travelerId, bookingId, tenantId, status: { $ne: "cancelled" } });

    if (!traveler) return sendError(res, 404, "Traveler not found.", requestId);

    if (traveler.isPrimary || traveler.isPrimaryTraveler) {
      const activeOthers = await BookingTravelerModel.countDocuments({
        bookingId,
        tenantId,
        _id: { $ne: traveler._id },
        status: { $ne: "cancelled" }
      });

      if (activeOthers > 0) {
        return sendError(res, 422, "Primary Traveler cannot be removed until another primary traveler is designated.", requestId);
      }
    }

    traveler.status = "cancelled";
    traveler.travelerStatus = "cancelled";
    await traveler.save();

    await TravelerServiceAssignmentModel.updateMany(
      { bookingId, travelerId: traveler._id, tenantId },
      { status: "cancelled" }
    );

    // Business Rule: "Financial recalculation required."
    await recalculateBookingFinancials(bookingId, tenantId);

    await recordBookingTimeline({
      bookingId,
      tenantId,
      eventType: "TravelerRemoved",
      title: "Traveler Removed",
      description: `Removed traveler ${traveler.customerSnapshot?.snapshotName || traveler.firstName} from booking`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff"
    });

    await AuditLogModel.create({
      action: "booking.traveler.remove",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { bookingId, travelerId }
    });

    publishEvent("TravelerRemoved", { bookingId: bookingId.toString(), tenantId, travelerId: traveler._id.toString() });
    publishEvent("BookingRecalculated", { bookingId: bookingId.toString(), tenantId });

    return sendSuccess(res, 200, "Traveler removed from booking.", null, requestId);
  } catch (error) {
    console.error("RemoveBookingTraveler error:", error);
    return sendError(res, 500, "Unable to remove traveler.", requestId);
  }
};

// ==========================================
// Financial Recalculation Helper
// ==========================================

export const recalculateBookingFinancials = async (bookingId, tenantId) => {
  try {
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId });
    if (!booking) return;

    const activeServices = await BookingServiceModel.find({
      bookingId,
      tenantId,
      status: { $ne: "cancelled" }
    });

    const calculatedTotal = activeServices.reduce((sum, s) => {
      const lineTotal = s.totalPrice || ((s.sellingPrice || 0) * (s.quantity || 1));
      return sum + lineTotal;
    }, 0);

    booking.totalAmount = calculatedTotal;

    if (!booking.financialSnapshot) {
      booking.financialSnapshot = {
        packagePrice: calculatedTotal,
        discounts: 0,
        taxes: 0,
        serviceCharges: 0,
        totalAmount: calculatedTotal,
        paidAmount: 0,
        outstandingBalance: calculatedTotal,
        refundAmount: 0,
        currency: booking.currency || "USD",
        paymentStatus: "unpaid",
        lastCalculatedAt: new Date()
      };
    } else {
      booking.financialSnapshot.totalAmount = calculatedTotal;
      booking.financialSnapshot.outstandingBalance = calculatedTotal - (booking.financialSnapshot.paidAmount || 0);
      booking.financialSnapshot.lastCalculatedAt = new Date();
    }

    await booking.save();
    publishEvent("BookingFinancialUpdated", { bookingId: booking._id.toString(), tenantId, totalAmount: calculatedTotal });
  } catch (err) {
    console.error("recalculateBookingFinancials error:", err);
  }
};

// ==========================================
// Part 4 — Booking Services APIs
// ==========================================

export const ListBookingServices = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || bookingConfig.defaultPageSize, 10), 1), bookingConfig.maxPageSize);

    const serviceType = req.query.serviceType || req.query.type || null;
    const supplierId = req.query.supplierId || req.query.supplier || null;
    // "Status" (lifecycle: active/cancelled/archived) and "Workflow Status"
    // (fulfillment: created/reserved/.../completed) are two distinct fields
    // on BookingServiceModel — previously ?status= was silently filtering
    // workflowStatus instead, so ?status=active always returned zero rows
    // (workflowStatus has no "active" value in its enum).
    const status = req.query.status || null;
    const workflowStatus = req.query.workflowStatus || null;
    const travelDateFrom = req.query.travelDateFrom ? new Date(req.query.travelDateFrom) : null;
    const travelDateTo = req.query.travelDateTo ? new Date(req.query.travelDateTo) : null;

    // Business Rule: "Only active services returned by default."
    const filter = { bookingId, tenantId, status: status ? status.toLowerCase() : "active" };

    if (serviceType) filter.serviceType = serviceType.toLowerCase();
    if (supplierId) filter.supplierId = supplierId;
    if (workflowStatus) filter.workflowStatus = workflowStatus.toLowerCase();
    if (travelDateFrom || travelDateTo) {
      filter.startDate = {};
      if (travelDateFrom) filter.startDate.$gte = travelDateFrom;
      if (travelDateTo) filter.startDate.$lte = travelDateTo;
    }

    const totalItems = await BookingServiceModel.countDocuments(filter);
    const services = await BookingServiceModel.find(filter)
      .sort({ createdAt: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    const formattedServices = await Promise.all(services.map(async (s) => {
      const travelerAssignments = await TravelerServiceAssignmentModel.find({
        bookingId,
        serviceId: s._id,
        tenantId,
        status: "assigned"
      }).populate("travelerId", "customerSnapshot firstName lastName").lean();

      return {
        serviceId: s._id,
        bookingId: s.bookingId,
        serviceType: s.serviceType,
        serviceCategory: s.serviceCategory || "other",
        serviceName: s.serviceName,
        supplierId: s.supplierId || null,
        supplierName: s.supplierName || "N/A",
        costPrice: s.costPrice || 0,
        sellingPrice: s.sellingPrice || 0,
        quantity: s.quantity || 1,
        totalPrice: s.totalPrice || ((s.sellingPrice || 0) * (s.quantity || 1)),
        currencyId: s.currencyId || "USD",
        startDate: s.startDate || null,
        endDate: s.endDate || null,
        status: s.status,
        workflowStatus: s.workflowStatus || "created",
        remarks: s.remarks || null,
        assignedTravelers: travelerAssignments.map((ta) => ({
          assignmentId: ta._id,
          travelerId: ta.travelerId?._id || ta.travelerId,
          travelerName: ta.travelerId?.customerSnapshot?.snapshotName || `${ta.travelerId?.firstName || ""} ${ta.travelerId?.lastName || ""}`.trim(),
          assignmentDetails: ta.assignmentDetails || {}
        }))
      };
    }));

    return sendSuccess(res, 200, "Booking services loaded.", {
      data: formattedServices,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      }
    }, requestId);
  } catch (error) {
    console.error("ListBookingServices error:", error);
    return sendError(res, 500, "Unable to load booking services.", requestId);
  }
};

export const AddBookingServices = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.create") && !permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId, status: { $ne: "archived" } });

    if (!booking) return sendError(res, 404, "Booking not found.", requestId);
    if (booking.status === "completed" || booking.status === "cancelled") {
      return sendError(res, 422, "Cannot add services to completed or cancelled bookings.", requestId);
    }

    let serviceInputs = [];
    if (Array.isArray(req.body.services)) {
      serviceInputs = req.body.services;
    } else if (req.body.serviceType) {
      serviceInputs = [req.body];
    }

    if (serviceInputs.length === 0) {
      return sendError(res, 422, "At least one service (serviceType) is required.", requestId);
    }

    const createdServices = [];

    for (const input of serviceInputs) {
      const {
        serviceType,
        serviceId = null,
        serviceCategory = "other",
        serviceName,
        supplierId = null,
        supplierName = null,
        costPrice = 0,
        sellingPrice = 0,
        quantity = 1,
        currencyId = booking.currency || bookingConfig.defaultCurrency,
        startDate = null,
        endDate = null,
        remarks = null,
        internalNotes = null,
        priority = bookingConfig.defaultServicePriority,
        workflowStatus = bookingConfig.defaultServiceWorkflowStatus,
        status = bookingConfig.defaultServiceStatus,
        details = {},
        travelerIds = []
      } = input;

      if (!serviceType) continue;

      const normalizedServiceType = `${serviceType}`.trim().toLowerCase();
      const normalizedServiceCategory = `${serviceCategory || "other"}`.trim().toLowerCase();
      const normalizedWorkflowStatus = `${workflowStatus || bookingConfig.defaultServiceWorkflowStatus}`.trim().toLowerCase();
      const normalizedStatus = `${status || bookingConfig.defaultServiceStatus}`.trim().toLowerCase();
      const normalizedPriority = `${priority || bookingConfig.defaultServicePriority}`.trim().toLowerCase();
      const normalizedCurrencyId = `${currencyId || booking.currency || bookingConfig.defaultCurrency}`.trim().toLowerCase();

      if (!bookingConfig.serviceTypes.includes(normalizedServiceType)) {
        return sendError(res, 422, `Unsupported serviceType '${serviceType}'.`, requestId);
      }
      if (!bookingConfig.serviceCategories.includes(normalizedServiceCategory)) {
        return sendError(res, 422, `Unsupported serviceCategory '${serviceCategory}'.`, requestId);
      }
      if (!bookingConfig.serviceWorkflowStatuses.includes(normalizedWorkflowStatus)) {
        return sendError(res, 422, `Unsupported workflowStatus '${workflowStatus}'.`, requestId);
      }
      if (!bookingConfig.supportedCurrencies.includes(normalizedCurrencyId)) {
        return sendError(res, 422, `Unsupported currencyId '${currencyId}'.`, requestId);
      }

      // Validation Rules: "Service Exists" / "Service Active" — only
      // enforceable for the service types that actually have a real catalog
      // in this codebase (flight/hotel/room). The rest (visa, transport,
      // insurance, guide, meals, ziyarat, activity, addon, package, other)
      // have no catalog model at all, so they remain manually-entered ad-hoc
      // line items — there is nothing real to validate serviceId against.
      let resolvedServiceName = serviceName ? serviceName.trim() : null;
      let resolvedSupplierName = supplierName;
      let resolvedSupplierId = supplierId;

      if (serviceId && !mongoose.Types.ObjectId.isValid(serviceId) && ["flight", "hotel", "room"].includes(normalizedServiceType)) {
        return sendError(res, 422, `Invalid serviceId "${serviceId}".`, requestId);
      }

      if (serviceId && normalizedServiceType === "flight") {
        const flight = await FlightCatalogModel.findOne({ _id: serviceId, tenantId, isActive: true });
        if (!flight) return sendError(res, 422, `Flight "${serviceId}" does not exist or is inactive.`, requestId);
        resolvedServiceName = resolvedServiceName || `${flight.airlineName} ${flight.flightNumber} (${flight.originAirport.code} - ${flight.destinationAirport.code})`;
        resolvedSupplierName = resolvedSupplierName || flight.airlineName;
        resolvedSupplierId = resolvedSupplierId || flight.airlineCode;
      } else if (serviceId && normalizedServiceType === "hotel") {
        const hotel = await HotelCatalogModel.findOne({ _id: serviceId, tenantId, isActive: true });
        if (!hotel) return sendError(res, 422, `Hotel "${serviceId}" does not exist or is inactive.`, requestId);
        resolvedServiceName = resolvedServiceName || hotel.name;
        resolvedSupplierName = resolvedSupplierName || hotel.supplier;
      } else if (serviceId && normalizedServiceType === "room") {
        const room = await HotelRoomInventoryModel.findOne({ _id: serviceId, tenantId, status: "available" });
        if (!room) return sendError(res, 422, `Room "${serviceId}" does not exist or is not available.`, requestId);
        resolvedServiceName = resolvedServiceName || `Room ${room.roomNumber} (${room.roomType})`;
      }

      if (!resolvedServiceName) {
        return sendError(res, 422, "serviceName is required (or a valid serviceId for flight/hotel/room).", requestId);
      }

      // Business Rule: "Duplicate services prevented" — same catalog
      // reference already active on this booking.
      if (serviceId) {
        const duplicateService = await BookingServiceModel.findOne({
          bookingId: booking._id, tenantId, status: "active", "details.catalogServiceId": serviceId
        });
        if (duplicateService) {
          return sendError(res, 409, `Service "${resolvedServiceName}" is already assigned to this booking.`, requestId);
        }
      }

      const numCost = Number(costPrice) || 0;
      const numSelling = Number(sellingPrice) || 0;
      const numQty = Math.max(Number(quantity) || 1, 1);
      const calculatedTotal = numSelling * numQty;

      const newService = await BookingServiceModel.create({
        bookingId: booking._id,
        tenantId,
        serviceType: normalizedServiceType,
        serviceCategory: normalizedServiceCategory,
        serviceName: resolvedServiceName,
        supplierId: resolvedSupplierId,
        supplierName: resolvedSupplierName,
        costPrice: numCost,
        sellingPrice: numSelling,
        quantity: numQty,
        totalPrice: calculatedTotal,
        currencyId: normalizedCurrencyId,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        status: normalizedStatus,
        workflowStatus: normalizedWorkflowStatus,
        remarks,
        internalNotes,
        priority: normalizedPriority,
        details: serviceId ? { ...details, catalogServiceId: serviceId } : details
      });

      if (Array.isArray(travelerIds) && travelerIds.length > 0) {
        for (const travelerId of travelerIds) {
          const traveler = await BookingTravelerModel.findOne({ _id: travelerId, bookingId: booking._id, tenantId });
          if (traveler) {
            await TravelerServiceAssignmentModel.create({
              bookingId: booking._id,
              tenantId,
              travelerId: traveler._id,
              serviceId: newService._id,
              serviceType: newService.serviceType,
              status: "assigned"
            });
          }
        }
      }

      createdServices.push(newService);
    }

    await recalculateBookingFinancials(booking._id, tenantId);

    await recordBookingTimeline({
      bookingId: booking._id,
      tenantId,
      eventType: "BookingServiceAssigned",
      title: "Services Assigned",
      description: `Added ${createdServices.length} service(s) to booking`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff"
    });

    await AuditLogModel.create({
      action: "booking.service.add",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: booking.branchId,
      requestId,
      metadata: { bookingId: booking._id, count: createdServices.length }
    });

    publishEvent("BookingServiceAssigned", { bookingId: booking._id.toString(), tenantId, count: createdServices.length });
    publishEvent("BookingUpdated", { bookingId: booking._id.toString(), tenantId });

    return sendSuccess(res, 201, "Services assigned successfully.", {
      added: createdServices.length,
      services: createdServices.map((s) => ({
        serviceId: s._id,
        serviceType: s.serviceType,
        serviceName: s.serviceName,
        totalPrice: s.totalPrice
      }))
    }, requestId);
  } catch (error) {
    console.error("AddBookingServices error:", error);
    return sendError(res, 500, "Unable to assign services.", requestId);
  }
};

export const UpdateBookingService = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId, serviceAssignmentId } = req.params;
    const service = await BookingServiceModel.findOne({
      _id: serviceAssignmentId,
      bookingId,
      tenantId,
      status: { $ne: "cancelled" }
    });

    if (!service) return sendError(res, 404, "Service assignment not found.", requestId);

    // Business Rule: "Completed services cannot be edited without approval."
    if (service.workflowStatus === "completed" && !permissions.includes("bookings.delete") && !permissions.includes("admin")) {
      return sendError(res, 403, "Elevated permission required to edit a completed service.", requestId);
    }

    const allowedFields = [
      "serviceName", "supplierId", "supplierName", "costPrice", "sellingPrice",
      "quantity", "currencyId", "startDate", "endDate", "remarks", "internalNotes",
      "priority", "workflowStatus", "serviceCategory", "details"
    ];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        if (field === "startDate" || field === "endDate") {
          service[field] = req.body[field] ? new Date(req.body[field]) : null;
        } else if (field === "serviceCategory") {
          service[field] = `${req.body[field]}`.trim().toLowerCase();
        } else if (field === "currencyId") {
          service[field] = `${req.body[field]}`.trim().toLowerCase();
        } else if (field === "workflowStatus") {
          service[field] = `${req.body[field]}`.trim().toLowerCase();
        } else if (field === "priority") {
          service[field] = `${req.body[field]}`.trim().toLowerCase();
        } else {
          service[field] = req.body[field];
        }
      }
    });

    if (service.serviceCategory && !bookingConfig.serviceCategories.includes(service.serviceCategory)) {
      return sendError(res, 422, `Unsupported serviceCategory '${service.serviceCategory}'.`, requestId);
    }

    if (service.workflowStatus && !bookingConfig.serviceWorkflowStatuses.includes(service.workflowStatus)) {
      return sendError(res, 422, `Unsupported workflowStatus '${service.workflowStatus}'.`, requestId);
    }

    if (service.currencyId && !bookingConfig.supportedCurrencies.includes(service.currencyId)) {
      return sendError(res, 422, `Unsupported currencyId '${service.currencyId}'.`, requestId);
    }

    service.totalPrice = (Number(service.sellingPrice) || 0) * (Number(service.quantity) || 1);
    await service.save();

    await recalculateBookingFinancials(bookingId, tenantId);

    await recordBookingTimeline({
      bookingId,
      tenantId,
      eventType: "BookingServiceUpdated",
      title: "Service Updated",
      description: `Updated service ${service.serviceName} (${service.serviceType})`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff"
    });

    await AuditLogModel.create({
      action: "booking.service.update",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { bookingId, serviceId: service._id }
    });

    publishEvent("BookingServiceUpdated", { bookingId, serviceId: service._id.toString(), tenantId });

    return sendSuccess(res, 200, "Service updated successfully.", service, requestId);
  } catch (error) {
    console.error("UpdateBookingService error:", error);
    return sendError(res, 500, "Unable to update service assignment.", requestId);
  }
};

export const RemoveBookingService = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.update") && !permissions.includes("bookings.delete") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId, serviceAssignmentId } = req.params;
    const service = await BookingServiceModel.findOne({
      _id: serviceAssignmentId,
      bookingId,
      tenantId,
      status: { $ne: "cancelled" }
    });

    if (!service) return sendError(res, 404, "Service assignment not found.", requestId);

    service.status = "cancelled";
    service.workflowStatus = "cancelled";
    await service.save();

    await TravelerServiceAssignmentModel.updateMany(
      { bookingId, serviceId: service._id, tenantId },
      { status: "cancelled" }
    );

    await recalculateBookingFinancials(bookingId, tenantId);

    await recordBookingTimeline({
      bookingId,
      tenantId,
      eventType: "BookingServiceRemoved",
      title: "Service Removed",
      description: `Removed service ${service.serviceName} from booking`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff"
    });

    await AuditLogModel.create({
      action: "booking.service.remove",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      requestId,
      metadata: { bookingId, serviceId: service._id }
    });

    // recalculateBookingFinancials (above) already publishes
    // "BookingFinancialUpdated" for this same recalculation — no need to
    // fire a second, differently-named event for the same fact here.
    publishEvent("BookingServiceRemoved", { bookingId, serviceId: service._id.toString(), tenantId });

    return sendSuccess(res, 200, "Service assignment removed.", null, requestId);
  } catch (error) {
    console.error("RemoveBookingService error:", error);
    return sendError(res, 500, "Unable to remove service assignment.", requestId);
  }
};

export const AssignTravelerServices = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const assignmentsInput = Array.isArray(req.body.assignments) ? req.body.assignments : [req.body];

    if (assignmentsInput.length === 0) {
      return sendError(res, 422, "Assignments array (travelerId, serviceAssignmentId) is required.", requestId);
    }

    const createdAssignments = [];

    for (const item of assignmentsInput) {
      const { travelerId, serviceAssignmentId, serviceId, assignmentDetails = {} } = item;
      const targetServiceId = serviceAssignmentId || serviceId;

      if (!travelerId || !targetServiceId) continue;

      const traveler = await BookingTravelerModel.findOne({ _id: travelerId, bookingId, tenantId, status: { $ne: "cancelled" } });
      const service = await BookingServiceModel.findOne({ _id: targetServiceId, bookingId, tenantId, status: { $ne: "cancelled" } });

      if (!traveler || !service) continue;

      const assignment = await TravelerServiceAssignmentModel.findOneAndUpdate(
        { bookingId, travelerId: traveler._id, serviceId: service._id, tenantId },
        {
          serviceType: service.serviceType,
          status: "assigned",
          assignmentDetails
        },
        { upsert: true, new: true }
      );

      createdAssignments.push(assignment);
    }

    publishEvent("TravelerServiceAssigned", { bookingId, tenantId, count: createdAssignments.length });

    return sendSuccess(res, 200, "Traveler services assigned.", { count: createdAssignments.length }, requestId);
  } catch (error) {
    console.error("AssignTravelerServices error:", error);
    return sendError(res, 500, "Unable to assign traveler services.", requestId);
  }
};

// ==========================================
// Part 5 — Booking Workflow APIs
// ==========================================

export const GetBookingWorkflow = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    const instance = await getOrCreateWorkflowInstance({
      tenantId,
      entityType: "Booking",
      entityId: booking._id,
      initialState: booking.status || "draft"
    });

    const definition = getWorkflowDefinitionForEntity("Booking");
    const allowedNextActions = getAllowedNextActions(instance.currentState, "Booking");
    const completedSteps = instance.completedSteps || [];
    const currentStateMeta = definition.states.find((s) => s.stateId === instance.currentState);
    const pendingSteps = definition.states
      .filter((s) => !completedSteps.includes(s.stateId))
      .map((s) => ({ stateId: s.stateId, label: s.label }));

    // Business Rule: "Only authorized users can view approval information."
    const canViewApprovals = permissions.includes("bookings.delete") || permissions.includes("admin");

    return sendSuccess(res, 200, "Booking workflow profile loaded.", {
      currentState: instance.currentState,
      currentStep: currentStateMeta?.label || instance.currentState,
      workflowVersion: definition.version,
      previousState: instance.previousState || null,
      completedSteps,
      pendingSteps,
      allowedNextActions,
      pendingApprovals: canViewApprovals ? (instance.pendingApprovals || []) : undefined,
      history: instance.history || []
    }, requestId);
  } catch (error) {
    console.error("GetBookingWorkflow error:", error);
    return sendError(res, 500, "Unable to load booking workflow.", requestId);
  }
};

export const TransitionBookingWorkflow = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];

    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const { action, targetState, remarks, comments } = req.body;

    if (!action && !targetState) {
      return sendError(res, 422, "Either 'action' or 'targetState' is required for workflow transition.", requestId);
    }

    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId, status: { $ne: "archived" } });
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    // Validation Rules "Required documents uploaded" / "Required payment
    // completed" are intentionally NOT enforced here: the workflow
    // definition's guardConditions are always empty (see
    // getWorkflowDefinitionForEntity) — there is no data model anywhere
    // mapping "this transition needs these specific documents/this payment
    // threshold", so building a check would mean fabricating requirements
    // the doc never specifies. Real enforcement needs that mapping defined
    // first (e.g. per-transition guardConditions sourced from config).

    const transitionResult = await executeWorkflowTransition({
      tenantId,
      entityType: "Booking",
      entityId: booking._id,
      action,
      targetState,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff",
      userRoles: req.auth?.roles || (req.auth?.role ? [req.auth.role] : []),
      comments: remarks || comments || null
    });

    if (transitionResult.requiresApproval) {
      return sendSuccess(res, 202, transitionResult.message, {
        currentState: transitionResult.currentState,
        requiresApproval: true,
        approvalRole: transitionResult.approvalRole
      }, requestId);
    }

    booking.status = transitionResult.currentState.toLowerCase();
    await booking.save();

    let legacyWorkflow = await BookingWorkflowModel.findOne({ bookingId: booking._id, tenantId });
    if (legacyWorkflow) {
      legacyWorkflow.currentStep = booking.status;
      legacyWorkflow.history.push({
        step: booking.status,
        changedBy: req.auth?.id || null,
        changedByName: req.auth?.username || "Staff",
        timestamp: new Date(),
        comments: remarks || comments || `Moved to ${transitionResult.currentState}`
      });
      await legacyWorkflow.save();
    }

    await recordBookingTimeline({
      bookingId: booking._id,
      tenantId,
      eventType: "WorkflowTransitionCompleted",
      title: "Workflow Transition Completed",
      description: `Booking moved from ${transitionResult.previousState} to ${transitionResult.currentState} via '${transitionResult.actionPerformed}'`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff"
    });

    await AuditLogModel.create({
      action: "booking.workflow.transition",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: booking.branchId,
      requestId,
      metadata: {
        bookingId: booking._id,
        previousState: transitionResult.previousState,
        currentState: transitionResult.currentState,
        actionPerformed: transitionResult.actionPerformed
      }
    });

    publishEvent("WorkflowTransitionCompleted", { bookingId: booking._id.toString(), tenantId, currentState: transitionResult.currentState });
    publishEvent("BookingStatusChanged", { bookingId: booking._id.toString(), tenantId, newStatus: booking.status });
    if (booking.status === "completed") {
      publishEvent("BookingCompleted", { bookingId: booking._id.toString(), tenantId });
    }
    publishEvent("TimelineCreated", { bookingId: booking._id.toString(), tenantId });
    publishEvent("NotificationRequested", { bookingId: booking._id.toString(), tenantId, event: "BookingStatusChanged" });
    publishEvent("BookingAnalyticsUpdated", { bookingId: booking._id.toString(), tenantId });

    // Automatic Actions: "Confirmed -> ... -> Create Tasks -> No manual
    // intervention required." Of the six examples the doc lists (Generate
    // Invoice, Create Payment Schedule, Notify Customer, Assign Visa
    // Officer, Assign Operations Team, Create Tasks), only task creation has
    // a real model to act on here — there's no Invoice/Payment model, and no
    // Visa-Officer/Operations-Team assignment concept tied to a booking
    // anywhere in this codebase. Fired async (not awaited), matching the
    // existing BookingSagaManager fire-and-forget convention.
    if (transitionResult.currentState === "confirmed") {
      BookingTaskModel.create({
        bookingId: booking._id,
        tenantId,
        entityType: "Booking",
        entityId: booking._id,
        title: "Prepare visa & travel documentation",
        description: "Booking confirmed — verify traveler documents and begin visa preparation.",
        workflowStatus: "created",
        status: "active",
        createdBy: "system",
        createdByName: "Workflow Automation"
      }).catch((err) => console.error("Workflow automation task creation failed:", err));
    }

    return sendSuccess(res, 200, "Workflow updated.", {
      previousState: transitionResult.previousState,
      currentState: transitionResult.currentState,
      actionPerformed: transitionResult.actionPerformed,
      requiresApproval: false
    }, requestId);
  } catch (error) {
    console.error("TransitionBookingWorkflow error:", error);
    return sendError(res, 400, error.message || "Unable to transition booking workflow.", requestId);
  }
};

// ==========================================
// Part 6 — Booking Operations APIs
// ==========================================

// --- Documents ---
export const ListBookingDocuments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    const documents = await BookingDocumentModel.find({
      bookingId: booking._id,
      tenantId,
      status: { $ne: "archived" },
      virusScanStatus: { $ne: "infected" }
    }).sort({ createdAt: -1 }).lean();

    return sendSuccess(res, 200, "Booking documents loaded.", documents.map(buildBookingDocumentResponse), requestId);
  } catch (error) {
    console.error("ListBookingDocuments error:", error);
    return sendError(res, 500, "Unable to load booking documents.", requestId);
  }
};

export const AddBookingDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.create") && !permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const { fileName, fileUrl, storageKey, fileType, fileSize, category = "Other", fileBuffer, fileBase64, mimeType } = req.body;

    if (!fileName && !fileUrl && !storageKey) {
      return sendError(res, 422, "fileName and (fileUrl or storageKey) are required.", requestId);
    }

    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId, status: { $ne: "archived" } });
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    let resolvedStorageKey = storageKey || null;
    let storedFileUrl = fileUrl ? resolveBookingDocumentUrl(fileUrl) : null;

    if (!storedFileUrl && !resolvedStorageKey && (fileBuffer || fileBase64)) {
      const buffer = fileBuffer
        ? Buffer.from(fileBuffer)
        : Buffer.from(fileBase64, "base64");
      const storageResult = await saveBookingDocumentFile({
        fileName: fileName || "booking-document",
        mimeType: mimeType || fileType || "application/octet-stream",
        buffer,
        extension: fileType?.includes("image") ? ".png" : ".bin"
      });
      storedFileUrl = storageResult.publicUrl;
      resolvedStorageKey = storageResult.storedFileName;
    }

    // "Document versioning supported" — increment based on prior versions of
    // the same document (same fileName within this booking), matching the
    // Customer document module's convention.
    const versionCount = await BookingDocumentModel.countDocuments({ bookingId: booking._id, tenantId, fileName: fileName ? fileName.trim() : "booking-document" });

    const doc = await BookingDocumentModel.create({
      bookingId: booking._id,
      tenantId,
      entityType: "Booking",
      entityId: booking._id,
      fileName: fileName ? fileName.trim() : "booking-document",
      storageKey: resolvedStorageKey,
      fileUrl: storedFileUrl || (fileUrl ? fileUrl.trim() : null) || "",
      fileType: fileType || mimeType || "application/pdf",
      fileSize: Number(fileSize) || 0,
      category,
      status: bookingConfig.defaultDocumentStatus,
      version: versionCount + 1,
      uploadedBy: req.auth?.id || null,
      uploadedByName: req.auth?.username || "Staff"
    });

    await recordBookingTimeline({
      bookingId: booking._id,
      tenantId,
      eventType: "DocumentUploaded",
      title: "Document Uploaded",
      description: `Uploaded document '${doc.fileName}' (${doc.category})`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff",
      referenceId: doc._id.toString()
    });

    await AuditLogModel.create({
      action: "booking.document.upload",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: booking.branchId,
      requestId,
      metadata: { bookingId: booking._id, documentId: doc._id }
    });

    // Named BookingDocumentUploaded (not the bare "DocumentUploaded") to avoid
    // colliding with the Visa module's identically-named event, which
    // VisaAnalyticsEngine/VisaTimelineEventBus already subscribe to.
    publishEvent("BookingDocumentUploaded", { bookingId: booking._id.toString(), tenantId, documentId: doc._id.toString() });

    return sendSuccess(res, 201, "Document metadata registered.", buildBookingDocumentResponse(doc), requestId);
  } catch (error) {
    console.error("AddBookingDocument error:", error);
    return sendError(res, 500, "Unable to add booking document.", requestId);
  }
};

export const VerifyBookingDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId, documentId } = req.params;
    const doc = await BookingDocumentModel.findOne({ _id: documentId, bookingId, tenantId, status: { $ne: "archived" } });
    if (!doc) return sendError(res, 404, "Document not found.", requestId);

    doc.status = "verified";
    doc.verifiedBy = req.auth?.id || null;
    doc.verifiedAt = new Date();
    doc.rejectionReason = null;
    await doc.save();

    await recordBookingTimeline({
      bookingId, tenantId, eventType: "BookingDocumentVerified", title: "Document Verified",
      description: `Document verified: ${doc.fileName}`, performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff", referenceId: doc._id.toString()
    });
    await AuditLogModel.create({
      action: "booking.document.verify", outcome: "success", reason: null,
      userId: req.auth?.id || null, tenantId, requestId, metadata: { bookingId, documentId: doc._id }
    });
    publishEvent("BookingDocumentVerified", { bookingId: bookingId.toString(), tenantId, documentId: doc._id.toString() });

    return sendSuccess(res, 200, "Document verified.", buildBookingDocumentResponse(doc), requestId);
  } catch (error) {
    console.error("VerifyBookingDocument error:", error);
    return sendError(res, 500, "Unable to verify document.", requestId);
  }
};

export const RejectBookingDocument = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId, documentId } = req.params;
    const { reason } = req.body;
    if (!reason) return sendError(res, 422, "reason is required.", requestId);

    const doc = await BookingDocumentModel.findOne({ _id: documentId, bookingId, tenantId, status: { $ne: "archived" } });
    if (!doc) return sendError(res, 404, "Document not found.", requestId);

    doc.status = "rejected";
    doc.verifiedBy = req.auth?.id || null;
    doc.verifiedAt = new Date();
    doc.rejectionReason = reason;
    await doc.save();

    await recordBookingTimeline({
      bookingId, tenantId, eventType: "BookingDocumentRejected", title: "Document Rejected",
      description: `Document rejected: ${doc.fileName} (${reason})`, performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff", referenceId: doc._id.toString()
    });
    await AuditLogModel.create({
      action: "booking.document.reject", outcome: "success", reason,
      userId: req.auth?.id || null, tenantId, requestId, metadata: { bookingId, documentId: doc._id }
    });
    publishEvent("BookingDocumentRejected", { bookingId: bookingId.toString(), tenantId, documentId: doc._id.toString(), reason });

    return sendSuccess(res, 200, "Document rejected.", buildBookingDocumentResponse(doc), requestId);
  } catch (error) {
    console.error("RejectBookingDocument error:", error);
    return sendError(res, 500, "Unable to reject document.", requestId);
  }
};

// --- Notes ---
export const ListBookingNotes = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    const notes = await BookingNoteModel.find({
      bookingId: booking._id,
      tenantId,
      status: { $ne: "archived" }
    }).sort({ createdAt: -1 }).lean();

    return sendSuccess(res, 200, "Booking notes loaded.", notes, requestId);
  } catch (error) {
    console.error("ListBookingNotes error:", error);
    return sendError(res, 500, "Unable to load booking notes.", requestId);
  }
};

export const AddBookingNote = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.create") && !permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const { category = "Operations", visibility = "Internal", content, isImportant = false } = req.body;

    if (!content || !content.trim()) {
      return sendError(res, 422, "Note content is required.", requestId);
    }

    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId, status: { $ne: "archived" } });
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    const note = await BookingNoteModel.create({
      bookingId: booking._id,
      tenantId,
      entityType: "Booking",
      entityId: booking._id,
      authorId: req.auth?.id || null,
      authorName: req.auth?.username || "Staff",
      category,
      visibility,
      content: content.trim(),
      isImportant: Boolean(isImportant),
      status: "active"
    });

    await recordBookingTimeline({
      bookingId: booking._id,
      tenantId,
      eventType: "BookingNoteCreated",
      title: "Note Added",
      description: `Note added [${category}]: ${content.trim().substring(0, 50)}...`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff",
      referenceId: note._id.toString()
    });

    await AuditLogModel.create({
      action: "booking.note.create",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: booking.branchId,
      requestId,
      metadata: { bookingId: booking._id, noteId: note._id, category }
    });

    publishEvent("BookingNoteCreated", { bookingId: booking._id.toString(), tenantId, noteId: note._id.toString() });

    return sendSuccess(res, 201, "Note created successfully.", note, requestId);
  } catch (error) {
    console.error("AddBookingNote error:", error);
    return sendError(res, 500, "Unable to add booking note.", requestId);
  }
};

// --- Timeline ---
export const ListBookingTimeline = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || bookingConfig.defaultPageSize, 10), 1), bookingConfig.maxPageSize);

    // Business Rule: "Supports filtering."
    const moduleFilter = req.query.module || null;
    const eventType = req.query.eventType || req.query.type || null;
    const performedBy = req.query.performedBy || req.query.user || null;
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;

    const filter = { bookingId: booking._id, tenantId };
    if (moduleFilter) filter.module = new RegExp(moduleFilter, "i");
    if (eventType) filter.eventType = new RegExp(eventType, "i");
    if (performedBy) filter.performedBy = performedBy;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = startDate;
      if (endDate) filter.createdAt.$lte = endDate;
    }

    const totalItems = await BookingTimelineModel.countDocuments(filter);

    const timelineEvents = await BookingTimelineModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    const formattedTimeline = timelineEvents.map((t) => ({
      eventId: t._id,
      module: t.module || "Booking",
      eventType: t.eventType,
      title: t.title || t.eventType,
      description: t.description,
      performedBy: t.performedBy,
      performedByName: t.performedByName || "Staff",
      timestamp: t.createdAt,
      referenceId: t.referenceId || null,
      metadata: t.metadata || {}
    }));

    return sendSuccess(res, 200, "Booking timeline loaded.", {
      data: formattedTimeline,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize)
      }
    }, requestId);
  } catch (error) {
    console.error("ListBookingTimeline error:", error);
    return sendError(res, 500, "Unable to load booking timeline.", requestId);
  }
};

// --- Tasks ---
export const ListBookingTasks = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    const tasks = await BookingTaskModel.find({
      bookingId: booking._id,
      tenantId,
      status: { $ne: "archived" }
    }).sort({ dueDate: 1, createdAt: -1 }).lean();

    return sendSuccess(res, 200, "Booking tasks loaded.", tasks, requestId);
  } catch (error) {
    console.error("ListBookingTasks error:", error);
    return sendError(res, 500, "Unable to load booking tasks.", requestId);
  }
};

export const AddBookingTask = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.create") && !permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;
    const { title, description = null, assignedTo = null, assignedToName = null, dueDate = null, priority = "normal" } = req.body;

    if (!title || !title.trim()) {
      return sendError(res, 422, "Task title is required.", requestId);
    }

    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId, status: { $ne: "archived" } });
    if (!booking) return sendError(res, 404, "Booking not found.", requestId);

    const task = await BookingTaskModel.create({
      bookingId: booking._id,
      tenantId,
      entityType: "Booking",
      entityId: booking._id,
      title: title.trim(),
      description,
      assignedTo,
      assignedToName: assignedToName || (assignedTo ? "Assigned Staff" : "Unassigned"),
      dueDate: dueDate ? new Date(dueDate) : null,
      priority: priority.toLowerCase(),
      workflowStatus: assignedTo ? "assigned" : "created",
      status: "active",
      createdBy: req.auth?.id || null,
      createdByName: req.auth?.username || "Staff"
    });

    // Seeds WorkflowInstanceModel so PATCH .../tasks/:taskId (generic engine,
    // entityType "Task") starts from the same state the task was actually
    // created in, matching how Booking's own workflow instance is
    // initialized explicitly at CreateBooking time rather than lazily.
    await getOrCreateWorkflowInstance({
      tenantId,
      entityType: "Task",
      entityId: task._id,
      initialState: task.workflowStatus
    });

    await recordBookingTimeline({
      bookingId: booking._id,
      tenantId,
      eventType: "TaskCreated",
      title: "Task Created",
      description: `Task created: ${task.title}`,
      performedBy: req.auth?.id || null,
      performedByName: req.auth?.username || "Staff",
      referenceId: task._id.toString()
    });

    await AuditLogModel.create({
      action: "booking.task.create",
      outcome: "success",
      reason: null,
      userId: req.auth?.id || null,
      tenantId,
      branchId: booking.branchId,
      requestId,
      metadata: { bookingId: booking._id, taskId: task._id }
    });

    publishEvent("BookingTaskCreated", { bookingId: booking._id.toString(), tenantId, taskId: task._id.toString() });
    if (assignedTo) {
      publishEvent("BookingTaskAssigned", { bookingId: booking._id.toString(), tenantId, taskId: task._id.toString(), assignedTo });
    }

    return sendSuccess(res, 201, "Task created successfully.", task, requestId);
  } catch (error) {
    console.error("AddBookingTask error:", error);
    return sendError(res, 500, "Unable to create booking task.", requestId);
  }
};

export const UpdateBookingTask = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.update") && !permissions.includes("booking.update")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId, taskId } = req.params;
    const { action, targetState, assignedTo, assignedToName, priority, dueDate, description, comments } = req.body;

    const task = await BookingTaskModel.findOne({ _id: taskId, bookingId, tenantId, status: { $ne: "archived" } });
    if (!task) return sendError(res, 404, "Task not found.", requestId);

    // Business Rule: "Supports reassignment."
    if (assignedTo !== undefined) {
      task.assignedTo = assignedTo;
      task.assignedToName = assignedToName || (assignedTo ? "Assigned Staff" : "Unassigned");
    }
    if (assignedToName !== undefined && assignedTo === undefined) task.assignedToName = assignedToName;
    if (priority !== undefined) task.priority = `${priority}`.trim().toLowerCase();
    if (dueDate !== undefined) task.dueDate = dueDate ? new Date(dueDate) : null;
    if (description !== undefined) task.description = description;

    let transitionResult = null;
    // "Task Workflow ... Workflow managed by Generic Workflow Engine."
    if (action || targetState) {
      transitionResult = await executeWorkflowTransition({
        tenantId,
        entityType: "Task",
        entityId: task._id,
        action,
        targetState,
        performedBy: req.auth?.id || null,
        performedByName: req.auth?.username || "Staff",
        userRoles: req.auth?.roles || (req.auth?.role ? [req.auth.role] : []),
        comments: comments || null
      });

      if (transitionResult.requiresApproval) {
        return sendSuccess(res, 202, transitionResult.message, {
          currentState: transitionResult.currentState,
          requiresApproval: true,
          approvalRole: transitionResult.approvalRole
        }, requestId);
      }

      task.workflowStatus = transitionResult.currentState;
    } else if (assignedTo && task.workflowStatus === "created") {
      // Reassigning an unassigned task naturally moves it to "assigned"
      // without requiring a separate explicit transition call.
      const autoTransition = await executeWorkflowTransition({
        tenantId, entityType: "Task", entityId: task._id, action: "Assign Task",
        performedBy: req.auth?.id || null, performedByName: req.auth?.username || "Staff",
        userRoles: req.auth?.roles || (req.auth?.role ? [req.auth.role] : [])
      }).catch(() => null);
      if (autoTransition && !autoTransition.requiresApproval) task.workflowStatus = autoTransition.currentState;
    }

    await task.save();

    await recordBookingTimeline({
      bookingId, tenantId, eventType: "TaskUpdated", title: "Task Updated",
      description: `Task updated: ${task.title} (${task.workflowStatus})`,
      performedBy: req.auth?.id || null, performedByName: req.auth?.username || "Staff",
      referenceId: task._id.toString()
    });

    await AuditLogModel.create({
      action: "booking.task.update", outcome: "success", reason: null,
      userId: req.auth?.id || null, tenantId, requestId,
      metadata: { bookingId, taskId: task._id, workflowStatus: task.workflowStatus }
    });

    // Publishes the specific domain event the resulting state maps to,
    // rather than always firing a generic "updated" event — matches the
    // doc's named events (Booking-prefixed, per the same collision-avoidance
    // convention already applied to Documents): BookingTaskAssigned,
    // BookingTaskCompleted, BookingTaskCancelled, BookingTaskOverdue
    // (BookingTaskOverdue is only reachable here via a manual "Mark Overdue"
    // action; automatic due-date detection would need a scheduled job, which
    // doesn't exist for Booking Tasks in this codebase).
    const eventMap = { assigned: "BookingTaskAssigned", completed: "BookingTaskCompleted", cancelled: "BookingTaskCancelled", overdue: "BookingTaskOverdue" };
    publishEvent(eventMap[task.workflowStatus] || "BookingTaskUpdated", { bookingId: bookingId.toString(), tenantId, taskId: task._id.toString() });

    return sendSuccess(res, 200, "Task updated successfully.", task, requestId);
  } catch (error) {
    console.error("UpdateBookingTask error:", error);
    return sendError(res, 400, error.message || "Unable to update task.", requestId);
  }
};

// ==========================================
// Part 7 — Financial Summary & Dashboard APIs
// ==========================================

export const GetBookingFinancialSummary = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const { bookingId } = req.params;

    // Business Rule: "Supports Redis cache" / AI Coding Rule: "Cache
    // aggressively." Read Model Only — this endpoint never recalculates,
    // it only reads booking.financialSnapshot (owned by
    // recalculateBookingFinancials, refreshed asynchronously by the
    // service/traveler mutation endpoints), so a short TTL cache is safe:
    // the underlying snapshot itself is already eventually-consistent by
    // design, not a live source of truth.
    const cacheKey = `booking-financial-summary:${tenantId}:${bookingId}`;
    const { data: summary, fromCache } = await CacheManager.getOrCompute(cacheKey, async () => {
      const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
      if (!booking) return null;

      const snapshot = booking.financialSnapshot || {};
      const bookingTotal = snapshot.totalAmount || booking.totalAmount || 0;
      const paidAmount = snapshot.paidAmount || booking.paidAmount || 0;
      const outstandingAmount = Math.max(bookingTotal - paidAmount, 0);

      return {
        bookingId: booking._id,
        bookingNumber: booking.bookingNumber || booking.bookingReference,
        bookingTotal,
        packageTotal: snapshot.packagePrice || bookingTotal,
        serviceCharges: snapshot.serviceCharges || 0,
        taxes: snapshot.taxes || 0,
        discounts: snapshot.discounts || 0,
        netAmount: bookingTotal,
        paidAmount,
        outstandingAmount,
        refundAmount: snapshot.refundAmount || 0,
        currency: snapshot.currency || booking.currency || "USD",
        paymentStatus: booking.paymentStatus ? (booking.paymentStatus.charAt(0).toUpperCase() + booking.paymentStatus.slice(1)) : "Unpaid",
        // Approximates "last payment date" from the snapshot's last
        // recalculation timestamp (no Payment ledger exists to read a real
        // payment date from — see invoiceCount/paymentCount below). Honest
        // only when a payment has actually landed (paidAmount > 0); if
        // nothing has been paid, there is no payment date to report.
        lastPaymentDate: paidAmount > 0 ? (snapshot.lastCalculatedAt || booking.updatedAt) : null,
        nextDueDate: booking.travelDate || null,
        // No Invoice or Payment model exists anywhere in this codebase (the
        // Finance module referenced by this doc's "Finance module owns
        // calculations" rule hasn't been built) — there is no real ledger to
        // count invoices/payments from. Reporting a fabricated "1" here
        // would be exactly the kind of hardcoded/fake data STEP 3 forbids,
        // so this honestly reports 0 (no tracked records) rather than
        // guessing. Flagged for the Finance module, not built here.
        invoiceCount: 0,
        paymentCount: 0,
        lastUpdated: snapshot.lastCalculatedAt || booking.updatedAt
      };
    }, parseInt(process.env.DASHBOARD_CACHE_TTL_SECONDS || "60", 10));

    if (!summary) return sendError(res, 404, "Booking not found.", requestId);

    return sendSuccess(res, 200, fromCache ? "Booking financial summary loaded (cached)." : "Booking financial summary loaded.", summary, requestId);
  } catch (error) {
    console.error("GetBookingFinancialSummary error:", error);
    return sendError(res, 500, "Unable to load financial summary.", requestId);
  }
};

export const GetBookingDashboard = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const tenantId = req.auth?.tenantId;
    const permissions = req.auth?.permissions || [];
    if (!tenantId) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    // Performance Strategy: "Redis Cache -> Materialized Views -> Summary
    // Tables. Never calculate dashboard metrics directly from transactional
    // tables." A full materialized-view/summary-table pipeline (paralleling
    // KPIEngine/VisaAnalyticsEngine's cron-computed summary collections) is
    // a genuinely new subsystem this Part doesn't build — flagged as a
    // follow-up. What's implemented here is the first two tiers for real:
    // an aggressive Redis/in-memory TTL cache in front of MongoDB
    // aggregation pipelines (never loading full transactional documents
    // into app memory, unlike the previous reduce()-based implementation).
    const cacheKey = `booking-dashboard:${tenantId}`;
    const { data: dashboard, fromCache } = await CacheManager.getOrCompute(cacheKey, async () => {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);

      const filter = { tenantId, status: { $ne: "archived" } };

      const [
        todaysBookingsCount,
        upcomingDeparturesCount,
        pendingVisaCount,
        cancelledBookingsCount,
        revenueAgg,
        pendingPaymentsAgg,
        taskAgg,
        workflowAgg,
        trendAgg
      ] = await Promise.all([
        BookingHeaderModel.countDocuments({ ...filter, createdAt: { $gte: startOfToday } }),
        BookingHeaderModel.countDocuments({ ...filter, travelDate: { $gte: new Date() } }),
        BookingHeaderModel.countDocuments({ ...filter, visaStatus: { $in: ["pending", "processing", "submitted"] } }),
        BookingHeaderModel.countDocuments({ ...filter, status: "cancelled" }),
        // Revenue grouped by currency — bookings are not guaranteed to
        // share one currency (bookingConfig.supportedCurrencies lists
        // usd/sar/aed/eur/gbp), so summing across currencies into one
        // number and labeling it "USD" would itself be fabricated data.
        BookingHeaderModel.aggregate([
          { $match: filter },
          { $group: {
              _id: { $ifNull: ["$financialSnapshot.currency", { $ifNull: ["$currency", bookingConfig.defaultCurrency] }] },
              grossRevenue: { $sum: { $ifNull: ["$financialSnapshot.totalAmount", { $ifNull: ["$totalAmount", 0] }] } },
              paidRevenue: { $sum: { $ifNull: ["$financialSnapshot.paidAmount", { $ifNull: ["$paidAmount", 0] }] } }
          } }
        ]),
        BookingHeaderModel.aggregate([
          { $match: { ...filter, paymentStatus: { $in: ["unpaid", "partially_paid"] } } },
          { $group: {
              _id: null,
              count: { $sum: 1 },
              amount: { $sum: { $subtract: [
                { $ifNull: ["$financialSnapshot.totalAmount", { $ifNull: ["$totalAmount", 0] }] },
                { $ifNull: ["$financialSnapshot.paidAmount", { $ifNull: ["$paidAmount", 0] }] }
              ] } }
          } }
        ]),
        BookingTaskModel.aggregate([
          { $match: { tenantId, status: "active" } },
          { $group: { _id: "$workflowStatus", count: { $sum: 1 } } }
        ]),
        // Full 14-state lifecycle (Part 5), not a hand-picked subset —
        // includes archived bookings deliberately since "archived" is
        // itself one of the real states being reported on.
        BookingHeaderModel.aggregate([
          { $match: { tenantId } },
          { $group: { _id: "$status", count: { $sum: 1 } } }
        ]),
        BookingHeaderModel.aggregate([
          { $match: { tenantId, createdAt: { $gte: (() => { const d = new Date(); d.setDate(d.getDate() - (parseInt(process.env.BOOKING_DASHBOARD_TREND_DAYS || "14", 10) - 1)); d.setHours(0, 0, 0, 0); return d; })() } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } }
        ])
      ]);

      const revenueByCurrency = revenueAgg.map((r) => ({
        currency: `${r._id || bookingConfig.defaultCurrency}`.toUpperCase(),
        grossRevenue: r.grossRevenue || 0,
        paidRevenue: r.paidRevenue || 0,
        outstandingBalance: Math.max((r.grossRevenue || 0) - (r.paidRevenue || 0), 0)
      }));
      const defaultCurrency = bookingConfig.defaultCurrency.toUpperCase();
      const defaultBucket = revenueByCurrency.find((r) => r.currency === defaultCurrency) || { grossRevenue: 0, paidRevenue: 0, outstandingBalance: 0 };

      const pendingPayments = {
        count: pendingPaymentsAgg[0]?.count || 0,
        amount: Math.max(pendingPaymentsAgg[0]?.amount || 0, 0)
      };

      const taskStates = ["created", "assigned", "in_progress", "completed", "cancelled", "overdue"];
      const taskSummary = Object.fromEntries(taskStates.map((s) => [s, 0]));
      taskAgg.forEach((t) => { if (t._id && taskSummary[t._id] !== undefined) taskSummary[t._id] = t.count; });

      const workflowSummary = Object.fromEntries(bookingConfig.bookingStatuses.map((s) => [s, 0]));
      workflowAgg.forEach((w) => { if (w._id && workflowSummary[w._id] !== undefined) workflowSummary[w._id] = w.count; });

      const bookingTrends = trendAgg.map((t) => ({ date: t._id, count: t.count }));

      return {
        todaysBookingsCount,
        upcomingDeparturesCount,
        pendingVisaCount,
        pendingPayments,
        cancelledBookingsCount,
        grossRevenue: defaultBucket.grossRevenue,
        paidRevenue: defaultBucket.paidRevenue,
        outstandingBalanceTotal: defaultBucket.outstandingBalance,
        currency: defaultCurrency,
        revenueByCurrency,
        taskSummary,
        workflowSummary,
        bookingTrends
      };
    }, parseInt(process.env.DASHBOARD_CACHE_TTL_SECONDS || "60", 10));

    return sendSuccess(res, 200, fromCache ? "Booking dashboard metrics loaded (cached)." : "Booking dashboard metrics loaded.", dashboard, requestId);
  } catch (error) {
    console.error("GetBookingDashboard error:", error);
    return sendError(res, 500, "Unable to load booking dashboard metrics.", requestId);
  }
};





