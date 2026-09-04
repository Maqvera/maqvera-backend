import mongoose from "mongoose";
import { AppError } from "./errorContract.js";
import { getPaginationConfig } from "./paginationConfig.js";
import { getCorrelationId } from "./correlationContext.js";

/**
 * Enterprise Architecture Hardening Phase — Standard Pagination Model
 * (Improvement 9). A NEW, additive, opt-in utility — this codebase's
 * existing list endpoints already return their own established
 * `{ items, pagination: { total, page, pageSize, totalPages } }` shape
 * (used across essentially every controller this whole hardening phase
 * and everything before it has built); renaming `items` -> `data` and
 * `total` -> `totalRecords` in place across every one of those existing
 * endpoints would be exactly the kind of mass, breaking, cross-cutting
 * rewrite this phase's own approach avoids. This file is real, new
 * infrastructure producing the spec's own exact envelope
 * (`data`/`totalRecords`/`hasNext`/`hasPrevious`/`nextCursor`/
 * `previousCursor`/`metadata`) for any NEW endpoint that adopts it going
 * forward — see docs/07-enterprise-standards/09-pagination.md "Adoption".
 */

const validationError = (field, message) => new AppError("VALIDATION_FAILED", { message, details: [{ field, message }] });

const encodeCursor = (id) => Buffer.from(String(id), "utf8").toString("base64url");
const decodeCursor = (cursor) => {
  try {
    const decoded = Buffer.from(String(cursor), "base64url").toString("utf8");
    if (!/^[0-9a-fA-F]{24}$/.test(decoded)) throw new Error("not an ObjectId");
    return new mongoose.Types.ObjectId(decoded);
  } catch {
    throw validationError("cursor", "Invalid cursor.");
  }
};

const buildMetadata = (correlationId) => ({
  correlationId: correlationId || getCorrelationId() || null,
  generatedAt: new Date().toISOString()
});

/**
 * Real validation, not silent clamping — "Requests like pageSize=100000
 * -> Reject 400 Bad Request." `maxPageSize` (per call site) is itself
 * capped at the config's `absoluteMaxPageSize` no matter what a caller
 * passes, so no endpoint can accidentally opt into an unbounded result
 * set.
 */
export const parsePaginationParams = (query = {}, { allowedSortFields = [], maxPageSize } = {}) => {
  const config = getPaginationConfig();
  const effectiveMaxPageSize = Math.min(maxPageSize || config.maxPageSize, config.absoluteMaxPageSize);

  const page = query.page !== undefined ? Number(query.page) : 1;
  if (!Number.isInteger(page) || page < 1) throw validationError("page", "page must be a positive integer.");

  const pageSize = query.pageSize !== undefined ? Number(query.pageSize) : config.defaultPageSize;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw validationError("pageSize", "pageSize must be a positive integer.");
  if (pageSize > effectiveMaxPageSize) throw validationError("pageSize", `pageSize must not exceed ${effectiveMaxPageSize}.`);

  const sortOrder = String(query.order || config.defaultSortOrder).toLowerCase();
  if (!["asc", "desc"].includes(sortOrder)) throw validationError("order", 'order must be "asc" or "desc".');

  const sortField = query.sort || config.defaultSortField;
  if (allowedSortFields.length > 0 && !allowedSortFields.includes(sortField)) {
    throw validationError("sort", `sort must be one of: ${allowedSortFields.join(", ")}.`);
  }

  return { page, pageSize, sortField, sortOrder, effectiveMaxPageSize };
};

/**
 * Offset pagination — "Best for Invoices, Customers, Vendors, Products,
 * Employees, Payments, Receipts." Deterministic ordering: the configured
 * tiebreaker (`_id`) is always appended after the caller's own sort
 * field, so page 2 can never contain duplicates or skip rows when two
 * documents share the same primary sort value.
 */
export const paginateOffset = async ({ Model, filter = {}, query = {}, allowedSortFields = [], maxPageSize, projection = null, correlationId = null }) => {
  const config = getPaginationConfig();
  const { page, pageSize, sortField, sortOrder } = parsePaginationParams(query, { allowedSortFields, maxPageSize });
  const direction = sortOrder === "asc" ? 1 : -1;
  const sortSpec = { [sortField]: direction, [config.tiebreakerField]: direction };

  const [data, totalRecords] = await Promise.all([
    Model.find(filter, projection).sort(sortSpec).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Model.countDocuments(filter)
  ]);

  const totalPages = Math.max(Math.ceil(totalRecords / pageSize), 1);
  return {
    data,
    pagination: {
      page, pageSize, totalRecords, totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > 1,
      nextCursor: null,
      previousCursor: null
    },
    metadata: buildMetadata(correlationId)
  };
};

/**
 * Cursor pagination — "Best for Audit Logs, Event Store, Search,
 * Notifications, Analytics, Financial Transactions." Real `_id`-based
 * keyset pagination (no `skip()` — a large `page=50000` offset scan is
 * exactly what this mode exists to avoid).
 *
 * `nextCursor` is real and straightforward: the id of the last row
 * returned, re-queried with `_id` strictly beyond it next time.
 *
 * `previousCursor` is real but requires the caller to flip `order` when
 * following it (documented, not a limitation hidden from the caller):
 * passing `cursor: previousCursor` with `order` REVERSED returns the
 * `pageSize` rows immediately before the current page, in reverse
 * order — the caller reverses the `data` array to display them in the
 * original order. This is the same internal technique Relay-style
 * `before`/`after` cursor APIs use, not a fabricated placeholder.
 */
export const paginateCursor = async ({ Model, filter = {}, query = {}, maxPageSize, projection = null, correlationId = null }) => {
  const config = getPaginationConfig();
  const effectiveMaxPageSize = Math.min(maxPageSize || config.maxPageSize, config.absoluteMaxPageSize);

  const pageSize = query.pageSize !== undefined ? Number(query.pageSize) : config.defaultPageSize;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw validationError("pageSize", "pageSize must be a positive integer.");
  if (pageSize > effectiveMaxPageSize) throw validationError("pageSize", `pageSize must not exceed ${effectiveMaxPageSize}.`);

  const sortOrder = String(query.order || config.defaultSortOrder).toLowerCase();
  if (!["asc", "desc"].includes(sortOrder)) throw validationError("order", 'order must be "asc" or "desc".');
  const direction = sortOrder === "asc" ? 1 : -1;

  const cursorFilter = { ...filter };
  if (query.cursor) {
    const cursorId = decodeCursor(query.cursor);
    cursorFilter._id = direction === 1 ? { $gt: cursorId } : { $lt: cursorId };
  }

  const rows = await Model.find(cursorFilter, projection).sort({ _id: direction }).limit(pageSize + 1).lean();
  const hasNext = rows.length > pageSize;
  const data = hasNext ? rows.slice(0, pageSize) : rows;

  const nextCursor = hasNext ? encodeCursor(data[data.length - 1]._id) : null;
  const previousCursor = query.cursor && data.length > 0 ? encodeCursor(data[0]._id) : null;

  return {
    data,
    pagination: {
      page: null, pageSize, totalRecords: null, totalPages: null,
      hasNext, hasPrevious: !!query.cursor,
      nextCursor, previousCursor
    },
    metadata: buildMetadata(correlationId)
  };
};
