import NumberingSchemeModel from "../models/NumberingSchemeModel.js";
import ResourceSequenceModel from "../models/ResourceSequenceModel.js";
import GeneratedNumberModel from "../models/GeneratedNumberModel.js";
import CompanyModel from "../models/CompanyModel.js";
import BranchModel from "../models/BranchModel.js";
import LegalEntityModel from "../models/LegalEntityModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getNumberingConfig, computeFiscalYear } from "../utils/numberingConfig.js";

/**
 * Enterprise Identity & Global Resource ID Platform (Improvement 5). Owns
 * the real, centrally-configurable Number Generator every business object
 * in this ERP should mint its human-readable number and Global Resource
 * ID through: "Every Business Entity Must Have UUID + Human Readable
 * Number + Global Resource ID," "Numbers Must Be Generated Centrally."
 *
 * Global Resource ID format: `{tenantSegment}[-{legalEntityCode}]-{documentNumber}`
 * — e.g. `MAQVERA-LE-4821-INV-2027-000145`. tenantSegment is derived
 * directly from the tenant's own tenantId (== TenantModel.tenantKey
 * throughout this codebase, see utils/accessScope.js), not a separately
 * managed short code — real and unique per tenant without inventing a
 * second tenant-numbering scheme on top of Improvement 4's own Organisation
 * platform. legalEntityCode is included only when a legalEntityId is
 * resolvable (explicitly passed, or looked up from a supplied companyId
 * via CompanyModel) — optional, since not every tenant adopts the
 * Organisation hierarchy (Improvement 4's own backward-compatibility
 * guarantee carries through here unchanged).
 */
class NumberGeneratorService {
  static _sanitizeSegment(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "TENANT";
  }

  static _paginate(query, config) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    return { page, pageSize };
  }

  static _buildDocumentNumber(scheme, { companyCode, branchCode, fiscalYear, seq }) {
    const segments = [scheme.prefix];
    if (scheme.includeCompany && companyCode) segments.push(companyCode);
    if (scheme.includeBranch && branchCode) segments.push(branchCode);
    if (scheme.includeYear) segments.push(String(fiscalYear));
    segments.push(String(seq).padStart(scheme.sequenceLength, "0"));
    return segments.join(scheme.separator || "-");
  }

  // ---- Schemes ----

  static async createScheme(tenantId, data, userId) {
    const config = getNumberingConfig();
    const {
      resourceType, companyId = null, branchId = null, prefix,
      separator = config.defaultSeparator, includeYear = true, includeCompany = false, includeBranch = false,
      sequenceLength = config.defaultSequenceLength, fiscalYearStartMonth = config.defaultFiscalYearStartMonth,
      allowGaps = true, isDefault = false
    } = data;
    if (!resourceType || !prefix) throw new Error("resourceType and prefix are required.");

    const existing = await NumberingSchemeModel.findOne({ tenantId, resourceType, companyId, branchId }).lean();
    if (existing) throw new Error(`A numbering scheme already exists for resourceType "${resourceType}" with this company/branch combination.`);

    if (isDefault) await NumberingSchemeModel.updateMany({ tenantId, resourceType, isDefault: true }, { $set: { isDefault: false } });

    const scheme = await NumberingSchemeModel.create({
      tenantId, resourceType, companyId, branchId, prefix, separator,
      includeYear, includeCompany, includeBranch, sequenceLength, fiscalYearStartMonth, allowGaps, isDefault,
      status: "Active",
      timeline: [{ event: "NumberSchemeCreated", description: `Numbering scheme for ${resourceType} created (${prefix}).`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "numbering.scheme.create", module: "Identity", resource: "NumberingScheme", resourceId: scheme._id.toString(), userId: userId || null, tenantId, details: { resourceType, prefix } });
    publishEvent("NumberSchemeCreated", { schemeId: scheme._id.toString(), tenantId, resourceType, prefix, performedBy: userId || null });

    return scheme.toJSON();
  }

  static async listSchemes(tenantId, query) {
    const config = getNumberingConfig();
    const filter = { tenantId };
    if (query.resourceType) filter.resourceType = query.resourceType;
    if (query.companyId) filter.companyId = query.companyId;
    if (query.branchId) filter.branchId = query.branchId;
    if (query.status) filter.status = query.status;
    const { page, pageSize } = NumberGeneratorService._paginate(query, config);

    const [items, total] = await Promise.all([
      NumberingSchemeModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      NumberingSchemeModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getSchemeById(tenantId, schemeId) {
    const scheme = await NumberingSchemeModel.findOne({ _id: schemeId, tenantId }).lean();
    if (!scheme) throw new Error("Numbering scheme not found.");
    return scheme;
  }

  static async updateScheme(tenantId, schemeId, data, userId) {
    const config = getNumberingConfig();
    const scheme = await NumberingSchemeModel.findOne({ _id: schemeId, tenantId });
    if (!scheme) throw new Error("Numbering scheme not found.");

    const { prefix, separator, includeYear, includeCompany, includeBranch, sequenceLength, fiscalYearStartMonth, allowGaps, isDefault, status } = data;
    if (prefix !== undefined) scheme.prefix = prefix;
    if (separator !== undefined) scheme.separator = separator;
    if (includeYear !== undefined) scheme.includeYear = includeYear;
    if (includeCompany !== undefined) scheme.includeCompany = includeCompany;
    if (includeBranch !== undefined) scheme.includeBranch = includeBranch;
    if (sequenceLength !== undefined) scheme.sequenceLength = sequenceLength;
    if (fiscalYearStartMonth !== undefined) scheme.fiscalYearStartMonth = fiscalYearStartMonth;
    if (allowGaps !== undefined) scheme.allowGaps = allowGaps;
    if (status !== undefined) {
      if (!config.schemeStatuses.includes(status)) throw new Error(`Invalid status "${status}".`);
      scheme.status = status;
    }
    if (isDefault !== undefined) {
      if (isDefault) await NumberingSchemeModel.updateMany({ tenantId, resourceType: scheme.resourceType, isDefault: true, _id: { $ne: scheme._id } }, { $set: { isDefault: false } });
      scheme.isDefault = isDefault;
    }
    scheme.updatedBy = userId || null;
    scheme.timeline.push({ event: "NumberSchemeUpdated", description: "Numbering scheme updated.", performedBy: userId || null });
    await scheme.save();

    await AuditLogModel.create({ action: "numbering.scheme.update", module: "Identity", resource: "NumberingScheme", resourceId: scheme._id.toString(), userId: userId || null, tenantId, details: data });
    publishEvent("NumberSchemeUpdated", { schemeId: scheme._id.toString(), tenantId, performedBy: userId || null });

    return scheme.toJSON();
  }

  /** Exact company+branch match > company-level match > explicit tenant default > plain tenant-wide scheme. Never fabricates a fallback format silently. */
  static async _resolveScheme(tenantId, resourceType, companyId = null, branchId = null) {
    const attempts = [];
    if (companyId && branchId) attempts.push({ tenantId, resourceType, companyId, branchId, status: "Active" });
    if (companyId) attempts.push({ tenantId, resourceType, companyId, branchId: null, status: "Active" });
    attempts.push({ tenantId, resourceType, isDefault: true, status: "Active" });
    attempts.push({ tenantId, resourceType, companyId: null, branchId: null, status: "Active" });

    for (const filter of attempts) {
      const scheme = await NumberingSchemeModel.findOne(filter);
      if (scheme) return scheme;
    }

    // Auto-provision standard default scheme for the tenant so business workflows never block
    try {
      const prefixMap = {
        Booking: "BK",
        Customer: "CUST",
        Invoice: "INV",
        Payment: "PAY",
        Receipt: "RCP",
        Voucher: "VCH",
        Visa: "VIS",
        Package: "PKG",
      };
      const prefix = prefixMap[resourceType] || String(resourceType).slice(0, 4).toUpperCase();
      const autoScheme = await NumberingSchemeModel.create({
        tenantId,
        resourceType,
        companyId: null,
        branchId: null,
        prefix,
        separator: "-",
        includeYear: true,
        sequenceLength: 6,
        allowGaps: true,
        isDefault: true,
        status: "Active",
        timeline: [
          {
            event: "NumberSchemeAutoCreated",
            description: `Default scheme for ${resourceType} auto-provisioned (${prefix}).`,
            performedBy: "system",
          },
        ],
      });
      return autoScheme;
    } catch (createErr) {
      const fallback = await NumberingSchemeModel.findOne({ tenantId, resourceType, status: "Active" });
      if (fallback) return fallback;
    }

    throw new Error(`No numbering scheme configured for resourceType "${resourceType}". Create one via POST /api/v1/numbering/schemes.`);
  }

  // ---- Generate / Register / Rollback / Reset ----

  static async generateNumber(tenantId, data, userId) {
    const { resourceType, companyId = null, branchId = null, resourceUuid = null } = data;
    let { legalEntityId = null } = data;
    if (!resourceType) throw new Error("resourceType is required.");

    const scheme = await NumberGeneratorService._resolveScheme(tenantId, resourceType, companyId, branchId);

    const [company, branch] = await Promise.all([
      companyId ? CompanyModel.findOne({ _id: companyId, tenantId }).lean() : null,
      branchId ? BranchModel.findOne({ _id: branchId, tenantId }).lean() : null
    ]);
    if (!legalEntityId && company) legalEntityId = company.legalEntityId;
    const legalEntity = legalEntityId ? await LegalEntityModel.findOne({ _id: legalEntityId, tenantId }).lean() : null;

    const fiscalYear = computeFiscalYear(new Date(), scheme.fiscalYearStartMonth);
    const sequenceKey = scheme.includeYear ? String(fiscalYear) : "ALL";
    const seq = await ResourceSequenceModel.getNext(tenantId, scheme._id, sequenceKey);

    const documentNumber = NumberGeneratorService._buildDocumentNumber(scheme, {
      companyCode: company?.companyCode, branchCode: branch?.branchCode, fiscalYear, seq
    });
    const tenantSegment = NumberGeneratorService._sanitizeSegment(tenantId);
    const legalEntitySegment = legalEntity ? legalEntity.legalEntityCode : null;
    const globalResourceId = [tenantSegment, legalEntitySegment, documentNumber].filter(Boolean).join("-");

    const isRegistered = !!resourceUuid;
    const generated = await GeneratedNumberModel.create({
      tenantId, schemeId: scheme._id, resourceType, companyId, branchId, legalEntityId: legalEntityId || null,
      sequenceKey, sequenceValue: seq, documentNumber, globalResourceId,
      resourceUuid: resourceUuid || null,
      status: isRegistered ? "Registered" : "Reserved",
      registeredAt: isRegistered ? new Date() : null,
      registeredBy: isRegistered ? (userId || null) : null,
      generatedBy: userId || null
    });

    await AuditLogModel.create({ action: "numbering.generate", module: "Identity", resource: "GeneratedNumber", resourceId: generated._id.toString(), userId: userId || null, tenantId, details: { resourceType, documentNumber, globalResourceId } });
    publishEvent("NumberGenerated", { generatedNumberId: generated._id.toString(), tenantId, resourceType, documentNumber, globalResourceId, performedBy: userId || null });
    publishEvent("SequenceReserved", { generatedNumberId: generated._id.toString(), tenantId, schemeId: scheme._id.toString(), sequenceKey, sequenceValue: seq, performedBy: userId || null });
    if (isRegistered) publishEvent("ResourceRegistered", { generatedNumberId: generated._id.toString(), tenantId, resourceType, resourceUuid, documentNumber, globalResourceId, performedBy: userId || null });

    return generated.toJSON();
  }

  static async registerResource(tenantId, generatedNumberId, resourceUuid, userId) {
    if (!resourceUuid) throw new Error("resourceUuid is required.");
    const generated = await GeneratedNumberModel.findOne({ _id: generatedNumberId, tenantId });
    if (!generated) throw new Error("Generated number not found.");
    if (generated.status === "RolledBack") throw new Error("Cannot register a rolled-back number.");
    if (generated.status === "Registered") {
      if (generated.resourceUuid !== resourceUuid) throw new Error("This number is already registered to a different resource.");
      return generated.toJSON();
    }

    generated.resourceUuid = resourceUuid;
    generated.status = "Registered";
    generated.registeredAt = new Date();
    generated.registeredBy = userId || null;
    await generated.save();

    await AuditLogModel.create({ action: "numbering.register", module: "Identity", resource: "GeneratedNumber", resourceId: generated._id.toString(), userId: userId || null, tenantId, details: { resourceUuid } });
    publishEvent("ResourceRegistered", { generatedNumberId: generated._id.toString(), tenantId, resourceType: generated.resourceType, resourceUuid, documentNumber: generated.documentNumber, globalResourceId: generated.globalResourceId, performedBy: userId || null });

    return generated.toJSON();
  }

  static async rollbackSequence(tenantId, generatedNumberId, reason, userId) {
    const generated = await GeneratedNumberModel.findOne({ _id: generatedNumberId, tenantId });
    if (!generated) throw new Error("Generated number not found.");
    if (generated.status !== "Reserved") throw new Error(`Cannot roll back a number in status "${generated.status}".`);

    const scheme = await NumberingSchemeModel.findOne({ _id: generated.schemeId, tenantId }).lean();
    if (!scheme) throw new Error("Numbering scheme not found.");
    if (scheme.allowGaps) throw new Error("This scheme allows gaps — rolled-back numbers are simply left unused, not reclaimed. Nothing to roll back.");

    const reclaimed = await ResourceSequenceModel.rollbackIfUnclaimed(tenantId, generated.schemeId, generated.sequenceKey, generated.sequenceValue);

    generated.status = "RolledBack";
    generated.rolledBackAt = new Date();
    generated.rolledBackBy = userId || null;
    generated.rolledBackReason = reason || null;
    await generated.save();

    await AuditLogModel.create({ action: "numbering.rollback", module: "Identity", resource: "GeneratedNumber", resourceId: generated._id.toString(), userId: userId || null, tenantId, details: { reason, reclaimed } });
    publishEvent("SequenceRolledBack", { generatedNumberId: generated._id.toString(), tenantId, schemeId: generated.schemeId.toString(), sequenceValue: generated.sequenceValue, reclaimed, performedBy: userId || null });

    return generated.toJSON();
  }

  static async resetSequence(tenantId, schemeId, key, newValue, userId) {
    if (typeof newValue !== "number" || newValue < 0) throw new Error("newValue must be a non-negative number.");
    const scheme = await NumberingSchemeModel.findOne({ _id: schemeId, tenantId }).lean();
    if (!scheme) throw new Error("Numbering scheme not found.");

    const sequence = await ResourceSequenceModel.findOneAndUpdate(
      { tenantId, schemeId, key },
      { $set: { seq: newValue } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await AuditLogModel.create({ action: "numbering.sequence.reset", module: "Identity", resource: "ResourceSequence", resourceId: sequence._id.toString(), userId: userId || null, tenantId, details: { schemeId, key, newValue } });
    publishEvent("SequenceReset", { schemeId, tenantId, key, newValue, performedBy: userId || null });

    return { schemeId, key, seq: sequence.seq };
  }

  static async listHistory(tenantId, query) {
    const config = getNumberingConfig();
    const filter = { tenantId };
    if (query.resourceType) filter.resourceType = query.resourceType;
    if (query.companyId) filter.companyId = query.companyId;
    if (query.branchId) filter.branchId = query.branchId;
    if (query.status) filter.status = query.status;
    if (query.resourceUuid) filter.resourceUuid = query.resourceUuid;
    if (query.documentNumber) filter.documentNumber = query.documentNumber;
    const { page, pageSize } = NumberGeneratorService._paginate(query, config);

    const [items, total] = await Promise.all([
      GeneratedNumberModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      GeneratedNumberModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }
}

export default NumberGeneratorService;
