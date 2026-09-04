import dotenv from "dotenv";
import mongoose from "mongoose";
import CommunicationTemplateModel from "../models/CommunicationTemplateModel.js";

dotenv.config();
const tenantId = process.env.SEED_TENANT_ID;
if (!tenantId) throw new Error("SEED_TENANT_ID is required to seed Visa communication templates.");

if (!process.env.URI) throw new Error("URI is required to seed Visa communication templates.");
await mongoose.connect(process.env.URI);

// Visa Module PRD §16 "Templates: Documents Required, Documents Missing,
// Application Submitted, Processing, Approved, Rejected, Payment Reminder".
// templateId set explicitly (not the service's auto-generated TPL-xxxx form)
// so services/VisaCommunicationListener.js can resolve each one by a stable,
// human-readable code — the schema itself has no format constraint on
// templateId, only a uniqueness one.
const TEMPLATES = [
  {
    templateId: "visa.documents_required",
    name: "Visa Documents Required",
    channel: "WhatsApp",
    bodyTemplate: "Hi {{travelerName}}, please upload the required documents for your {{visaType}} application to {{destinationCountry}} (Case {{caseNumber}}).",
    variables: ["travelerName", "visaType", "destinationCountry", "caseNumber"]
  },
  {
    templateId: "visa.documents_missing",
    name: "Visa Documents Missing/Rejected",
    channel: "WhatsApp",
    bodyTemplate: "Hi {{travelerName}}, one of your uploaded documents was rejected: {{reason}}. Please re-upload it for Case {{caseNumber}}.",
    variables: ["travelerName", "reason", "caseNumber"]
  },
  {
    templateId: "visa.application_submitted",
    name: "Visa Application Submitted",
    channel: "WhatsApp",
    bodyTemplate: "Hi {{travelerName}}, your visa application (Case {{caseNumber}}) has been submitted to {{embassyName}}. Expected processing: {{expectedProcessingDays}} day(s).",
    variables: ["travelerName", "caseNumber", "embassyName", "expectedProcessingDays"]
  },
  {
    templateId: "visa.processing",
    name: "Visa Application Processing",
    channel: "WhatsApp",
    bodyTemplate: "Hi {{travelerName}}, your visa application (Case {{caseNumber}}) is now being processed by the embassy.",
    variables: ["travelerName", "caseNumber"]
  },
  {
    templateId: "visa.approved",
    name: "Visa Approved",
    channel: "WhatsApp",
    bodyTemplate: "Congratulations {{travelerName}}! Your visa for {{destinationCountry}} (Case {{caseNumber}}) has been approved.",
    variables: ["travelerName", "destinationCountry", "caseNumber"]
  },
  {
    templateId: "visa.rejected",
    name: "Visa Rejected",
    channel: "WhatsApp",
    bodyTemplate: "Hi {{travelerName}}, unfortunately your visa application (Case {{caseNumber}}) was not approved. Reason: {{rejectionReason}}.",
    variables: ["travelerName", "caseNumber", "rejectionReason"]
  },
  {
    templateId: "visa.payment_reminder",
    name: "Visa Payment Reminder",
    channel: "WhatsApp",
    bodyTemplate: "Hi {{travelerName}}, your payment of {{outstandingBalance}} {{currency}} for Case {{caseNumber}} is overdue. Please settle at your earliest convenience.",
    variables: ["travelerName", "outstandingBalance", "currency", "caseNumber"]
  }
];

for (const tpl of TEMPLATES) {
  await CommunicationTemplateModel.findOneAndUpdate(
    { tenantId, templateId: tpl.templateId },
    { tenantId, ...tpl, subjectTemplate: "", status: "Active", version: 1 },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

await mongoose.disconnect();
console.log(`${TEMPLATES.length} Visa communication template(s) configured for tenant ${tenantId}.`);
