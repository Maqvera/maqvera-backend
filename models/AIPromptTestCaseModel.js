import mongoose from "mongoose";

/**
 * EXT-031 §13 "Prompt Testing — Golden Dataset, Expected Outputs, Prompt
 * Benchmarks." Belongs to the PARENT AIPrompt (not a specific version) —
 * the same test cases are meant to run against every version of a prompt
 * so quality is comparable across versions (§20 "Quality Score" trend).
 * Assertions are real, checkable substring matches against the LLM's
 * actual output — never an LLM-graded "vibe check", which would just be
 * another unverified model call grading another model call.
 */
const AIPromptTestCaseSchema = new mongoose.Schema(
  {
    promptId: { type: mongoose.Schema.Types.ObjectId, ref: "AIPrompt", required: true, index: true },
    tenantId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    // Values substituted into the template's {{variables}} for this
    // specific test run, plus a simulated end-user message where relevant.
    variables: { type: mongoose.Schema.Types.Mixed, default: {} },
    userMessage: { type: String, default: null },
    expectedContains: [{ type: String }],
    expectedNotContains: [{ type: String }],
    createdBy: { type: String, required: true },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

AIPromptTestCaseSchema.index({ promptId: 1, isActive: 1 });

export default mongoose.models.AIPromptTestCase || mongoose.model("AIPromptTestCase", AIPromptTestCaseSchema);
