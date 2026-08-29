import PackageTemplateModel from "../models/PackageTemplateModel.js";
import TenantProfileModel from "../models/TenantProfileModel.js";
import TenantModel from "../models/Tenantmodel.js";
import CustomerModel from "../models/CustomerModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import PackagePricingService from "./PackagePricingService.js";
import PaymentGatewayService from "./PaymentGatewayService.js";
import LeadService from "./LeadService.js";
import { CreateCustomer } from "../controllers/CustomerController.js";
import { publishEvent } from "../utils/eventBus.js";

// Public B2C Booking Site — PRD "CRM Feature Map by Phase" Phase 2 module
// 15. Everything here is reached WITHOUT authenticateAccessToken
// (routes/PublicBookingRoutes.js), so tenant identity can never come from
// req.auth/getAccessScope the way every other controller in this codebase
// gets it — it's resolved from an admin-published `publicSlug`
// (TenantProfileModel) instead, and every query is still filtered by the
// tenantId that resolves to, same "tenant is the only isolation boundary"
// discipline as everywhere else, just entered from a different door.
//
// Deliberately a thin orchestration layer: template browsing reads
// PackageTemplateModel directly, and the one real write path
// (createPublicBooking) composes three already-existing, already-tested
// PackagePricingService methods (cloneFromTemplate -> calculatePackage ->
// convertPackageToBooking) plus the real CreateCustomer controller function
// (same fakeReq/fakeRes reuse pattern as LeadService.convertToCustomer) and
// PaymentGatewayService.createCheckoutSession — no parallel pricing,
// customer-creation, or payment logic is introduced here.
class PublicBookingService {
  static async resolveTenantBySlug(tenantSlug) {
    if (!tenantSlug) throw new Error("tenantSlug is required.");
    const profile = await TenantProfileModel.findOne({ publicSlug: tenantSlug.toLowerCase().trim() })
      .select("tenantId companyName logoUrl primaryColor secondaryColor")
      .lean();
    if (!profile) throw new Error("Agency not found for this tenantSlug.");

    const tenant = await TenantModel.findOne({ tenantKey: profile.tenantId }).select("status").lean();
    if (!tenant || tenant.status !== "active") throw new Error("This agency's public site is not currently available.");

    return profile;
  }

  static async listPublicPackages(tenantSlug, query = {}) {
    const tenant = await PublicBookingService.resolveTenantBySlug(tenantSlug);
    const filter = { tenantId: tenant.tenantId, active: true, publicVisible: true };
    if (query.type) filter.packageType = query.type;
    if (query.minPrice || query.maxPrice) {
      filter.displayPriceFrom = {};
      if (query.minPrice) filter.displayPriceFrom.$gte = Number(query.minPrice);
      if (query.maxPrice) filter.displayPriceFrom.$lte = Number(query.maxPrice);
    }

    let templates = await PackageTemplateModel.find(filter).sort({ createdAt: -1 }).lean();
    templates = templates.map((t) => ({ ...t, durationNights: templateDurationNights(t) }));
    if (query.duration) {
      const targetNights = Number(query.duration);
      templates = templates.filter((t) => t.durationNights === targetNights);
    }

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(query.pageSize, 10) || 20));
    const total = templates.length;
    const paged = templates.slice((page - 1) * pageSize, page * pageSize);

    return {
      agency: { companyName: tenant.companyName, logoUrl: tenant.logoUrl, primaryColor: tenant.primaryColor, secondaryColor: tenant.secondaryColor },
      items: paged.map(publicTemplateSummary),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
    };
  }

  static async getPublicPackageDetail(tenantSlug, templateId) {
    const tenant = await PublicBookingService.resolveTenantBySlug(tenantSlug);
    const template = await PackageTemplateModel.findOne({ _id: templateId, tenantId: tenant.tenantId, active: true, publicVisible: true }).lean();
    if (!template) throw new Error("Package not found.");
    return { agency: { companyName: tenant.companyName, logoUrl: tenant.logoUrl, primaryColor: tenant.primaryColor, secondaryColor: tenant.secondaryColor }, package: publicTemplateDetail(template) };
  }

  static async createPublicLead(tenantSlug, data) {
    const tenant = await PublicBookingService.resolveTenantBySlug(tenantSlug);
    const { firstName, lastName = null, email = null, phone = null, notes = null } = data;
    if (!firstName) throw new Error("firstName is required.");
    return LeadService.createLead({ firstName, lastName, email, phone, source: "Website", notes }, tenant.tenantId, null);
  }

  /**
   * POST /public/bookings — creates a real, tenant-owned Draft booking for
   * an anonymous website visitor. Never trusts a client-supplied
   * roomTypeId blindly: it's only honoured if it's actually a row in the
   * freshly-calculated matrix for these real dates, otherwise the cheapest
   * available room is selected — a stale/guessed id from a cached page
   * must never silently price the wrong room.
   */
  static async createPublicBooking(tenantSlug, data, requestId) {
    const tenant = await PublicBookingService.resolveTenantBySlug(tenantSlug);
    const tenantId = tenant.tenantId;
    const { packageTemplateId, travelStartDate, travelers = { adults: 1 }, roomTypeId = null, customer = {} } = data;

    if (!packageTemplateId) throw new Error("packageTemplateId is required.");
    if (!travelStartDate) throw new Error("travelStartDate is required.");
    if (!customer.firstName || !customer.lastName || !customer.email || !customer.phone) {
      throw new Error("customer.firstName, customer.lastName, customer.email, and customer.phone are required.");
    }

    const template = await PackageTemplateModel.findOne({ _id: packageTemplateId, tenantId, active: true, publicVisible: true }).lean();
    if (!template) throw new Error("Package not found.");

    const customerId = await PublicBookingService._findOrCreatePublicCustomer(tenantId, customer, requestId);

    const cloned = await PackagePricingService.cloneFromTemplate(packageTemplateId, { travelStartDate, customerId: customerId.toString(), travelers }, tenantId, null);
    const calculated = await PackagePricingService.calculatePackage(cloned._id.toString(), tenantId, null, {});
    if (!calculated.ready || !calculated.roomWisePriceMatrix?.length) {
      throw new Error("This package cannot be priced for the selected dates right now — please contact the agency directly.");
    }

    const matrix = calculated.roomWisePriceMatrix;
    const requested = roomTypeId ? matrix.find((row) => row.roomTypeId.toString() === roomTypeId.toString()) : null;
    const selectedRow = requested || matrix.reduce((cheapest, row) => (!cheapest || row.finalPricePerPerson < cheapest.finalPricePerPerson ? row : cheapest), null);

    const conversion = await PackagePricingService.convertPackageToBooking(cloned._id.toString(), { roomTypeId: selectedRow.roomTypeId.toString(), rooms: 1 }, tenantId, null);
    const checkout = await PublicBookingService._tryCreateCheckout(tenantId, conversion.bookingId);

    await AuditLogModel.create({ action: "public.booking.create", module: "PublicBooking", resource: "Booking", resourceId: conversion.bookingId, userId: null, tenantId, details: { packageTemplateId, customerId: customerId.toString() } });
    publishEvent("PublicBookingCreated", { tenantId, bookingId: conversion.bookingId, customerId: customerId.toString(), performedBy: null });

    return {
      bookingId: conversion.bookingId,
      bookingNumber: conversion.bookingNumber,
      customerId: customerId.toString(),
      selectedRoomType: { roomTypeId: selectedRow.roomTypeId, roomTypeName: selectedRow.roomTypeName, finalPricePerPerson: selectedRow.finalPricePerPerson },
      checkout
    };
  }

  // Reuses the real CreateCustomer controller (same fakeReq/fakeRes pattern
  // LeadService.convertToCustomer already uses) rather than a second,
  // parallel customer-creation path — a public visitor gets exactly the
  // same CustomerModel shape/side-effects (timeline, preferences, audit
  // log) as one created by a staff member. Looks up by email first so a
  // repeat visitor is never turned into a second customer record.
  static async _findOrCreatePublicCustomer(tenantId, customer, requestId) {
    const email = customer.email.toLowerCase().trim();
    const existing = await CustomerModel.findOne({ tenantId, email }).select("_id").lean();
    if (existing) return existing._id;

    const fakeReq = {
      auth: { tenantId, id: "public-website", userId: "public-website", permissions: ["customer.create"] },
      requestId,
      body: {
        firstName: customer.firstName, lastName: customer.lastName,
        primaryEmail: email, primaryPhone: customer.phone,
        tags: ["public-website"], notes: "Created via the public booking site."
      }
    };
    const fakeRes = {
      statusCode: null, body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; }
    };
    await CreateCustomer(fakeReq, fakeRes);

    if (fakeRes.statusCode === 409 && fakeRes.body?.isDuplicate) return fakeRes.body.existingCustomer.customerId;
    if (!fakeRes.statusCode || fakeRes.statusCode >= 400) throw new Error(fakeRes.body?.message || "Failed to create customer.");
    return fakeRes.body.data.customerId;
  }

  // A tenant that hasn't connected Stripe yet (or one that has, but this
  // particular Draft booking rolls to a zero balance) must still get a
  // real booking back — checkout is a best-effort add-on, never a reason
  // to fail the whole public booking request.
  static async _tryCreateCheckout(tenantId, bookingId) {
    try {
      const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).select("bookingNumber bookingReference financialSnapshot totalAmount currency").lean();
      const amount = booking?.financialSnapshot?.outstandingBalance ?? (booking?.financialSnapshot?.totalAmount || booking?.totalAmount || 0);
      if (!(amount > 0)) return { available: false, reason: "No outstanding balance to collect yet." };
      const session = await PaymentGatewayService.createCheckoutSession({
        tenantId, bookingId, bookingReference: booking.bookingNumber || booking.bookingReference,
        amount, currency: booking?.financialSnapshot?.currency || booking?.currency || "USD"
      });
      return { available: true, url: session.url, sessionId: session.sessionId };
    } catch (error) {
      return { available: false, reason: error.message };
    }
  }
}

function templateDurationNights(template) {
  return (template.segments || []).reduce((max, s) => Math.max(max, (s.offsetDays || 0) + (s.nights || 0)), 0);
}

function publicTemplateSummary(template) {
  return {
    id: template._id,
    name: template.name,
    description: template.description,
    packageType: template.packageType,
    images: template.images || [],
    durationNights: template.durationNights,
    displayPriceFrom: template.displayPriceFrom,
    displayCurrency: template.displayCurrency
  };
}

function publicTemplateDetail(template) {
  return {
    ...publicTemplateSummary({ ...template, durationNights: templateDurationNights(template) }),
    segments: (template.segments || []).map((s) => ({ city: s.city, country: s.country, mealPlan: s.mealPlan, offsetDays: s.offsetDays, nights: s.nights }))
  };
}

export default PublicBookingService;
