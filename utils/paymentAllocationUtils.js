// Shared payment-allocation math for both Accounts Receivable (Part 5,
// customer payments in) and Accounts Payable (Part 6, vendor payments out).
// The arithmetic is identical in both directions — only which party ends up
// with a credit balance differs — so it lives here rather than being
// defined twice or having one Finance service import from a sibling one.
const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * "Partial Payments... Overpayments: Credit balance created automatically."
 * Splits a requested allocation amount into the portion that actually
 * reduces the outstanding balance and the portion that becomes credit
 * (Customer Credit for AR, Vendor Credit for AP).
 */
export const computeOverpaymentSplit = (allocateAmount, outstandingBalance) => {
  const appliedToBalance = roundCurrency(Math.min(allocateAmount, outstandingBalance));
  const overpaymentExcess = roundCurrency(Math.max(0, roundCurrency(allocateAmount - outstandingBalance)));
  return { appliedToBalance, overpaymentExcess };
};

/** outstandingBalance <= 0 -> Paid; otherwise -> Partially Paid. */
export const resolveStatusAfterPayment = (outstandingBalance) => (outstandingBalance <= 0 ? "Paid" : "Partially Paid");
