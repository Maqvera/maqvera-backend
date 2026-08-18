import express from "express";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import { requireFeature, subscriptionResponseHeaders } from "../middleware/subscriptionEnforcement.js";
import validate, { customerSchemas } from "../middleware/validateRequest.js";
import rateLimit from "express-rate-limit";
import {
  ListCustomers,
  SearchCustomers,
  CreateCustomer,
  GetCustomer,
  UpdateCustomer,
  ArchiveCustomer,
  MergeCustomers,
  GetCustomerVersions,
  GetCustomerTimeline,
  GetCustomerNotes,
  AddCustomerNote,
  ArchiveCustomerNote,
  GetCustomerDocuments,
  AddCustomerDocument,
  VerifyCustomerDocument,
  RejectCustomerDocument,
  DeleteCustomerDocument,
  GetCustomerEmergencyContacts,
  AddCustomerEmergencyContact,
  UpdateCustomerEmergencyContact,
  DeleteCustomerEmergencyContact,
  GetCustomerFamily,
  AddCustomerFamilyMember,
  UpdateCustomerFamilyMember,
  DeleteCustomerFamilyMember,
  PromoteCustomerFamilyMember,
  GetCustomerPassports,
  AddCustomerPassport,
  UpdateCustomerPassport,
  GetCustomerPhones,
  AddCustomerPhone,
  UpdateCustomerPhone,
  DeleteCustomerPhone,
  GetCustomerEmails,
  AddCustomerEmail,
  UpdateCustomerEmail,
  DeleteCustomerEmail,
  GetCustomerAddresses,
  AddCustomerAddress,
  UpdateCustomerAddress,
  DeleteCustomerAddress,
  GetCustomerPreferences,
  UpdateCustomerPreferences,
  GetCustomerStatistics,
  GetCustomerBookings,
  GetCustomerAccountStatement
} from "../controllers/CustomerController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again after 15 minutes.'
});

router.use(authenticateAccessToken);
// Enterprise Subscription Platform — "Refactor Pattern 1... CRM Enabled?
// YES -> Continue." See routes/FinanceRoutes.js's own doc comment for
// the full reasoning; Customer is this codebase's real CRM-domain module.
router.use(requireFeature("crm"));
router.use(subscriptionResponseHeaders);

// Fast search & merge operations
router.get("/search", limiter, SearchCustomers);
router.post("/merge", limiter, validate(customerSchemas.customerMerge), MergeCustomers);

// Customer CRUD
router.get("/", limiter, ListCustomers);
router.post("/", limiter, validate(customerSchemas.createCustomer), CreateCustomer);
router.get("/:customerId", limiter, GetCustomer);
router.patch("/:customerId", limiter, validate(customerSchemas.updateCustomer), UpdateCustomer);
router.post("/:customerId/archive", limiter, ArchiveCustomer);

// Profile Version History
router.get("/:customerId/versions", limiter, GetCustomerVersions);

// Sub-resource endpoints
router.get("/:customerId/timeline", limiter, GetCustomerTimeline);

router.get("/:customerId/notes", limiter, GetCustomerNotes);
router.post("/:customerId/notes", limiter, validate(customerSchemas.customerNote), AddCustomerNote);
router.post("/:customerId/notes/:noteId/archive", limiter, ArchiveCustomerNote);

router.get("/:customerId/documents", limiter, GetCustomerDocuments);
router.post("/:customerId/documents", limiter, validate(customerSchemas.customerDocument), AddCustomerDocument);
router.post("/:customerId/documents/:documentId/verify", limiter, VerifyCustomerDocument);
router.post("/:customerId/documents/:documentId/reject", limiter, validate(customerSchemas.customerDocumentReject), RejectCustomerDocument);
router.delete("/:customerId/documents/:documentId", limiter, DeleteCustomerDocument);

router.get("/:customerId/emergency-contacts", limiter, GetCustomerEmergencyContacts);
router.post("/:customerId/emergency-contacts", limiter, validate(customerSchemas.customerEmergencyContact), AddCustomerEmergencyContact);
router.patch("/:customerId/emergency-contacts/:contactId", limiter, validate(customerSchemas.customerEmergencyContact), UpdateCustomerEmergencyContact);
router.delete("/:customerId/emergency-contacts/:contactId", limiter, DeleteCustomerEmergencyContact);

router.get("/:customerId/family", limiter, GetCustomerFamily);
router.post("/:customerId/family", limiter, validate(customerSchemas.customerFamilyMember), AddCustomerFamilyMember);
router.patch("/:customerId/family/:memberId", limiter, validate(customerSchemas.customerFamilyMemberUpdate), UpdateCustomerFamilyMember);
router.delete("/:customerId/family/:memberId", limiter, DeleteCustomerFamilyMember);
router.post("/:customerId/family/:memberId/promote", limiter, validate(customerSchemas.customerFamilyMemberPromote), PromoteCustomerFamilyMember);

router.get("/:customerId/passports", limiter, GetCustomerPassports);
router.post("/:customerId/passports", limiter, validate(customerSchemas.customerPassport), AddCustomerPassport);
router.patch("/:customerId/passports/:passportId", limiter, validate(customerSchemas.customerPassportUpdate), UpdateCustomerPassport);

router.get("/:customerId/phones", limiter, GetCustomerPhones);
router.post("/:customerId/phones", limiter, validate(customerSchemas.customerPhone), AddCustomerPhone);
router.patch("/:customerId/phones/:phoneId", limiter, validate(customerSchemas.customerPhoneUpdate), UpdateCustomerPhone);
router.delete("/:customerId/phones/:phoneId", limiter, DeleteCustomerPhone);

router.get("/:customerId/emails", limiter, GetCustomerEmails);
router.post("/:customerId/emails", limiter, validate(customerSchemas.customerEmail), AddCustomerEmail);
router.patch("/:customerId/emails/:emailId", limiter, validate(customerSchemas.customerEmailUpdate), UpdateCustomerEmail);
router.delete("/:customerId/emails/:emailId", limiter, DeleteCustomerEmail);

router.get("/:customerId/addresses", limiter, GetCustomerAddresses);
router.post("/:customerId/addresses", limiter, validate(customerSchemas.customerAddress), AddCustomerAddress);
router.patch("/:customerId/addresses/:addressId", limiter, validate(customerSchemas.customerAddress), UpdateCustomerAddress);
router.delete("/:customerId/addresses/:addressId", limiter, DeleteCustomerAddress);

router.get("/:customerId/preferences", limiter, GetCustomerPreferences);
router.patch("/:customerId/preferences", limiter, validate(customerSchemas.customerPreferences), UpdateCustomerPreferences);

router.get("/:customerId/statistics", limiter, GetCustomerStatistics);
router.get("/:customerId/bookings", limiter, GetCustomerBookings);
router.get("/:customerId/account-statement", limiter, GetCustomerAccountStatement);

export default router;
