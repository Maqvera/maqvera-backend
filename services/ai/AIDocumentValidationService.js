import VendorModel from "../../models/VendorModel.js";
import CurrencyModel from "../../models/CurrencyModel.js";
import EnterpriseVerificationModel from "../../models/EnterpriseVerificationModel.js";

// Document Intelligence Platform Phase 2 — validates extracted fields
// against real ERP master data (VendorModel, CurrencyModel) and real prior
// extractions (EnterpriseVerificationModel), never a guessed rule. Output
// shape matches EnterpriseVerificationModel.businessRuleResult.rulesEvaluated
// exactly (ruleCode/ruleName/status/message) — the same existing,
// already-generic structure DocumentVerificationService's own passport
// business-rule stage already uses, not a second parallel validation-result
// shape.
//
// A rule that genuinely cannot be evaluated (no vendor name was extracted
// to check, no currency code found in the text) is never silently skipped
// OR silently passed — it's either omitted (nothing to check) or reported
// "pending" with an honest reason, matching the same discipline
// DocumentVerificationService's own REQUIRED_STAMP/REQUIRED_PAGES rules
// already use for "requires manual officer review."

const CURRENCY_CODE_REGEX = /\b(USD|PKR|EUR|GBP|AED|SAR|INR|CNY|JPY|CAD|AUD)\b/;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class AIDocumentValidationService {
  /**
   * @param {object} params
   * @param {string} params.tenantId
   * @param {string} params.documentType
   * @param {object} params.fields - the extractor's own output (AIDocumentExtractionService.extractFields)
   * @param {string} [params.rawText] - for the currency-sanity check only
   * @param {string} [params.documentId] - excluded from its own duplicate-check query
   * @returns {Promise<Array<{ruleCode, ruleName, status, message}>>}
   */
  static async validateExtraction({ tenantId, documentType, fields = {}, rawText = null, documentId = null }) {
    const rules = [];

    // "Expired document detection" — passport is the one type in scope
    // here with a real expiry concept.
    if (fields.expiryDate) {
      const isExpired = new Date(fields.expiryDate).getTime() < Date.now();
      rules.push({
        ruleCode: "DOCUMENT_EXPIRY_CHECK", ruleName: "Document Not Expired",
        status: isExpired ? "failed" : "passed",
        message: isExpired ? `Document expired on ${new Date(fields.expiryDate).toISOString().slice(0, 10)}.` : "Document has not expired."
      });
    }

    // "Vendor/customer existence check against existing CRM/Finance master
    // data" — case-insensitive exact match on the real VendorModel (OCR
    // vendor-name variance means an exact byte match would be too brittle,
    // but a fuzzy/partial match risks false positives on real financial
    // data, so this stays a strict case-insensitive match, not a guess).
    if (["invoice", "receipt"].includes(documentType) && fields.vendor) {
      const vendor = await VendorModel.findOne({ tenantId, name: new RegExp(`^${escapeRegex(fields.vendor.trim())}$`, "i") }).lean();
      rules.push({
        ruleCode: "VENDOR_EXISTS_CHECK", ruleName: "Vendor Recognized",
        status: vendor ? "passed" : "pending",
        message: vendor ? `Matched vendor "${vendor.name}".` : `No vendor record matches "${fields.vendor}" — requires manual confirmation.`
      });
    }

    // "Duplicate invoice detection (same vendor + invoice number + tenant)"
    // — queries real prior extractions already stored on other documents'
    // own EnterpriseVerificationModel rows (see DocumentVerificationService's
    // processQueuedOcr, which stores genericExtractedFields there).
    if (documentType === "invoice" && fields.vendor && fields.invoiceNumber) {
      const duplicateFilter = {
        tenantId,
        "ocrResult.genericExtractedFields.invoiceNumber": fields.invoiceNumber,
        "ocrResult.genericExtractedFields.vendor": fields.vendor
      };
      if (documentId) duplicateFilter.documentId = { $ne: documentId };
      const duplicate = await EnterpriseVerificationModel.findOne(duplicateFilter).select("documentId").lean();
      rules.push({
        ruleCode: "DUPLICATE_INVOICE_CHECK", ruleName: "No Duplicate Invoice",
        status: duplicate ? "failed" : "passed",
        message: duplicate ? `Invoice "${fields.invoiceNumber}" for vendor "${fields.vendor}" was already submitted (document ${duplicate.documentId}).` : "No prior invoice with this vendor + invoice number combination found."
      });
    }

    // "Currency/tax sanity checks" — only evaluated when a real currency
    // code is actually present in the OCR'd text; never guessed (no
    // hardcoded default currency, per this codebase's own Golden Rule 2).
    if (rawText) {
      const currencyMatch = rawText.match(CURRENCY_CODE_REGEX);
      if (currencyMatch) {
        const currencyExists = await CurrencyModel.exists({ tenantId, currencyCode: currencyMatch[1] });
        rules.push({
          ruleCode: "CURRENCY_SANITY_CHECK", ruleName: "Currency Recognized",
          status: currencyExists ? "passed" : "pending",
          message: currencyExists ? `Currency "${currencyMatch[1]}" is a real configured currency for this tenant.` : `Currency "${currencyMatch[1]}" is not configured for this tenant — requires manual confirmation.`
        });
      }
    }

    return rules;
  }
}

export default AIDocumentValidationService;
