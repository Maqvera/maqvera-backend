import mongoose from "mongoose";
import ChartOfAccountModel from "../models/ChartOfAccountModel.js";
import ChartTemplateModel from "../models/ChartTemplateModel.js";
import TaxRuleModel from "../models/TaxRuleModel.js";
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

/**
 * "AccountMerged" (Part 36) — a real, deliberately bounded merge: only ever
 * allowed when the source account has never posted (no journal history to
 * reassign) and isn't itself a system account. Merging a source that
 * already has posted transactions would require rewriting immutable
 * journal history, which this codebase never does.
 */
export const assertCanMerge = (sourceAccount, targetAccount) => {
  if (sourceAccount._id.toString() === targetAccount._id.toString()) {
    throw new Error("An account cannot be merged into itself.");
  }
  if (sourceAccount.isSystemAccount) throw new Error("System accounts cannot be merged away.");
  if (sourceAccount.hasPostedTransactions) throw new Error("Accounts with journal entries cannot be merged — no immutable posted history is ever reassigned.");
  if (targetAccount.status !== "Active") throw new Error(`Target account ${targetAccount.accountCode} must be Active to receive a merge.`);
};

/**
 * "Deferred Revenue" + "Revenue Recognition Rules" (Part 37) — pure
 * validation, no DB access needed (unlike taxMapping's real TaxRuleModel
 * lookup), so it's directly unit-testable. deferredRevenueType may only be
 * set on a Liabilities-category account — a deferred revenue balance is,
 * by definition, always a liability (cash received but not yet earned) —
 * and both values must come from the tenant's configured, real catalogs.
 */
export const assertValidRevenueRecognition = ({ category, revenueRecognition }, config) => {
  if (!revenueRecognition) return;
  const { deferredRevenueType, recognitionRule } = revenueRecognition;
  if (deferredRevenueType) {
    if (!config.deferredRevenueAccountTypes.includes(deferredRevenueType)) {
      throw new Error(`Invalid revenueRecognition.deferredRevenueType "${deferredRevenueType}".`);
    }
    if (category !== "Liabilities") {
      throw new Error("revenueRecognition.deferredRevenueType can only be set on a Liabilities-category account.");
    }
  }
  if (recognitionRule?.method && !config.revenueRecognitionMethods.includes(recognitionRule.method)) {
    throw new Error(`Invalid revenueRecognition.recognitionRule.method "${recognitionRule.method}".`);
  }
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class ChartOfAccountService {
  static _generateTemplateId() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `TPL-${timestamp}-${random}`;
  }

  /**
   * GET /api/v1/accounts — filter, paginate, sort.
   * Tenant-scoped only (no branch dimension — see docs/06-external-integrations/03-final-architecture-no-branches-rbac.md).
   */
  static async listAccounts(query, tenantId) {
    const config = getFinanceConfig();
    const { category, parentId, status, currency, ownershipType, sort } = query;

    const filter = { tenantId };
    if (category) filter.category = category;
    if (status) filter.status = status;
    if (currency) filter.currency = currency;
    if (ownershipType) filter.ownershipType = ownershipType;
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

  static async _validateEnterpriseFields(data, tenantId, existingCategory = null) {
    const config = getFinanceConfig();
    const { postingRestriction, dimensions, ownershipType, taxMapping, revenueRecognition, category } = data;

    if (postingRestriction?.type && !config.postingRestrictionTypes.includes(postingRestriction.type)) {
      throw new Error(`Invalid postingRestriction.type "${postingRestriction.type}".`);
    }
    for (const key of [...(dimensions?.required || []), ...(dimensions?.allowed || [])]) {
      if (!config.financialDimensionTypes.includes(key)) throw new Error(`Invalid dimension type "${key}".`);
    }
    if (ownershipType && !config.accountOwnershipTypes.includes(ownershipType)) {
      throw new Error(`Invalid ownershipType "${ownershipType}".`);
    }
    if (taxMapping?.taxType && !config.taxTypes.includes(taxMapping.taxType)) {
      throw new Error(`Invalid taxMapping.taxType "${taxMapping.taxType}".`);
    }
    if (taxMapping?.taxCode) {
      const rule = await TaxRuleModel.findOne({ tenantId, taxCode: taxMapping.taxCode.toUpperCase() }).lean();
      if (!rule) throw new Error(`taxMapping.taxCode "${taxMapping.taxCode}" does not match any configured tax rule for this tenant.`);
    }
    assertValidRevenueRecognition({ category: category || existingCategory, revenueRecognition }, config);
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
    const {
      accountCode, name, description = null, category, parentId = null, currency, allowPosting, tags = [],
      aliases = [], postingRestriction = null, dimensions = null, ownershipType = "Company",
      currencyMapping = null, taxMapping = null, budgetControlled = false, revenueRecognition = null
    } = data;

    if (!accountCode || !name || !category) {
      throw new Error("accountCode, name, and category are required.");
    }

    await ChartOfAccountService._validateEnterpriseFields(data, tenantId);

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
      aliases,
      category,
      type,
      parentId: parent ? parent._id : null,
      ancestors,
      level,
      status,
      currency: currency || config.defaultCurrency,
      allowPosting: resolvedAllowPosting,
      postingRestriction: postingRestriction || undefined,
      dimensions: dimensions || undefined,
      ownershipType,
      currencyMapping: currencyMapping || undefined,
      taxMapping: taxMapping || undefined,
      budgetControlled,
      revenueRecognition: revenueRecognition || undefined,
      version: 1,
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
   * allowPosting, tags, aliases, postingRestriction, dimensions,
   * currencyMapping, taxMapping, budgetControlled. accountCode and
   * category are immutable post-creation. Every real change is appended to
   * `revisionHistory` ("Versioning... complete historical snapshots").
   */
  static async updateAccount(accountId, data, tenantId, userId) {
    const config = getFinanceConfig();
    const account = await ChartOfAccountModel.findOne({ _id: accountId, tenantId });
    if (!account) throw new Error("Account not found.");

    if (account.isSystemAccount) {
      throw new Error("System accounts cannot be modified.");
    }

    await ChartOfAccountService._validateEnterpriseFields(data, tenantId, account.category);

    const { name, description, status, parentId, currency, allowPosting, tags, aliases, postingRestriction, dimensions, currencyMapping, taxMapping, budgetControlled, revenueRecognition } = data;
    const changedFields = {};
    const snapshot = account.toJSON();

    if (name !== undefined) changedFields.name = name;
    if (description !== undefined) changedFields.description = description;
    if (status !== undefined) changedFields.status = status;
    if (allowPosting !== undefined) changedFields.allowPosting = allowPosting;
    if (tags !== undefined) changedFields.tags = tags;
    if (aliases !== undefined) changedFields.aliases = aliases;
    if (budgetControlled !== undefined) changedFields.budgetControlled = budgetControlled;

    let postingRuleChanged = false;
    if (postingRestriction !== undefined) { changedFields.postingRestriction = postingRestriction; postingRuleChanged = true; }
    let dimensionsChanged = false;
    if (dimensions !== undefined) { changedFields.dimensions = dimensions; dimensionsChanged = true; }
    let currencyMappingChanged = false;
    if (currencyMapping !== undefined) { changedFields.currencyMapping = currencyMapping; currencyMappingChanged = true; }
    let taxMappingChanged = false;
    if (taxMapping !== undefined) { changedFields.taxMapping = taxMapping; taxMappingChanged = true; }
    let revenueRecognitionChanged = false;
    if (revenueRecognition !== undefined) { changedFields.revenueRecognition = revenueRecognition; revenueRecognitionChanged = true; }

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

    if (Object.keys(changedFields).length === 0) return account.toJSON();

    changedFields.updatedBy = userId || null;
    changedFields.version = account.version + 1;
    Object.assign(account, changedFields);
    account.revisionHistory.push({
      version: changedFields.version,
      changedBy: userId || null,
      changedAt: new Date(),
      changedFields: Object.keys(changedFields).filter((f) => f !== "updatedBy" && f !== "version"),
      snapshot
    });
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
    if (postingRuleChanged) publishEvent("PostingRuleChanged", { tenantId, accountId: account._id.toString(), postingRestriction: account.postingRestriction, performedBy: userId || null });
    if (dimensionsChanged) publishEvent("DimensionAssigned", { tenantId, accountId: account._id.toString(), dimensions: account.dimensions, performedBy: userId || null });
    if (currencyMappingChanged) publishEvent("CurrencyMappingUpdated", { tenantId, accountId: account._id.toString(), performedBy: userId || null });
    if (taxMappingChanged) publishEvent("TaxMappingUpdated", { tenantId, accountId: account._id.toString(), performedBy: userId || null });
    if (revenueRecognitionChanged) publishEvent("RevenueRecognitionRuleUpdated", { tenantId, accountId: account._id.toString(), revenueRecognition: account.revenueRecognition, performedBy: userId || null });

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

  /**
   * POST /api/v1/accounts/:accountId/reactivate — Inactive/Suspended/
   * Archived -> Active. The named `AccountActivated` event.
   */
  static async reactivateAccount(accountId, tenantId, userId) {
    const account = await ChartOfAccountModel.findOne({ _id: accountId, tenantId });
    if (!account) throw new Error("Account not found.");
    if (account.status === "Active") throw new Error("Account is already Active.");
    if (account.isSystemAccount) throw new Error("System accounts are managed by trusted server-side bootstrap only.");

    account.status = "Active";
    account.updatedBy = userId || null;
    await account.save();

    await AuditLogModel.create({ action: "finance.account.reactivate", module: "Finance", resource: "ChartOfAccount", resourceId: account._id.toString(), userId: userId || null, tenantId, details: { accountCode: account.accountCode } });
    publishEvent("AccountActivated", { tenantId, accountId: account._id.toString(), performedBy: userId || null });

    return account.toJSON();
  }

  /**
   * POST /api/v1/accounts/:accountId/suspend — Active -> Suspended. A
   * temporary block on posting, distinct from the more final Inactive/
   * Archived states.
   */
  static async suspendAccount(accountId, data, tenantId, userId) {
    const account = await ChartOfAccountModel.findOne({ _id: accountId, tenantId });
    if (!account) throw new Error("Account not found.");
    if (account.isSystemAccount) throw new Error("System accounts cannot be suspended.");
    if (account.status !== "Active") throw new Error(`Only Active accounts can be suspended (current status: "${account.status}").`);

    account.status = "Suspended";
    account.updatedBy = userId || null;
    await account.save();

    await AuditLogModel.create({ action: "finance.account.suspend", module: "Finance", resource: "ChartOfAccount", resourceId: account._id.toString(), userId: userId || null, tenantId, details: { reason: data?.reason || null } });
    publishEvent("AccountSuspended", { tenantId, accountId: account._id.toString(), reason: data?.reason || null, performedBy: userId || null });

    return account.toJSON();
  }

  /**
   * POST /api/v1/accounts/:accountId/archive — same structural guard as
   * deactivate (no children, no posted transactions, not a system
   * account), any non-Archived status -> Archived. The named
   * `AccountArchived` event, distinct from the pre-existing
   * `AccountDeactivated` (-> Inactive).
   */
  static async archiveAccount(accountId, tenantId, userId) {
    const account = await ChartOfAccountModel.findOne({ _id: accountId, tenantId });
    if (!account) throw new Error("Account not found.");
    if (account.status === "Archived") throw new Error("Account is already Archived.");
    assertCanDeactivate(account);

    const childCount = await ChartOfAccountModel.countDocuments({ tenantId, parentId: account._id });
    if (childCount > 0) {
      throw new Error("Account has child accounts and cannot be archived. Reassign or archive child accounts first.");
    }

    account.status = "Archived";
    account.updatedBy = userId || null;
    await account.save();

    await AuditLogModel.create({ action: "finance.account.archive", module: "Finance", resource: "ChartOfAccount", resourceId: account._id.toString(), userId: userId || null, tenantId, details: { accountCode: account.accountCode } });
    publishEvent("AccountArchived", { tenantId, accountId: account._id.toString(), performedBy: userId || null });

    return account.toJSON();
  }

  /**
   * POST /api/v1/accounts/:accountId/merge — merges `accountId` (source)
   * into `data.targetAccountId`. Real, deliberately bounded (see
   * `assertCanMerge`'s own doc comment): the source is archived and
   * flagged `mergedInto`, never deleted, and only ever allowed before it
   * has any posted journal history.
   */
  static async mergeAccounts(accountId, data, tenantId, userId) {
    const { targetAccountId } = data;
    if (!targetAccountId) throw new Error("targetAccountId is required.");

    const [source, target] = await Promise.all([
      ChartOfAccountModel.findOne({ _id: accountId, tenantId }),
      ChartOfAccountModel.findOne({ _id: targetAccountId, tenantId })
    ]);
    if (!source) throw new Error("Source account not found.");
    if (!target) throw new Error("Target account not found.");
    assertCanMerge(source, target);

    const childCount = await ChartOfAccountModel.countDocuments({ tenantId, parentId: source._id });
    if (childCount > 0) throw new Error("Source account has child accounts and cannot be merged. Reassign child accounts first.");

    source.status = "Archived";
    source.mergedInto = target._id;
    source.updatedBy = userId || null;
    await source.save();

    await AuditLogModel.create({ action: "finance.account.merge", module: "Finance", resource: "ChartOfAccount", resourceId: source._id.toString(), userId: userId || null, tenantId, details: { sourceAccountCode: source.accountCode, targetAccountCode: target.accountCode } });
    publishEvent("AccountMerged", { tenantId, sourceAccountId: source._id.toString(), targetAccountId: target._id.toString(), performedBy: userId || null });

    return source.toJSON();
  }

  /** Called by the (future) Journal/Posting Engine when a journal line first posts to this account. */
  static async markAsPosted(accountId, tenantId) {
    await ChartOfAccountModel.updateOne({ _id: accountId, tenantId }, { $set: { hasPostedTransactions: true } });
  }

  // ---- Account Templates ----

  static async listTemplates(query, tenantId) {
    const filter = { $or: [{ tenantId: null }, { tenantId }] };
    if (query.industry) filter.industry = query.industry;
    if (query.status) filter.status = query.status;
    return ChartTemplateModel.find(filter).sort({ isSystemTemplate: -1, name: 1 }).lean();
  }

  static async getTemplateById(templateId, tenantId) {
    const template = await ChartTemplateModel.findOne({ templateId, $or: [{ tenantId: null }, { tenantId }] }).lean();
    if (!template) throw new Error("Chart template not found.");
    return template;
  }

  /**
   * POST /api/v1/account-templates/:templateId/apply — bulk-creates real
   * ChartOfAccountModel rows for this tenant from the template's own
   * blueprints, resolving `parentAccountCode` references into real
   * parentId/ancestors/level via a multi-pass topological resolution (so
   * blueprints may be declared in any order). Idempotent: an account code
   * that already exists for this tenant is skipped, never overwritten or
   * duplicated.
   */
  static async applyTemplate(templateId, tenantId, userId) {
    const template = await ChartOfAccountService.getTemplateById(templateId, tenantId);
    const config = getFinanceConfig();

    const existingCodes = new Set((await ChartOfAccountModel.find({ tenantId }).select("accountCode").lean()).map((a) => a.accountCode));
    const createdIdByCode = new Map();
    const createdIds = [];
    const skipped = [];
    const pending = template.accountBlueprints.filter((bp) => !existingCodes.has(bp.accountCode));
    for (const bp of template.accountBlueprints) {
      if (existingCodes.has(bp.accountCode)) skipped.push(bp.accountCode);
    }

    let remaining = [...pending];
    let progressed = true;
    while (remaining.length > 0 && progressed) {
      progressed = false;
      const stillRemaining = [];
      for (const bp of remaining) {
        const parentResolved = !bp.parentAccountCode || createdIdByCode.has(bp.parentAccountCode) || existingCodes.has(bp.parentAccountCode);
        if (!parentResolved) { stillRemaining.push(bp); continue; }

        let parent = null;
        if (bp.parentAccountCode) {
          const parentId = createdIdByCode.get(bp.parentAccountCode);
          parent = parentId
            ? await ChartOfAccountModel.findOne({ _id: parentId, tenantId })
            : await ChartOfAccountModel.findOne({ tenantId, accountCode: bp.parentAccountCode });
        }

        const { level, ancestors } = computeHierarchyFields(parent);
        assertWithinMaxDepth(level, config.maxHierarchyDepth);

        const account = await ChartOfAccountModel.create({
          tenantId, accountCode: bp.accountCode, name: bp.name, description: bp.description || null,
          category: bp.category, type: bp.type, parentId: parent ? parent._id : null, ancestors, level,
          status: config.defaultAccountStatus, currency: config.defaultCurrency, allowPosting: bp.allowPosting !== false,
          ownershipType: "Company", version: 1, isSystemAccount: false, tags: bp.tags || [],
          createdBy: userId || null, updatedBy: userId || null
        });

        createdIdByCode.set(bp.accountCode, account._id);
        createdIds.push(account._id.toString());
        progressed = true;
      }
      remaining = stillRemaining;
    }
    // Whatever's left has an unresolvable parentAccountCode (a template
    // authoring bug) — reported, not silently dropped.
    const unresolved = remaining.map((bp) => bp.accountCode);

    await AuditLogModel.create({ action: "finance.account.apply_template", module: "Finance", resource: "ChartOfAccount", resourceId: template.templateId, userId: userId || null, tenantId, details: { templateId: template.templateId, createdCount: createdIds.length, skippedCount: skipped.length, unresolvedCount: unresolved.length } });
    publishEvent("ChartTemplateApplied", { tenantId, templateId: template.templateId, templateName: template.name, createdCount: createdIds.length, performedBy: userId || null });

    return { templateId: template.templateId, templateName: template.name, createdAccountIds: createdIds, createdCount: createdIds.length, skippedAccountCodes: skipped, unresolvedAccountCodes: unresolved };
  }

  static async createTemplate(data, tenantId, userId) {
    const { name, industry = null, description = null, accountBlueprints = [] } = data;
    if (!name) throw new Error("name is required.");
    if (!Array.isArray(accountBlueprints) || accountBlueprints.length === 0) throw new Error("accountBlueprints must be a non-empty array.");

    const templateId = ChartOfAccountService._generateTemplateId();
    const template = await ChartTemplateModel.create({
      tenantId: tenantId || null, templateId, name, industry, description, accountBlueprints,
      isSystemTemplate: false, status: "Active", createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "finance.account.create_template", module: "Finance", resource: "ChartTemplate", resourceId: template._id.toString(), userId: userId || null, tenantId, details: { templateId, name } });

    return template.toJSON();
  }
}

export default ChartOfAccountService;
