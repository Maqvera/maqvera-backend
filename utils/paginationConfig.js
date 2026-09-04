import dotenv from "dotenv";

dotenv.config();

// Enterprise Architecture Hardening Phase — Standard Pagination Model
// (Improvement 9). "Maximum Page Size — Default 25, Maximum 100,
// Absolute Maximum 500... Requests like pageSize=100000 -> Reject 400
// Bad Request." `maxPageSize` is the real enforced ceiling for a normal
// call site; `absoluteMaxPageSize` is the hard cap a specific call site
// may raise its own `maxPageSize` up to (e.g. a bulk-export endpoint),
// never beyond.
export const getPaginationConfig = () => {
  return {
    defaultPageSize: parseInt(process.env.PAGINATION_DEFAULT_PAGE_SIZE || "25", 10),
    maxPageSize: parseInt(process.env.PAGINATION_MAX_PAGE_SIZE || "100", 10),
    absoluteMaxPageSize: parseInt(process.env.PAGINATION_ABSOLUTE_MAX_PAGE_SIZE || "500", 10),
    defaultSortField: process.env.PAGINATION_DEFAULT_SORT_FIELD || "createdAt",
    defaultSortOrder: process.env.PAGINATION_DEFAULT_SORT_ORDER || "desc",
    // "ORDER BY createdAt DESC, id DESC" — the real deterministic
    // tiebreaker appended to every sort so page 2 can never contain
    // duplicates or skip rows when two documents share the same primary
    // sort value (e.g. two records created in the same millisecond).
    tiebreakerField: "_id"
  };
};

export default getPaginationConfig;
