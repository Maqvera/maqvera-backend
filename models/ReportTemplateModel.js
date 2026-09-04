import mongoose from "mongoose";

/**
 * Reporting Platform Part 8 fix — centralized, versioned report layout/
 * branding templates, generalized from the single hardcoded
 * templates/reports/financial_report.html. One logical template
 * (`templateKey`, e.g. "financial_report", "travel_workload_dashboard") can
 * have several `locale` variants, each its own document — same
 * locale-variant shape as models/CommunicationTemplateModel.js, reused
 * rather than inventing a second convention. `reportType` is the
 * `report.reportType` value(s) this template renders (ReportExportService
 * resolves by tenantId + reportType + locale); `htmlBody` is a Handlebars
 * source string rendered through the SAME chokepoint
 * (services/HtmlPdfRenderer.js) every file-based template already uses, so
 * `{{{sharedCss}}}`/partials/helpers all work identically. `brandingConfig`
 * is passed into the render data as `branding` so a template can reference
 * `{{branding.logo}}` etc. without every module re-deriving tenant branding
 * itself.
 */
const ReportTemplateSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  templateKey: {
    type: String,
    required: true,
    index: true
  },
  reportType: {
    type: String,
    required: true,
    index: true
  },
  locale: {
    type: String,
    default: "en",
    index: true
  },
  htmlBody: {
    type: String,
    required: true
  },
  brandingConfig: {
    logo: { type: String, default: null },
    colors: { type: mongoose.Schema.Types.Mixed, default: null },
    fonts: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  status: {
    type: String,
    enum: ["Draft", "Active", "Archived"],
    default: "Draft",
    index: true
  },
  version: {
    type: Number,
    default: 1
  },
  createdBy: {
    type: String,
    default: null
  },
  updatedBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

ReportTemplateSchema.index({ tenantId: 1, templateKey: 1, locale: 1 }, { unique: true });
ReportTemplateSchema.index({ tenantId: 1, reportType: 1, locale: 1, status: 1 });

ReportTemplateSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const ReportTemplateModel = mongoose.model("report_template", ReportTemplateSchema);

export default ReportTemplateModel;
