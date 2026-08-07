import Joi from "joi";
import { sendError } from "../utils/apiResponse.js";
import { getBookingConfig } from "../utils/bookingConfig.js";

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
    branchName: Joi.string().trim().max(200).optional().allow(""),
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
    branchId: Joi.string().trim().min(1).max(100).required(),
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

  branchAssignment: Joi.object({
    branchId: Joi.string().trim().min(1).max(100).required(),
  }),

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
    branchId: Joi.string().trim().min(1).max(100).required(),
    departmentId: Joi.string().trim().min(1).max(100).required(),
    designation: Joi.string().trim().max(100).optional().allow(""),
  }),

  acceptInvitation: Joi.object({
    token: Joi.string().trim().min(1).max(512).required(),
    username: Joi.string().trim().min(2).max(100).required(),
    password: Joi.string().min(6).max(128).required(),
  }),
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
      branchId: Joi.string().trim().min(1).max(100).optional(),
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
      branchId: Joi.string().trim().min(1).max(100).optional(),
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
    branchId: Joi.string().trim().max(100).optional(),
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
