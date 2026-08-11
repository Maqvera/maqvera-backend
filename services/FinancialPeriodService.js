import FinancialPeriodModel from "../models/FinancialPeriodModel.js";

/**
 * Pure predicate — testable without a DB. A period blocks posting when it
 * exists and its status isn't "Open" ("Closed periods blocked... Year-end
 * lock supported").
 */
export const periodBlocksPosting = (period) => !!period && period.status !== "Open";

class FinancialPeriodService {
  /**
   * Finds the financial period (if any) covering `date` for this tenant.
   */
  static async findPeriodForDate(tenantId, date) {
    return FinancialPeriodModel.findOne({
      tenantId,
      startDate: { $lte: date },
      endDate: { $gte: date }
    }).lean();
  }

  /**
   * "Validate Financial Period" / "Posting allowed only in Open Period."
   * A tenant that hasn't configured financial periods at all is treated as
   * permissive (unconfigured = open) — this module doesn't yet ship period
   * management endpoints (no endpoint contract for them was given in Part
   * 3/4), so blocking every posting for every tenant until periods exist
   * would silently break the module for everyone. Once a tenant DOES
   * configure a period covering a date, its status is enforced for real.
   */
  static async assertPeriodOpen(tenantId, date) {
    const period = await FinancialPeriodService.findPeriodForDate(tenantId, new Date(date));
    if (periodBlocksPosting(period)) {
      throw new Error(`Financial period is required to be open to post on this date (status: ${period.status}).`);
    }
    return period;
  }
}

export default FinancialPeriodService;
