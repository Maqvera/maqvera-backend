import InvoiceDocumentQrService from "../services/InvoiceDocumentQrService.js";
import { sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";

/**
 * GET /api/v1/documents/view/:token — DELIBERATELY PUBLIC (no
 * authenticateAccessToken), registered before that middleware in
 * routes/FinanceRoutes.js. Same public-token-as-access-control convention
 * as controllers/ReceiptController.js's own downloadReceiptPdf: a customer
 * scanning a printed QR code has no ERP login to present. Checks both
 * Invoice and BookingVoucher (InvoiceDocumentQrService.resolveByToken) since
 * either document type mints tokens from the same service, then redirects
 * straight to the stored PDF — same redirect-to-stored-URL shape as
 * downloadReceiptPdf, not a second binary-streaming path.
 */
export const viewDocumentByToken = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const document = await InvoiceDocumentQrService.resolveByToken(req.params.token);
    if (!document || !document.pdfUrl) return sendError(res, 404, "Document not found.", requestId);

    return res.redirect(document.pdfUrl);
  } catch (error) {
    console.error("viewDocumentByToken error:", error);
    return sendError(res, 500, "Failed to retrieve document.", requestId);
  }
};
