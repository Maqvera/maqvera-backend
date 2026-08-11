// Shared "days past due -> aging bucket" computation, used by both
// Accounts Receivable (Part 5, customer aging) and Accounts Payable (Part
// 6, vendor aging) — the bucket boundary logic is identical, only the
// underlying entity differs, so it lives here rather than being defined
// twice or having one Finance service import from a sibling one.
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `buckets` — [{ label, minDays, maxDays }], where minDays/maxDays are days
 * *past due* (dueDate to referenceDate) and `null` means unbounded on that
 * side (JSON can't encode Infinity).
 */
export const computeAgingBucket = (dueDate, referenceDate, buckets) => {
  const daysOverdue = Math.floor((referenceDate.getTime() - new Date(dueDate).getTime()) / DAY_MS);
  const match = buckets.find((bucket) =>
    (bucket.minDays === null || daysOverdue >= bucket.minDays) &&
    (bucket.maxDays === null || daysOverdue <= bucket.maxDays)
  );
  return { label: match ? match.label : null, daysOverdue };
};

export default computeAgingBucket;
