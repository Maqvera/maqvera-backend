import mongoose from "mongoose";

/**
 * Enterprise Communication Platform — Template Version History Schema
 * Immutable snapshot of a CommunicationTemplateModel document at a given version.
 * Written once per version, never mutated — this is what makes rollback possible
 * (CommunicationTemplateModel.version alone cannot be rolled back to anything).
 * Tenant-scoped only — no branchId per Master Architecture rules.
 */
const CommunicationTemplateVersionSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  templateId: {
    type: String,
    required: true,
    index: true
  },
  // Part 8 fix — each locale variant of a template has its own independent
  // version lineage (they're separate CommunicationTemplateModel documents).
  locale: {
    type: String,
    default: "en",
    index: true
  },
  version: {
    type: Number,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  channel: {
    type: String,
    required: true
  },
  subjectTemplate: {
    type: String,
    default: ""
  },
  bodyTemplate: {
    type: String,
    required: true
  },
  variables: {
    type: [String],
    default: []
  },
  status: {
    type: String,
    default: "Active"
  },
  createdBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

CommunicationTemplateVersionSchema.index({ tenantId: 1, templateId: 1, locale: 1, version: 1 }, { unique: true });

CommunicationTemplateVersionSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const CommunicationTemplateVersionModel = mongoose.model("communication_template_version", CommunicationTemplateVersionSchema);

export default CommunicationTemplateVersionModel;
