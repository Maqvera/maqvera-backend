import mongoose from "mongoose";
import ChartOfAccountModel from "../models/ChartOfAccountModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getFinanceConfig } from "../utils/financeConfig.js";

// ---------------------------------------------------------------------------
// Pure hierarchy helpers — no DB access, so they're unit-testable directly
// (see tests/chartOfAccountService.test.js) without a live Mongo connection.
// ---------------------------------------------------------------------------

/**
 * Computes { level, ancestors } for a new/reparented account given its
 * (already-loaded) parent document, or null for a root account.
 */
export const computeHierarchyFields = (parent) => {
  if (!parent) return { level: 0, ancestors: [] };
  return {
    level: parent.level + 1,
    ancestors: [...parent.ancestors, parent._id]
  };
};

/**
 * True if setting `candidateParentId` as the parent of `accountId` would
 * create a cycle — i.e. candidateParentId IS accountId, or accountId already
 * appears in candidateParent's own ancestor chain (candidateParent is a
 * descendant of accountId).
 */
export const wouldCreateCycle = (accountId, candidateParentId, candidateParentAncestors = []) => {
  const accountIdStr = accountId.toString();
  if (candidateParentId && candidateParentId.toString() === accountIdStr) return true;
  return candidateParentAncestors.some((ancestorId) => ancestorId.toString() === accountIdStr);
};

/** Throws when a proposed level exceeds the configured maximum hierarchy depth. */
export const assertWithinMaxDepth = (level, maxDepth) => {
  if (level > maxDepth) {
    throw new Error(`Account hierarchy exceeds the maximum allowed depth of ${maxDepth}.`);
  }
};

/**
 * Recomputes a descendant's { level, ancestors } after its ancestor
 * `accountId` moved to a new position in the tree (newAncestorsOfAccount /
 * newLevelOfAccount). Pure — operates entirely on the values passed in.
 */
export const recomputeDescendantPath = (descendant, accountId, newAncestorsOfAccount, newLevelOfAccount) => {
  const accountIdStr = accountId.toString();
  const idx = descendant.ancestors.findIndex((ancestorId) => ancestorId.toString() === accountIdStr);
  const tail = idx === -1 ? [] : descendant.ancestors.slice(idx + 1);
  return {
    ancestors: [...newAncestorsOfAccount, accountId, ...tail],
    level: newLevelOfAccount + 1 + tail.length
  };
};

/** Business-rule gate for deactivating/deleting an account. */
export const assertCanDeactivate = (account) => {
  if (account.isSystemAccount) throw new Error("System accounts cannot be deleted.");
  if (account.hasPostedTransactions) throw new Error("Accounts with journal entries cannot be removed.");
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class ChartOfAccountService {
  /**
   * GET /api/v1/accounts — filter, paginate, sort.
   * Tenant-scoped only (no branch dimension — see docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
   */
  static async listAccounts(query, tenantId) {
    const config = getFinanceConfig();
    const { category, parentId, status, currency, sort } = query;

    const filter = { tenantId };
    if (category) filter.category = category;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;
    if (parentId !== undefined) {
      filter.parentId = (parentId === "null" || parentId === "root" || parentId === "")
        ? null
        : mongoose.isValidObjectId(parentId) ? parentId : null;
    }

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    const skip = (page - 1) * pageSize;

    let sortSpec = { accountCode: 1 };
    if (sort) {
      const direction = sort.startsWith("-") ? -1 : 1;
      const field = sort.replace(/^-/, "");
      sortSpec = { [field]: direction };
    }

    const [items, total] = await Promise.all([
      ChartOfAccountModel.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
      ChartOfAccountModel.countDocuments(filter)
    ]);

    return {
      items,
      pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
    };
  }

  static async getAccountById(accountId, tenantId) {
    const account = await ChartOfAccountModel.findOne({ _id: accountId, tenantId }).lean();
    if (!account) throw new Error("Account not found.");
    return account;
  }

  /**
   * POST /api/v1/accounts
   * Validate Account Code -> Validate Parent -> Validate Category ->
   * Create Account -> Audit -> Publish AccountCreated -> Return Success.
   * (Category/type/status values are already constrained to the configured
   * enum by middleware/validateRequest.js's Joi schema before this runs.)
   */
  static async createAccount(data, tenantId, userId) {
    const config = getFinanceConfig();
    const { accountCode, name, description = null, category, parentId = null, currency, allowPosting, tags = [] } = data;

    if (!accountCode || !name || !category) {
      throw new Error("accountCode, name, and category are required.");
    }

    const existing = await ChartOfAccountModel.findOne({ tenantId, accountCode }).lean();
    if (existing) throw new Error("Account code already exists for this tenant.");

    let parent = null;
    if (parentId) {
      parent = await ChartOfAccountModel.findOne({ _id: parentId, tenantId });
      if (!parent) throw new Error("Parent account not found.");
    }

    const { level, ancestors } = computeHierarchyFields(parent);
    assertWithinMaxDepth(level, config.maxHierarchyDepth);

    const type = data.type || config.defaultAccountType;
    const status = data.status || config.defaultAccountStatus;
    const resolvedAllowPosting = allowPosting !== undefined
      ? allowPosting
      : !["Header", "Summary", "Virtual"].includes(type);

    const account = await ChartOfAccountModel.create({
      tenantId,
      accountCode,
      name,
      description,
      category,
      type,
      parentId: parent ? parent._id : null,
      ancestors,
      level,
      status,
      currency: currency || config.defaultCurrency,
      allowPosting: resolvedAllowPosting,
      // Never caller-settable — system accounts are provisioned by trusted
      // server-side bootstrap only, not through the public create endpoint.
      isSystemAccount: false,
      tags,
      createdBy: userId || null,
      updatedBy: userId || null
    });

    await AuditLogModel.create({
      action: "finance.account.create",
      module: "Finance",
      resource: "ChartOfAccount",
      resourceId: account._id.toString(),
      userId: userId || null,
      tenantId,
      details: { accountCode: account.accountCode, category: account.category }
    });

    publishEvent("AccountCreated", {
      tenantId,
      accountId: account._id.toString(),
      accountCode: account.accountCode,
      category: account.category,
      performedBy: userId || null
    });

    return account.toJSON();
  }

  /**
   * PATCH /api/v1/accounts/:accountId
   * Editable fields only: name, description, status, parentId, currency,
   * allowPosting, tags. accountCode and category are immutable post-creation.
   */
  static async updateAccount(accountId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const account = await ChartOfAccountModel.findOne({ _id: accountId, tenantId });
    if (!account) throw new Error("Account not found.");

    if (account.isSystemAccount) {
      throw new Error("System accounts cannot be modified.");
    }

    const { name, description, status, parentId, currency, allowPosting, tags } = data;
    const changedFields = {};

    if (name !== undefined) changedFields.name = name;
    if (description !== undefined) changedFields.description = description;
    if (status !== undefined) changedFields.status = status;
    if (allowPosting !== undefined) changedFields.allowPosting = allowPosting;
    if (tags !== undefined) changedFields.tags = tags;

    if (currency !== undefined && currency !== account.currency) {
      if (account.hasPostedTransactions) {
        throw new Error("Account currency cannot be changed once transactions have been posted.");
      }
      changedFields.currency = currency;
    }

    let hierarchyChanged = false;
    if (parentId !== undefined) {
      const nextParentId = parentId === null || parentId === "null" || parentId === "" ? null : parentId;
      const currentParentId = account.parentId ? account.parentId.toString() : null;

      if ((nextParentId || null) !== currentParentId) {
        let newParent = null;
        if (nextParentId) {
          newParent = await ChartOfAccountModel.findOne({ _id: nextParentId, tenantId });
          if (!newParent) throw new Error("Parent account not found.");
          if (wouldCreateCycle(account._id, newParent._id, newParent.ancestors)) {
            throw new Error("Hierarchy integrity violation: an account cannot become its own descendant.");
          }
        }

        const { level, ancestors } = computeHierarchyFields(newParent);
        assertWithinMaxDepth(level, config.maxHierarchyDepth);

        changedFields.parentId = newParent ? newParent._id : null;
        changedFields.level = level;
        changedFields.ancestors = ancestors;
        hierarchyChanged = true;
      }
    }

    changedFields.updatedBy = userId || null;
    Object.assign(account, changedFields);
    await account.save();

    if (hierarchyChanged) {
      await ChartOfAccountService._cascadeDescendantHierarchy(account, tenantId);
    }

    await AuditLogModel.create({
      action: "finance.account.update",
      module: "Finance",
      resource: "ChartOfAccount",
      resourceId: account._id.toString(),
      userId: userId || null,
      tenantId,
      details: { changedFields: Object.keys(changedFields) }
    });

    publishEvent("AccountUpdated", { tenantId, accountId: account._id.toString(), performedBy: userId || null, changedFields: Object.keys(changedFields) });
    if (hierarchyChanged) {
      publishEvent("AccountHierarchyChanged", { tenantId, accountId: account._id.toString(), newParentId: account.parentId ? account.parentId.toString() : null, performedBy: userId || null });
    }

    return account.toJSON();
  }

  /** Reparents every descendant of `account` to keep ancestors/level consistent after a move. */
  static async _cascadeDescendantHierarchy(account, tenantId) {
    const descendants = await ChartOfAccountModel.find({ tenantId, ancestors: account._id });
    const bulkOps = descendants.map((descendant) => {
      const { ancestors, level } = recomputeDescendantPath(descendant, account._id, account.ancestors, account.level);
      return {
        updateOne: {
          filter: { _id: descendant._id },
          update: { $set: { ancestors, level } }
        }
      };
    });
    if (bulkOps.length) await ChartOfAccountModel.bulkWrite(bulkOps);
  }

  /**
   * DELETE /api/v1/accounts/:accountId — soft delete only.
   * Blocked for system accounts, accounts with posted journal entries, and
   * accounts that still have child accounts (would orphan the hierarchy).
   */
  static async deactivateAccount(accountId, tenantId, userId) {
    const account = await ChartOfAccountModel.findOne({ _id: accountId, tenantId });
    if (!account) throw new Error("Account not found.");

    assertCanDeactivate(account);

    const childCount = await ChartOfAccountModel.countDocuments({ tenantId, parentId: account._id });
    if (childCount > 0) {
      throw new Error("Account has child accounts and cannot be deactivated. Reassign or archive child accounts first.");
    }

    account.status = "Inactive";
    account.updatedBy = userId || null;
    await account.save();

    await AuditLogModel.create({
      action: "finance.account.deactivate",
      module: "Finance",
      resource: "ChartOfAccount",
      resourceId: account._id.toString(),
      userId: userId || null,
      tenantId,
      details: { accountCode: account.accountCode }
    });

    publishEvent("AccountDeactivated", { tenantId, accountId: account._id.toString(), performedBy: userId || null });

    return account.toJSON();
  }

  /** Called by the (future) Journal/Posting Engine when a journal line first posts to this account. */
  static async markAsPosted(accountId, tenantId) {
    await ChartOfAccountModel.updateOne({ _id: accountId, tenantId }, { $set: { hasPostedTransactions: true } });
  }
}

export default ChartOfAccountService;
