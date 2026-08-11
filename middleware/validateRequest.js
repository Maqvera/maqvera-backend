import Joi from "joi";
import { sendError } from "../utils/apiResponse.js";
import { getBookingConfig } from "../utils/bookingConfig.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

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
    defaultServicePriority: bookingConfig.defaultServicePriority
  };
};

const validate = (schema, property = "body") => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], { abortEarly: false, stripUnknown: true });
    if (error) {
      const messages = error.details.map((d) => d.message).join("; ");
      return sendError(res, 400, messages, req.requestId);
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
  }),

  login: Joi.object({
    email: Joi.string().email({ tlds: false }).lowercase().trim().max(255).required().messages({
      "string.email": "Valid email is required",
      "any.required": "Email is required",
    }),
    password: Joi.string().min(1).max(128).required().messages({
      "any.required": "Password is required",
    }),
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
    firstName: Joi.string().trim().min(1).max(100).required(),
    lastName: Joi.string().trim().min(1).max(100).required(),
    email: Joi.string().email({ tlds: false }).lowercase().trim().max(255).required(),
    phone: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).optional().allow("").messages({ "string.pattern.base": "Phone must be a valid number (E.164 format, e.g. +923001234567)." }),
    departmentId: Joi.string().trim().min(1).max(100).required(),
    roleIds: Joi.array().items(Joi.string()).optional(),
    role: Joi.string().trim().max(100).optional(),
    designation: Joi.string().trim().max(100).optional().allow(""),
    joiningDate: Joi.date().optional(),
  }).or("role", "roleIds"),

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
    firstName: Joi.string().trim().min(1).max(100).required(),
    lastName: Joi.string().trim().min(1).max(100).required(),
    phone: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).optional().allow("").messages({ "string.pattern.base": "Phone must be a valid number (E.164 format, e.g. +923001234567)." }),
    role: Joi.string().trim().max(100).optional(),
    departmentId: Joi.string().trim().min(1).max(100).required(),
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
    defaultServicePriority
  } = getBookingValidationValues();

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
    details: Joi.object().optional().default({})
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

  return {
    createAccount: Joi.object({
      accountCode: Joi.string().trim().min(1).max(50).required(),
      name: Joi.string().trim().min(1).max(200).required(),
      description: Joi.string().trim().max(1000).optional().allow(""),
      category: Joi.string().trim().valid(...config.accountCategories).required(),
      type: Joi.string().trim().valid(...config.accountTypes).optional(),
      parentId: objectIdRef.optional().allow(null, ""),
      status: Joi.string().trim().valid(...config.accountStatuses).optional(),
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).optional(),
      allowPosting: Joi.boolean().optional(),
      tags: Joi.array().items(Joi.string().trim().max(50)).optional()
    }),

    updateAccount: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      description: Joi.string().trim().max(1000).optional().allow(""),
      status: Joi.string().trim().valid(...config.accountStatuses).optional(),
      parentId: objectIdRef.optional().allow(null, ""),
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).optional(),
      allowPosting: Joi.boolean().optional(),
      tags: Joi.array().items(Joi.string().trim().max(50)).optional()
    }).min(1)
  };
};

const ACCOUNT_SCHEMA_KEYS = new Set(["createAccount", "updateAccount"]);

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
  description: Joi.string().trim().max(500).optional().allow("")
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
      })).optional()
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
      })).optional()
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
    })
  };
};

const JOURNAL_SCHEMA_KEYS = new Set(["createJournal", "updateJournal", "rejectJournal", "reverseJournal"]);

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

  return {
    createVendor: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      contactEmail: Joi.string().trim().email({ tlds: false }).optional().allow(""),
      contactPhone: Joi.string().trim().max(50).optional().allow(""),
      currency: Joi.string().trim().uppercase().valid(...config.supportedCurrencies.map((c) => c.toUpperCase())).required(),
      paymentTermsDays: Joi.number().integer().min(0).optional()
    })
  };
};

const VENDOR_SCHEMA_KEYS = new Set(["createVendor"]);

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
      category: Joi.string().trim().valid(...config.expenseCategories).required(),
      amount: Joi.number().greater(0).optional(),
      currency: Joi.string().trim().valid(...config.supportedCurrencies).required(),
      expenseDate: Joi.date().required(),
      description: Joi.string().trim().min(1).max(1000).required(),
      paymentMethod: Joi.string().trim().valid(...config.expensePaymentMethods).optional(),
      corporateCard: corporateCardSchema.optional(),
      perDiem: perDiemSchema.optional(),
      mileage: mileageSchema.optional()
    }),

    updateExpense: Joi.object({
      category: Joi.string().trim().valid(...config.expenseCategories).optional(),
      amount: Joi.number().greater(0).optional(),
      description: Joi.string().trim().min(1).max(1000).optional(),
      expenseDate: Joi.date().optional(),
      department: objectIdRef.optional().allow(null, ""),
      projectId: Joi.string().trim().optional().allow(null, ""),
      costCenter: Joi.string().trim().optional().allow(null, ""),
      paymentMethod: Joi.string().trim().valid(...config.expensePaymentMethods).optional().allow(null, "")
    }),

    verifyReceipt: Joi.object({
      status: Joi.string().trim().valid("Verified", "Duplicate", "Rejected").required(),
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
    })
  };
};

const EXPENSE_SCHEMA_KEYS = new Set(["createExpense", "updateExpense", "verifyReceipt", "approve", "reject", "returnExpense", "cancel", "reimburse", "createBudget"]);

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
      priority: Joi.string().trim().optional().allow(null, "")
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
    createCollectionRequest: Joi.object({
      customerId: objectIdRef.required(),
      invoiceIds: Joi.array().items(objectIdRef).min(1).required(),
      paymentDueDate: Joi.date().required(),
      preferredMethod: Joi.string().trim().optional().allow(null, ""),
      generatePaymentLink: Joi.boolean().optional()
    }),

    collectPayment: Joi.object({
      amount: Joi.number().greater(0).optional(),
      paymentMethod: Joi.string().trim().optional().allow(null, ""),
      installmentNumber: Joi.number().integer().min(1).optional().allow(null)
    }),

    createInstallmentPlan: Joi.object({
      installmentCount: Joi.number().integer().min(1).optional(),
      frequency: Joi.string().trim().valid(...config.installmentFrequencies).required(),
      startDate: Joi.date().optional(),
      customSchedule: Joi.array().items(Joi.object({
        dueDate: Joi.date().required(),
        amount: Joi.number().greater(0).required()
      })).optional()
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
    })
  };
};

const CUSTOMER_COLLECTION_SCHEMA_KEYS = new Set(["createCollectionRequest", "collectPayment", "createInstallmentPlan", "sendReminder", "dispute", "writeOff", "cancel", "createDeposit"]);

export const customerCollectionSchemas = new Proxy({}, {
  get(_target, prop) {
    if (CUSTOMER_COLLECTION_SCHEMA_KEYS.has(prop)) {
      return buildCustomerCollectionSchemas()[prop];
    }
    return undefined;
  }
});

// Enterprise Multi-Currency & Foreign Exchange (Part 19). Same
// config-driven Proxy pattern as every other Finance schema group. No
// `branchId`/`branch` field anywhere.
const buildCurrencySchemas = () => {
  const config = getFinanceConfig();

  return {
    createCurrency: Joi.object({
      currencyCode: Joi.string().trim().uppercase().length(3).required(),
      name: Joi.string().trim().max(100).optional(),
      symbol: Joi.string().trim().max(8).optional().allow(null, ""),
      decimalPlaces: Joi.number().integer().min(0).max(4).optional(),
      baseCurrency: Joi.boolean().optional()
    }),

    suspend: Joi.object({
      reason: Joi.string().trim().max(1000).optional().allow(null, "")
    }),

    createExchangeRate: Joi.object({
      fromCurrency: Joi.string().trim().uppercase().length(3).required(),
      toCurrency: Joi.string().trim().uppercase().length(3).required(),
      rate: Joi.number().greater(0).required(),
      effectiveDate: Joi.date().required(),
      rateType: Joi.string().trim().valid(...config.exchangeRateTypes).optional(),
      provider: Joi.string().trim().valid(...config.rateProviders).optional()
    }),

    importRates: Joi.object({
      baseCurrency: Joi.string().trim().uppercase().length(3).optional()
    }),

    runRevaluation: Joi.object({
      revaluationDate: Joi.date().optional()
    })
  };
};

const CURRENCY_SCHEMA_KEYS = new Set(["createCurrency", "suspend", "createExchangeRate", "importRates", "runRevaluation"]);

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
    }).unknown(true)
  };
};

const FINANCIAL_ANALYTICS_SCHEMA_KEYS = new Set(["runAnalysis"]);

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

export default validate;
