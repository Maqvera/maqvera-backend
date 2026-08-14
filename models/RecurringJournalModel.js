import mongoose from "mongoose";

// "Recurring Journals" — File 2, Journal Platform Part 2, item 19. Real
// scheduling infrastructure (recurringJournalScheduler.js, node-cron —
// this codebase already runs a dozen real cron schedulers this same way).
// A recurring journal definition always applies a real, tenant-authored
// JournalTemplateModel (by templateId) on the configured frequency — no
// inline line definitions here, so a recurring schedule and a one-off
// template application always share the exact same real posting logic
// (JournalService.applyJournalTemplate).
const RecurringJournalSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: null
  },
  templateId: {
    type: String,
    required: true
  },
  // Config-driven (financeConfig.recurringJournalFrequencies).
  frequency: {
    type: String,
    required: true
  },
  // Only consulted when frequency === "Custom".
  customIntervalDays: {
    type: Number,
    default: null
  },
  nextRunDate: {
    type: Date,
    required: true,
    index: true
  },
  lastRunDate: {
    type: Date,
    default: null
  },
  // Optional stop condition — null means "runs indefinitely until Paused/Cancelled."
  endDate: {
    type: Date,
    default: null
  },
  // Active, Paused, Completed (endDate reached), Cancelled.
  status: {
    type: String,
    default: "Active",
    index: true
  },
  runCount: {
    type: Number,
    default: 0
  },
  lastGeneratedJournalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "journal",
    default: null
  },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

RecurringJournalSchema.index({ tenantId: 1, status: 1, nextRunDate: 1 });

RecurringJournalSchema.set("toJSON", {
  transform: (_, ret) => {
    delete ret.__v;
    return ret;
  }
});

const RecurringJournalModel = mongoose.model("recurring_journal", RecurringJournalSchema);

export default RecurringJournalModel;
