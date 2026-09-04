import test, { after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { parsePaginationParams, paginateOffset, paginateCursor } from "../utils/pagination.js";
import { runWithCorrelationId } from "../utils/correlationContext.js";

dotenv.config();

// Enterprise Architecture Hardening Phase — Standard Pagination Model
// (Improvement 9). Real proof against a real collection
// (AuditLogModel — the spec's own recommended cursor-pagination use
// case): deterministic offset paging with a real tiebreaker, real
// pageSize-exceeded rejection (never silent clamping), and real
// keyset/cursor pagination that traverses an entire dataset with no
// duplicates or gaps, including genuine forward+backward navigation.
let dbAvailable = false;
const uri = process.env.URI || process.env.MONGO_URI;
if (uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    dbAvailable = mongoose.connection.readyState === 1;
  } catch {
    dbAvailable = false;
  }
}
const dbSkipReason = "No reachable MongoDB configured (set URI in .env) — skipping live integration test.";

test("parsePaginationParams: real validation rejects bad input instead of silently clamping", () => {
  assert.throws(() => parsePaginationParams({ page: 0 }), (e) => e.code === "VALIDATION_FAILED" && e.details[0].field === "page");
  assert.throws(() => parsePaginationParams({ page: "abc" }), (e) => e.code === "VALIDATION_FAILED");
  assert.throws(() => parsePaginationParams({ pageSize: 100000 }), (e) => e.code === "VALIDATION_FAILED" && e.details[0].field === "pageSize");
  assert.throws(() => parsePaginationParams({ order: "sideways" }), (e) => e.details[0].field === "order");
  assert.throws(() => parsePaginationParams({ sort: "notAllowed" }, { allowedSortFields: ["createdAt", "action"] }), (e) => e.details[0].field === "sort");

  const parsed = parsePaginationParams({});
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pageSize, 25);
  assert.equal(parsed.sortOrder, "desc");

  const custom = parsePaginationParams({ page: "3", pageSize: "10", sort: "action", order: "ASC" }, { allowedSortFields: ["action"] });
  assert.deepEqual({ page: custom.page, pageSize: custom.pageSize, sortField: custom.sortField, sortOrder: custom.sortOrder }, { page: 3, pageSize: 10, sortField: "action", sortOrder: "asc" });
});

test("paginateOffset: real deterministic paging, sorting, and the standard envelope against a real collection", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const suffix = `pag-offset-${Date.now()}`;
  const action = `PaginationTestAction-${suffix}`;

  t.after(async () => { await AuditLogModel.deleteMany({ action }); });

  for (let i = 0; i < 23; i++) {
    await AuditLogModel.create({ action, outcome: "success", metadata: { seq: i } });
  }

  const pageOne = await runWithCorrelationId("corr-pagination-1", () =>
    paginateOffset({ Model: AuditLogModel, filter: { action }, query: { page: 1, pageSize: 10 } })
  );
  assert.equal(pageOne.data.length, 10);
  assert.equal(pageOne.pagination.page, 1);
  assert.equal(pageOne.pagination.pageSize, 10);
  assert.equal(pageOne.pagination.totalRecords, 23);
  assert.equal(pageOne.pagination.totalPages, 3);
  assert.equal(pageOne.pagination.hasNext, true);
  assert.equal(pageOne.pagination.hasPrevious, false);
  assert.equal(pageOne.metadata.correlationId, "corr-pagination-1");
  assert.ok(pageOne.metadata.generatedAt);

  const pageThree = await paginateOffset({ Model: AuditLogModel, filter: { action }, query: { page: 3, pageSize: 10 } });
  assert.equal(pageThree.data.length, 3, "the last page holds the remainder, not a full pageSize");
  assert.equal(pageThree.pagination.hasNext, false);
  assert.equal(pageThree.pagination.hasPrevious, true);

  // No duplicates/gaps across all 3 pages — the real deterministic-ordering guarantee.
  const allIds = new Set();
  for (const page of [1, 2, 3]) {
    const result = await paginateOffset({ Model: AuditLogModel, filter: { action }, query: { page, pageSize: 10 } });
    for (const row of result.data) allIds.add(String(row._id));
  }
  assert.equal(allIds.size, 23);

  // Real sort field + order, restricted to an allow-list.
  const ascBySeq = await paginateOffset({ Model: AuditLogModel, filter: { action }, query: { page: 1, pageSize: 23, sort: "createdAt", order: "asc" }, allowedSortFields: ["createdAt", "action"] });
  const seqs = ascBySeq.data.map((d) => d.metadata.seq);
  const sortedSeqs = [...seqs].sort((a, b) => a - b);
  assert.deepEqual(seqs, sortedSeqs, "ascending order must actually be applied, not just accepted");

  await assert.rejects(
    () => paginateOffset({ Model: AuditLogModel, filter: { action }, query: { sort: "email" }, allowedSortFields: ["createdAt", "action"] }),
    (error) => error.code === "VALIDATION_FAILED"
  );
});

test("paginateCursor: real keyset traversal of an entire dataset with no duplicates/gaps, plus genuine forward+backward navigation", { skip: !dbAvailable && dbSkipReason }, async (t) => {
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  const suffix = `pag-cursor-${Date.now()}`;
  const action = `PaginationCursorTestAction-${suffix}`;

  t.after(async () => { await AuditLogModel.deleteMany({ action }); });

  for (let i = 0; i < 25; i++) {
    await AuditLogModel.create({ action, outcome: "success", metadata: { seq: i } });
  }

  // Traverse the whole dataset forward via nextCursor.
  const collected = [];
  let cursor = null;
  let guard = 0;
  while (guard++ < 10) {
    const result = await paginateCursor({ Model: AuditLogModel, filter: { action }, query: { pageSize: 10, order: "asc", ...(cursor ? { cursor } : {}) } });
    collected.push(...result.data);
    if (!result.pagination.hasNext) break;
    cursor = result.pagination.nextCursor;
  }
  assert.equal(collected.length, 25, "traversing every page via nextCursor must yield the whole dataset exactly once");
  assert.equal(new Set(collected.map((d) => String(d._id))).size, 25, "no duplicates across pages");

  // Reject an invalid/tampered cursor rather than silently returning garbage.
  await assert.rejects(
    () => paginateCursor({ Model: AuditLogModel, filter: { action }, query: { cursor: "not-a-real-cursor" } }),
    (error) => error.code === "VALIDATION_FAILED" && error.details[0].field === "cursor"
  );

  // Genuine backward navigation: page 1 (asc) -> page 2 via nextCursor ->
  // back to page 1 via previousCursor with order flipped, reversed.
  const page1 = await paginateCursor({ Model: AuditLogModel, filter: { action }, query: { pageSize: 10, order: "asc" } });
  const page2 = await paginateCursor({ Model: AuditLogModel, filter: { action }, query: { pageSize: 10, order: "asc", cursor: page1.pagination.nextCursor } });
  assert.ok(page2.pagination.previousCursor);

  const backToPage1 = await paginateCursor({ Model: AuditLogModel, filter: { action }, query: { pageSize: 10, order: "desc", cursor: page2.pagination.previousCursor } });
  const recoveredIds = backToPage1.data.map((d) => String(d._id)).reverse();
  assert.deepEqual(recoveredIds, page1.data.map((d) => String(d._id)), "following previousCursor with order flipped, then reversing, recovers the exact prior page");
});

test("paginateCursor: pageSize exceeding the configured maximum is rejected, never silently clamped", { skip: !dbAvailable && dbSkipReason }, async () => {
  const AuditLogModel = (await import("../models/AuditLogmodel.js")).default;
  await assert.rejects(
    () => paginateCursor({ Model: AuditLogModel, filter: { action: "nonexistent" }, query: { pageSize: 100000 } }),
    (error) => error.code === "VALIDATION_FAILED"
  );
});

after(async () => {
  if (dbAvailable) await mongoose.disconnect();
});
