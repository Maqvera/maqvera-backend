import BookingOneClickAutomationService from "../services/BookingOneClickAutomationService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

// One-Click Automation Engine (PRD "CRM Feature Map by Phase" Phase 3
// module 22) — a separate, small controller file (not added onto
// controllers/BookingController.js) specifically so
// BookingOneClickAutomationService can import BookingController's
// GenerateBookingInvoice without creating a circular import back into
// this file.
const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("not found")) return 404;
  if (message.includes("required")) return 400;
  return 500;
};

/**
 * POST /api/v1/bookings/:bookingId/one-click-complete
 * Body: { visa?: {countryId|destinationCountry, visaTypeId|visaType, travelPurpose?, priority?}, invoice?: {dueDate?}, whatsapp?: {templateId?} }
 */
export const RunOneClickAutomation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("admin") && !permissions.includes("booking.automation.run")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const userId = req.auth?.userId || req.auth?.id || null;
    const run = await BookingOneClickAutomationService.run(req.params.bookingId, req.body || {}, scope.tenantId, userId, requestId);
    return sendSuccess(res, 200, run.status === "completed" ? "Automation completed." : "Automation completed with some steps failed — see steps for detail.", run, requestId);
  } catch (error) {
    console.error("RunOneClickAutomation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to run one-click automation.", requestId);
  }
};

export const ListOneClickAutomationRuns = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes("admin") && !permissions.includes("booking.automation.run") && !permissions.includes("bookings.read") && !permissions.includes("booking.read")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const runs = await BookingOneClickAutomationService.listRuns(req.params.bookingId, scope.tenantId);
    return sendSuccess(res, 200, "Automation runs retrieved successfully.", { items: runs }, requestId);
  } catch (error) {
    console.error("ListOneClickAutomationRuns error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve automation runs.", requestId);
  }
};
