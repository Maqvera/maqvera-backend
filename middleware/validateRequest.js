import Joi from "joi";
import { getBookingConfig } from "../utils/bookingConfig.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import { getPlatformConfig } from "../utils/platformConfig.js";
import { getOrganisationConfig } from "../utils/organisationConfig.js";
import { getNumberingConfig } from "../utils/numberingConfig.js";
import { getPackagePricingConfig } from "../utils/packagePricingConfig.js";
import { getHotelConfig } from "../utils/hotelConfig.js";
import { getLeadConfig } from "../utils/leadConfig.js";
import { AppError, sendStandardError, fieldDetailsFromJoiError } from "../utils/errorContract.js";

const getBookingValidationValues = () => {
  const bookingConfig = getBookingConfig();
  return {
    bookingTypeValues: bookingConfig.bookingTypes,
    bookingStatusValues: bookingConfig.bookingStatuses,
    paymentStatusValues: bookingConfig.paymentStatuses,
    visaStatusValues: bookingConfig.visaStatuses,
    serviceTypeValues: bookingConfig.serviceTypes,
    serviceCategoryValues: bookingConfig.serviceCategories,
    serviceWorkflowStatusValues: bookingConfig.serviceWorkflowStatuses,
    travelerTypeValues: bookingConfig.travelerTypes,
    currencyValues: bookingConfig.supportedCurrencies,
    defaultCurrency: bookingConfig.defaultCurrency,
    defaultPaymentStatus: bookingConfig.defaultPaymentStatus,
    defaultVisaStatus: bookingConfig.defaultVisaStatus,
    defaultBookingType: bookingConfig.defaultBookingType,
    defaultServiceWorkflowStatus: bookingConfig.defaultServiceWorkflowStatus,
    defaultServiceStatus: bookingConfig.defaultServiceStatus,
    defaultServicePriority: bookingConfig.defaultServicePriority,
    hotelMealPlanValues: bookingConfig.hotelMealPlans,
    hotelRoomViewValues: bookingConfig.hotelRoomViews
  };
};

const validate = (schema, property = "body") => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], { abortEarly: false, stripUnknown: true });
    if (error) {
      // Standard Error Contract (Enterprise Architecture Hardening Phase,
      // Improvement 4) — "Validation errors MUST include field-level
      // details." The top-level `message` stays the exact same joined
      // string every existing caller of this central `validate()` has
      // always received (nothing that reads only `message` sees any
      // change); `data.details` is the real, new, additive field-level
      // array the previous version never provided at all.
      const messages = error.details.map((d) => d.message).join("; ");
      const appError = new AppError("VALIDATION_FAILED", { message: messages, details: fieldDetailsFromJoiError(error) });
      return sendStandardError(res, appError, req.requestId);
    }
    req[property] = value;
    next();
  };
};

const email = Joi.string().email({ tlds: false }).lowercase().trim().max(255).required();
const password = Joi.string().min(6).max(128).required();
const token = Joi.string().hex().min(20).max(256).required();

const tenantKeySlug = Joi.string().trim().lowercase().pattern(/^[a-z0-9-]{3,40}$/).messages({
  "string.pattern.base": "tenantKey must be lowercase letters, numbers, and hyphens only (3-40 characters).",
});

export const authSchemas = {
  signup: Joi.object({
    username: Joi.string().trim().min(2).max(100).required(),
    email,
    password,
    // Optional here because a deployment may set DEFAULT_TENANT_KEY for a
    // genuinely single-tenant on-prem mode — the controller enforces that at
    // least one of (body tenantKey, DEFAULT_TENANT_KEY) resolves to a real
    // tenant, it never silently falls back to "whichever tenant is oldest".
    tenantKey: tenantKeySlug.optional(),
  }),

  setupTenant: Joi.object({
    companyName: Joi.string().trim().min(2).max(200).required(),
    tenantKey: tenantKeySlug.required(),
    username: Joi.string().trim().min(2).max(100).required(),
    email,
    password,
    // Per-Tenant Payment Gateway Integration (PRD Issue 12) — a real
    // plan selection is now required at signup; the tenant itself is
    // only created once payment for this plan actually completes.
    // Inline ObjectId pattern (not the later-declared `objectIdRef` const
    // below in this file) — `authSchemas` is a plain object evaluated
    // immediately at module load, top to bottom, not a lazy Proxy like
    // `paymentGatewaySchemas`; referencing `objectIdRef` here would throw
    // a real "Cannot access before initialization" error at import time.
    planId: Joi.string().trim().pattern(/^[0-9a-fA-F]{24}$/).required().messages({ "string.pattern.base": "planId must be a valid id." }),
    billingCycle: Joi.string().trim().optional(),
  }),

  login: Joi.object({
    email: Joi.string().email({ tlds: false }).lowercase().trim().max(255).required().messages({
      "string.email": "Valid email is required",
      "any.required": "Email is required",
    }),
    password: Joi.string().min(1).max(128).required().messages({
      "any.required": "Password is required",
    }),
    tenantKey: tenantKeySlug.optional(),
    mfaToken: Joi.string().optional(),
    code: Joi.string().optional(),
    recoveryCode: Joi.string().optional(),
    rememberMe: Joi.boolean().optional().default(false),
  }),

  forgotPassword: Joi.object({
    email,
  }),

  resetPassword: Joi.object({
    resetToken: token,
    newPassword: password,
    confirmPassword: Joi.string().valid(Joi.ref("newPassword")).required().messages({
      "any.only": "Passwords do not match",
      "any.required": "Confirm password is required",
    }),
  }),

  changePassword: Joi.object({
    currentPassword: Joi.string().required(),
    newPassword: password,
    confirmPassword: Joi.string().valid(Joi.ref("newPassword")).required().messages({
      "any.only": "Passwords do not match",
    }),
  }),

  refresh: Joi.object({
    refreshToken: Joi.string().required(),
  }),

  logout: Joi.object({
    logoutFromAllDevices: Joi.boolean().optional().default(false),
  }),

  verifyEmail: Joi.object({
    verificationToken: token,
  }),

  setupMfa: Joi.object({
    // "sms" is intentionally excluded: no SMS provider is integrated (no
    // phone field even exists on the identity user), so accepting it would
    // silently deliver an email instead while claiming SMS was sent.
    method: Joi.string().valid("totp", "email").required(),
  }),

  verifyMfaSetup: Joi.object({
    code: Joi.string().required(),
  }),

  completeMfaLogin: Joi.object({
    mfaToken: Joi.string().required(),
    code: Joi.string().optional(),
    recoveryCode: Joi.string().optional(),
  }).min(1),

  disableMfa: Joi.object({
    password: Joi.string().required(),
    code: Joi.string().optional(),
  }),

  listSessions: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    pageSize: Joi.number().integer().min(1).max(100).default(20),
    status: Joi.string().valid("active", "revoked", "expired", "all").default("active"),
    sort: Joi.string().default("-lastActivityAt"),
  }),

  addTrustedDevice: Joi.object({
    deviceId: Joi.string().trim().min(1).max(255).required(),
    deviceName: Joi.string().trim().max(255).optional().allow(""),
  }),
};

export const userSchemas = {
  createUser: Joi.object({
    firstName: Joi.string().trim().min(1).max(100).optional().allow(""),
    lastName: Joi.string().trim().min(1).max(100).optional().allow(""),
    email: Joi.string().email({ tlds: false }).lowercase().trim().max(255).required(),
    phone: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).optional().allow("").messages({ "string.pattern.base": "Phone must be a valid number (E.164 format, e.g. +923001234567)." }),
    departmentId: Joi.string().trim().min(1).max(100).optional().allow(""),
    roleIds: Joi.array().items(Joi.string()).optional(),
    role: Joi.string().trim().max(100).optional().allow(""),
    designation: Joi.string().trim().max(100).optional().allow(""),
    joiningDate: Joi.date().optional(),
  }),

  updateUser: Joi.object({
    firstName: Joi.string().trim().min(1).max(100).optional(),
    lastName: Joi.string().trim().min(1).max(100).optional(),
    phone: Joi.string().trim().max(50).optional().allow(""),
    designation: Joi.string().trim().max(100).optional().allow(""),
    emergencyContact: Joi.string().trim().max(255).optional().allow(""),
    address: Joi.string().trim().max(500).optional().allow(""),
    preferredLanguage: Joi.string().trim().max(50).optional(),
    profilePicture: Joi.string().trim().max(500).optional().allow(""),
    timezone: Joi.string().trim().max(100).optional(),
    notes: Joi.string().trim().max(2000).optional().allow(""),
  }),

  updateStatus: Joi.object({
    status: Joi.string().trim().min(1).max(50).required(),
    reason: Joi.string().trim().max(500).optional().allow(""),
  }),

  roleAssignment: Joi.object({
    role: Joi.string().trim().max(100).optional(),
    roleIds: Joi.array().items(Joi.string()).optional(),
  }).or("role", "roleIds"),

  departmentAssignment: Joi.object({
    departmentId: Joi.string().trim().min(1).max(100).required(),
  }),

  permissions: Joi.object({
    grant: Joi.array().items(Joi.string()).default([]),
    revoke: Joi.array().items(Joi.string()).default([]),
  }),

  preferences: Joi.object({
    language: Joi.string().trim().max(50).optional(),
    timezone: Joi.string().trim().max(100).optional(),
    theme: Joi.string().trim().max(50).optional(),
    dashboardLayout: Joi.string().trim().max(100).optional(),
    notificationPreferences: Joi.object().optional(),
    dateFormat: Joi.string().trim().max(50).optional(),
    currencyFormat: Joi.string().trim().max(50).optional(),
  }),

  inviteUser: Joi.object({
    email: Joi.string().email({ tlds: false }).lowercase().trim().max(255).required(),
    firstName: Joi.string().trim().min(1).max(100).optional().allow(""),
    lastName: Joi.string().trim().min(1).max(100).optional().allow(""),
    phone: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).optional().allow("").messages({ "string.pattern.base": "Phone must be a valid number (E.164 format, e.g. +923001234567)." }),
    role: Joi.string().trim().max(100).optional().default("User"),
    departmentId: Joi.string().trim().min(1).max(100).optional().allow(""),
    designation: Joi.string().trim().max(100).optional().allow(""),
  }),

  acceptInvitation: Joi.object({
    token: Joi.string().trim().min(1).max(512).required(),
    username: Joi.string().trim().min(2).max(100).required(),
    password: Joi.string().min(6).max(128).required(),
  }),
};

export const roleSchemas = {
  createRole: Joi.object({
    name: Joi.string().trim().min(2).max(100).required(),
    description: Joi.string().trim().max(500).optional().allow(""),
    permissions: Joi.array().items(Joi.string().trim().min(1).max(100)).min(1).required(),
  }),

  updateRole: Joi.object({
    description: Joi.string().trim().max(500).optional().allow(""),
    permissions: Joi.array().items(Joi.string().trim().min(1).max(100)).min(1).optional(),
    status: Joi.string().valid("active", "inactive").optional(),
  }).min(1),
};

const buildBookingSchemas = () => {
  const {
    bookingTypeValues,
    paymentStatusValues,
    visaStatusValues,
    serviceTypeValues,
    serviceCategoryValues,
    serviceWorkflowStatusValues,
    travelerTypeValues,
    currencyValues,
    defaultCurrency,
    defaultPaymentStatus,
    defaultVisaStatus,
    defaultBookingType,
    defaultServiceWorkflowStatus,
    defaultServiceStatus,
    defaultServicePriority,
    hotelMealPlanValues,
    hotelRoomViewValues
  } = getBookingValidationValues();

  // Structured hotel service details (PRD A8) — validated only when
  // serviceType==="hotel" (see serviceItemFields.details below). `nights` is
  // never accepted from the client — utils/hotelServiceDetails.js computes
  // it server-side; overrideNights/overrideNightsReason is the only way to
  // record a deliberate, audited deviation from that computed value.
  const hotelServiceDetailsSchema = Joi.object({
    hotelName: Joi.string().trim().min(1).max(200).required(),
    hotelConfirmationNumber: Joi.string().trim().max(100).optional().allow(""),
    city: Joi.string().trim().max(100).optional().allow(""),
    season: Joi.string().trim().max(100).optional().allow(""),
    roomType: Joi.string().trim().min(1).max(100).required(),
    roomQuantity: Joi.number().integer().min(1).optional(),
    view: Joi.string().trim().lowercase().valid(...hotelRoomViewValues).optional(),
    adultCount: Joi.number().integer().min(1).required(),
    childCount: Joi.number().integer().min(0).optional(),
    infantCount: Joi.number().integer().min(0).optional(),
    mealPlan: Joi.string().trim().lowercase().valid(...hotelMealPlanValues).optional(),
    mealPrice: Joi.number().min(0).optional(),
    checkIn: Joi.date().required(),
    checkOut: Joi.date().required().greater(Joi.ref("checkIn")),
    ratePerNight: Joi.number().min(0).optional(),
    overrideNights: Joi.number().integer().min(1).optional(),
    overrideNightsReason: Joi.string().trim().max(500).when("overrideNights", { is: Joi.exist(), then: Joi.required(), otherwise: Joi.optional() }),
    catalogServiceId: Joi.string().trim().max(100).optional()
  });

  // "Editable Fields" for PATCH /bookings/{id}/travelers/{travelerId}.
  const travelerPreferenceFields = {
    mealPreference: Joi.string().trim().max(100).optional().allow(''),
    wheelchairRequired: Joi.boolean().optional(),
    specialAssistance: Joi.string().trim().max(500).optional().allow(''),
    roomPreference: Joi.string().trim().max(100).optional().allow(''),
    seatPreference: Joi.string().trim().max(100).optional().allow(''),
    medicalNotes: Joi.string().trim().max(1000).optional().allow(''),
    baggageRequirement: Joi.string().trim().max(200).optional().allow(''),
    priority: Joi.string().trim().lowercase().valid('normal', 'high', 'vip').optional()
  };

  const travelerItemSchema = Joi.object({
    customerId: Joi.string().trim().min(1).max(100).required(),
    isPrimaryTraveler: Joi.boolean().optional(),
    isPrimary: Joi.boolean().optional(),
    travelerType: Joi.string().trim().lowercase().valid(...travelerTypeValues).optional(),
    ...travelerPreferenceFields
  });

  // serviceName is optional when a valid serviceId (flight/hotel/room
  // catalog reference) is provided instead — the controller derives the
  // name from the catalog in that case (see AddBookingServices).
  const serviceItemFields = {
    serviceType: Joi.string().trim().lowercase().valid(...serviceTypeValues).required(),
    serviceId: Joi.string().trim().max(100).optional(),
    serviceCategory: Joi.string().trim().lowercase().valid(...serviceCategoryValues).optional().default('other'),
    serviceName: Joi.string().trim().min(1).max(200).optional(),
    supplierId: Joi.string().trim().max(100).optional().allow(""),
    supplierName: Joi.string().trim().max(200).optional().allow(""),
    costPrice: Joi.number().min(0).optional().default(0),
    sellingPrice: Joi.number().min(0).optional().default(0),
    quantity: Joi.number().integer().min(1).optional().default(1),
    currencyId: Joi.string().trim().lowercase().valid(...currencyValues).optional().default(defaultCurrency.toLowerCase()),
    startDate: Joi.date().optional(),
    endDate: Joi.date().optional(),
    remarks: Joi.string().trim().max(4000).optional().allow(""),
    internalNotes: Joi.string().trim().max(4000).optional().allow(""),
    priority: Joi.string().trim().lowercase().valid("normal", "medium", "high", "vip").optional().default(defaultServicePriority),
    workflowStatus: Joi.string().trim().lowercase().valid(...serviceWorkflowStatusValues).optional().default(defaultServiceWorkflowStatus),
    status: Joi.string().trim().lowercase().valid("active", "cancelled", "archived").optional().default(defaultServiceStatus),
    travelerIds: Joi.array().items(Joi.string()).optional(),
    details: Joi.alternatives().conditional("serviceType", {
      is: "hotel",
      then: hotelServiceDetailsSchema.required(),
      otherwise: Joi.object().optional().default({})
    })
  };

  const serviceItemSchema = Joi.object(serviceItemFields).or('serviceName', 'serviceId');

  return {
    createBooking: Joi.object({
      customerId: Joi.string().trim().min(1).max(100).required(),
      bookingType: Joi.string().trim().valid(...bookingTypeValues).default(defaultBookingType),
      packageId: Joi.string().trim().max(100).optional().allow(""),
      travelDate: Joi.date().optional(),
      returnDate: Joi.date().optional(),
      assignedConsultant: Joi.string().trim().max(100).optional().allow(""),
      currencyId: Joi.string().trim().min(1).max(10).optional().default(defaultCurrency),
      remarks: Joi.string().trim().max(4000).optional().allow(""),
      totalAmount: Joi.number().min(0).optional().default(0),
      priority: Joi.string().trim().valid("normal", "medium", "high", "vip").optional(),
      paymentStatus: Joi.string().trim().valid(...paymentStatusValues).optional().default(defaultPaymentStatus),
      visaStatus: Joi.string().trim().valid(...visaStatusValues).optional().default(defaultVisaStatus),
      convertedCurrency: Joi.string().trim().min(1).max(10).optional().allow(null, ""),
    }),

    // Section 31 "Editable Fields" — status/paymentStatus/visaStatus/totalAmount
    // are deliberately excluded: status transitions belong to
    // PATCH /bookings/{id}/workflow (with its approval gating), and
    // totalAmount is derived from real BookingServiceModel line items via
    // recalculateBookingFinancials, never set by hand.
    updateBooking: Joi.object({
      travelDate: Joi.date().optional(),
      returnDate: Joi.date().optional(),
      assignedConsultant: Joi.string().trim().max(100).optional().allow(""),
      assignedTo: Joi.string().trim().max(100).optional().allow(""),
      remarks: Joi.string().trim().max(4000).optional().allow(""),
      priority: Joi.string().trim().valid("normal", "medium", "high", "vip").optional(),
      internalNotes: Joi.string().trim().max(4000).optional().allow(""),
      preferredContactTime: Joi.string().trim().max(100).optional().allow(""),
    }),

    // Accepts either { travelers: [...] } (bulk) or a bare single-traveler
    // body (matches the controller's dual input handling).
    addBookingTravelers: Joi.object({
      travelers: Joi.array().items(travelerItemSchema).min(1).optional(),
      customerId: Joi.string().trim().min(1).max(100).optional(),
      isPrimaryTraveler: Joi.boolean().optional(),
      isPrimary: Joi.boolean().optional(),
      travelerType: Joi.string().trim().lowercase().valid(...travelerTypeValues).optional(),
      ...travelerPreferenceFields
    }).or('travelers', 'customerId'),

    updateBookingTraveler: Joi.object({
      ...travelerPreferenceFields,
      emergencyContact: Joi.object({
        name: Joi.string().trim().max(200).optional().allow(''),
        phone: Joi.string().trim().max(50).optional().allow(''),
        relationship: Joi.string().trim().max(100).optional().allow('')
      }).optional(),
      isPrimary: Joi.boolean().optional(),
      isPrimaryTraveler: Joi.boolean().optional()
    }),

    // Accepts either { services: [...] } (bulk, matches the doc's example
    // request) or a bare single-service body (matches the controller's dual
    // input handling). serviceType is optional at this top level (unlike
    // inside serviceItemSchema) since it's only required when the caller
    // uses the flat single-service form rather than the services[] array.
    addBookingServices: Joi.object({
      services: Joi.array().items(serviceItemSchema).min(1).optional(),
      ...serviceItemFields,
      serviceType: Joi.string().trim().lowercase().valid(...serviceTypeValues).optional()
    }).or('services', 'serviceType'),

    updateBookingService: Joi.object({
      serviceName: Joi.string().trim().min(1).max(200).optional(),
      supplierId: Joi.string().trim().max(100).optional().allow(""),
      supplierName: Joi.string().trim().max(200).optional().allow(""),
      costPrice: Joi.number().min(0).optional(),
      sellingPrice: Joi.number().min(0).optional(),
      quantity: Joi.number().integer().min(1).optional(),
      currencyId: Joi.string().trim().lowercase().valid(...currencyValues).optional(),
      startDate: Joi.date().optional(),
      endDate: Joi.date().optional(),
      remarks: Joi.string().trim().max(4000).optional().allow(""),
      internalNotes: Joi.string().trim().max(4000).optional().allow(""),
      priority: Joi.string().trim().lowercase().valid("normal", "medium", "high", "vip").optional(),
      workflowStatus: Joi.string().trim().lowercase().valid(...serviceWorkflowStatusValues).optional(),
      serviceCategory: Joi.string().trim().lowercase().valid(...serviceCategoryValues).optional(),
      status: Joi.string().trim().lowercase().valid("active", "cancelled", "archived").optional(),
      details: Joi.object().optional()
    }),

    // Accepts either the human-readable action label from the doc's example
    // ("Confirm Booking") or the machine action key ("confirm_booking") —
    // WorkflowEngine.executeWorkflowTransition matches case-insensitively.
    transitionBookingWorkflow: Joi.object({
      action: Joi.string().trim().min(1).max(100).optional(),
      targetState: Joi.string().trim().lowercase().optional(),
      remarks: Joi.string().trim().max(2000).optional().allow(""),
      comments: Joi.string().trim().max(2000).optional().allow("")
    }).or('action', 'targetState'),

    cancelBooking: Joi.object({
      reason: Joi.string().trim().min(1).max(2000).required(),
      category: Joi.string().trim().max(100).optional(),
      remarks: Joi.string().trim().max(2000).optional().allow("")
    }),

    // Client uploads directly to the configured storage backend (or sends a
    // pre-hosted fileUrl) and only registers the resulting pointer here — a
    // raw fileUrl is never required when storageKey is supplied, and the
    // download URL returned to callers is always computed server-side.
    addBookingDocument: Joi.object({
      fileName: Joi.string().trim().min(1).max(255).optional(),
      fileUrl: Joi.string().trim().max(2000).optional().allow(""),
      storageKey: Joi.string().trim().max(500).optional(),
      fileType: Joi.string().trim().max(100).optional(),
      mimeType: Joi.string().trim().max(100).optional(),
      fileSize: Joi.number().integer().min(0).optional(),
      category: Joi.string().trim().valid("Agreement", "Quotation", "Itinerary", "Flight Ticket", "Hotel Voucher", "Insurance Certificate", "Payment Receipt", "Visa Approval", "Other").optional(),
      fileBuffer: Joi.array().items(Joi.number()).optional(),
      fileBase64: Joi.string().optional()
    }).or('fileName', 'fileUrl', 'storageKey'),

    rejectBookingDocument: Joi.object({
      reason: Joi.string().trim().min(1).max(500).required()
    }),

    addBookingNote: Joi.object({
      category: Joi.string().trim().valid("Operations", "Finance", "Customer Service", "Sales", "Visa", "General").optional(),
      visibility: Joi.string().trim().valid("Internal", "External", "Public").optional(),
      content: Joi.string().trim().min(1).max(4000).required(),
      isImportant: Joi.boolean().optional()
    }),

    addBookingTask: Joi.object({
      title: Joi.string().trim().min(1).max(200).required(),
      description: Joi.string().trim().max(2000).optional().allow(""),
      assignedTo: Joi.string().trim().max(100).optional().allow(""),
      assignedToName: Joi.string().trim().max(200).optional().allow(""),
      dueDate: Joi.date().optional(),
      priority: Joi.string().trim().lowercase().valid("low", "normal", "high", "urgent").optional()
    }),

    // action/targetState drive the task's workflowStatus via the generic
    // engine (entityType "Task"); the rest are direct field edits.
    updateBookingTask: Joi.object({
      action: Joi.string().trim().min(1).max(100).optional(),
      targetState: Joi.string().trim().lowercase().optional(),
      comments: Joi.string().trim().max(2000).optional().allow(""),
      assignedTo: Joi.string().trim().max(100).optional().allow(""),
      assignedToName: Joi.string().trim().max(200).optional().allow(""),
      priority: Joi.string().trim().lowercase().valid("low", "normal", "high", "urgent").optional(),
      dueDate: Joi.date().optional(),
      description: Joi.string().trim().max(2000).optional().allow("")
    })
  };
};

const BOOKING_SCHEMA_KEYS = new Set([
  "createBooking", "updateBooking",
  "addBookingTravelers", "updateBookingTraveler",
  "addBookingServices", "updateBookingService",
  "transitionBookingWorkflow", "cancelBooking",
  "addBookingDocument", "rejectBookingDocument",
  "addBookingNote", "addBookingTask", "updateBookingTask"
]);

export const bookingSchemas = new Proxy({}, {
  get(_target, prop) {
    if (BOOKING_SCHEMA_KEYS.has(prop)) {
      return buildBookingSchemas()[prop];
    }
    return undefined;
  }
});

const objectIdRef = Joi.string().trim().pattern(/^[0-9a-fA-F]{24}$/).messages({
  "string.pattern.base": "must be a valid account id"
});

// Finance / Chart of Accounts (Part 2). Rebuilds its .valid(...) lists from
// getFinanceConfig() on every access via the Proxy below, same pattern as
// bookingSchemas — config changes (env-driven category/type/status/currency
// lists) take effect without a schema-caching restart.
const buildAccountSchemas = () => {
  const config = getFinanceConfig();

  // "Posting Restrictions"/"Financial Dimensions"/"Multi-Currency Mapping"/
  // "Tax Mapping" (Part 36) — shared sub-schemas for createAccount/updateAccount.
  const postingRestrictionSchema = Joi.object({
    type: Joi.string().trim().valid(...config.postingRestrictionTypes).required(),
    restrictedCurrencies: Joi.array().items(Joi.string().trim().uppercase().length(3)).optional(),
    restrictedDimensionValues: Joi.object().pattern(Joi.string(), Joi.array().items(Joi.string())).optional()
  });

  const dimensionsSchema = Joi.object({
    required: Joi.array().items(Joi.string().trim().valid(...config.financialDimensionTypes)).optional(),
    allowed: Joi.array().items(Joi.string().trim().valid(...config.financialDimensionTypes)).optional()
  });

  const currencyMappingSchema = Joi.object({
    allowedTransactionCurrencies: Joi.array().items(Joi.string().trim().uppercase().length(3)).optional(),
    reportingCurrency: Joi.string().trim().uppercase().length(3).optional().allow(null, ""),
    revaluationRequired: Joi.boolean().optional(),
    fxGainAccountCode: Joi.string().trim().optional().allow(null, ""),
    fxLossAccountCode: Joi.string().trim().optional().allow(null, "")
  });

  const taxMappingSchema = Joi.object({
    taxCode: Joi.string().trim().optional().allow(null, ""),
    taxType: Joi.string().trim().valid(...config.taxTypes).optional().allow(null, ""),
    jurisdiction: Joi.string().trim().optional().allow(null, ""),
    electronicFilingCode: Joi.string().trim().optional().allow(null, "")
  });

  // "Deferred Revenue" + "Revenue Recognition Rules" (Part 37) — declarative
  // metadata only, same sub-schema pattern as the Part 36 blocks above.
  const revenueRecognitionSchema = Joi.object({
    deferredRevenueType: Joi.string().trim().valid(...config.deferredRevenueAccountTypes).optional().allow(null, ""),
    recognitionRule: Joi.object({
      method: Joi.string().trim().valid(...config.revenueRecognitionMethods).optional().allow(null, ""),
      durationMonths: Joi.number().min(0).optional().allow(null)
    }).optional()
  });

  return {
    createAccount: Joi.object({
      accountCode: Joi.string().trim().min(1).max(50).required(),
      name: Joi.string().trim().min(1).max(200).required(),
      description: Joi.string().trim().max(1000).optional().allow(""),
      aliases: Joi.array().items(Joi.string().trim().max(100)).optional(),
      category: Joi.string().trim().valid(...config.accountCategories).required(),
      type: Joi.string().trim().valid(...config.accountTypes).optional(),
      parentId: objectIdRef.optional().allow(null, ""),
      status: Joi.string().trim().valid(...config.accountStatuses).optional(),
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).optional(),
      allowPosting: Joi.boolean().optional(),
      tags: Joi.array().items(Joi.string().trim().max(50)).optional(),
      postingRestriction: postingRestrictionSchema.optional(),
      dimensions: dimensionsSchema.optional(),
      ownershipType: Joi.string().trim().valid(...config.accountOwnershipTypes).optional(),
      currencyMapping: currencyMappingSchema.optional(),
      taxMapping: taxMappingSchema.optional(),
      budgetControlled: Joi.boolean().optional(),
      revenueRecognition: revenueRecognitionSchema.optional()
    }),

    updateAccount: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      description: Joi.string().trim().max(1000).optional().allow(""),
      aliases: Joi.array().items(Joi.string().trim().max(100)).optional(),
      status: Joi.string().trim().valid(...config.accountStatuses).optional(),
      parentId: objectIdRef.optional().allow(null, ""),
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).optional(),
      allowPosting: Joi.boolean().optional(),
      tags: Joi.array().items(Joi.string().trim().max(50)).optional(),
      postingRestriction: postingRestrictionSchema.optional(),
      dimensions: dimensionsSchema.optional(),
      currencyMapping: currencyMappingSchema.optional(),
      taxMapping: taxMappingSchema.optional(),
      budgetControlled: Joi.boolean().optional(),
      revenueRecognition: revenueRecognitionSchema.optional()
    }).min(1),

    suspendAccount: Joi.object({
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    }),

    mergeAccounts: Joi.object({
      targetAccountId: objectIdRef.required()
    }),

    createTemplate: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      industry: Joi.string().trim().max(100).optional().allow(null, ""),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      accountBlueprints: Joi.array().items(Joi.object({
        accountCode: Joi.string().trim().min(1).max(50).required(),
        name: Joi.string().trim().min(1).max(200).required(),
        description: Joi.string().trim().max(1000).optional().allow(null, ""),
        category: Joi.string().trim().valid(...config.accountCategories).required(),
        type: Joi.string().trim().valid(...config.accountTypes).required(),
        parentAccountCode: Joi.string().trim().optional().allow(null, ""),
        allowPosting: Joi.boolean().optional(),
        tags: Joi.array().items(Joi.string().trim().max(50)).optional()
      })).min(1).required()
    })
  };
};

const ACCOUNT_SCHEMA_KEYS = new Set(["createAccount", "updateAccount", "suspendAccount", "mergeAccounts", "createTemplate"]);

export const accountSchemas = new Proxy({}, {
  get(_target, prop) {
    if (ACCOUNT_SCHEMA_KEYS.has(prop)) {
      return buildAccountSchemas()[prop];
    }
    return undefined;
  }
});

const journalLineSchema = Joi.object({
  // Any one of these three identifies the target account — resolution order
  // (accountId -> accountCode -> name) lives in JournalService, not here.
  accountId: objectIdRef.optional(),
  accountCode: Joi.string().trim().min(1).max(50).optional(),
  account: Joi.string().trim().min(1).max(200).optional(),
  debit: Joi.number().min(0).optional(),
  credit: Joi.number().min(0).optional(),
  description: Joi.string().trim().max(500).optional().allow(""),
  // "Journal Line Dimensions"/"Multi-Currency Storage" (File 2, Journal
  // Platform Part 4, item 41/43) — optional per-line tax code, validated
  // against a real TaxRuleModel row in JournalService, not shaped here
  // beyond "a string."
  taxCode: Joi.string().trim().max(50).optional().allow(null, ""),
  // "Financial Dimensions" (Part 36) — open key/value tags; validated
  // against the target account's own `dimensions.required` in
  // JournalService, not shaped here beyond "an object of strings."
  dimensions: Joi.object().pattern(Joi.string(), Joi.string()).optional()
}).or("accountId", "accountCode", "account").or("debit", "credit");

// General Journal (Part 3). Config-driven journalType/status lists rebuild
// on every access via the Proxy below, same pattern as bookingSchemas/accountSchemas.
const buildJournalSchemas = () => {
  const config = getFinanceConfig();

  return {
    createJournal: Joi.object({
      journalType: Joi.string().trim().valid(...config.journalTypes).optional(),
      postingDate: Joi.date().required(),
      description: Joi.string().trim().max(1000).optional().allow(""),
      referenceNumber: Joi.string().trim().max(100).optional().allow(""),
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).optional(),
      lines: Joi.array().items(journalLineSchema).min(2).required(),
      remarks: Joi.string().trim().max(1000).optional().allow(""),
      attachments: Joi.array().items(Joi.object({
        url: Joi.string().uri().required(),
        filename: Joi.string().trim().max(255).optional(),
        contentType: Joi.string().trim().max(100).optional()
      })).optional(),
      // "Journal Source Types" (File 2, Journal Platform Part 1) — real,
      // optional traceability metadata. sourceModule is restricted to
      // modules that actually generate journals in this codebase.
      sourceModule: Joi.string().trim().valid(...config.journalSourceModules).optional().allow(null, ""),
      sourceEntity: Joi.string().trim().max(100).optional().allow(null, ""),
      sourceId: Joi.string().trim().max(100).optional().allow(null, ""),
      sourceVersion: Joi.number().integer().min(0).optional().allow(null),
      correlationId: Joi.string().trim().max(100).optional().allow(null, "")
    }),

    updateJournal: Joi.object({
      description: Joi.string().trim().max(1000).optional().allow(""),
      postingDate: Joi.date().optional(),
      lines: Joi.array().items(journalLineSchema).min(2).optional(),
      remarks: Joi.string().trim().max(1000).optional().allow(""),
      attachments: Joi.array().items(Joi.object({
        url: Joi.string().uri().required(),
        filename: Joi.string().trim().max(255).optional(),
        contentType: Joi.string().trim().max(100).optional()
      })).optional(),
      // "Version Conflict Check" (File 2, Journal Platform Part 3, item 39)
      // — optional optimistic-concurrency token; omitted entirely, the
      // check is skipped (backward-compatible with every existing caller).
      expectedVersion: Joi.number().integer().min(1).optional()
    }).min(1),

    rejectJournal: Joi.object({
      reason: Joi.string().trim().min(1).max(1000).required()
    }),

    reverseJournal: Joi.object({
      postingDate: Joi.date().optional(),
      description: Joi.string().trim().max(1000).optional().allow(""),
      lines: Joi.array().items(Joi.object({
        lineId: Joi.string().trim().required(),
        amount: Joi.number().greater(0).required()
      })).optional()
    }),

    // File 2, Journal Platform Part 2 (Part 39).
    correctJournal: Joi.object({
      postingDate: Joi.date().optional(),
      description: Joi.string().trim().max(1000).optional().allow(""),
      lines: Joi.array().items(journalLineSchema).min(2).required()
    }),

    createJournalTemplate: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      journalType: Joi.string().trim().valid(...config.journalTypes).optional(),
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).optional().allow(null, ""),
      lineBlueprints: Joi.array().items(Joi.object({
        accountCode: Joi.string().trim().min(1).max(50).required(),
        description: Joi.string().trim().max(500).optional().allow(null, ""),
        debit: Joi.number().min(0).optional(),
        credit: Joi.number().min(0).optional(),
        dimensions: Joi.object().pattern(Joi.string(), Joi.string()).optional()
      })).min(2).required()
    }),

    applyJournalTemplate: Joi.object({
      journalType: Joi.string().trim().valid(...config.journalTypes).optional(),
      postingDate: Joi.date().optional(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      referenceNumber: Joi.string().trim().max(100).optional().allow(null, ""),
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).optional().allow(null, ""),
      sourceModule: Joi.string().trim().valid(...config.journalSourceModules).optional().allow(null, ""),
      correlationId: Joi.string().trim().max(100).optional().allow(null, ""),
      lineOverrides: Joi.array().items(Joi.object({
        description: Joi.string().trim().max(500).optional().allow(null, ""),
        debit: Joi.number().min(0).optional(),
        credit: Joi.number().min(0).optional(),
        dimensions: Joi.object().pattern(Joi.string(), Joi.string()).optional()
      })).optional()
    }),

    createRecurringJournal: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      templateId: Joi.string().trim().required(),
      frequency: Joi.string().trim().valid(...config.recurringJournalFrequencies).required(),
      customIntervalDays: Joi.number().integer().greater(0).optional().allow(null),
      nextRunDate: Joi.date().required(),
      endDate: Joi.date().optional().allow(null)
    }),

    createJournalBatch: Joi.object({
      batchType: Joi.string().trim().valid(...config.journalBatchTypes).required(),
      autoPost: Joi.boolean().optional(),
      journals: Joi.array().items(Joi.object({
        journalType: Joi.string().trim().valid(...config.journalTypes).optional(),
        postingDate: Joi.date().required(),
        description: Joi.string().trim().max(1000).optional().allow(""),
        referenceNumber: Joi.string().trim().max(100).optional().allow(""),
        currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).optional(),
        lines: Joi.array().items(journalLineSchema).min(2).required(),
        sourceModule: Joi.string().trim().valid(...config.journalSourceModules).optional().allow(null, ""),
        correlationId: Joi.string().trim().max(100).optional().allow(null, "")
      })).min(1).required()
    })
  };
};

const JOURNAL_SCHEMA_KEYS = new Set([
  "createJournal", "updateJournal", "rejectJournal", "reverseJournal", "correctJournal",
  "createJournalTemplate", "applyJournalTemplate", "createRecurringJournal", "createJournalBatch"
]);

export const journalSchemas = new Proxy({}, {
  get(_target, prop) {
    if (JOURNAL_SCHEMA_KEYS.has(prop)) {
      return buildJournalSchemas()[prop];
    }
    return undefined;
  }
});

// Accounts Receivable / Payments (Part 5). Config-driven valid-value lists
// rebuild on every access via the Proxy below, same pattern as the other
// Finance schemas.
const buildReceivableSchemas = () => {
  const config = getFinanceConfig();

  return {
    createReceivable: Joi.object({
      customerId: objectIdRef.required(),
      invoiceId: objectIdRef.optional().allow(null, ""),
      invoiceNumber: Joi.string().trim().min(1).max(100).optional(),
      issueDate: Joi.date().optional(),
      dueDate: Joi.date().required(),
      originalAmount: Joi.number().greater(0).required(),
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).required(),
      revenueAccountCode: Joi.string().trim().max(50).optional()
    }),

    allocatePayment: Joi.object({
      paymentId: objectIdRef.required(),
      amount: Joi.number().greater(0).required()
    }),

    writeOffReceivable: Joi.object({
      writeOffType: Joi.string().trim().valid("SmallBalance", "BadDebt").required(),
      reason: Joi.string().trim().max(1000).optional().allow("")
    })
  };
};

const RECEIVABLE_SCHEMA_KEYS = new Set(["createReceivable", "allocatePayment", "writeOffReceivable"]);

export const receivableSchemas = new Proxy({}, {
  get(_target, prop) {
    if (RECEIVABLE_SCHEMA_KEYS.has(prop)) {
      return buildReceivableSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Payment Engine (Part 7). Config-driven valid-value lists
// rebuild on every access via the Proxy below, same pattern as the other
// Finance schemas. `partyType`/`partyId` are optional — a payment is an
// independent transaction per the spec's own request example, which has no
// party reference at all.
const buildPaymentSchemas = () => {
  const config = getFinanceConfig();

  return {
    createPayment: Joi.object({
      paymentType: Joi.string().trim().valid(...config.paymentTypes).optional(),
      partyType: Joi.string().trim().valid("customer", "vendor").optional(),
      partyId: objectIdRef.optional(),
      amount: Joi.number().greater(0).required(),
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).required(),
      paymentMethod: Joi.string().trim().valid(...config.paymentMethods).required(),
      gateway: Joi.string().trim().valid(...config.gateways).optional(),
      gatewayPaymentMethodId: Joi.string().trim().max(255).optional(),
      reference: Joi.string().trim().max(200).optional().allow(""),
      transactionDate: Joi.date().optional()
    }),

    allocate: Joi.object({
      targetType: Joi.string().trim().valid(...config.allocationTargetTypes).required(),
      targetId: objectIdRef.required(),
      amount: Joi.number().greater(0).required()
    }),

    void: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    refund: Joi.object({
      amount: Joi.number().greater(0).required(),
      reason: Joi.string().trim().max(1000).optional().allow("")
    })
  };
};

const PAYMENT_SCHEMA_KEYS = new Set(["createPayment", "allocate", "void", "refund"]);

export const paymentSchemas = new Proxy({}, {
  get(_target, prop) {
    if (PAYMENT_SCHEMA_KEYS.has(prop)) {
      return buildPaymentSchemas()[prop];
    }
    return undefined;
  }
});

// Per-Tenant Payment Gateway Integration (Stripe Connect). Deliberately a
// SEPARATE export from `paymentSchemas` directly above — that one is
// Finance's own Accounts Receivable payment-recording module; this one
// validates the new agency-connects-their-own-Stripe-account routes.
// Reusing the `paymentSchemas` name would silently collide with an
// already-live export.
const PAYMENT_GATEWAY_SCHEMA_KEYS = new Set(["disconnectGateway", "createCheckout"]);

const buildPaymentGatewaySchemas = () => ({
  disconnectGateway: Joi.object({
    provider: Joi.string().trim().valid("stripe", "hyperpay", "paypal").default("stripe")
  }),
  createCheckout: Joi.object({
    bookingId: objectIdRef.required()
  })
});

export const paymentGatewaySchemas = new Proxy({}, {
  get(_target, prop) {
    if (PAYMENT_GATEWAY_SCHEMA_KEYS.has(prop)) {
      return buildPaymentGatewaySchemas()[prop];
    }
    return undefined;
  }
});

// Accounts Payable / Vendors / Vendor Payments (Part 6). Config-driven
// valid-value lists rebuild on every access via the Proxy below, same
// pattern as the other Finance schemas.
const buildPayableSchemas = () => {
  const config = getFinanceConfig();

  return {
    createPayable: Joi.object({
      vendorId: objectIdRef.required(),
      invoiceNumber: Joi.string().trim().min(1).max(100).optional(),
      invoiceDate: Joi.date().optional(),
      dueDate: Joi.date().required(),
      originalAmount: Joi.number().greater(0).required(),
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).required(),
      expenseAccountCode: Joi.string().trim().max(50).optional()
    }),

    allocatePayment: Joi.object({
      paymentId: objectIdRef.required(),
      amount: Joi.number().greater(0).required()
    }),

    writeOffPayable: Joi.object({
      writeOffType: Joi.string().trim().valid("SmallBalance", "VendorWaiver", "AccountingAdjustment").required(),
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    schedulePayment: Joi.object({
      scheduledDate: Joi.date().required(),
      priority: Joi.string().trim().valid(...config.paymentPriorities).required()
    })
  };
};

const PAYABLE_SCHEMA_KEYS = new Set(["createPayable", "allocatePayment", "writeOffPayable", "schedulePayment"]);

export const payableSchemas = new Proxy({}, {
  get(_target, prop) {
    if (PAYABLE_SCHEMA_KEYS.has(prop)) {
      return buildPayableSchemas()[prop];
    }
    return undefined;
  }
});

const buildVendorSchemas = () => {
  const config = getFinanceConfig();

  // Visa Module PRD §11 "Vendor details" — populated only for vendors that
  // actually handle visa submissions (see VendorModel.visaVendorProfile's
  // own doc comment); every field optional here too.
  const visaVendorProfileSchema = Joi.object({
    country: Joi.string().trim().max(100).optional().allow(null, ""),
    processingTime: Joi.number().integer().min(0).optional().allow(null),
    defaultCost: Joi.number().min(0).optional().allow(null),
    currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).optional().allow(null)
  }).optional();

  return {
    createVendor: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      contactEmail: Joi.string().trim().email({ tlds: false }).optional().allow(""),
      contactPhone: Joi.string().trim().max(50).optional().allow(""),
      contactPerson: Joi.string().trim().max(200).optional().allow(""),
      whatsapp: Joi.string().trim().max(50).optional().allow(""),
      visaVendorProfile: visaVendorProfileSchema,
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).required(),
      paymentTermsDays: Joi.number().integer().min(0).optional()
    }),

    updateVendor: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      contactEmail: Joi.string().trim().email({ tlds: false }).optional().allow(""),
      contactPhone: Joi.string().trim().max(50).optional().allow(""),
      contactPerson: Joi.string().trim().max(200).optional().allow(""),
      whatsapp: Joi.string().trim().max(50).optional().allow(""),
      visaVendorProfile: visaVendorProfileSchema,
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).optional(),
      paymentTermsDays: Joi.number().integer().min(0).optional(),
      status: Joi.string().trim().valid("Active", "Inactive").optional()
    })
  };
};

const VENDOR_SCHEMA_KEYS = new Set(["createVendor", "updateVendor"]);

export const vendorSchemas = new Proxy({}, {
  get(_target, prop) {
    if (VENDOR_SCHEMA_KEYS.has(prop)) {
      return buildVendorSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Receipts (Part 8). Config-driven valid-value lists rebuild on
// every access via the Proxy below, same pattern as the other Finance
// schemas.
const buildReceiptSchemas = () => {
  const config = getFinanceConfig();

  const deliveryMethodsSchema = Joi.array().items(Joi.string().trim().valid(...config.deliveryMethods)).optional();

  return {
    createReceipt: Joi.object({
      paymentId: objectIdRef.required(),
      template: Joi.string().trim().valid(...config.receiptTemplates).optional(),
      partyType: Joi.string().trim().valid("customer", "vendor").optional(),
      partyId: objectIdRef.optional(),
      deliveryMethods: deliveryMethodsSchema,
      webhookUrl: Joi.string().uri().optional()
    }),

    reissue: Joi.object({
      deliveryMethods: deliveryMethodsSchema,
      webhookUrl: Joi.string().uri().optional()
    }),

    cancel: Joi.object({
      reason: Joi.string().trim().min(1).max(1000).required()
    }),

    redeliver: Joi.object({
      deliveryMethods: Joi.array().items(Joi.string().trim().valid(...config.deliveryMethods)).min(1).required(),
      webhookUrl: Joi.string().uri().optional()
    })
  };
};

const RECEIPT_SCHEMA_KEYS = new Set(["createReceipt", "reissue", "cancel", "redeliver"]);

export const receiptSchemas = new Proxy({}, {
  get(_target, prop) {
    if (RECEIPT_SCHEMA_KEYS.has(prop)) {
      return buildReceiptSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Invoices (Part 9). Config-driven valid-value lists rebuild on
// every access via the Proxy below, same pattern as the other Finance
// schemas.
const buildInvoiceSchemas = () => {
  const config = getFinanceConfig();

  const lineItemSchema = Joi.object({
    description: Joi.string().trim().min(1).max(500).required(),
    quantity: Joi.number().greater(0).required(),
    // Real, versioned taxCodes now come from Part 20's own TaxRuleModel
    // (e.g. "VAT15"), not just the static config.taxCodes fallback list —
    // restricting to that list here would reject a real, dynamically
    // created tax rule's own code. Format-validated only; TaxService
    // itself is the real source of truth for whether a code resolves.
    taxCode: Joi.string().trim().uppercase().max(20).optional().allow(null, ""),
    // Finance Module Part 21 — an optional catalog SKU. When supplied,
    // InvoiceService resolves unitPrice/discount via the real
    // PricingService instead of requiring the caller to supply them
    // directly.
    productCode: Joi.string().trim().uppercase().max(64).optional().allow(null, ""),
    // Required unless `productCode` is supplied (PricingService then
    // resolves it) — enforced by the schema-level `.or(...)` below rather
    // than a `.when()`, since either field alone is sufficient.
    unitPrice: Joi.number().min(0).optional(),
    discountType: Joi.string().trim().valid("Percentage", "Flat").optional(),
    discountValue: Joi.number().min(0).optional()
  }).or("unitPrice", "productCode");

  const attachmentSchema = Joi.object({
    url: Joi.string().uri().required(),
    filename: Joi.string().trim().max(255).optional(),
    contentType: Joi.string().trim().max(100).optional()
  });

  return {
    createInvoice: Joi.object({
      customerId: objectIdRef.required(),
      invoiceType: Joi.string().trim().valid(...config.invoiceTypes).optional(),
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).required(),
      issueDate: Joi.date().optional(),
      dueDate: Joi.date().required(),
      items: Joi.array().items(lineItemSchema).min(1).required(),
      notes: Joi.string().trim().max(2000).optional().allow(""),
      attachments: Joi.array().items(attachmentSchema).optional()
    }),

    updateInvoice: Joi.object({
      items: Joi.array().items(lineItemSchema).min(1).optional(),
      dueDate: Joi.date().optional(),
      notes: Joi.string().trim().max(2000).optional().allow(""),
      attachments: Joi.array().items(attachmentSchema).optional(),
      reason: Joi.string().trim().max(1000).optional().allow("")
    }).min(1),

    cancel: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    void: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    })
  };
};

const INVOICE_SCHEMA_KEYS = new Set(["createInvoice", "updateInvoice", "cancel", "void"]);

export const invoiceSchemas = new Proxy({}, {
  get(_target, prop) {
    if (INVOICE_SCHEMA_KEYS.has(prop)) {
      return buildInvoiceSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Credit Notes (Part 10). Same config-driven Proxy pattern as
// every other Finance schema group.
const buildCreditNoteSchemas = () => {
  const config = getFinanceConfig();

  const creditLineItemSchema = Joi.object({
    invoiceLineId: objectIdRef.required(),
    quantity: Joi.number().greater(0).required(),
    amount: Joi.number().greater(0).required()
  });

  return {
    createCreditNote: Joi.object({
      invoiceId: objectIdRef.required(),
      reason: Joi.string().trim().valid(...config.creditNoteReasons).required(),
      reasonDetail: Joi.string().trim().max(1000).optional().allow(""),
      items: Joi.array().items(creditLineItemSchema).min(1).required(),
      disposition: Joi.string().trim().valid("CustomerCredit", "Refund").optional()
    }),

    cancel: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    void: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    })
  };
};

const CREDIT_NOTE_SCHEMA_KEYS = new Set(["createCreditNote", "cancel", "void"]);

export const creditNoteSchemas = new Proxy({}, {
  get(_target, prop) {
    if (CREDIT_NOTE_SCHEMA_KEYS.has(prop)) {
      return buildCreditNoteSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Debit Notes (Part 11). Same config-driven Proxy pattern as
// Credit Note above — party-aware via Joi .when(): invoiceId is required
// only for partyType "Customer", payableId only for "Vendor" (see
// DebitNoteModel.js doc comment on why this codebase can't use a single
// generic invoiceId field the way the spec does).
const buildDebitNoteSchemas = () => {
  const config = getFinanceConfig();

  const debitLineItemSchema = Joi.object({
    description: Joi.string().trim().min(1).max(500).required(),
    amount: Joi.number().greater(0).required(),
    taxCode: Joi.string().trim().optional().allow(null, "")
  });

  return {
    createDebitNote: Joi.object({
      partyType: Joi.string().trim().valid("Customer", "Vendor").required(),
      invoiceId: objectIdRef.when("partyType", { is: "Customer", then: Joi.required(), otherwise: Joi.forbidden() }),
      payableId: objectIdRef.when("partyType", { is: "Vendor", then: Joi.required(), otherwise: Joi.forbidden() }),
      reason: Joi.string().trim().valid(...config.debitNoteReasons).required(),
      reasonDetail: Joi.string().trim().max(1000).optional().allow(""),
      items: Joi.array().items(debitLineItemSchema).min(1).required(),
      glAccountCode: Joi.string().trim().max(100).optional().allow(null, "")
    }),

    cancel: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    void: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    })
  };
};

const DEBIT_NOTE_SCHEMA_KEYS = new Set(["createDebitNote", "cancel", "void"]);

export const debitNoteSchemas = new Proxy({}, {
  get(_target, prop) {
    if (DEBIT_NOTE_SCHEMA_KEYS.has(prop)) {
      return buildDebitNoteSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Refund Management (Part 12). Same config-driven Proxy pattern
// as Credit/Debit Note above. `paymentId`/`creditNoteId` are NOT mutually
// exclusive at the schema level (a refund can legitimately carry both — the
// "Credit Note + Refund" common case still benefits from a paymentId when
// the caller knows exactly which original payment to refund via the
// gateway) — RefundService itself enforces "at least one of the two" and
// "paymentId required when refundMethod is Original Gateway".
const buildRefundSchemas = () => {
  const config = getFinanceConfig();

  return {
    createRefund: Joi.object({
      paymentId: objectIdRef.optional(),
      creditNoteId: objectIdRef.optional(),
      refundAmount: Joi.number().greater(0).optional(),
      reason: Joi.string().trim().min(1).max(500).required(),
      refundMethod: Joi.string().trim().valid(...config.refundMethods).optional()
    }).or("paymentId", "creditNoteId"),

    reject: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    cancel: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    })
  };
};

const REFUND_SCHEMA_KEYS = new Set(["createRefund", "reject", "cancel"]);

export const refundSchemas = new Proxy({}, {
  get(_target, prop) {
    if (REFUND_SCHEMA_KEYS.has(prop)) {
      return buildRefundSchemas()[prop];
    }
    return undefined;
  }
});

// Chargebacks (Part 12) — grouped under Refund Management, see
// utils/financeConfig.js chargebackStatuses doc comment for why this is its
// own small resource rather than a Refund status value.
export const chargebackSchemas = {
  createChargeback: Joi.object({
    paymentId: objectIdRef.required(),
    amount: Joi.number().greater(0).required(),
    reason: Joi.string().trim().min(1).max(500).required(),
    gatewayDisputeId: Joi.string().trim().max(200).optional().allow(null, ""),
    refundId: objectIdRef.optional()
  }),

  submitEvidence: Joi.object({
    evidenceUrls: Joi.array().items(Joi.string().trim().uri()).min(1).required()
  }),

  resolve: Joi.object({
    decision: Joi.string().trim().valid("Won", "Lost").required()
  })
};

// Enterprise Bank Accounts (Part 13). Same config-driven Proxy pattern as
// every other Finance schema group. No `branchId` field anywhere — see
// utils/financeConfig.js's own doc comment on why the spec's "Branch Bank
// Accounts"/"Branch Match" language was dropped.
const authorizedUserSchema = Joi.object({
  userId: Joi.string().trim().required(),
  role: Joi.string().trim().max(100).optional().allow(null, "")
});

const buildBankAccountSchemas = () => {
  const config = getFinanceConfig();

  return {
    createBankAccount: Joi.object({
      bankName: Joi.string().trim().min(1).max(200).required(),
      accountName: Joi.string().trim().min(1).max(200).required(),
      accountNumber: Joi.string().trim().min(4).max(64).required(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).required(),
      accountType: Joi.string().trim().valid(...config.bankAccountTypes).required(),
      iban: Joi.string().trim().max(64).optional().allow(null, ""),
      swiftCode: Joi.string().trim().max(20).optional().allow(null, ""),
      glAccountCode: Joi.string().trim().optional().allow(null, ""),
      linkedGateways: Joi.array().items(Joi.string().trim()).optional(),
      authorizedUsers: Joi.array().items(authorizedUserSchema).optional()
    }),

    updateBankAccount: Joi.object({
      bankName: Joi.string().trim().min(1).max(200).optional(),
      accountName: Joi.string().trim().min(1).max(200).optional(),
      glAccountCode: Joi.string().trim().optional().allow(null, ""),
      linkedGateways: Joi.array().items(Joi.string().trim()).optional(),
      authorizedUsers: Joi.array().items(authorizedUserSchema).optional()
    }),

    freeze: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    suspend: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    close: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    adjustBalance: Joi.object({
      direction: Joi.string().trim().valid("Credit", "Debit").required(),
      amount: Joi.number().greater(0).required(),
      reason: Joi.string().trim().min(1).max(500).required()
    }),

    hold: Joi.object({
      amount: Joi.number().greater(0).required(),
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    }),

    releaseHold: Joi.object({
      amount: Joi.number().greater(0).required(),
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    }),

    createVirtualAccount: Joi.object({
      accountName: Joi.string().trim().min(1).max(200).required(),
      accountNumber: Joi.string().trim().min(4).max(64).required()
    }),

    linkSettlementAccount: Joi.object({
      settlementAccountId: objectIdRef.required()
    })
  };
};

const BANK_ACCOUNT_SCHEMA_KEYS = new Set(["createBankAccount", "updateBankAccount", "freeze", "suspend", "close", "adjustBalance", "hold", "releaseHold", "createVirtualAccount", "linkSettlementAccount"]);

export const bankAccountSchemas = new Proxy({}, {
  get(_target, prop) {
    if (BANK_ACCOUNT_SCHEMA_KEYS.has(prop)) {
      return buildBankAccountSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Bank Reconciliation (Part 14). Same config-driven Proxy
// pattern as every other Finance schema group. `importStatement` validates
// the multipart text fields only — the file itself is handled by multer
// (controllers/BankReconciliationController.js's uploadStatementFile) and
// the real format parsers (services/reconciliationParsers/), not Joi.
const buildBankReconciliationSchemas = () => {
  const config = getFinanceConfig();

  return {
    importStatement: Joi.object({
      bankAccountId: objectIdRef.required(),
      format: Joi.string().trim().valid(...config.reconciliationImportFormats).required(),
      // Only required for formats with no native statement header (CSV,
      // Excel, Custom can still override); MT940/CAMT.053/OFX supply these
      // from the file itself — BankReconciliationService.importStatement
      // only falls back to these when the parser didn't provide them.
      statementDate: Joi.date().optional(),
      openingBalance: Joi.number().optional(),
      closingBalance: Joi.number().optional(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).optional()
    }),

    matchTransaction: Joi.object({
      statementTransactionId: objectIdRef.required(),
      erpTransactionId: objectIdRef.required()
    }),

    unmatchTransaction: Joi.object({
      statementTransactionId: objectIdRef.required()
    }),

    resolveException: Joi.object({
      resolutionAction: Joi.string().trim().valid("AdjustmentCreated", "MarkedDuplicate", "ManuallyMatched", "Ignored", "Other").required(),
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    createAdjustment: Joi.object({
      direction: Joi.string().trim().valid("Credit", "Debit").required(),
      amount: Joi.number().greater(0).required(),
      adjustmentType: Joi.string().trim().valid("BankCharge", "InterestIncome", "FxGainLoss", "Correction").required(),
      reason: Joi.string().trim().min(1).max(500).required(),
      exceptionId: objectIdRef.optional()
    }),

    reject: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    })
  };
};

const BANK_RECONCILIATION_SCHEMA_KEYS = new Set(["importStatement", "matchTransaction", "unmatchTransaction", "resolveException", "createAdjustment", "reject"]);

export const bankReconciliationSchemas = new Proxy({}, {
  get(_target, prop) {
    if (BANK_RECONCILIATION_SCHEMA_KEYS.has(prop)) {
      return buildBankReconciliationSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Cash Management (Part 15). Same config-driven Proxy pattern
// as every other Finance schema group. No `branchId` field anywhere — see
// utils/financeConfig.js's own doc comment on why the spec's "Branch
// Vaults"/"Validate Branch" language was dropped.
const buildCashManagementSchemas = () => {
  const config = getFinanceConfig();

  return {
    createCashLocation: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      type: Joi.string().trim().valid(...config.cashLocationTypes).required(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).required(),
      glAccountCode: Joi.string().trim().optional().allow(null, ""),
      responsibleEmployeeId: objectIdRef.optional().allow(null, ""),
      dualAuthorizationRequired: Joi.boolean().optional(),
      targetFloatAmount: Joi.number().min(0).optional().allow(null)
    }),

    updateCashLocation: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      glAccountCode: Joi.string().trim().optional().allow(null, ""),
      responsibleEmployeeId: objectIdRef.optional().allow(null, ""),
      dualAuthorizationRequired: Joi.boolean().optional(),
      targetFloatAmount: Joi.number().min(0).optional().allow(null)
    }),

    close: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    createCashTransfer: Joi.object({
      fromLocationId: objectIdRef.required(),
      toLocationId: objectIdRef.required(),
      amount: Joi.number().greater(0).required(),
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    }),

    reject: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    cancel: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    createCashCount: Joi.object({
      actualBalance: Joi.number().min(0).required(),
      countType: Joi.string().trim().valid(...config.cashCountTypes).required(),
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    resolveVariance: Joi.object({
      notes: Joi.string().trim().min(1).max(1000).required()
    }),

    issuePettyCashAdvance: Joi.object({
      issuedTo: objectIdRef.required(),
      amount: Joi.number().greater(0).required(),
      purpose: Joi.string().trim().min(1).max(500).required()
    }),

    settlePettyCashAdvance: Joi.object({
      spentAmount: Joi.number().min(0).optional(),
      returnedAmount: Joi.number().min(0).optional(),
      description: Joi.string().trim().max(500).optional().allow(null, "")
    }),

    replenishPettyCash: Joi.object({
      amount: Joi.number().greater(0).required(),
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    })
  };
};

const CASH_MANAGEMENT_SCHEMA_KEYS = new Set(["createCashLocation", "updateCashLocation", "close", "createCashTransfer", "reject", "cancel", "createCashCount", "resolveVariance", "issuePettyCashAdvance", "settlePettyCashAdvance", "replenishPettyCash"]);

export const cashManagementSchemas = new Proxy({}, {
  get(_target, prop) {
    if (CASH_MANAGEMENT_SCHEMA_KEYS.has(prop)) {
      return buildCashManagementSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Expense Management (Part 16). Same config-driven Proxy
// pattern as every other Finance schema group. No `branchId` field
// anywhere — see utils/financeConfig.js's own doc comment.
const buildExpenseSchemas = () => {
  const config = getFinanceConfig();

  const perDiemSchema = Joi.object({
    applicable: Joi.boolean().required(),
    country: Joi.string().trim().optional(),
    days: Joi.number().greater(0).optional()
  });

  const mileageSchema = Joi.object({
    applicable: Joi.boolean().required(),
    distance: Joi.number().greater(0).optional(),
    vehicleType: Joi.string().trim().optional()
  });

  const corporateCardSchema = Joi.object({
    cardType: Joi.string().trim().optional(),
    last4: Joi.string().trim().max(4).optional(),
    cardholderName: Joi.string().trim().optional()
  });

  return {
    createExpense: Joi.object({
      employeeId: objectIdRef.required(),
      department: objectIdRef.optional().allow(null, ""),
      projectId: Joi.string().trim().optional().allow(null, ""),
      costCenter: Joi.string().trim().optional().allow(null, ""),
      // "Profit Centre filtering" (Part 3/4) — same plain descriptive-
      // string treatment as costCenter (no ProfitCenterModel exists).
      profitCenter: Joi.string().trim().optional().allow(null, ""),
      // Purely descriptive organizational labels — never used for tenant/
      // access scoping. See Part 34's own reconciliation of the "Business
      // Unit"/"Branch" hierarchy onto this codebase's real architecture.
      businessUnit: Joi.string().trim().max(200).optional().allow(null, ""),
      branch: Joi.string().trim().max(200).optional().allow(null, ""),
      tags: Joi.array().items(Joi.string().trim().max(50)).max(20).optional(),
      // "Expense Allocation Engine" (Part 35) — optional multi-target
      // split; validated for 100%-total reconciliation in
      // ExpenseService.validateAllocations, not here (Joi only shapes the
      // structure).
      allocations: Joi.array().items(Joi.object({
        department: objectIdRef.optional().allow(null, ""),
        costCenter: Joi.string().trim().optional().allow(null, ""),
        projectId: Joi.string().trim().optional().allow(null, ""),
        businessUnit: Joi.string().trim().optional().allow(null, ""),
        branch: Joi.string().trim().optional().allow(null, ""),
        percentage: Joi.number().greater(0).max(100).required()
      })).optional(),
      category: Joi.string().trim().valid(...config.expenseCategories).required(),
      // "Configurable Expense Category Hierarchy... Level 1" (Part 44) —
      // optional; validated against `category` (Level 2) in the service
      // layer, not here (Joi only shapes valid Level-1 keys).
      categoryGroup: Joi.string().trim().valid(...Object.keys(config.expenseCategoryHierarchy)).optional().allow(null, ""),
      expenseType: Joi.string().trim().valid(...config.expenseTypes).optional(),
      amount: Joi.number().greater(0).optional(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).required(),
      // ISO country code — the Tax Engine's jurisdiction; optional (see
      // ExpenseModel.js's own doc comment) alongside `taxCode`.
      country: Joi.string().trim().length(2).uppercase().optional().allow(null, ""),
      taxCode: Joi.string().trim().optional().allow(null, ""),
      expenseDate: Joi.date().required(),
      description: Joi.string().trim().min(1).max(1000).required(),
      paymentMethod: Joi.string().trim().valid(...config.expensePaymentMethods).optional(),
      corporateCard: corporateCardSchema.optional(),
      perDiem: perDiemSchema.optional(),
      mileage: mileageSchema.optional()
    }),

    updateExpense: Joi.object({
      category: Joi.string().trim().valid(...config.expenseCategories).optional(),
      categoryGroup: Joi.string().trim().valid(...Object.keys(config.expenseCategoryHierarchy)).optional().allow(null, ""),
      expenseType: Joi.string().trim().valid(...config.expenseTypes).optional(),
      amount: Joi.number().greater(0).optional(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).optional(),
      description: Joi.string().trim().min(1).max(1000).optional(),
      expenseDate: Joi.date().optional(),
      department: objectIdRef.optional().allow(null, ""),
      projectId: Joi.string().trim().optional().allow(null, ""),
      costCenter: Joi.string().trim().optional().allow(null, ""),
      profitCenter: Joi.string().trim().optional().allow(null, ""),
      businessUnit: Joi.string().trim().max(200).optional().allow(null, ""),
      branch: Joi.string().trim().max(200).optional().allow(null, ""),
      tags: Joi.array().items(Joi.string().trim().max(50)).max(20).optional(),
      allocations: Joi.array().items(Joi.object({
        department: objectIdRef.optional().allow(null, ""),
        costCenter: Joi.string().trim().optional().allow(null, ""),
        projectId: Joi.string().trim().optional().allow(null, ""),
        businessUnit: Joi.string().trim().optional().allow(null, ""),
        branch: Joi.string().trim().optional().allow(null, ""),
        percentage: Joi.number().greater(0).max(100).required()
      })).optional(),
      country: Joi.string().trim().length(2).uppercase().optional().allow(null, ""),
      taxCode: Joi.string().trim().optional().allow(null, ""),
      paymentMethod: Joi.string().trim().valid(...config.expensePaymentMethods).optional().allow(null, "")
    }),

    verifyReceipt: Joi.object({
      status: Joi.string().trim().valid("Verified", "Duplicate", "Rejected").required(),
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    // "OCR Information... Manual Corrections" (Part 4/4).
    correctOcr: Joi.object({
      amount: Joi.number().greater(0).optional().allow(null),
      vendor: Joi.string().trim().max(200).optional().allow(null, ""),
      date: Joi.date().optional().allow(null),
      receiptNumber: Joi.string().trim().max(50).optional().allow(null, ""),
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    approve: Joi.object({
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    reject: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    returnExpense: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    cancel: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    reimburse: Joi.object({
      method: Joi.string().trim().valid(...config.reimbursementMethods).required(),
      bankAccountId: objectIdRef.optional(),
      cashLocationId: objectIdRef.optional(),
      vendorId: objectIdRef.optional()
    }),

    createBudget: Joi.object({
      scope: Joi.string().trim().valid("Department", "Project", "CostCenter").required(),
      scopeRef: Joi.string().trim().required(),
      period: Joi.string().trim().pattern(/^\d{4}(-\d{2})?$/).required().messages({ "string.pattern.base": 'period must be "YYYY" or "YYYY-MM".' }),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).required(),
      allocatedAmount: Joi.number().min(0).required()
    }),

    // ---- Bulk Operations (Enterprise Expense Management Refactor Part 3/4) ----
    // `expenseIds` cap mirrors `expenseBulkActionMaxItems`; the service
    // layer re-checks the same bound (Joi only shapes the request shape).
    bulkIds: Joi.object({
      expenseIds: Joi.array().items(objectIdRef).min(1).max(config.expenseBulkActionMaxItems).required()
    }),

    bulkApprove: Joi.object({
      expenseIds: Joi.array().items(objectIdRef).min(1).max(config.expenseBulkActionMaxItems).required(),
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    bulkReject: Joi.object({
      expenseIds: Joi.array().items(objectIdRef).min(1).max(config.expenseBulkActionMaxItems).required(),
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    bulkTag: Joi.object({
      expenseIds: Joi.array().items(objectIdRef).min(1).max(config.expenseBulkActionMaxItems).required(),
      tags: Joi.array().items(Joi.string().trim().max(50)).min(1).max(20).required()
    }),

    bulkComment: Joi.object({
      expenseIds: Joi.array().items(objectIdRef).min(1).max(config.expenseBulkActionMaxItems).required(),
      text: Joi.string().trim().min(1).max(1000).required()
    }),

    bulkAssignReviewer: Joi.object({
      expenseIds: Joi.array().items(objectIdRef).min(1).max(config.expenseBulkActionMaxItems).required(),
      reviewerId: objectIdRef.required(),
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    })
  };
};

const EXPENSE_SCHEMA_KEYS = new Set(["createExpense", "updateExpense", "verifyReceipt", "correctOcr", "approve", "reject", "returnExpense", "cancel", "reimburse", "createBudget", "bulkIds", "bulkApprove", "bulkReject", "bulkTag", "bulkComment", "bulkAssignReviewer"]);

export const expenseSchemas = new Proxy({}, {
  get(_target, prop) {
    if (EXPENSE_SCHEMA_KEYS.has(prop)) {
      return buildExpenseSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Vendor Payments (Part 17). Same config-driven Proxy pattern
// as every other Finance schema group. No `branchId` field anywhere — see
// utils/financeConfig.js's own doc comment.
const buildVendorPaymentSchemas = () => {
  const config = getFinanceConfig();

  return {
    addVendorBankAccount: Joi.object({
      accountName: Joi.string().trim().min(1).max(200).required(),
      bankName: Joi.string().trim().min(1).max(200).required(),
      country: Joi.string().trim().min(1).max(100).required(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).required(),
      iban: Joi.string().trim().optional().allow(null, ""),
      swiftBic: Joi.string().trim().optional().allow(null, ""),
      accountNumber: Joi.string().trim().optional().allow(null, ""),
      isPrimary: Joi.boolean().optional()
    }),

    createProposal: Joi.object({
      vendorId: objectIdRef.required(),
      invoiceIds: Joi.array().items(objectIdRef).min(1).required(),
      amounts: Joi.object().pattern(Joi.string(), Joi.number().greater(0)).optional(),
      paymentDate: Joi.date().required(),
      bankAccountId: objectIdRef.required(),
      vendorBankAccountId: objectIdRef.optional().allow(null, ""),
      priority: Joi.string().trim().optional().allow(null, ""),
      // "Payment Classification" (File 6 Part 2) — all optional; the
      // pre-Part-2 request shape (vendorId/invoiceIds/paymentDate/
      // bankAccountId only) keeps working unchanged.
      paymentType: Joi.string().trim().valid(...config.paymentMethods).optional().allow(null, ""),
      department: objectIdRef.optional().allow(null, ""),
      costCenter: Joi.string().trim().optional().allow(null, ""),
      projectId: Joi.string().trim().optional().allow(null, ""),
      source: Joi.string().trim().valid(...config.vendorPaymentSources).optional().allow(null, "")
    }),

    reject: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    cancel: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    hold: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    generateFile: Joi.object({
      vendorPaymentIds: Joi.array().items(objectIdRef).min(1).required(),
      format: Joi.string().trim().valid(...config.paymentFileFormats).required()
    }),

    createBatch: Joi.object({
      batchType: Joi.string().trim().valid(...config.paymentBatchTypes).required(),
      scheduledDate: Joi.date().required(),
      vendorPaymentIds: Joi.array().items(objectIdRef).min(1).required()
    }),

    createAdvance: Joi.object({
      vendorId: objectIdRef.required(),
      bankAccountId: objectIdRef.required(),
      amount: Joi.number().greater(0).required(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).required(),
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    })
  };
};

const VENDOR_PAYMENT_SCHEMA_KEYS = new Set(["addVendorBankAccount", "createProposal", "reject", "cancel", "hold", "generateFile", "createBatch", "createAdvance"]);

export const vendorPaymentSchemas = new Proxy({}, {
  get(_target, prop) {
    if (VENDOR_PAYMENT_SCHEMA_KEYS.has(prop)) {
      return buildVendorPaymentSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Customer Payments (Part 18). Same config-driven Proxy pattern
// as every other Finance schema group. No `branchId`/`branch` field
// anywhere — the spec's own "Branch Match"/"Branch Isolation"/`branch`
// query param are dropped per the standing master instructions.
const buildCustomerCollectionSchemas = () => {
  const config = getFinanceConfig();

  return {
    // Part 18 Part 2 (API Contracts Refactoring) — `invoiceIds`/
    // `paymentDueDate` dropped from `.required()` to optional: the
    // original AR-invoice shape still works exactly as before when
    // supplied, but a caller may instead supply `collectionSource` +
    // `amount` + `currency` directly for a non-invoice source ("Customer
    // Payment is NOT Invoice"). Which combination is actually required is
    // enforced in CustomerCollectionService.createCollectionRequest itself
    // (cross-field business validation, same convention as e.g.
    // createInstallmentPlan's own `customSchedule`-required-when-Custom
    // check) rather than duplicated here. No `merchantId`/`storeId`/
    // `subscriptionId` existence validation — informational only, see
    // PaymentIntentModel's own doc comment for why.
    createCollectionRequest: Joi.object({
      customerId: objectIdRef.required(),
      invoiceIds: Joi.array().items(objectIdRef).min(1).optional(),
      paymentDueDate: Joi.date().optional(),
      preferredMethod: Joi.string().trim().optional().allow(null, ""),
      generatePaymentLink: Joi.boolean().optional(),
      merchantId: Joi.alternatives().try(objectIdRef, Joi.string().trim()).optional().allow(null, ""),
      storeId: Joi.alternatives().try(objectIdRef, Joi.string().trim()).optional().allow(null, ""),
      subscriptionId: Joi.alternatives().try(objectIdRef, Joi.string().trim()).optional().allow(null, ""),
      collectionSource: Joi.string().trim().valid(...config.collectionSources).optional(),
      sourceDocumentId: Joi.string().trim().max(200).optional().allow(null, ""),
      // .insensitive() — the spec's own request example uses uppercase
      // "USD" while this codebase's `supportedCurrencies` default list
      // (utils/bookingConfig.js) is lowercase; matched case-insensitively
      // rather than forcing every caller to know which case this tenant's
      // config happens to use.
      currency: Joi.string().trim().valid(...config.supportedCurrencies).insensitive().optional(),
      amount: Joi.number().greater(0).optional(),
      paymentMethod: Joi.string().trim().valid(...config.paymentMethods).optional(),
      paymentProvider: Joi.string().trim().valid(...config.gateways).optional(),
      paymentDate: Joi.date().optional(),
      returnUrl: Joi.string().trim().uri().max(2000).optional().allow(null, ""),
      cancelUrl: Joi.string().trim().uri().max(2000).optional().allow(null, ""),
      metadata: Joi.object().unknown(true).optional().allow(null)
    }),

    // Part 18 Part 3 (Payment Collection, Allocation & Reconciliation).
    // `customerIp`/`deviceId`/`riskSessionId`/`savePaymentMethod` are
    // recorded honestly as authentication/fraud-signal context — no real
    // 3DS/SCA challenge is implemented (see PaymentIntentModel's own doc
    // comment).
    collectPayment: Joi.object({
      amount: Joi.number().greater(0).optional(),
      paymentMethod: Joi.string().trim().valid(...config.paymentMethods).optional().allow(null, ""),
      installmentNumber: Joi.number().integer().min(1).optional().allow(null),
      paymentProvider: Joi.string().trim().valid(...config.gateways).optional().allow(null, ""),
      captureMode: Joi.string().trim().valid(...config.captureModes).optional(),
      savePaymentMethod: Joi.boolean().optional(),
      customerIp: Joi.string().trim().ip({ version: ["ipv4", "ipv6"] }).optional().allow(null, ""),
      deviceId: Joi.string().trim().max(200).optional().allow(null, ""),
      riskSessionId: Joi.string().trim().max(200).optional().allow(null, "")
    }),

    // Part 18 Part 3 — POST /customer-payments/{collectionId}/capture.
    captureAuthorizedPayment: Joi.object({
      amount: Joi.number().greater(0).optional(),
      installmentNumber: Joi.number().integer().min(1).optional().allow(null)
    }),

    // Part 18 Part 4 — "Down Payment + Installments," "Balloon Payment,"
    // "Grace Period."
    createInstallmentPlan: Joi.object({
      installmentCount: Joi.number().integer().min(1).optional(),
      frequency: Joi.string().trim().valid(...config.installmentFrequencies).required(),
      startDate: Joi.date().optional(),
      customSchedule: Joi.array().items(Joi.object({
        dueDate: Joi.date().required(),
        amount: Joi.number().greater(0).required()
      })).optional(),
      downPayment: Joi.number().min(0).optional(),
      balloonAmount: Joi.number().min(0).optional(),
      gracePeriodDays: Joi.number().integer().min(0).optional().allow(null),
      paymentMethod: Joi.string().trim().valid(...config.paymentMethods).optional().allow(null, "")
    }),

    rescheduleInstallment: Joi.object({
      newDueDate: Joi.date().required(),
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    }),

    cancelInstallmentPlan: Joi.object({
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    }),

    sendReminder: Joi.object({
      channel: Joi.string().trim().valid(...config.deliveryMethods).required()
    }),

    dispute: Joi.object({
      reason: Joi.string().trim().min(1).max(1000).required()
    }),

    writeOff: Joi.object({
      writeOffType: Joi.string().trim().optional().allow(null, ""),
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    cancel: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow("")
    }),

    createDeposit: Joi.object({
      customerId: objectIdRef.required(),
      amount: Joi.number().greater(0).required(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).required(),
      sourceType: Joi.string().trim().valid(...config.customerDepositSourceTypes).required(),
      paymentMethod: Joi.string().trim().optional().allow(null, "")
    }),

    // "Payment Allocation Engine" (Part 18 continuation).
    allocatePayment: Joi.object({
      allocationStrategy: Joi.string().trim().valid(...config.paymentAllocationStrategies).optional(),
      invoiceIds: Joi.array().items(objectIdRef).min(1).optional()
    }),

    // File 6 Part 5.
    addComment: Joi.object({
      text: Joi.string().trim().min(1).max(2000).required()
    }),

    addTimelineEntry: Joi.object({
      description: Joi.string().trim().min(1).max(2000).required(),
      event: Joi.string().trim().max(100).optional().allow(null, "")
    }),

    reopen: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    })
  };
};

const CUSTOMER_COLLECTION_SCHEMA_KEYS = new Set(["createCollectionRequest", "collectPayment", "captureAuthorizedPayment", "createInstallmentPlan", "rescheduleInstallment", "cancelInstallmentPlan", "sendReminder", "dispute", "writeOff", "cancel", "createDeposit", "allocatePayment", "addComment", "addTimelineEntry", "reopen"]);

export const customerCollectionSchemas = new Proxy({}, {
  get(_target, prop) {
    if (CUSTOMER_COLLECTION_SCHEMA_KEYS.has(prop)) {
      return buildCustomerCollectionSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Customer Payments — Wallet Support (Part 18 Part 4). Same
// config-driven Proxy pattern as every other Finance schema group. No
// `branchId`/`branch` field anywhere.
const buildWalletSchemas = () => {
  const config = getFinanceConfig();

  return {
    createWallet: Joi.object({
      customerId: objectIdRef.required(),
      walletType: Joi.string().trim().valid(...config.walletTypes).optional(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).insensitive().required(),
      maxBalance: Joi.number().greater(0).optional().allow(null)
    }),
    topUp: Joi.object({
      amount: Joi.number().greater(0).required(),
      paymentMethod: Joi.string().trim().valid(...config.paymentMethods).required(),
      paymentProvider: Joi.string().trim().valid(...config.gateways).optional().allow(null, "")
    }),
    purchase: Joi.object({
      amount: Joi.number().greater(0).required(),
      collectionId: objectIdRef.required(),
      installmentNumber: Joi.number().integer().min(1).optional().allow(null)
    }),
    refund: Joi.object({
      amount: Joi.number().greater(0).required(),
      reason: Joi.string().trim().max(500).optional().allow(null, ""),
      paymentId: objectIdRef.optional().allow(null, "")
    }),
    transfer: Joi.object({
      toWalletId: objectIdRef.required(),
      amount: Joi.number().greater(0).required()
    }),
    withdraw: Joi.object({
      amount: Joi.number().greater(0).required(),
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    }),
    suspend: Joi.object({
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    })
  };
};

const WALLET_SCHEMA_KEYS = new Set(["createWallet", "topUp", "purchase", "refund", "transfer", "withdraw", "suspend"]);

export const walletSchemas = new Proxy({}, {
  get(_target, prop) {
    if (WALLET_SCHEMA_KEYS.has(prop)) return buildWalletSchemas()[prop];
    return undefined;
  }
});

// Enterprise Customer Payments — Subscription + Membership Billing (Part
// 18 Part 4). Same config-driven Proxy pattern as every other Finance
// schema group. No `branchId`/`branch` field anywhere.
const buildSubscriptionSchemas = () => {
  const config = getFinanceConfig();

  return {
    createSubscription: Joi.object({
      customerId: objectIdRef.required(),
      planType: Joi.string().trim().valid(...config.subscriptionPlanTypes).optional(),
      planName: Joi.string().trim().min(1).max(200).required(),
      membershipTier: Joi.string().trim().valid(...config.membershipTiers).optional().allow(null, ""),
      billingCycle: Joi.string().trim().valid(...config.subscriptionBillingCycles).optional(),
      amount: Joi.number().greater(0).required(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).insensitive().required(),
      trialDays: Joi.number().integer().min(0).optional(),
      autoRenew: Joi.boolean().optional(),
      gracePeriodDays: Joi.number().integer().min(0).optional().allow(null),
      retryAttempts: Joi.number().integer().min(0).optional().allow(null),
      prorationEnabled: Joi.boolean().optional(),
      paymentMethod: Joi.string().trim().valid(...config.paymentMethods).optional().allow(null, ""),
      paymentProvider: Joi.string().trim().valid(...config.gateways).optional().allow(null, "")
    }),
    recordUsage: Joi.object({
      quantity: Joi.number().required(),
      unitPrice: Joi.number().min(0).optional().allow(null)
    }),
    changePlan: Joi.object({
      newAmount: Joi.number().greater(0).required(),
      type: Joi.string().trim().valid("Upgrade", "Downgrade").required()
    }),
    pause: Joi.object({
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    }),
    cancel: Joi.object({
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    }),
    terminate: Joi.object({
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    })
  };
};

const SUBSCRIPTION_SCHEMA_KEYS = new Set(["createSubscription", "recordUsage", "changePlan", "pause", "cancel", "terminate"]);

export const subscriptionSchemas = new Proxy({}, {
  get(_target, prop) {
    if (SUBSCRIPTION_SCHEMA_KEYS.has(prop)) return buildSubscriptionSchemas()[prop];
    return undefined;
  }
});

// Enterprise Customer Payments — Collection Campaigns (Part 18 Part 4).
// Same config-driven Proxy pattern as every other Finance schema group.
// No `branchId`/`branch` field anywhere.
const buildCollectionCampaignSchemas = () => {
  const config = getFinanceConfig();

  return {
    createCampaign: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      campaignType: Joi.string().trim().valid(...config.collectionCampaignTypes).required(),
      reminderChannel: Joi.string().trim().valid(...config.deliveryMethods).optional(),
      targetCriteria: Joi.object({
        status: Joi.string().trim().valid(...config.customerCollectionStatuses).optional().allow(null, ""),
        collectionSource: Joi.string().trim().valid(...config.collectionSources).optional().allow(null, ""),
        currency: Joi.string().trim().optional().allow(null, ""),
        minAmount: Joi.number().min(0).optional().allow(null),
        maxAmount: Joi.number().min(0).optional().allow(null),
        minDaysOverdue: Joi.number().integer().min(0).optional().allow(null),
        collectionStage: Joi.string().trim().optional().allow(null, "")
      }).optional()
    })
  };
};

const COLLECTION_CAMPAIGN_SCHEMA_KEYS = new Set(["createCampaign"]);

export const collectionCampaignSchemas = new Proxy({}, {
  get(_target, prop) {
    if (COLLECTION_CAMPAIGN_SCHEMA_KEYS.has(prop)) return buildCollectionCampaignSchemas()[prop];
    return undefined;
  }
});

// Enterprise Customer Payments — Webhook Platform (Part 18 Part 5). Same
// config-driven Proxy pattern as every other Finance schema group. No
// `branchId`/`branch` field anywhere. `subscribedEvents` accepts any
// string ("Custom Events") — not restricted to `webhookEventTypes`, since
// that catalog is a curated "known events" list, not an exhaustive one.
const buildWebhookSchemas = () => {
  return {
    createSubscription: Joi.object({
      url: Joi.string().trim().uri({ scheme: ["http", "https"] }).max(2000).required(),
      description: Joi.string().trim().max(500).optional().allow(null, ""),
      subscribedEvents: Joi.array().items(Joi.string().trim().min(1).max(100)).min(1).required()
    }),
    updateStatus: Joi.object({
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    })
  };
};

const WEBHOOK_SCHEMA_KEYS = new Set(["createSubscription", "updateStatus"]);

export const webhookSchemas = new Proxy({}, {
  get(_target, prop) {
    if (WEBHOOK_SCHEMA_KEYS.has(prop)) return buildWebhookSchemas()[prop];
    return undefined;
  }
});

// Enterprise Multi-Currency & Foreign Exchange (Part 19). Same
// config-driven Proxy pattern as every other Finance schema group. No
// `branchId`/`branch` field anywhere.
const buildCurrencySchemas = () => {
  const config = getFinanceConfig();

  return {
    // File 4 Part 2 — `status` from the spec's own request example is
    // deliberately NOT accepted here: a currency always starts Draft,
    // real (CurrencyService.createCurrency never trusts a caller-supplied
    // initial status).
    createCurrency: Joi.object({
      currencyCode: Joi.string().trim().uppercase().length(3).required(),
      isoNumericCode: Joi.string().trim().pattern(/^\d{3}$/).optional().allow(null, ""),
      name: Joi.string().trim().max(100).optional(),
      symbol: Joi.string().trim().max(8).optional().allow(null, ""),
      decimalPlaces: Joi.number().integer().min(0).max(4).optional(),
      currencyType: Joi.string().trim().valid(...config.currencyTypes).optional(),
      baseCurrency: Joi.boolean().optional(),
      reportingCurrency: Joi.boolean().optional()
    }),

    suspend: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    // File 4 Part 2 — `expiresAt` is real and optional; `approvalStatus`/
    // `version` are never caller-supplied (CurrencyService.createExchangeRate
    // computes both).
    createExchangeRate: Joi.object({
      fromCurrency: Joi.string().trim().uppercase().length(3).required(),
      toCurrency: Joi.string().trim().uppercase().length(3).required(),
      rate: Joi.number().greater(0).required(),
      effectiveDate: Joi.date().required(),
      expiresAt: Joi.date().optional().allow(null),
      rateType: Joi.string().trim().valid(...config.exchangeRateTypes).optional(),
      provider: Joi.string().trim().valid(...config.rateProviders).optional()
    }),

    rejectExchangeRate: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    importRates: Joi.object({
      baseCurrency: Joi.string().trim().uppercase().length(3).optional()
    }),

    runRevaluation: Joi.object({
      revaluationDate: Joi.date().optional()
    }),

    // File 7 Part 3 — POST /api/v1/currency/convert. `merchantId`/
    // `companyId` from the spec's own request example are accepted but
    // never validated/used — no Merchant model, and Company is already
    // Tenant (see this Part's own doc section).
    convert: Joi.object({
      merchantId: Joi.string().trim().optional().allow(null, ""),
      companyId: Joi.string().trim().optional().allow(null, ""),
      fromCurrency: Joi.string().trim().uppercase().length(3).required(),
      toCurrency: Joi.string().trim().uppercase().length(3).required(),
      amount: Joi.number().greater(0).required(),
      conversionDate: Joi.date().optional(),
      rateType: Joi.string().trim().valid(...config.exchangeRateTypes, "auto").optional(),
      source: Joi.string().trim().valid(...config.conversionSources).optional()
    })
  };
};

const CURRENCY_SCHEMA_KEYS = new Set(["createCurrency", "suspend", "createExchangeRate", "rejectExchangeRate", "importRates", "runRevaluation", "convert"]);

export const currencySchemas = new Proxy({}, {
  get(_target, prop) {
    if (CURRENCY_SCHEMA_KEYS.has(prop)) {
      return buildCurrencySchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Tax Engine (Part 20). Same config-driven Proxy pattern as
// every other Finance schema group. No `branchId`/`branch` field
// anywhere.
const buildTaxSchemas = () => {
  const config = getFinanceConfig();

  return {
    createTaxRule: Joi.object({
      taxCode: Joi.string().trim().uppercase().min(1).max(20).required(),
      name: Joi.string().trim().min(1).max(200).required(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      taxType: Joi.string().trim().valid(...config.taxTypes).required(),
      country: Joi.string().trim().uppercase().min(2).max(4).required(),
      state: Joi.string().trim().optional().allow(null, ""),
      rate: Joi.number().min(0).required(),
      calculationMethod: Joi.string().trim().valid(...config.taxCalculationMethods).optional(),
      compoundOnTaxCodes: Joi.array().items(Joi.string().trim().uppercase()).optional(),
      minTaxAmount: Joi.number().min(0).optional().allow(null),
      maxTaxAmount: Joi.number().min(0).optional().allow(null),
      reverseChargeScopes: Joi.array().items(Joi.string().trim().valid(...config.reverseChargeScopes)).optional(),
      withholdingCategory: Joi.string().trim().valid(...config.withholdingCategories).optional().allow(null, ""),
      effectiveDate: Joi.date().required()
    }),

    calculateTax: Joi.object({
      customerCountry: Joi.string().trim().uppercase().min(2).max(4).required(),
      customerState: Joi.string().trim().optional().allow(null, ""),
      transactionType: Joi.string().trim().optional(),
      transactionId: objectIdRef.optional().allow(null, ""),
      transactionRef: Joi.string().trim().optional().allow(null, ""),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).required(),
      lines: Joi.array().items(Joi.object({
        amount: Joi.number().greater(0).required(),
        taxCode: Joi.string().trim().uppercase().optional().allow(null, "")
      })).min(1).required(),
      partyType: Joi.string().trim().valid("customer", "vendor").optional().allow(null, ""),
      partyId: objectIdRef.optional().allow(null, ""),
      reverseChargeContext: Joi.array().items(Joi.string().trim().valid(...config.reverseChargeScopes)).optional(),
      direction: Joi.string().trim().valid("Output", "Input").optional(),
      asOfDate: Joi.date().optional()
    }),

    calculateWithholding: Joi.object({
      amount: Joi.number().greater(0).required(),
      withholdingCategory: Joi.string().trim().valid(...config.withholdingCategories).required(),
      country: Joi.string().trim().uppercase().min(2).max(4).required(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).required(),
      transactionId: objectIdRef.optional().allow(null, ""),
      transactionRef: Joi.string().trim().optional().allow(null, ""),
      asOfDate: Joi.date().optional()
    }),

    createExemption: Joi.object({
      partyType: Joi.string().trim().valid("customer", "vendor").required(),
      partyId: objectIdRef.required(),
      exemptionType: Joi.string().trim().valid(...config.taxExemptionTypes).required(),
      certificateNumber: Joi.string().trim().min(1).max(100).required(),
      certificateUrl: Joi.string().trim().uri().optional().allow(null, ""),
      applicableTaxCodes: Joi.array().items(Joi.string().trim().uppercase()).optional(),
      validFrom: Joi.date().required(),
      validUntil: Joi.date().optional().allow(null)
    }),

    revokeExemption: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    })
  };
};

const TAX_SCHEMA_KEYS = new Set(["createTaxRule", "calculateTax", "calculateWithholding", "createExemption", "revokeExemption"]);

export const taxSchemas = new Proxy({}, {
  get(_target, prop) {
    if (TAX_SCHEMA_KEYS.has(prop)) {
      return buildTaxSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Discount & Pricing Engine (Part 21). Same config-driven
// Proxy pattern as every other Finance schema group. No `branchId`/
// `branch` field anywhere.
const buildPricingSchemas = () => {
  const config = getFinanceConfig();

  return {
    createPricingRule: Joi.object({
      ruleName: Joi.string().trim().min(1).max(150).required(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      ruleType: Joi.string().trim().valid(...config.pricingRuleTypes).required(),
      promotionType: Joi.string().trim().valid(...config.promotionTypes).optional().allow(null, ""),
      customerId: objectIdRef.optional().allow(null, ""),
      customerGroup: Joi.string().trim().optional().allow(null, ""),
      productCode: Joi.string().trim().uppercase().optional().allow(null, ""),
      discountType: Joi.string().trim().valid(...config.discountTypes).optional().allow(null, ""),
      discountValue: Joi.number().min(0).optional(),
      buyQuantity: Joi.number().integer().min(1).optional().allow(null),
      getQuantity: Joi.number().integer().min(1).optional().allow(null),
      fixedPrice: Joi.number().min(0).optional().allow(null),
      tiers: Joi.array().items(Joi.object({
        minQuantity: Joi.number().min(0).required(),
        discountType: Joi.string().trim().valid(...config.discountTypes).required(),
        discountValue: Joi.number().min(0).required()
      })).optional(),
      isStackable: Joi.boolean().optional(),
      priority: Joi.number().required(),
      effectiveDate: Joi.date().required()
    }),

    calculatePrice: Joi.object({
      customerId: objectIdRef.optional().allow(null, ""),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).required(),
      items: Joi.array().items(Joi.object({
        productCode: Joi.string().trim().optional().allow(null, ""),
        productId: Joi.string().trim().optional().allow(null, ""),
        quantity: Joi.number().greater(0).required(),
        unitPrice: Joi.number().min(0).optional().allow(null),
        taxCode: Joi.string().trim().uppercase().optional().allow(null, "")
      })).min(1).required(),
      couponCode: Joi.string().trim().optional().allow(null, ""),
      redeemCoupon: Joi.boolean().optional(),
      transactionRef: Joi.string().trim().optional().allow(null, ""),
      asOfDate: Joi.date().optional()
    }),

    createPriceList: Joi.object({
      name: Joi.string().trim().min(1).max(150).required(),
      listType: Joi.string().trim().required(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).required(),
      customerId: objectIdRef.optional().allow(null, ""),
      customerGroup: Joi.string().trim().optional().allow(null, ""),
      isDefault: Joi.boolean().optional()
    }),

    upsertPriceListEntry: Joi.object({
      productCode: Joi.string().trim().uppercase().min(1).required(),
      unitPrice: Joi.number().min(0).required()
    }),

    createCoupon: Joi.object({
      code: Joi.string().trim().uppercase().min(1).max(40).required(),
      name: Joi.string().trim().min(1).max(150).required(),
      discountType: Joi.string().trim().valid(...config.discountTypes).required(),
      discountValue: Joi.number().min(0).required(),
      usageType: Joi.string().trim().valid(...config.couponUsageTypes).required(),
      usageLimit: Joi.number().integer().min(1).optional().allow(null),
      perCustomerLimit: Joi.number().integer().min(1).optional().allow(null),
      applicableProductCodes: Joi.array().items(Joi.string().trim().uppercase()).optional(),
      applicableCustomerIds: Joi.array().items(objectIdRef).optional(),
      validFrom: Joi.date().required(),
      validUntil: Joi.date().optional().allow(null)
    }),

    revokeCoupon: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    })
  };
};

const PRICING_SCHEMA_KEYS = new Set(["createPricingRule", "calculatePrice", "createPriceList", "upsertPriceListEntry", "createCoupon", "revokeCoupon"]);

export const pricingSchemas = new Proxy({}, {
  get(_target, prop) {
    if (PRICING_SCHEMA_KEYS.has(prop)) {
      return buildPricingSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Financial Approval Workflow (Part 22). Same config-driven
// Proxy pattern as every other Finance schema group. No `branchId`/
// `branch` field anywhere.
const buildApprovalWorkflowSchemas = () => {
  const config = getFinanceConfig();

  const levelSchema = Joi.object({
    levelName: Joi.string().trim().min(1).max(100).required(),
    order: Joi.number().integer().min(0).required(),
    approverType: Joi.string().trim().valid("Role", "User").required(),
    approverPermissionKey: Joi.string().trim().optional().allow(null, ""),
    approverUserId: objectIdRef.optional().allow(null, ""),
    minApprovals: Joi.number().integer().min(1).optional().allow(null),
    slaHours: Joi.number().min(1).optional().allow(null)
  });

  return {
    createWorkflowDefinition: Joi.object({
      name: Joi.string().trim().min(1).max(150).required(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      module: Joi.string().trim().valid(...config.workflowModules).required(),
      conditions: Joi.object().optional(),
      approvalType: Joi.string().trim().valid(...config.approvalTypes).required(),
      levels: Joi.array().items(levelSchema).optional(),
      branches: Joi.array().items(Joi.object({
        conditions: Joi.object().optional(),
        approvalType: Joi.string().trim().valid(...config.approvalTypes).required(),
        levels: Joi.array().items(levelSchema).min(1).required()
      })).optional(),
      slaHours: Joi.number().min(1).optional().allow(null),
      escalation: Joi.object({
        enabled: Joi.boolean().optional(),
        afterHours: Joi.number().min(1).optional().allow(null),
        escalateToPermissionKey: Joi.string().trim().optional().allow(null, "")
      }).optional(),
      effectiveDate: Joi.date().required()
    }),

    startApproval: Joi.object({
      module: Joi.string().trim().valid(...config.workflowModules).required(),
      entityId: objectIdRef.required(),
      entityRef: Joi.string().trim().optional().allow(null, ""),
      context: Joi.object().optional(),
      asOfDate: Joi.date().optional()
    }),

    recordDecision: Joi.object({
      decision: Joi.string().trim().valid("Approved", "Rejected").required(),
      comments: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    cancelApproval: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    createDelegation: Joi.object({
      delegatorUserId: objectIdRef.required(),
      delegateUserId: objectIdRef.required(),
      delegationType: Joi.string().trim().valid(...config.delegationTypes).required(),
      module: Joi.string().trim().valid(...config.workflowModules).optional().allow(null, ""),
      validFrom: Joi.date().required(),
      validUntil: Joi.date().optional().allow(null),
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    })
  };
};

const APPROVAL_WORKFLOW_SCHEMA_KEYS = new Set(["createWorkflowDefinition", "startApproval", "recordDecision", "cancelApproval", "createDelegation"]);

export const approvalWorkflowSchemas = new Proxy({}, {
  get(_target, prop) {
    if (APPROVAL_WORKFLOW_SCHEMA_KEYS.has(prop)) {
      return buildApprovalWorkflowSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Settlement Engine (Part 23). Same config-driven Proxy
// pattern as every other Finance schema group. No `branchId`/`branch`
// field anywhere — the spec's own "Branch Match" is dropped.
const buildSettlementSchemas = () => {
  const config = getFinanceConfig();

  return {
    createSettlement: Joi.object({
      paymentId: objectIdRef.required(),
      settlementAccount: objectIdRef.required(),
      settlementDate: Joi.date().required(),
      splits: Joi.array().items(Joi.object({
        splitType: Joi.string().trim().valid(...config.settlementSplitTypes).required(),
        payeeType: Joi.string().trim().valid("customer", "vendor").optional().allow(null, ""),
        payeeId: objectIdRef.optional().allow(null, ""),
        amount: Joi.number().greater(0).required()
      })).optional()
    }),

    cancelSettlement: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    createAdjustment: Joi.object({
      adjustmentType: Joi.string().trim().valid(...config.settlementAdjustmentTypes).required(),
      amount: Joi.number().invalid(0).required(),
      reason: Joi.string().trim().max(1000).optional().allow(null, ""),
      chargebackId: objectIdRef.optional().allow(null, "")
    }),

    reconcile: Joi.object({
      settlementAccountId: objectIdRef.required(),
      dateFrom: Joi.date().optional(),
      dateTo: Joi.date().optional()
    }),

    createBatch: Joi.object({
      batchType: Joi.string().trim().valid(...config.settlementBatchTypes).required(),
      settlementIds: Joi.array().items(objectIdRef).min(1).required(),
      scheduledDate: Joi.date().optional().allow(null)
    }),

    sendBatch: Joi.object({
      format: Joi.string().trim().valid("CSV", "ACH", "SEPA", "ISO 20022", "SWIFT MT").required()
    })
  };
};

const SETTLEMENT_SCHEMA_KEYS = new Set(["createSettlement", "cancelSettlement", "createAdjustment", "reconcile", "createBatch", "sendBatch"]);

export const settlementSchemas = new Proxy({}, {
  get(_target, prop) {
    if (SETTLEMENT_SCHEMA_KEYS.has(prop)) {
      return buildSettlementSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Financial Reporting (Part 24). Same config-driven Proxy
// pattern as every other Finance schema group. No `branchId`/`branch`
// field anywhere — the spec's own "Branch Match"/branch query param are
// dropped.
const buildFinancialReportSchemas = () => {
  const config = getFinanceConfig();

  return {
    generateReport: Joi.object({
      reportType: Joi.string().trim().valid(...config.reportTypes).required(),
      period: Joi.string().trim().optional().allow(null, ""),
      periodStart: Joi.date().optional(),
      periodEnd: Joi.date().optional(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).optional().allow(null, "")
    }).unknown(true),

    exportReport: Joi.object({
      format: Joi.string().trim().valid(...config.reportExportFormats).required()
    }),

    createSchedule: Joi.object({
      name: Joi.string().trim().min(1).max(150).required(),
      reportType: Joi.string().trim().valid(...config.reportTypes).required(),
      parameters: Joi.object().optional(),
      frequency: Joi.string().trim().valid(...config.reportScheduleFrequencies).required(),
      recipientEmails: Joi.array().items(Joi.string().trim().email({ tlds: false })).optional(),
      format: Joi.string().trim().valid(...config.reportExportFormats).required()
    })
  };
};

const FINANCIAL_REPORT_SCHEMA_KEYS = new Set(["generateReport", "exportReport", "createSchedule"]);

export const financialReportSchemas = new Proxy({}, {
  get(_target, prop) {
    if (FINANCIAL_REPORT_SCHEMA_KEYS.has(prop)) {
      return buildFinancialReportSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Financial Analytics (Part 26). Same config-driven Proxy
// pattern as every other Finance schema group. No `branchId`/`branch`
// field anywhere — the spec's own "Branch Exists" validation rule and
// "Branch Isolation" are dropped per the standing master instructions.
const buildFinancialAnalyticsSchemas = () => {
  const config = getFinanceConfig();

  return {
    runAnalysis: Joi.object({
      analysisType: Joi.string().trim().valid(...config.analysisTypes).required(),
      period: Joi.string().trim().optional().allow(null, ""),
      periodStart: Joi.date().optional(),
      periodEnd: Joi.date().optional(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).optional().allow(null, "")
    }).unknown(true),

    refreshAnalytics: Joi.object({
      period: Joi.string().trim().optional().allow(null, ""),
      scope: Joi.string().trim().optional().allow(null, "")
    }).unknown(true)
  };
};

const FINANCIAL_ANALYTICS_SCHEMA_KEYS = new Set(["runAnalysis", "refreshAnalytics"]);

export const financialAnalyticsSchemas = new Proxy({}, {
  get(_target, prop) {
    if (FINANCIAL_ANALYTICS_SCHEMA_KEYS.has(prop)) {
      return buildFinancialAnalyticsSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Audit & Compliance (Part 27). Same config-driven Proxy
// pattern as every other Finance schema group. No `branchId`/`branch`
// field anywhere — the spec's own "Branch Isolation" AI Coding Rule is
// dropped per the standing master instructions.
const buildAuditComplianceSchemas = () => {
  const config = getFinanceConfig();

  return {
    recordEvent: Joi.object({
      module: Joi.string().trim().min(1).max(100).required(),
      category: Joi.string().trim().valid(...config.auditCategories).required(),
      entityType: Joi.string().trim().optional().allow(null, ""),
      entityId: Joi.string().trim().optional().allow(null, ""),
      action: Joi.string().trim().min(1).max(150).required(),
      beforeState: Joi.object().optional().allow(null),
      afterState: Joi.object().optional().allow(null),
      severity: Joi.string().trim().valid(...config.auditSeverities).optional(),
      timestamp: Joi.date().optional(),
      correlationId: Joi.string().trim().optional().allow(null, ""),
      exceptionReason: Joi.string().trim().max(500).optional().allow(null, ""),
      targetUserId: Joi.string().trim().optional().allow(null, ""),
      targetUserEmail: Joi.string().trim().optional().allow(null, "")
    }).unknown(true),

    setLegalHold: Joi.object({
      legalHold: Joi.boolean().required()
    }),

    exportEvidence: Joi.object({
      format: Joi.string().trim().valid("CSV", "JSON").optional(),
      module: Joi.string().trim().optional().allow(null, ""),
      category: Joi.string().trim().valid(...config.auditCategories).optional().allow(null, ""),
      entityType: Joi.string().trim().optional().allow(null, ""),
      entityId: Joi.string().trim().optional().allow(null, ""),
      userId: Joi.string().trim().optional().allow(null, ""),
      dateFrom: Joi.date().optional(),
      dateTo: Joi.date().optional()
    }),

    createPolicy: Joi.object({
      name: Joi.string().trim().min(1).max(150).required(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      policyType: Joi.string().trim().valid(...config.compliancePolicyTypes).required(),
      ruleType: Joi.string().trim().valid(...config.complianceRuleTypes).required(),
      conditions: Joi.object().optional(),
      categories: Joi.array().items(Joi.string().trim().valid(...config.auditCategories)).optional(),
      entityTypes: Joi.array().items(Joi.string().trim()).optional(),
      severity: Joi.string().trim().valid(...config.auditSeverities).optional()
    }),

    updatePolicyStatus: Joi.object({
      status: Joi.string().trim().valid("Active", "Inactive").required()
    })
  };
};

const AUDIT_COMPLIANCE_SCHEMA_KEYS = new Set(["recordEvent", "setLegalHold", "exportEvidence", "createPolicy", "updatePolicyStatus"]);

export const auditComplianceSchemas = new Proxy({}, {
  get(_target, prop) {
    if (AUDIT_COMPLIANCE_SCHEMA_KEYS.has(prop)) {
      return buildAuditComplianceSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Financial Dashboard (Part 25). Same config-driven Proxy
// pattern. No `branchId`/`branch` field anywhere.
const buildFinancialDashboardSchemas = () => {
  const config = getFinanceConfig();

  return {
    acknowledgeAlert: Joi.object({}).unknown(false),

    savePreferences: Joi.object({
      layout: Joi.object().optional().allow(null),
      favoriteWidgets: Joi.array().items(Joi.string().trim()).optional(),
      filters: Joi.object().optional(),
      theme: Joi.string().trim().max(50).optional().allow(null),
      refreshInterval: Joi.string().trim().valid(...config.dashboardRefreshIntervals).optional()
    })
  };
};

const FINANCIAL_DASHBOARD_SCHEMA_KEYS = new Set(["acknowledgeAlert", "savePreferences"]);

export const financialDashboardSchemas = new Proxy({}, {
  get(_target, prop) {
    if (FINANCIAL_DASHBOARD_SCHEMA_KEYS.has(prop)) {
      return buildFinancialDashboardSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Budgeting & Forecasting Platform (Part 17 EPM).
// Config-driven Proxy pattern as every other Finance schema group.
// Tenant-scoped only — no `branchId`/`branch` field anywhere.
const buildPlanningSchemas = () => {
  const config = getFinanceConfig();

  return {
    createBudget: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      department: Joi.string().trim().max(100).optional().allow(null, ""),
      fiscalYear: Joi.string().trim().min(1).max(20).required(),
      currency: Joi.string().trim().length(3).uppercase().required(),
      budgetType: Joi.string().trim().valid(...config.budgetTypes).optional(),
      owner: Joi.string().trim().max(100).optional(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      periodStart: Joi.date().optional(),
      periodEnd: Joi.date().optional(),
      lineItems: Joi.array().items(Joi.object({
        code: Joi.string().trim().optional().allow(null, ""),
        accountCode: Joi.string().trim().optional().allow(null, ""),
        category: Joi.string().trim().required(),
        name: Joi.string().trim().required(),
        allocatedAmount: Joi.number().min(0).required(),
        periodBreakdown: Joi.object().optional(),
        notes: Joi.string().trim().optional().allow(null, "")
      })).optional()
    }),

    updateBudget: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      department: Joi.string().trim().max(100).optional().allow(null, ""),
      currency: Joi.string().trim().length(3).uppercase().optional(),
      budgetType: Joi.string().trim().valid(...config.budgetTypes).optional(),
      owner: Joi.string().trim().max(100).optional(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      periodStart: Joi.date().optional(),
      periodEnd: Joi.date().optional(),
      lineItems: Joi.array().items(Joi.object({
        code: Joi.string().trim().optional().allow(null, ""),
        accountCode: Joi.string().trim().optional().allow(null, ""),
        category: Joi.string().trim().required(),
        name: Joi.string().trim().required(),
        allocatedAmount: Joi.number().min(0).required(),
        periodBreakdown: Joi.object().optional(),
        notes: Joi.string().trim().optional().allow(null, "")
      })).optional()
    }),

    approveBudget: Joi.object({
      decision: Joi.string().trim().valid("Approved", "Rejected", "RevisionRequested").required(),
      comments: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    createRevision: Joi.object({
      reason: Joi.string().trim().max(500).optional().allow(null, ""),
      department: Joi.string().trim().max(100).optional().allow(null, ""),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      lineItems: Joi.array().items(Joi.object({
        code: Joi.string().trim().optional().allow(null, ""),
        accountCode: Joi.string().trim().optional().allow(null, ""),
        category: Joi.string().trim().required(),
        name: Joi.string().trim().required(),
        allocatedAmount: Joi.number().min(0).required(),
        periodBreakdown: Joi.object().optional(),
        notes: Joi.string().trim().optional().allow(null, "")
      })).optional()
    }),

    generateForecast: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      forecastType: Joi.string().trim().valid(...config.forecastTypes).required(),
      fiscalYear: Joi.string().trim().min(1).max(20).required(),
      baseBudgetId: Joi.string().trim().optional().allow(null, ""),
      currency: Joi.string().trim().length(3).uppercase().optional(),
      methodology: Joi.string().trim().valid("LinearTrend", "MovingAverage", "GrowthRate", "RunRate", "HistoricalAverage", "Custom").optional(),
      growthRate: Joi.number().optional(),
      startDate: Joi.date().optional(),
      endDate: Joi.date().optional(),
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    calculateVariance: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      varianceType: Joi.string().trim().valid(...config.varianceTypes).optional(),
      budgetId: Joi.string().trim().optional().allow(null, ""),
      forecastId: Joi.string().trim().optional().allow(null, ""),
      fiscalYear: Joi.string().trim().min(1).max(20).required(),
      period: Joi.string().trim().optional().allow(null, ""),
      currency: Joi.string().trim().length(3).uppercase().optional()
    }),

    createScenario: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      scenarioType: Joi.string().trim().valid(...config.scenarioTypes).required(),
      baseBudgetId: Joi.string().trim().optional().allow(null, ""),
      baseForecastId: Joi.string().trim().optional().allow(null, ""),
      fiscalYear: Joi.string().trim().min(1).max(20).required(),
      currency: Joi.string().trim().length(3).uppercase().optional(),
      assumptions: Joi.object({
        revenueMultiplier: Joi.number().optional(),
        expenseMultiplier: Joi.number().optional(),
        inflationRate: Joi.number().optional(),
        headcountGrowthPct: Joi.number().optional(),
        customParameters: Joi.object().optional()
      }).optional(),
      description: Joi.string().trim().max(1000).optional().allow(null, "")
    })
  };
};

const PLANNING_SCHEMA_KEYS = new Set([
  "createBudget", "updateBudget", "approveBudget", "createRevision",
  "generateForecast", "calculateVariance", "createScenario"
]);

export const planningSchemas = new Proxy({}, {
  get(_target, prop) {
    if (PLANNING_SCHEMA_KEYS.has(prop)) {
      return buildPlanningSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Treasury Management Platform — Part 18 (TMS).
// Config-driven Proxy pattern as every other Finance schema group.
// Tenant-scoped only — no `branchId`/`branch` field anywhere.
const buildTreasurySchemas = () => {
  const config = getFinanceConfig();

  return {
    calculateCashPosition: Joi.object({
      valuationDate: Joi.date().optional()
    }),

    syncBankBalances: Joi.object({
      bankAccountId: Joi.string().trim().optional().allow(null, ""),
      balanceOverrides: Joi.object().optional()
    }),

    generateLiquidityForecast: Joi.object({
      horizon: Joi.string().trim().valid("7-Day", "30-Day", "90-Day", "12-Month", "Custom").optional(),
      baseCurrency: Joi.string().trim().length(3).uppercase().optional(),
      minimumBuffer: Joi.number().min(0).optional(),
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    createInvestment: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      investmentType: Joi.string().trim().valid(...config.investmentTypes).required(),
      counterpartyBank: Joi.string().trim().min(1).max(200).required(),
      currency: Joi.string().trim().length(3).uppercase().optional(),
      principalAmount: Joi.number().positive().required(),
      interestRate: Joi.number().min(0).max(100).optional(),
      startDate: Joi.date().optional(),
      maturityDate: Joi.date().required(),
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    updateInvestmentStatus: Joi.object({
      status: Joi.string().trim().valid(...config.investmentStatuses).required(),
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    recordDebt: Joi.object({
      facilityName: Joi.string().trim().min(1).max(200).required(),
      debtType: Joi.string().trim().valid(...config.debtTypes).required(),
      lender: Joi.string().trim().min(1).max(200).required(),
      currency: Joi.string().trim().length(3).uppercase().optional(),
      principalAmount: Joi.number().positive().required(),
      outstandingBalance: Joi.number().min(0).optional(),
      interestRate: Joi.number().min(0).max(100).optional(),
      interestType: Joi.string().trim().valid("Fixed", "Floating").optional(),
      startDate: Joi.date().optional(),
      maturityDate: Joi.date().required(),
      repaymentFrequency: Joi.string().trim().valid("Monthly", "Quarterly", "Annually", "Bullet").optional(),
      nextPaymentDate: Joi.date().optional(),
      nextPaymentAmount: Joi.number().min(0).optional(),
      covenants: Joi.array().items(Joi.object({
        covenantName: Joi.string().trim().required(),
        metric: Joi.string().trim().required(),
        targetValue: Joi.number().required(),
        currentValue: Joi.number().optional(),
        compliant: Joi.boolean().optional()
      })).optional(),
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    updateDebtStatus: Joi.object({
      status: Joi.string().trim().valid(...config.debtStatuses).optional(),
      outstandingBalance: Joi.number().min(0).optional(),
      notes: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    calculateFXExposure: Joi.object({
      baseCurrency: Joi.string().trim().length(3).uppercase().optional()
    }),

    evaluateTreasuryRisks: Joi.object({})
  };
};

const TREASURY_SCHEMA_KEYS = new Set([
  "calculateCashPosition", "syncBankBalances", "generateLiquidityForecast",
  "createInvestment", "updateInvestmentStatus", "recordDebt", "updateDebtStatus",
  "calculateFXExposure", "evaluateTreasuryRisks"
]);

export const treasurySchemas = new Proxy({}, {
  get(_target, prop) {
    if (TREASURY_SCHEMA_KEYS.has(prop)) {
      return buildTreasurySchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Financial Governance & Compliance Platform — Part 19.
// Config-driven Proxy pattern as every other Finance schema group.
// Tenant-scoped only — no `branchId`/`branch` field anywhere.
const buildGovernanceSchemas = () => {
  const config = getFinanceConfig();

  return {
    evaluateGovernance: Joi.object({
      transactionId: Joi.string().trim().min(1).max(100).required(),
      operation: Joi.string().trim().min(1).max(100).required(),
      amount: Joi.number().min(0).optional(),
      creatorId: Joi.string().trim().optional().allow(null, ""),
      approverId: Joi.string().trim().optional().allow(null, ""),
      payload: Joi.object().optional()
    }),

    createPolicy: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      policyType: Joi.string().trim().valid(...config.governancePolicyTypes).required(),
      priority: Joi.number().integer().min(1).max(100).optional(),
      effectiveDate: Joi.date().optional(),
      expirationDate: Joi.date().optional(),
      owner: Joi.string().trim().max(100).optional(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      rules: Joi.object({
        thresholdAmount: Joi.number().min(0).optional().allow(null),
        requiresDualAuthorization: Joi.boolean().optional(),
        sodIncompatibleRoles: Joi.array().items(Joi.string().trim()).optional(),
        sodIncompatibleActions: Joi.array().items(Joi.string().trim()).optional(),
        allowedOperations: Joi.array().items(Joi.string().trim()).optional(),
        fraudRiskThreshold: Joi.number().min(0).max(100).optional(),
        customConditions: Joi.object().optional()
      }).optional()
    }),

    createSoDRule: Joi.object({
      ruleName: Joi.string().trim().min(1).max(200).required(),
      firstAction: Joi.string().trim().min(1).max(100).required(),
      secondAction: Joi.string().trim().min(1).max(100).required(),
      riskLevel: Joi.string().trim().valid("Low", "Medium", "High", "Critical").optional(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      mitigationControl: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    createFraudRule: Joi.object({
      ruleName: Joi.string().trim().min(1).max(200).required(),
      checkType: Joi.string().trim().valid("DuplicatePayment", "UnusualAmount", "ApprovalVelocity", "HighRiskVendor", "OffHoursTransaction", "Custom").required(),
      riskSeverity: Joi.string().trim().valid(...config.fraudRiskLevels).optional(),
      parameters: Joi.object().optional()
    })
  };
};

const GOVERNANCE_SCHEMA_KEYS = new Set([
  "evaluateGovernance", "createPolicy", "createSoDRule", "createFraudRule"
]);

export const governanceSchemas = new Proxy({}, {
  get(_target, prop) {
    if (GOVERNANCE_SCHEMA_KEYS.has(prop)) {
      return buildGovernanceSchemas()[prop];
    }
    return undefined;
  }
});

const buildFinancePlatformSchemas = () => ({
  processFinancialRequest: Joi.object({
    transactionId: Joi.string().trim().min(1).max(100).required(),
    operation: Joi.string().trim().min(1).max(100).required(),
    amount: Joi.number().min(0).optional(),
    creatorId: Joi.string().trim().optional().allow(null, ""),
    approverId: Joi.string().trim().optional().allow(null, ""),
    payload: Joi.object().optional()
  })
});

const FINANCE_PLATFORM_SCHEMA_KEYS = new Set(["processFinancialRequest"]);

export const financePlatformSchemas = new Proxy({}, {
  get(_target, prop) {
    if (FINANCE_PLATFORM_SCHEMA_KEYS.has(prop)) {
      return buildFinancePlatformSchemas()[prop];
    }
    return undefined;
  }
});

const buildCommunicationSchemas = () => ({
  requestCommunication: Joi.object({
    sourceModule: Joi.string().trim().valid("CRM", "Booking", "Travel", "Visa", "Finance", "HR", "Inventory", "Sales", "Procurement", "AI", "System").optional(),
    channel: Joi.string().trim().valid("Email", "SMS", "WhatsApp", "Push", "InApp", "Webhook").required(),
    recipient: Joi.object({
      userId: Joi.string().trim().optional().allow(null, ""),
      email: Joi.string().email({ tlds: false }).lowercase().trim().optional().allow(null, ""),
      phone: Joi.string().trim().optional().allow(null, ""),
      pushToken: Joi.string().trim().optional().allow(null, ""),
      endpointUrl: Joi.string().uri().trim().optional().allow(null, "")
    }).required(),
    templateId: Joi.string().trim().optional().allow(null, ""),
    templateData: Joi.object().optional(),
    locale: Joi.string().trim().min(2).max(10).optional(),
    subject: Joi.string().trim().max(500).optional().allow(null, ""),
    content: Joi.string().trim().max(10000).optional().allow(null, ""),
    priority: Joi.string().trim().valid("Low", "Normal", "High", "Critical").optional(),
    scheduledAt: Joi.date().optional(),
    idempotencyKey: Joi.string().trim().max(100).optional().allow(null, ""),
    topic: Joi.string().trim().max(100).optional().allow(null, ""),
    deepLink: Joi.object({
      screen: Joi.string().trim().max(200).optional().allow(null, ""),
      params: Joi.object().optional()
    }).optional()
  }),

  createTemplate: Joi.object({
    templateId: Joi.string().trim().optional().allow(null, ""),
    locale: Joi.string().trim().min(2).max(10).optional(),
    name: Joi.string().trim().min(1).max(200).required(),
    channel: Joi.string().trim().valid("Email", "SMS", "WhatsApp", "Push", "InApp", "Webhook").required(),
    subjectTemplate: Joi.string().trim().max(500).optional().allow(""),
    bodyTemplate: Joi.string().trim().min(1).required(),
    variables: Joi.array().items(Joi.string().trim()).optional()
  }),

  updateTemplate: Joi.object({
    locale: Joi.string().trim().min(2).max(10).optional(),
    name: Joi.string().trim().min(1).max(200).optional(),
    subjectTemplate: Joi.string().trim().max(500).optional().allow(""),
    bodyTemplate: Joi.string().trim().min(1).optional(),
    variables: Joi.array().items(Joi.string().trim()).optional(),
    // "Active" is deliberately excluded here — a template can only reach
    // Active via approveTemplate() (see CommunicationTemplateService's own
    // doc comment on why a direct status update can't set it).
    status: Joi.string().trim().valid("Draft", "Archived").optional()
  }),

  templateLocaleAction: Joi.object({
    locale: Joi.string().trim().min(2).max(10).optional()
  }),

  rejectTemplate: Joi.object({
    locale: Joi.string().trim().min(2).max(10).optional(),
    reason: Joi.string().trim().min(1).max(1000).required()
  }),

  rollbackTemplate: Joi.object({
    locale: Joi.string().trim().min(2).max(10).optional(),
    toVersion: Joi.number().integer().min(1).required()
  }),

  updateUserPreferences: Joi.object({
    emailOptIn: Joi.boolean().optional(),
    smsOptIn: Joi.boolean().optional(),
    whatsAppOptIn: Joi.boolean().optional(),
    pushOptIn: Joi.boolean().optional(),
    inAppOptIn: Joi.boolean().optional(),
    preferredChannel: Joi.string().trim().valid("Email", "SMS", "WhatsApp", "Push", "InApp").optional(),
    doNotDisturb: Joi.boolean().optional(),
    quietHours: Joi.object({
      start: Joi.string().trim().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).allow(null).optional(),
      end: Joi.string().trim().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).allow(null).optional(),
      timezone: Joi.string().trim().max(64).optional()
    }).optional(),
    subscribedTopics: Joi.array().items(Joi.string().trim().max(100)).optional(),
    unsubscribedTopics: Joi.array().items(Joi.string().trim().max(100)).optional()
  }),

  sendEmail: Joi.object({
    template: Joi.string().trim().optional().allow(null, ""),
    templateId: Joi.string().trim().optional().allow(null, ""),
    to: Joi.alternatives().try(
      Joi.string().email({ tlds: false }).lowercase().trim(),
      Joi.array().items(Joi.string().email({ tlds: false }).lowercase().trim()).min(1)
    ).required(),
    variables: Joi.object().optional(),
    templateData: Joi.object().optional(),
    locale: Joi.string().trim().min(2).max(10).optional(),
    subject: Joi.string().trim().max(500).optional().allow(null, ""),
    content: Joi.string().trim().max(50000).optional().allow(null, ""),
    body: Joi.string().trim().max(50000).optional().allow(null, ""),
    attachments: Joi.array().items(
      Joi.alternatives().try(
        Joi.string().trim(),
        Joi.object({
          filename: Joi.string().trim().required(),
          path: Joi.string().trim().optional(),
          url: Joi.string().uri().trim().optional(),
          content: Joi.string().optional(),
          contentType: Joi.string().trim().optional(),
          size: Joi.number().max(25 * 1024 * 1024).optional()
        })
      )
    ).optional(),
    emailType: Joi.string().trim().valid("Transactional", "Marketing", "System Alert", "Password Reset", "Verification", "Invoice", "Receipt", "Reminder", "Custom").optional(),
    sourceModule: Joi.string().trim().valid("CRM", "Booking", "Travel", "Visa", "Finance", "HR", "Inventory", "Sales", "Procurement", "AI", "System").optional(),
    priority: Joi.string().trim().valid("Low", "Normal", "High", "Critical").optional(),
    scheduledAt: Joi.date().optional(),
    idempotencyKey: Joi.string().trim().max(100).optional().allow(null, "")
  }),

  sendSms: Joi.object({
    phone: Joi.string().trim().required(),
    type: Joi.string().trim().valid("OTP", "Authentication", "Verification", "Invoice", "Payment Reminder", "Booking Confirmation", "Visa Update", "System Alert", "Marketing", "Custom").optional(),
    smsType: Joi.string().trim().valid("OTP", "Authentication", "Verification", "Invoice", "Payment Reminder", "Booking Confirmation", "Visa Update", "System Alert", "Marketing", "Custom").optional(),
    template: Joi.string().trim().optional().allow(null, ""),
    templateId: Joi.string().trim().optional().allow(null, ""),
    variables: Joi.object().optional(),
    templateData: Joi.object().optional(),
    locale: Joi.string().trim().min(2).max(10).optional(),
    message: Joi.string().trim().max(2000).optional().allow(null, ""),
    content: Joi.string().trim().max(2000).optional().allow(null, ""),
    priority: Joi.string().trim().valid("Low", "Normal", "High", "Critical").optional(),
    scheduledAt: Joi.date().optional(),
    sourceModule: Joi.string().trim().valid("CRM", "Booking", "Travel", "Visa", "Finance", "HR", "Inventory", "Sales", "Procurement", "AI", "System").optional(),
    idempotencyKey: Joi.string().trim().max(100).optional().allow(null, "")
  }),

  generateOtp: Joi.object({
    phone: Joi.string().trim().required(),
    purpose: Joi.string().trim().max(100).optional(),
    template: Joi.string().trim().optional().allow(null, ""),
    variables: Joi.object().optional(),
    expiryMinutes: Joi.number().integer().min(1).max(60).optional()
  }),

  verifyOtp: Joi.object({
    phone: Joi.string().trim().required(),
    otp: Joi.alternatives().try(Joi.string().trim(), Joi.number()).required(),
    otpCode: Joi.alternatives().try(Joi.string().trim(), Joi.number()).optional(),
    purpose: Joi.string().trim().optional()
  }),

  createBulkCampaign: Joi.object({
    name: Joi.string().trim().min(1).max(200).required(),
    smsType: Joi.string().trim().valid("Marketing", "Invoice", "Payment Reminder", "Booking Confirmation", "Visa Update", "System Alert", "Custom").optional(),
    templateId: Joi.string().trim().optional().allow(null, ""),
    templateVariables: Joi.object().optional(),
    messageText: Joi.string().trim().max(2000).optional().allow(null, ""),
    recipients: Joi.array().items(
      Joi.alternatives().try(
        Joi.string().trim(),
        Joi.object({ phone: Joi.string().trim().required() })
      )
    ).min(1).required(),
    rateLimitPerSecond: Joi.number().integer().min(1).max(1000).optional(),
    scheduledAt: Joi.date().optional()
  }),

  updateCampaignStatus: Joi.object({
    action: Joi.string().trim().valid("pause", "resume", "cancel").required()
  }),

  sendWhatsApp: Joi.object({
    phone: Joi.string().trim().required(),
    templateId: Joi.string().trim().optional().allow(null, ""),
    templateData: Joi.object().optional(),
    locale: Joi.string().trim().min(2).max(10).optional(),
    content: Joi.string().trim().max(4096).optional().allow(null, ""),
    priority: Joi.string().trim().valid("Low", "Normal", "High", "Critical").optional(),
    scheduledAt: Joi.date().optional(),
    sourceModule: Joi.string().trim().valid("CRM", "Booking", "Travel", "Visa", "Finance", "HR", "Inventory", "Sales", "Procurement", "AI", "System", "PackagePricing").optional(),
    idempotencyKey: Joi.string().trim().max(100).optional().allow(null, "")
  }),

  registerDevice: Joi.object({
    platform: Joi.string().trim().valid("ios", "android", "web").required(),
    token: Joi.string().trim().min(1).required(),
    topics: Joi.array().items(Joi.string().trim().max(100)).optional()
  }),

  archiveMessage: Joi.object({
    reason: Joi.string().trim().min(1).max(500).required()
  }),

  purgeMessage: Joi.object({
    approvedBy: Joi.string().trim().min(1).required(),
    reason: Joi.string().trim().max(500).optional().allow(null, "")
  }),

  applyLegalHold: Joi.object({
    reason: Joi.string().trim().min(1).max(500).required()
  }),

  removeLegalHold: Joi.object({
    holdId: Joi.string().trim().required(),
    removalReason: Joi.string().trim().max(500).optional().allow(null, "")
  }),

  sendPush: Joi.object({
    userId: Joi.string().trim().required(),
    subject: Joi.string().trim().max(200).optional().allow(null, ""),
    content: Joi.string().trim().max(1000).optional().allow(null, ""),
    screen: Joi.string().trim().max(200).optional().allow(null, ""),
    params: Joi.object().optional(),
    priority: Joi.string().trim().valid("Low", "Normal", "High", "Critical").optional(),
    sourceModule: Joi.string().trim().valid("CRM", "Booking", "Travel", "Visa", "Finance", "HR", "Inventory", "Sales", "Procurement", "AI", "System").optional(),
    idempotencyKey: Joi.string().trim().max(100).optional().allow(null, "")
  })
});

const COMMUNICATION_SCHEMA_KEYS = new Set([
  "requestCommunication", "createTemplate", "updateTemplate", "templateLocaleAction", "rejectTemplate", "rollbackTemplate", "updateUserPreferences", "sendEmail",
  "sendSms", "generateOtp", "verifyOtp", "createBulkCampaign", "updateCampaignStatus", "sendWhatsApp",
  "registerDevice", "sendPush", "archiveMessage", "purgeMessage", "applyLegalHold", "removeLegalHold"
]);

export const communicationSchemas = new Proxy({}, {
  get(_target, prop) {
    if (COMMUNICATION_SCHEMA_KEYS.has(prop)) {
      return buildCommunicationSchemas()[prop];
    }
    return undefined;
  }
});

// Reporting Platform Part 8 fix — report template registry (ReportTemplateModel).
export const reportTemplateSchemas = {
  createReportTemplate: Joi.object({
    templateKey: Joi.string().trim().min(1).max(200).required(),
    reportType: Joi.string().trim().min(1).max(200).required(),
    locale: Joi.string().trim().min(2).max(10).optional(),
    htmlBody: Joi.string().trim().min(1).required(),
    brandingConfig: Joi.object({
      logo: Joi.string().trim().max(2000).optional().allow(null, ""),
      colors: Joi.object().optional().allow(null),
      fonts: Joi.object().optional().allow(null)
    }).optional()
  }),

  updateReportTemplate: Joi.object({
    locale: Joi.string().trim().min(2).max(10).optional(),
    htmlBody: Joi.string().trim().min(1).optional(),
    brandingConfig: Joi.object({
      logo: Joi.string().trim().max(2000).optional().allow(null, ""),
      colors: Joi.object().optional().allow(null),
      fonts: Joi.object().optional().allow(null)
    }).optional()
  }),

  templateLocaleAction: Joi.object({
    locale: Joi.string().trim().min(2).max(10).optional()
  })
};

// Reporting Platform Part 5 fix — KPI definition registry (KPIDefinitionModel).
export const kpiDefinitionSchemas = {
  registerKPIDefinition: Joi.object({
    kpiKey: Joi.string().trim().min(1).max(200).required(),
    name: Joi.string().trim().min(1).max(200).required(),
    ownerModule: Joi.string().trim().min(1).max(100).required(),
    category: Joi.string().trim().max(100).optional().allow(null, ""),
    codeRef: Joi.string().trim().min(1).max(300).required(),
    description: Joi.string().trim().max(1000).optional().allow(null, ""),
    unit: Joi.string().trim().max(50).optional().allow(null, ""),
    target: Joi.number().optional().allow(null),
    thresholds: Joi.object({
      warning: Joi.number().optional().allow(null),
      critical: Joi.number().optional().allow(null)
    }).optional()
  }),

  deprecateKPIDefinition: Joi.object({
    ownerModule: Joi.string().trim().min(1).max(100).required()
  })
};

// Reporting Platform Part 2 fix — report catalog registry (ReportCatalogModel).
export const reportCatalogSchemas = {
  registerReportCatalogEntry: Joi.object({
    reportKey: Joi.string().trim().min(1).max(200).required(),
    name: Joi.string().trim().min(1).max(200).required(),
    module: Joi.string().trim().min(1).max(100).required(),
    category: Joi.string().trim().max(100).optional().allow(null, ""),
    tags: Joi.array().items(Joi.string().trim().max(50)).optional(),
    owner: Joi.string().trim().max(200).optional().allow(null, ""),
    description: Joi.string().trim().max(1000).optional().allow(null, ""),
    lifecycleState: Joi.string().trim().max(50).optional(),
    relatedKpiKeys: Joi.array().items(Joi.string().trim().max(200)).optional()
  }),

  transitionReportCatalogLifecycle: Joi.object({
    lifecycleState: Joi.string().trim().min(1).max(50).required(),
    adminOverride: Joi.boolean().optional()
  })
};





export const customerSchemas = {
  createCustomer: Joi.object({
    firstName: Joi.string().trim().min(1).max(100).required().messages({
      'any.required': 'firstName is required',
      'string.empty': 'firstName is required'
    }),
    middleName: Joi.string().trim().max(100).optional().allow(''),
    lastName: Joi.string().trim().min(1).max(100).required().messages({
      'any.required': 'lastName is required',
      'string.empty': 'lastName is required'
    }),
    primaryEmail: Joi.string().email({ tlds: false }).lowercase().trim().max(255).optional(),
    email: Joi.string().email({ tlds: false }).lowercase().trim().max(255).optional(),
    primaryPhone: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).optional().messages({ "string.pattern.base": "primaryPhone must be a valid number (E.164 format, e.g. +923001234567)." }),
    phone: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).optional().messages({ "string.pattern.base": "phone must be a valid number (E.164 format, e.g. +923001234567)." }),
    alternatePhone: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).optional().allow('').messages({ "string.pattern.base": "alternatePhone must be a valid number (E.164 format, e.g. +923001234567)." }),
    type: Joi.string().trim().max(100).optional(),
    customerType: Joi.string().trim().max(100).optional(),
    category: Joi.string().trim().max(100).optional(),
    status: Joi.string().trim().max(100).optional(),
    title: Joi.string().trim().max(50).optional().allow(''),
    companyName: Joi.string().trim().max(200).optional().allow(''),
    dateOfBirth: Joi.date().optional(),
    gender: Joi.string().trim().max(20).optional(),
    maritalStatus: Joi.string().trim().max(30).optional(),
    nationality: Joi.string().trim().max(100).optional(),
    nationalId: Joi.string().trim().max(100).optional().allow(''),
    nationalityId: Joi.string().trim().max(100).optional(),
    preferredLanguageId: Joi.string().trim().max(100).optional(),
    preferredLanguage: Joi.string().trim().max(50).optional(),
    preferredCurrency: Joi.string().trim().max(50).optional(),
    marketingConsent: Joi.boolean().optional(),
    profilePhoto: Joi.string().trim().max(500).optional().allow(''),
    timezone: Joi.string().trim().max(100).optional(),
    address: Joi.object().optional(),
    passports: Joi.array().items(Joi.object()).optional(),
    emergencyContacts: Joi.array().items(Joi.object()).optional(),
    mahramInformation: Joi.object().optional(),
    medicalInformation: Joi.object().optional(),
    assignedTo: Joi.string().trim().max(100).optional().allow(''),
    tags: Joi.array().items(Joi.string()).optional(),
    notes: Joi.string().trim().max(2000).optional().allow(''),
    createAnyway: Joi.boolean().optional()
  }).custom((value, helpers) => {
    const resolvedEmail = value.primaryEmail || value.email;
    const resolvedPhone = value.primaryPhone || value.phone;
    if (!resolvedEmail) {
      return helpers.message('primaryEmail is required');
    }
    if (!resolvedPhone) {
      return helpers.message('primaryPhone is required');
    }
    return value;
  }),

  updateCustomer: Joi.object({
    firstName: Joi.string().trim().min(1).max(100).optional(),
    middleName: Joi.string().trim().max(100).optional().allow(''),
    lastName: Joi.string().trim().min(1).max(100).optional(),
    title: Joi.string().trim().max(100).optional().allow(''),
    companyName: Joi.string().trim().max(200).optional().allow(''),
    type: Joi.string().trim().max(100).optional(),
    category: Joi.string().trim().max(100).optional(),
    status: Joi.string().trim().max(100).optional(),
    phone: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).optional().allow('').messages({ "string.pattern.base": "phone must be a valid number (E.164 format, e.g. +923001234567)." }),
    alternatePhone: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).optional().allow('').messages({ "string.pattern.base": "alternatePhone must be a valid number (E.164 format, e.g. +923001234567)." }),
    email: Joi.string().email({ tlds: false }).lowercase().trim().max(255).optional(),
    primaryEmail: Joi.string().email({ tlds: false }).lowercase().trim().max(255).optional(),
    primaryPhone: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).optional().allow('').messages({ "string.pattern.base": "primaryPhone must be a valid number (E.164 format, e.g. +923001234567)." }),
    nationalId: Joi.string().trim().max(100).optional().allow(''),
    gender: Joi.string().trim().max(20).optional(),
    dateOfBirth: Joi.date().optional(),
    maritalStatus: Joi.string().trim().max(30).optional(),
    nationality: Joi.string().trim().max(100).optional(),
    preferredLanguage: Joi.string().trim().max(50).optional(),
    preferredCurrency: Joi.string().trim().max(50).optional(),
    marketingConsent: Joi.boolean().optional(),
    profilePhoto: Joi.string().trim().max(500).optional().allow(''),
    timezone: Joi.string().trim().max(100).optional(),
    address: Joi.object({
      street: Joi.string().trim().max(255).optional().allow(''),
      city: Joi.string().trim().max(100).optional().allow(''),
      state: Joi.string().trim().max(100).optional().allow(''),
      postalCode: Joi.string().trim().max(20).optional().allow(''),
      country: Joi.string().trim().max(100).optional().allow('')
    }).optional(),
    assignedTo: Joi.string().trim().max(100).optional().allow(''),
    tags: Joi.array().items(Joi.string()).optional(),
    notes: Joi.string().trim().max(2000).optional().allow('')
  }).unknown(true).custom((value) => {
    // Array-type sub-resources are edited only through their dedicated
    // endpoints (/passports, /emergency-contacts, /phones, /emails, /addresses).
    const disallowed = ['passports', 'emergencyContacts', 'mahramInformation', 'medicalInformation', 'phones', 'emails', 'addresses'];
    disallowed.forEach((key) => {
      delete value[key];
    });
    return value;
  }),

  customerPreferences: Joi.object({
    preferredLanguage: Joi.string().trim().max(50).optional(),
    preferredCurrency: Joi.string().trim().max(50).optional(),
    preferredCommunicationChannel: Joi.string().trim().max(50).optional(),
    communicationChannel: Joi.string().trim().max(50).optional(),
    preferredAirline: Joi.string().trim().max(100).optional().allow(''),
    preferredHotelCategory: Joi.string().trim().max(100).optional().allow(''),
    hotelPreferences: Joi.array().items(Joi.string()).optional(),
    mealPreference: Joi.string().trim().max(100).optional(),
    seatPreference: Joi.string().trim().max(100).optional(),
    specialAssistance: Joi.string().trim().max(200).optional().allow(''),
    wheelchairAssistance: Joi.boolean().optional(),
    marketingConsent: Joi.boolean().optional(),
    notificationPreferences: Joi.object().optional()
  }),

  customerNote: Joi.object({
    content: Joi.string().trim().min(1).max(4000).required(),
    category: Joi.string().trim().max(100).optional(),
    visibility: Joi.string().trim().max(50).optional(),
    isImportant: Joi.boolean().optional(),
    attachments: Joi.array().items(Joi.object()).optional()
  }),

  customerDocument: Joi.object({
    documentType: Joi.string().trim().max(100).optional(),
    documentNumber: Joi.string().trim().max(100).optional().allow(''),
    storageProvider: Joi.string().trim().max(50).required(),
    // Client uploads directly to the configured storage backend and only
    // registers the resulting key here — a raw fileUrl is never accepted;
    // the download URL is always computed server-side (signed, short-lived).
    storageKey: Joi.string().trim().min(1).max(500).required(),
    fileName: Joi.string().trim().min(1).max(255).required(),
    mimeType: Joi.string().trim().max(100).optional(),
    size: Joi.number().integer().min(1).optional(),
    fileSize: Joi.number().integer().min(1).optional(),
    expiryDate: Joi.date().optional(),
    notes: Joi.string().trim().max(2000).optional().allow('')
  }),

  customerDocumentReject: Joi.object({
    reason: Joi.string().trim().min(1).max(500).required()
  }),

  customerEmergencyContact: Joi.object({
    name: Joi.string().trim().min(1).max(200).required(),
    relationship: Joi.string().trim().min(1).max(100).required(),
    phone: Joi.string().trim().max(50).optional().allow(''),
    email: Joi.string().email({ tlds: false }).lowercase().trim().max(255).optional().allow(''),
    country: Joi.string().trim().max(100).optional().allow(''),
    priority: Joi.number().integer().min(1).max(10).optional(),
    preferredContactMethod: Joi.string().trim().max(50).optional().allow(''),
    isPrimary: Joi.boolean().optional()
  }),

  customerFamilyMember: Joi.object({
    relationship: Joi.string().trim().min(1).max(100).required(),
    fullName: Joi.string().trim().min(1).max(200).optional(),
    firstName: Joi.string().trim().min(1).max(100).optional(),
    lastName: Joi.string().trim().min(1).max(100).optional(),
    gender: Joi.string().trim().max(20).optional(),
    dateOfBirth: Joi.date().optional(),
    isTraveler: Joi.boolean().optional(),
    passportNumber: Joi.string().trim().max(100).optional().allow(''),
    phone: Joi.string().trim().max(50).optional().allow(''),
    email: Joi.string().email({ tlds: false }).lowercase().trim().max(255).optional().allow('')
  }).or('fullName', 'firstName'),

  customerFamilyMemberUpdate: Joi.object({
    relationship: Joi.string().trim().min(1).max(100).optional(),
    firstName: Joi.string().trim().min(1).max(100).optional(),
    lastName: Joi.string().trim().min(1).max(100).optional(),
    gender: Joi.string().trim().max(20).optional(),
    dateOfBirth: Joi.date().optional(),
    isTraveler: Joi.boolean().optional(),
    passportNumber: Joi.string().trim().max(100).optional().allow(''),
    phone: Joi.string().trim().max(50).optional().allow(''),
    email: Joi.string().email({ tlds: false }).lowercase().trim().max(255).optional().allow('')
  }),

  customerFamilyMemberPromote: Joi.object({
    primaryEmail: Joi.string().email({ tlds: false }).lowercase().trim().max(255).optional(),
    primaryPhone: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).optional().messages({ "string.pattern.base": "primaryPhone must be a valid number (E.164 format, e.g. +923001234567)." })
  }),

  customerPassport: Joi.object({
    passportNumber: Joi.string().trim().min(1).max(100).required(),
    countryId: Joi.string().trim().max(100).optional(),
    countryOfIssue: Joi.string().trim().min(1).max(100).optional(),
    issueDate: Joi.date().required(),
    expiryDate: Joi.date().required(),
    placeOfIssue: Joi.string().trim().min(1).max(200).required(),
    isPrimary: Joi.boolean().optional(),
    status: Joi.string().trim().max(50).optional()
  }).or('countryId', 'countryOfIssue'),

  customerPassportUpdate: Joi.object({
    placeOfIssue: Joi.string().trim().min(1).max(200).optional(),
    expiryDate: Joi.date().optional(),
    isPrimary: Joi.boolean().optional(),
    status: Joi.string().trim().valid('active', 'expiring_soon', 'expired', 'cancelled', 'lost', 'renewed').optional()
  }),

  customerPhone: Joi.object({
    number: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).required().messages({ "string.pattern.base": "number must be a valid phone number (E.164 format, e.g. +923001234567)." }),
    label: Joi.string().trim().valid('mobile', 'home', 'work', 'other').optional(),
    isPrimary: Joi.boolean().optional()
  }),

  customerPhoneUpdate: Joi.object({
    number: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).optional().messages({ "string.pattern.base": "number must be a valid phone number (E.164 format, e.g. +923001234567)." }),
    label: Joi.string().trim().valid('mobile', 'home', 'work', 'other').optional(),
    isPrimary: Joi.boolean().optional()
  }),

  customerEmail: Joi.object({
    address: Joi.string().email({ tlds: false }).lowercase().trim().max(255).required(),
    label: Joi.string().trim().valid('personal', 'work', 'other').optional(),
    isPrimary: Joi.boolean().optional()
  }),

  customerEmailUpdate: Joi.object({
    address: Joi.string().email({ tlds: false }).lowercase().trim().max(255).optional(),
    label: Joi.string().trim().valid('personal', 'work', 'other').optional(),
    isPrimary: Joi.boolean().optional()
  }),

  customerAddress: Joi.object({
    type: Joi.string().trim().valid('home', 'work', 'billing', 'mailing', 'other').optional(),
    street: Joi.string().trim().max(255).optional().allow(''),
    city: Joi.string().trim().max(100).optional().allow(''),
    state: Joi.string().trim().max(100).optional().allow(''),
    postalCode: Joi.string().trim().max(20).optional().allow(''),
    country: Joi.string().trim().max(100).optional().allow(''),
    isPrimary: Joi.boolean().optional()
  }),

  customerMerge: Joi.object({
    primaryCustomerId: Joi.string().trim().min(1).max(100).required(),
    duplicateCustomerId: Joi.string().trim().min(1).max(100).required()
  })
};

// Enterprise Subscription Platform — same env-driven Proxy pattern as
// currencySchemas/customerCollectionSchemas above, so plan-tier/billing-cycle
// validity stays config-driven rather than hardcoded here.
const buildPlatformSchemas = () => {
  const config = getPlatformConfig();
  return {
    createPlan: Joi.object({
      planCode: Joi.string().trim().min(1).max(30).required(),
      name: Joi.string().trim().min(1).max(150).required(),
      tier: Joi.string().trim().valid(...config.planTiers).required(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      pricing: Joi.object({
        currency: Joi.string().trim().optional(),
        monthly: Joi.number().min(0).optional().allow(null),
        quarterly: Joi.number().min(0).optional().allow(null),
        yearly: Joi.number().min(0).optional().allow(null)
      }).optional(),
      limits: Joi.object({
        maxUsers: Joi.number().integer().min(0).optional().allow(null),
        maxStorageGB: Joi.number().min(0).optional().allow(null),
        maxApiCallsPerDay: Joi.number().integer().min(0).optional().allow(null),
        maxProjects: Joi.number().integer().min(0).optional().allow(null),
        maxEmployees: Joi.number().integer().min(0).optional().allow(null),
        aiCreditsPerMonth: Joi.number().integer().min(0).optional().allow(null)
      }).optional(),
      features: Joi.object().pattern(Joi.string(), Joi.boolean()).optional(),
      trialDays: Joi.number().integer().min(0).optional().allow(null),
      gracePeriodDays: Joi.number().integer().min(0).optional().allow(null),
      supportLevel: Joi.string().trim().valid(...config.supportLevels).optional().allow(null, ""),
      backupFrequency: Joi.string().trim().valid(...config.backupFrequencies).optional().allow(null, ""),
      isSellable: Joi.boolean().optional(),
      isCustom: Joi.boolean().optional(),
      sortOrder: Joi.number().integer().optional()
    }),

    updatePlan: Joi.object({
      name: Joi.string().trim().min(1).max(150).optional(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      pricing: Joi.object({
        currency: Joi.string().trim().optional(),
        monthly: Joi.number().min(0).optional().allow(null),
        quarterly: Joi.number().min(0).optional().allow(null),
        yearly: Joi.number().min(0).optional().allow(null)
      }).optional(),
      limits: Joi.object().optional(),
      features: Joi.object().pattern(Joi.string(), Joi.boolean()).optional(),
      trialDays: Joi.number().integer().min(0).optional().allow(null),
      gracePeriodDays: Joi.number().integer().min(0).optional().allow(null),
      supportLevel: Joi.string().trim().valid(...config.supportLevels).optional().allow(null, ""),
      backupFrequency: Joi.string().trim().valid(...config.backupFrequencies).optional().allow(null, ""),
      isSellable: Joi.boolean().optional(),
      sortOrder: Joi.number().integer().optional()
    }),

    startTrial: Joi.object({
      planId: objectIdRef.required()
    }),

    createSubscription: Joi.object({
      planId: objectIdRef.required(),
      billingCycle: Joi.string().trim().valid(...config.billingCycles).required()
    }),

    cancelSubscription: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    setupBillingAccount: Joi.object({
      billingContactName: Joi.string().trim().min(1).max(150).required(),
      billingContactEmail: Joi.string().trim().email().required(),
      billingContactPhone: Joi.string().trim().max(30).optional().allow(null, ""),
      taxNumber: Joi.string().trim().max(50).optional().allow(null, ""),
      billingAddress: Joi.object({
        line1: Joi.string().trim().max(255).optional().allow(null, ""),
        city: Joi.string().trim().max(100).optional().allow(null, ""),
        country: Joi.string().trim().max(100).optional().allow(null, ""),
        postalCode: Joi.string().trim().max(20).optional().allow(null, "")
      }).optional(),
      paymentMethod: Joi.string().trim().valid(...config.billingPaymentMethods).optional(),
      manualPaymentDetails: Joi.object({
        accountTitle: Joi.string().trim().optional().allow(null, ""),
        accountNumber: Joi.string().trim().optional().allow(null, ""),
        bankOrProviderName: Joi.string().trim().optional().allow(null, "")
      }).optional()
    }),

    payInvoiceManually: Joi.object({
      reference: Joi.string().trim().max(200).optional().allow(null, "")
    }),

    adminSuspend: Joi.object({
      reason: Joi.string().trim().min(1).max(1000).required()
    }),

    // Enterprise Merchant & Billing Platform (Improvement 3).
    createMerchant: Joi.object({
      organisationName: Joi.string().trim().min(1).max(200).required(),
      legalName: Joi.string().trim().max(200).optional().allow(null, ""),
      taxNumber: Joi.string().trim().max(50).optional().allow(null, ""),
      registrationNumber: Joi.string().trim().max(50).optional().allow(null, ""),
      country: Joi.string().trim().max(100).optional().allow(null, ""),
      primaryContact: Joi.object({
        name: Joi.string().trim().optional().allow(null, ""),
        email: Joi.string().trim().email().optional().allow(null, ""),
        phone: Joi.string().trim().optional().allow(null, "")
      }).optional(),
      billingEmail: Joi.string().trim().email().required()
    }),

    merchantSuspend: Joi.object({
      reason: Joi.string().trim().min(1).max(1000).required()
    }),

    addPaymentMethod: Joi.object({
      paymentMethod: Joi.string().trim().valid(...config.billingPaymentMethods).required(),
      stripePaymentMethodId: Joi.string().trim().optional().allow(null, ""),
      manualPaymentDetails: Joi.object({
        accountTitle: Joi.string().trim().optional().allow(null, ""),
        accountNumber: Joi.string().trim().optional().allow(null, ""),
        bankOrProviderName: Joi.string().trim().optional().allow(null, "")
      }).optional()
    }),

    walletOperation: Joi.object({
      merchantId: objectIdRef.required(),
      balanceType: Joi.string().trim().valid(...config.walletBalanceTypes).optional(),
      amount: Joi.number().greater(0).optional(),
      currency: Joi.string().trim().optional()
    }),

    merchantRefund: Joi.object({
      merchantId: objectIdRef.required(),
      amount: Joi.number().greater(0).required(),
      currency: Joi.string().trim().required(),
      reason: Joi.string().trim().min(1).max(1000).required(),
      referenceId: Joi.string().trim().optional().allow(null, "")
    })
  };
};

const PLATFORM_SCHEMA_KEYS = new Set(["createPlan", "updatePlan", "startTrial", "createSubscription", "cancelSubscription", "setupBillingAccount", "payInvoiceManually", "adminSuspend", "createMerchant", "merchantSuspend", "addPaymentMethod", "walletOperation", "merchantRefund"]);

export const platformSchemas = new Proxy({}, {
  get(_target, prop) {
    if (PLATFORM_SCHEMA_KEYS.has(prop)) {
      return buildPlatformSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Organisation Structure Platform (Improvement 4). Same
// config-driven-Proxy pattern as buildPlatformSchemas above — status
// enums come from utils/organisationConfig.js so an env override takes
// effect without a schema-caching bug.
const buildOrganisationSchemas = () => {
  const config = getOrganisationConfig();
  const addressSchema = Joi.object({
    line1: Joi.string().trim().max(255).optional().allow(null, ""),
    city: Joi.string().trim().max(100).optional().allow(null, ""),
    country: Joi.string().trim().max(100).optional().allow(null, ""),
    postalCode: Joi.string().trim().max(20).optional().allow(null, "")
  });

  return {
    createOrganisation: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      industry: Joi.string().trim().max(100).optional().allow(null, "")
    }),
    updateOrganisation: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      industry: Joi.string().trim().max(100).optional().allow(null, ""),
      status: Joi.string().trim().valid(...config.organisationStatuses).optional()
    }),

    createLegalEntity: Joi.object({
      organisationId: objectIdRef.required(),
      name: Joi.string().trim().min(1).max(200).required(),
      registrationNumber: Joi.string().trim().max(50).optional().allow(null, ""),
      taxNumber: Joi.string().trim().max(50).optional().allow(null, ""),
      country: Joi.string().trim().max(100).optional().allow(null, ""),
      reportingCurrency: Joi.string().trim().max(10).optional().allow(null, "")
    }),
    updateLegalEntity: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      registrationNumber: Joi.string().trim().max(50).optional().allow(null, ""),
      taxNumber: Joi.string().trim().max(50).optional().allow(null, ""),
      country: Joi.string().trim().max(100).optional().allow(null, ""),
      reportingCurrency: Joi.string().trim().max(10).optional().allow(null, ""),
      status: Joi.string().trim().valid(...config.legalEntityStatuses).optional()
    }),

    createBusinessUnit: Joi.object({
      legalEntityId: objectIdRef.required(),
      name: Joi.string().trim().min(1).max(200).required(),
      description: Joi.string().trim().max(1000).optional().allow(null, "")
    }),
    updateBusinessUnit: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      status: Joi.string().trim().valid(...config.businessUnitStatuses).optional()
    }),

    createCompany: Joi.object({
      legalEntityId: objectIdRef.required(),
      businessUnitId: objectIdRef.optional().allow(null, ""),
      name: Joi.string().trim().min(1).max(200).required(),
      registrationNumber: Joi.string().trim().max(50).optional().allow(null, ""),
      taxNumber: Joi.string().trim().max(50).optional().allow(null, ""),
      country: Joi.string().trim().max(100).optional().allow(null, ""),
      currency: Joi.string().trim().max(10).optional().allow(null, "")
    }),
    updateCompany: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      registrationNumber: Joi.string().trim().max(50).optional().allow(null, ""),
      taxNumber: Joi.string().trim().max(50).optional().allow(null, ""),
      country: Joi.string().trim().max(100).optional().allow(null, ""),
      currency: Joi.string().trim().max(10).optional().allow(null, ""),
      status: Joi.string().trim().valid(...config.companyStatuses).optional()
    }),

    createBranch: Joi.object({
      companyId: objectIdRef.required(),
      name: Joi.string().trim().min(1).max(200).required(),
      address: addressSchema.optional()
    }),
    updateBranch: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      address: addressSchema.optional()
    }),
    closeBranch: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    createDepartment: Joi.object({
      companyId: objectIdRef.optional().allow(null, ""),
      branchId: objectIdRef.optional().allow(null, ""),
      name: Joi.string().trim().min(1).max(200).required(),
      description: Joi.string().trim().max(1000).optional().allow(null, "")
    }),
    updateDepartment: Joi.object({
      companyId: objectIdRef.optional().allow(null, ""),
      branchId: objectIdRef.optional().allow(null, ""),
      name: Joi.string().trim().min(1).max(200).optional(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      status: Joi.string().trim().valid("active", "inactive", "suspended", "deleted").optional()
    }),

    createTeam: Joi.object({
      departmentId: objectIdRef.required(),
      name: Joi.string().trim().min(1).max(200).required(),
      description: Joi.string().trim().max(1000).optional().allow(null, "")
    }),
    updateTeam: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      description: Joi.string().trim().max(1000).optional().allow(null, ""),
      status: Joi.string().trim().valid(...config.teamStatuses).optional()
    })
  };
};

const ORGANISATION_SCHEMA_KEYS = new Set([
  "createOrganisation", "updateOrganisation",
  "createLegalEntity", "updateLegalEntity",
  "createBusinessUnit", "updateBusinessUnit",
  "createCompany", "updateCompany",
  "createBranch", "updateBranch", "closeBranch",
  "createDepartment", "updateDepartment",
  "createTeam", "updateTeam"
]);

export const organisationSchemas = new Proxy({}, {
  get(_target, prop) {
    if (ORGANISATION_SCHEMA_KEYS.has(prop)) {
      return buildOrganisationSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Identity & Global Resource ID Platform (Improvement 5).
// resourceType is deliberately NOT restricted to
// config.resourceTypeCatalog — see utils/numberingConfig.js's own doc
// comment on why it stays a free string (the spec's own "Configurable
// Formats" requirement covers resource types this codebase doesn't know
// about yet, not just the seeded catalog).
const buildNumberingSchemas = () => {
  const config = getNumberingConfig();

  return {
    createScheme: Joi.object({
      resourceType: Joi.string().trim().min(1).max(100).required(),
      companyId: objectIdRef.optional().allow(null, ""),
      branchId: objectIdRef.optional().allow(null, ""),
      prefix: Joi.string().trim().min(1).max(20).required(),
      separator: Joi.string().trim().max(3).allow("").optional(),
      includeYear: Joi.boolean().optional(),
      includeCompany: Joi.boolean().optional(),
      includeBranch: Joi.boolean().optional(),
      sequenceLength: Joi.number().integer().min(1).max(12).optional(),
      fiscalYearStartMonth: Joi.number().integer().min(1).max(12).optional(),
      allowGaps: Joi.boolean().optional(),
      isDefault: Joi.boolean().optional()
    }),
    updateScheme: Joi.object({
      prefix: Joi.string().trim().min(1).max(20).optional(),
      separator: Joi.string().trim().max(3).allow("").optional(),
      includeYear: Joi.boolean().optional(),
      includeCompany: Joi.boolean().optional(),
      includeBranch: Joi.boolean().optional(),
      sequenceLength: Joi.number().integer().min(1).max(12).optional(),
      fiscalYearStartMonth: Joi.number().integer().min(1).max(12).optional(),
      allowGaps: Joi.boolean().optional(),
      isDefault: Joi.boolean().optional(),
      status: Joi.string().trim().valid(...config.schemeStatuses).optional()
    }),
    resetSequence: Joi.object({
      key: Joi.string().trim().min(1).max(20).required(),
      newValue: Joi.number().integer().min(0).required()
    }),

    generateNumber: Joi.object({
      resourceType: Joi.string().trim().min(1).max(100).required(),
      companyId: objectIdRef.optional().allow(null, ""),
      branchId: objectIdRef.optional().allow(null, ""),
      legalEntityId: objectIdRef.optional().allow(null, ""),
      resourceUuid: Joi.string().trim().max(100).optional().allow(null, "")
    }),
    registerResource: Joi.object({
      resourceUuid: Joi.string().trim().min(1).max(100).required()
    }),
    rollbackSequence: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    })
  };
};

const NUMBERING_SCHEMA_KEYS = new Set(["createScheme", "updateScheme", "resetSequence", "generateNumber", "registerResource", "rollbackSequence"]);

export const numberingSchemas = new Proxy({}, {
  get(_target, prop) {
    if (NUMBERING_SCHEMA_KEYS.has(prop)) {
      return buildNumberingSchemas()[prop];
    }
    return undefined;
  }
});

// Booking-module PRD Part C item #14 — "required-field validation... Company
// Name" (Document 4 §24). Deliberately not a Proxy/config-driven schema like
// bookingSchemas/numberingSchemas above — nothing here reads from a
// get*Config() function, so a plain static object matches customerSchemas'
// own convention instead.
export const tenantProfileSchemas = {
  createOrUpdateProfile: Joi.object({
    companyName: Joi.string().trim().min(1).max(200).required().messages({
      'any.required': 'companyName is required',
      'string.empty': 'companyName is required'
    }),
    registrationNumber: Joi.string().trim().max(100).optional().allow(null, ''),
    // Distinct from registrationNumber (Commercial Registration) — see
    // TenantProfileModel.js's own doc comment.
    licenseNumber: Joi.string().trim().max(100).optional().allow(null, ''),
    vatNumber: Joi.string().trim().max(100).optional().allow(null, ''),
    companyNameArabic: Joi.string().trim().max(200).optional().allow(null, ''),
    address: Joi.string().trim().max(500).optional().allow(null, ''),
    city: Joi.string().trim().max(100).optional().allow(null, ''),
    country: Joi.string().trim().max(100).optional().allow(null, ''),
    phone: Joi.string().trim().max(50).optional().allow(null, ''),
    email: Joi.string().trim().email().optional().allow(null, ''),
    defaultBankAccountId: objectIdRef.optional().allow(null, ''),
    primaryColor: Joi.string().trim().max(20).optional().allow(null, ''),
    secondaryColor: Joi.string().trim().max(20).optional().allow(null, ''),
    customDomain: Joi.string().trim().lowercase().max(255).optional().allow(null, ''),
    publicSlug: Joi.string().trim().lowercase().min(1).max(63).pattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/).optional().allow(null, ''),
    documentSettings: Joi.object({
      invoiceDisplayName: Joi.string().trim().max(200).optional().allow(null, ''),
      termsAndConditions: Joi.string().trim().max(5000).optional().allow(null, ''),
      cancellationPolicy: Joi.string().trim().max(5000).optional().allow(null, ''),
      operationalContacts: Joi.string().trim().max(2000).optional().allow(null, ''),
      tagline: Joi.string().trim().max(200).optional().allow(null, ''),
      greetingText: Joi.string().trim().max(2000).optional().allow(null, '')
    }).optional()
  }),
  updateSettings: Joi.object({
    notificationPreferences: Joi.object({
      email: Joi.boolean().optional(),
      sms: Joi.boolean().optional(),
      whatsapp: Joi.boolean().optional()
    }).optional(),
    backupEnabled: Joi.boolean().optional(),
    backupFrequency: Joi.string().trim().valid('Daily', 'Weekly', 'Monthly').optional()
  })
};

// Public B2C Booking Site (PRD "CRM Feature Map by Phase" Phase 2 module
// 15) — routes/PublicBookingRoutes.js's request bodies. Plain object, not
// the config-driven Proxy pattern used elsewhere in this file: nothing
// here needs an env-configurable enum, it's the same fixed shape either way.
export const publicBookingSchemas = {
  createBooking: Joi.object({
    tenantSlug: Joi.string().trim().lowercase().min(1).max(63).required(),
    packageTemplateId: objectIdRef.required(),
    travelStartDate: Joi.date().required(),
    travelers: Joi.object({
      adults: Joi.number().integer().min(1).optional(),
      children: Joi.number().integer().min(0).optional(),
      infants: Joi.number().integer().min(0).optional()
    }).optional(),
    roomTypeId: objectIdRef.optional().allow(null, ""),
    customer: Joi.object({
      firstName: Joi.string().trim().min(1).max(100).required(),
      lastName: Joi.string().trim().min(1).max(100).required(),
      email: Joi.string().trim().email({ tlds: false }).required(),
      phone: Joi.string().trim().min(5).max(30).required()
    }).required()
  }),

  createLead: Joi.object({
    tenantSlug: Joi.string().trim().lowercase().min(1).max(63).required(),
    firstName: Joi.string().trim().min(1).max(100).required(),
    lastName: Joi.string().trim().max(100).optional().allow(null, ""),
    email: Joi.string().trim().email({ tlds: false }).optional().allow(null, ""),
    phone: Joi.string().trim().min(5).max(30).optional().allow(null, ""),
    notes: Joi.string().trim().max(2000).optional().allow(null, "")
  })
};

// Package Pricing Engine — Global-Package-Pricing-Engine-PRD-v2.1. Same
// config-driven Proxy pattern as pricingSchemas/numberingSchemas above; every
// `.valid(...)` list is pulled from getPackagePricingConfig() rather than a
// literal array, so a new rateBasis/chargeBasis/scope value only needs a
// config change, never a schema edit.
const buildPackagePricingSchemas = () => {
  const config = getPackagePricingConfig();
  const hotelConfig = getHotelConfig();
  const rateStatus = Joi.string().trim().valid(...config.rateStatuses).optional();
  const rateSource = Joi.string().trim().valid(...config.rateSourceTypes).optional();

  return {
    createRoomType: Joi.object({
      name: Joi.string().trim().min(1).max(100).required(),
      defaultOccupancy: Joi.number().integer().min(1).required(),
      sortOrder: Joi.number().integer().optional()
    }),

    createTransportVehicle: Joi.object({
      name: Joi.string().trim().min(1).max(100).required(),
      minCapacity: Joi.number().integer().min(1).required(),
      maxCapacity: Joi.number().integer().min(1).required(),
      luggageCapacity: Joi.number().min(0).optional().allow(null),
      category: Joi.string().trim().max(100).optional().allow(null, "")
    }),

    // PRD §8 "Hotel Database" — hotel master data, distinct from
    // createHotelRate's hotel-x-room-type-x-date rate rows.
    createHotelCatalog: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      city: Joi.string().trim().min(1).max(150).required(),
      country: Joi.string().trim().max(150).optional().allow(null, ""),
      starRating: Joi.number().integer().min(1).max(5).optional(),
      address: Joi.string().trim().max(500).optional().allow(null, ""),
      supplier: Joi.string().trim().max(200).optional().allow(null, ""),
      amenities: Joi.array().items(Joi.string().trim().max(150)).optional(),
      contacts: Joi.object({
        phone: Joi.string().trim().max(50).optional().allow(null, ""),
        email: Joi.string().trim().email().optional().allow(null, ""),
        managerName: Joi.string().trim().max(150).optional().allow(null, "")
      }).optional(),
      latitude: Joi.number().min(-90).max(90).optional().allow(null),
      longitude: Joi.number().min(-180).max(180).optional().allow(null),
      distanceFromLandmark: Joi.object({
        label: Joi.string().trim().max(150).optional().allow(null, ""),
        km: Joi.number().min(0).optional().allow(null)
      }).optional().allow(null),
      distanceFromAirport: Joi.number().min(0).optional().allow(null),
      checkInTime: Joi.string().trim().max(20).optional().allow(null, ""),
      checkOutTime: Joi.string().trim().max(20).optional().allow(null, ""),
      description: Joi.string().trim().max(5000).optional().allow(null, ""),
      images: Joi.array().items(Joi.string().trim().max(2000)).optional(),
      logoUrl: Joi.string().trim().max(2000).optional().allow(null, ""),
      shuttleAvailable: Joi.boolean().optional(),
      mealPlansOffered: Joi.array().items(Joi.string().trim().valid(...hotelConfig.mealPlans)).optional(),
      cancellationPolicy: Joi.string().trim().max(2000).optional().allow(null, ""),
      supplierHotelCode: Joi.string().trim().max(100).optional().allow(null, "")
    }),

    createHotelRate: Joi.object({
      hotelCatalogId: objectIdRef.required(),
      roomTypeId: objectIdRef.required(),
      mealPlan: Joi.string().trim().max(100).optional().allow(null, ""),
      currency: Joi.string().trim().length(3).uppercase().required(),
      pricePerNight: Joi.number().min(0).required(),
      occupancy: Joi.number().integer().min(1).required(),
      rateBasis: Joi.string().trim().valid(...config.hotelRateBasisTypes).required(),
      date: Joi.date().optional().allow(null),
      validFrom: Joi.date().optional().allow(null),
      validTo: Joi.date().optional().allow(null),
      daysOfWeek: Joi.array().items(Joi.number().integer().min(0).max(6)).optional(),
      season: Joi.string().trim().max(100).optional().allow(null, ""),
      supplier: Joi.string().trim().max(200).optional().allow(null, ""),
      extraBedRate: Joi.number().min(0).optional().allow(null),
      extraBedBasis: Joi.string().trim().valid(...config.extraBedBasisTypes).optional().allow(null, ""),
      maxExtraBeds: Joi.number().integer().min(0).optional(),
      status: rateStatus,
      source: rateSource
    }),

    createTransportRate: Joi.object({
      origin: Joi.string().trim().min(1).max(200).required(),
      destination: Joi.string().trim().min(1).max(200).required(),
      vehicleId: objectIdRef.required(),
      currency: Joi.string().trim().length(3).uppercase().required(),
      rate: Joi.number().min(0).required(),
      direction: Joi.string().trim().valid(...config.transportDirectionTypes).optional(),
      validFrom: Joi.date().optional().allow(null),
      validTo: Joi.date().optional().allow(null),
      supplier: Joi.string().trim().max(200).optional().allow(null, ""),
      status: rateStatus,
      source: rateSource
    }),

    createFlightRate: Joi.object({
      route: Joi.string().trim().min(1).max(200).required(),
      airline: Joi.string().trim().max(200).optional().allow(null, ""),
      cabin: Joi.string().trim().max(100).optional().allow(null, ""),
      currency: Joi.string().trim().length(3).uppercase().required(),
      costPerPerson: Joi.number().min(0).required(),
      direction: Joi.string().trim().valid(...config.transportDirectionTypes).optional(),
      validFrom: Joi.date().optional().allow(null),
      validTo: Joi.date().optional().allow(null),
      status: rateStatus,
      source: rateSource
    }),

    createVisaRate: Joi.object({
      country: Joi.string().trim().min(1).max(100).required(),
      visaType: Joi.string().trim().min(1).max(100).required(),
      nationality: Joi.string().trim().max(100).optional().allow(null, ""),
      currency: Joi.string().trim().length(3).uppercase().required(),
      adultCost: Joi.number().min(0).required(),
      childCost: Joi.number().min(0).optional().allow(null),
      infantCost: Joi.number().min(0).optional().allow(null),
      processingTime: Joi.string().trim().max(100).optional().allow(null, ""),
      validFrom: Joi.date().optional().allow(null),
      validTo: Joi.date().optional().allow(null),
      status: rateStatus,
      source: rateSource
    }),

    createServiceRate: Joi.object({
      name: Joi.string().trim().min(1).max(150).required(),
      chargeBasis: Joi.string().trim().valid(...config.serviceChargeBasisTypes).required(),
      currency: Joi.string().trim().length(3).uppercase().required(),
      amount: Joi.number().min(0).required(),
      validFrom: Joi.date().optional().allow(null),
      validTo: Joi.date().optional().allow(null),
      status: rateStatus,
      source: rateSource
    }),

    createMarkupRule: Joi.object({
      name: Joi.string().trim().max(150).optional().allow(null, ""),
      scope: Joi.string().trim().valid(...config.markupScopeTypes).required(),
      type: Joi.string().trim().valid(...config.markupTypes).required(),
      value: Joi.number().min(0).required(),
      priceListType: Joi.string().trim().valid(...config.priceListTypes).required()
    }),

    createSupplier: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      category: Joi.string().trim().valid(...config.supplierCategories).required(),
      contactName: Joi.string().trim().max(150).optional().allow(null, ""),
      phone: Joi.string().trim().max(50).optional().allow(null, ""),
      email: Joi.string().trim().email().optional().allow(null, ""),
      currency: Joi.string().trim().length(3).uppercase().optional().allow(null, ""),
      notes: Joi.string().trim().max(2000).optional().allow(null, "")
    }),

    createCommissionRule: Joi.object({
      name: Joi.string().trim().max(150).optional().allow(null, ""),
      scope: Joi.string().trim().valid(...config.commissionScopeTypes).required(),
      type: Joi.string().trim().valid(...config.markupTypes).required(),
      value: Joi.number().min(0).required(),
      agentUserId: Joi.string().trim().optional().allow(null, ""),
      destinationCountry: Joi.string().trim().max(150).optional().allow(null, ""),
      hotelCatalogId: objectIdRef.optional().allow(null, "")
    }),

    // Generic partial-update body shared by every rate/master PATCH route —
    // each service method only reads the fields relevant to its own model,
    // so this stays permissive rather than duplicating every model's full
    // create schema with everything optional.
    updateRecord: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    }).unknown(true),

    createQuotation: Joi.object({
      roomTypeId: objectIdRef.required(),
      paymentTerms: Joi.string().trim().max(2000).optional().allow(null, ""),
      validUntil: Joi.date().optional().allow(null),
      termsAndConditions: Joi.string().trim().max(5000).optional().allow(null, "")
    }),

    linkBooking: Joi.object({
      bookingId: objectIdRef.required()
    }),

    bulkCreateRates: Joi.object({
      items: Joi.array().items(Joi.object().unknown(true)).min(1).required()
    }),

    bulkUpdateRateStatus: Joi.object({
      ids: Joi.array().items(objectIdRef).min(1).required(),
      status: Joi.string().trim().valid(...config.rateStatuses).required(),
      reason: Joi.string().trim().max(500).optional().allow(null, "")
    }),

    cloneRate: Joi.object().unknown(true),

    saveAsTemplate: Joi.object({
      name: Joi.string().trim().min(1).max(200).required()
    }),

    updatePackageTemplate: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      description: Joi.string().trim().max(2000).optional().allow(null, ""),
      active: Joi.boolean().optional(),
      publicVisible: Joi.boolean().optional(),
      packageType: Joi.string().trim().max(100).optional().allow(null, ""),
      images: Joi.array().items(Joi.string().trim().uri()).max(20).optional(),
      displayPriceFrom: Joi.number().min(0).optional().allow(null),
      displayCurrency: Joi.string().trim().length(3).uppercase().optional().allow(null, "")
    }),

    cloneFromTemplate: Joi.object({
      travelStartDate: Joi.date().required(),
      name: Joi.string().trim().max(200).optional().allow(null, ""),
      customerId: objectIdRef.optional().allow(null, ""),
      agentUserId: Joi.string().trim().optional().allow(null, ""),
      travelers: Joi.object({
        adults: Joi.number().integer().min(1).optional(),
        children: Joi.number().integer().min(0).optional(),
        infants: Joi.number().integer().min(0).optional()
      }).optional()
    }),

    comparePackages: Joi.object({
      packageIds: Joi.array().items(objectIdRef).min(2).required()
    }),

    convertToBooking: Joi.object({
      roomTypeId: objectIdRef.required(),
      rooms: Joi.number().integer().min(1).optional(),
      bookingId: objectIdRef.optional().allow(null, ""),
      bookingType: Joi.string().trim().optional().allow(null, "")
    }),

    generateFlyer: Joi.object({
      template: Joi.string().trim().valid(...config.flyerTemplates).optional(),
      format: Joi.string().trim().valid(...config.flyerFormats).optional(),
      dimensionPreset: Joi.string().trim().valid(...Object.keys(config.flyerDimensionPresets)).optional(),
      roomTypeIds: Joi.array().items(objectIdRef).optional(),
      language: Joi.string().trim().lowercase().optional(),
      displayCurrency: Joi.string().trim().length(3).uppercase().optional().allow(null, "")
    }),

    sendWhatsAppMessage: Joi.object({
      phone: Joi.string().trim().max(30).optional().allow(null, ""),
      roomTypeIds: Joi.array().items(objectIdRef).optional()
    }),

    sendQuotation: Joi.object({
      channel: Joi.string().trim().valid("email", "whatsapp", "both").optional(),
      email: Joi.string().trim().email({ tlds: false }).optional().allow(null, ""),
      phone: Joi.string().trim().max(30).optional().allow(null, ""),
      message: Joi.string().trim().max(2000).optional().allow(null, "")
    }),

    convertQuotationToBooking: Joi.object({
      rooms: Joi.number().integer().min(1).optional(),
      bookingId: objectIdRef.optional().allow(null, ""),
      bookingType: Joi.string().trim().optional().allow(null, "")
    }),

    updatePackage: Joi.object({
      name: Joi.string().trim().max(200).optional().allow(null, ""),
      customerId: objectIdRef.optional().allow(null, ""),
      agentUserId: Joi.string().trim().optional().allow(null, ""),
      travelStartDate: Joi.date().optional(),
      travelEndDate: Joi.date().optional(),
      travelers: Joi.object({
        adults: Joi.number().integer().min(1).optional(),
        children: Joi.number().integer().min(0).optional(),
        infants: Joi.number().integer().min(0).optional()
      }).optional(),
      segments: Joi.array().items(Joi.object({
        city: Joi.string().trim().min(1).max(150).required(),
        country: Joi.string().trim().max(150).optional().allow(null, ""),
        hotelCatalogId: objectIdRef.required(),
        checkIn: Joi.date().required(),
        checkOut: Joi.date().required(),
        mealPlan: Joi.string().trim().max(100).optional().allow(null, ""),
        rooms: Joi.number().integer().min(1).optional(),
        extraBeds: Joi.number().integer().min(0).optional(),
        sortOrder: Joi.number().integer().optional()
      })).optional(),
      transportLegs: Joi.array().items(Joi.object({
        origin: Joi.string().trim().min(1).max(200).required(),
        destination: Joi.string().trim().min(1).max(200).required(),
        direction: Joi.string().trim().valid(...config.transportDirectionTypes).optional().allow(null),
        vehicleId: objectIdRef.optional().allow(null),
        sortOrder: Joi.number().integer().optional()
      })).optional(),
      flightSelections: Joi.array().items(Joi.object({ flightRateId: objectIdRef.required() })).optional(),
      visaSelections: Joi.array().items(Joi.object({ visaRateId: objectIdRef.required() })).optional(),
      serviceSelections: Joi.array().items(Joi.object({
        serviceRateId: objectIdRef.required(),
        quantity: Joi.number().min(0).optional()
      })).optional(),
      vehicleSelectionRule: Joi.string().trim().valid(...config.vehicleSelectionRules).optional(),
      priceListType: Joi.string().trim().valid(...config.priceListTypes).optional(),
      sellingCurrency: Joi.string().trim().length(3).uppercase().optional(),
      markupRuleIds: Joi.array().items(objectIdRef).optional(),
      commissionRuleIds: Joi.array().items(objectIdRef).optional(),
      roundingRule: Joi.string().trim().valid(...config.roundingRuleTypes).optional(),
      discount: Joi.object({
        type: Joi.string().trim().valid(...config.discountTypes).required(),
        value: Joi.number().min(0).required(),
        scope: Joi.string().trim().valid(...config.discountScopeTypes).optional().allow(null, ""),
        reason: Joi.string().trim().max(500).optional().allow(null, "")
      }).optional().allow(null),
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    createPackage: Joi.object({
      name: Joi.string().trim().max(200).optional().allow(null, ""),
      customerId: objectIdRef.optional().allow(null, ""),
      agentUserId: Joi.string().trim().optional().allow(null, ""),
      travelStartDate: Joi.date().required(),
      travelEndDate: Joi.date().required(),
      travelers: Joi.object({
        adults: Joi.number().integer().min(1).required(),
        children: Joi.number().integer().min(0).optional(),
        infants: Joi.number().integer().min(0).optional()
      }).required(),
      segments: Joi.array().items(Joi.object({
        city: Joi.string().trim().min(1).max(150).required(),
        country: Joi.string().trim().max(150).optional().allow(null, ""),
        hotelCatalogId: objectIdRef.required(),
        checkIn: Joi.date().required(),
        checkOut: Joi.date().required(),
        mealPlan: Joi.string().trim().max(100).optional().allow(null, ""),
        rooms: Joi.number().integer().min(1).optional(),
        extraBeds: Joi.number().integer().min(0).optional(),
        sortOrder: Joi.number().integer().optional()
      })).optional(),
      transportLegs: Joi.array().items(Joi.object({
        origin: Joi.string().trim().min(1).max(200).required(),
        destination: Joi.string().trim().min(1).max(200).required(),
        direction: Joi.string().trim().valid(...config.transportDirectionTypes).optional().allow(null),
        vehicleId: objectIdRef.optional().allow(null),
        sortOrder: Joi.number().integer().optional()
      })).optional(),
      flightSelections: Joi.array().items(Joi.object({ flightRateId: objectIdRef.required() })).optional(),
      visaSelections: Joi.array().items(Joi.object({ visaRateId: objectIdRef.required() })).optional(),
      serviceSelections: Joi.array().items(Joi.object({
        serviceRateId: objectIdRef.required(),
        quantity: Joi.number().min(0).optional()
      })).optional(),
      vehicleSelectionRule: Joi.string().trim().valid(...config.vehicleSelectionRules).optional(),
      priceListType: Joi.string().trim().valid(...config.priceListTypes).optional(),
      sellingCurrency: Joi.string().trim().length(3).uppercase().required(),
      markupRuleIds: Joi.array().items(objectIdRef).optional(),
      commissionRuleIds: Joi.array().items(objectIdRef).optional(),
      roundingRule: Joi.string().trim().valid(...config.roundingRuleTypes).optional(),
      discount: Joi.object({
        type: Joi.string().trim().valid(...config.discountTypes).required(),
        value: Joi.number().min(0).required(),
        scope: Joi.string().trim().valid(...config.discountScopeTypes).optional().allow(null, ""),
        reason: Joi.string().trim().max(500).optional().allow(null, "")
      }).optional().allow(null)
    }),

    calculatePackage: Joi.object({
      recalculate: Joi.boolean().optional()
    })
  };
};

const PACKAGE_PRICING_SCHEMA_KEYS = new Set([
  "createRoomType", "createTransportVehicle", "createHotelCatalog", "createHotelRate", "createTransportRate", "createFlightRate", "createVisaRate",
  "createServiceRate", "createMarkupRule", "createSupplier", "createCommissionRule", "updateRecord", "createPackage",
  "updatePackage", "linkBooking", "convertToBooking", "createQuotation", "sendQuotation", "convertQuotationToBooking", "generateFlyer", "sendWhatsAppMessage", "calculatePackage", "comparePackages",
  "saveAsTemplate", "updatePackageTemplate", "cloneFromTemplate", "bulkCreateRates", "bulkUpdateRateStatus", "cloneRate"
]);

export const packagePricingSchemas = new Proxy({}, {
  get(_target, prop) {
    if (PACKAGE_PRICING_SCHEMA_KEYS.has(prop)) {
      return buildPackagePricingSchemas()[prop];
    }
    return undefined;
  }
});

// Lead & Marketing Management — PRD "CRM Feature Map by Phase" Phase 2
// module 17. Same env-driven-config-backed Proxy pattern as
// packagePricingSchemas above, rebuilt from getLeadConfig() on every
// access so a LEAD_STATUSES_JSON/LEAD_SOURCES_JSON env change takes effect
// without a restart-sensitive schema cache.
const buildLeadSchemas = () => {
  const config = getLeadConfig();
  return {
    createLead: Joi.object({
      firstName: Joi.string().trim().min(1).max(200).required(),
      lastName: Joi.string().trim().max(200).optional().allow(null, ''),
      email: Joi.string().trim().email({ tlds: false }).optional().allow(null, ''),
      phone: Joi.string().trim().max(30).optional().allow(null, ''),
      source: Joi.string().trim().valid(...config.leadSources).optional(),
      status: Joi.string().trim().valid(...config.leadStatuses).optional(),
      assignedToUserId: Joi.string().trim().optional().allow(null, ''),
      followUpDate: Joi.date().optional().allow(null),
      interestedInPackageId: objectIdRef.optional().allow(null, ''),
      notes: Joi.string().trim().max(5000).optional().allow(null, ''),
      tags: Joi.array().items(Joi.string().trim()).optional()
    }),
    updateLead: Joi.object({
      firstName: Joi.string().trim().min(1).max(200).optional(),
      lastName: Joi.string().trim().max(200).optional().allow(null, ''),
      email: Joi.string().trim().email({ tlds: false }).optional().allow(null, ''),
      phone: Joi.string().trim().max(30).optional().allow(null, ''),
      source: Joi.string().trim().valid(...config.leadSources).optional(),
      status: Joi.string().trim().valid(...config.leadStatuses).optional(),
      assignedToUserId: Joi.string().trim().optional().allow(null, ''),
      followUpDate: Joi.date().optional().allow(null),
      interestedInPackageId: objectIdRef.optional().allow(null, ''),
      notes: Joi.string().trim().max(5000).optional().allow(null, ''),
      tags: Joi.array().items(Joi.string().trim()).optional()
    }),
    convertLead: Joi.object({
      firstName: Joi.string().trim().min(1).max(200).optional(),
      lastName: Joi.string().trim().min(1).max(200).optional(),
      email: Joi.string().trim().email({ tlds: false }).optional(),
      phone: Joi.string().trim().max(30).optional(),
      customerFields: Joi.object().unknown(true).optional()
    })
  };
};

const LEAD_SCHEMA_KEYS = new Set(["createLead", "updateLead", "convertLead"]);

// Developer Portal — PRD "CRM Feature Map by Phase" Phase 4 module 33.
export const apiKeySchemas = {
  createApiKey: Joi.object({
    name: Joi.string().trim().min(1).max(200).required(),
    permissions: Joi.array().items(Joi.string().trim()).optional(),
    expiresAt: Joi.date().optional().allow(null)
  })
};

// B2B Agent Portal — PRD "CRM Feature Map by Phase" Phase 2 module 14.
export const agentSchemas = {
  createAgent: Joi.object({
    name: Joi.string().trim().min(1).max(200).required(),
    email: Joi.string().trim().email({ tlds: false }).required(),
    phone: Joi.string().trim().max(30).optional().allow(null, ''),
    password: Joi.string().min(1).required(),
    parentAgentId: objectIdRef.optional().allow(null, ''),
    creditLimit: Joi.number().min(0).optional()
  }),
  agentLogin: Joi.object({
    email: Joi.string().trim().email({ tlds: false }).required(),
    password: Joi.string().min(1).required()
  })
};

// Embassy/consulate contact directory (PRD "CRM Feature Map by Phase"
// Phase 4 module 40 — Emergency Support).
export const embassyDirectorySchemas = {
  createEmbassyContact: Joi.object({
    embassyId: Joi.string().trim().min(1).max(100).required(),
    name: Joi.string().trim().min(1).max(200).required(),
    processingCenterType: Joi.string().trim().valid("Embassy", "Consulate", "VAC", "Authorized_Partner", "Government_Portal").required(),
    countryId: Joi.string().trim().min(1).max(100).required(),
    city: Joi.string().trim().max(100).optional().allow(null, ''),
    phone: Joi.string().trim().max(30).optional().allow(null, ''),
    email: Joi.string().trim().email({ tlds: false }).optional().allow(null, ''),
    address: Joi.string().trim().max(500).optional().allow(null, ''),
    emergencyContactPhone: Joi.string().trim().max(30).optional().allow(null, '')
  }),
  updateEmbassyContact: Joi.object({
    name: Joi.string().trim().min(1).max(200).optional(),
    processingCenterType: Joi.string().trim().valid("Embassy", "Consulate", "VAC", "Authorized_Partner", "Government_Portal").optional(),
    city: Joi.string().trim().max(100).optional().allow(null, ''),
    phone: Joi.string().trim().max(30).optional().allow(null, ''),
    email: Joi.string().trim().email({ tlds: false }).optional().allow(null, ''),
    address: Joi.string().trim().max(500).optional().allow(null, ''),
    emergencyContactPhone: Joi.string().trim().max(30).optional().allow(null, ''),
    isActive: Joi.boolean().optional()
  })
};

// Review & Rating System (PRD "CRM Feature Map by Phase" Phase 4 module 40).
export const reviewSchemas = {
  createReview: Joi.object({
    bookingId: objectIdRef.required(),
    packageRating: Joi.number().integer().min(1).max(5).optional().allow(null),
    hotelRating: Joi.number().integer().min(1).max(5).optional().allow(null),
    guideRating: Joi.number().integer().min(1).max(5).optional().allow(null),
    driverRating: Joi.number().integer().min(1).max(5).optional().allow(null),
    comment: Joi.string().trim().max(5000).optional().allow(null, '')
  }),
  moderateReview: Joi.object({
    status: Joi.string().trim().valid("published", "hidden").required()
  })
};

export const leadSchemas = new Proxy({}, {
  get(_target, prop) {
    if (LEAD_SCHEMA_KEYS.has(prop)) {
      return buildLeadSchemas()[prop];
    }
    return undefined;
  }
});

// Marketing Campaign System (PRD "CRM Feature Map by Phase" Phase 2 module
// 20) — routes/MarketingCampaignRoutes.js. Plain object, same as
// publicBookingSchemas above: nothing here is env-configurable.
export const marketingCampaignSchemas = {
  createCampaign: Joi.object({
    name: Joi.string().trim().min(1).max(200).required(),
    channel: Joi.string().trim().valid("Email", "SMS", "WhatsApp").required(),
    templateId: Joi.string().trim().min(1).max(200).required(),
    segmentFilter: Joi.object({
      customerType: Joi.string().trim().optional().allow(null, ""),
      category: Joi.string().trim().optional().allow(null, ""),
      status: Joi.string().trim().optional().allow(null, ""),
      assignedTo: Joi.string().trim().optional().allow(null, ""),
      countryId: Joi.string().trim().optional().allow(null, ""),
      cityId: Joi.string().trim().optional().allow(null, ""),
      createdAfter: Joi.date().optional().allow(null, ""),
      createdBefore: Joi.date().optional().allow(null, "")
    }).optional(),
    scheduledAt: Joi.date().optional().allow(null, "")
  })
};

export default validate;
