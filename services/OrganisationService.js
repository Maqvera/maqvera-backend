import OrganisationModel from "../models/OrganisationModel.js";
import LegalEntityModel from "../models/LegalEntityModel.js";
import BusinessUnitModel from "../models/BusinessUnitModel.js";
import CompanyModel from "../models/CompanyModel.js";
import BranchModel from "../models/BranchModel.js";
import DepartmentModel from "../models/Departmentmodel.js";
import TeamModel from "../models/TeamModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import { getOrganisationConfig } from "../utils/organisationConfig.js";

const CLOSED_STATUSES = new Set(["closed", "deleted"]);

/**
 * Enterprise Organisation Structure Platform (Improvement 4). Owns the
 * real hierarchy every other module's organisationId/legalEntityId/
 * businessUnitId/companyId/branchId/departmentId/teamId references
 * resolve against:
 *
 *   Tenant -> Organisation -> Legal Entity -> [Business Unit] -> Company
 *   -> Branch -> Department -> Team
 *
 * Tenant remains the ONLY data-isolation boundary (utils/accessScope.js) —
 * every entity here is tenant-scoped, but that scoping is ownership
 * bookkeeping, never a second access-control dimension. Deliberately one
 * service for the whole hierarchy (not seven) because its entire reason
 * to exist is validating parent/child relationships across those seven
 * entities in one consistent place — see `_assertParent` below, the real
 * implementation of the spec's "Validate Entire Organisation Hierarchy"
 * rule.
 */
class OrganisationService {
  static _generateCode(prefix) {
    return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  static _paginate(query, config) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || config.defaultPageSize, 1), config.maxPageSize);
    return { page, pageSize };
  }

  /** Real parent-chain validation — every create/reparent of a child entity resolves its declared parent, confirms it belongs to the SAME tenant, and rejects a Closed/deleted parent as unable to accept new children. */
  static async _assertParent(Model, id, tenantId, label) {
    if (!id) throw new Error(`${label} is required.`);
    const parent = await Model.findOne({ _id: id, tenantId }).lean();
    if (!parent) throw new Error(`${label} not found.`);
    if (CLOSED_STATUSES.has(String(parent.status).toLowerCase())) throw new Error(`${label} is closed and cannot accept new records.`);
    return parent;
  }

  // ---- Organisation ----

  static async createOrganisation(tenantId, data, userId) {
    const config = getOrganisationConfig();
    const { name, description = null, industry = null } = data;
    if (!name) throw new Error("name is required.");

    const organisation = await OrganisationModel.create({
      organisationCode: OrganisationService._generateCode(config.organisationNumberPrefix),
      tenantId, name, description, industry,
      status: "Active",
      timeline: [{ event: "OrganisationCreated", description: `Organisation ${name} created.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "organisation.create", module: "Organisation", resource: "Organisation", resourceId: organisation._id.toString(), userId: userId || null, tenantId, details: { name } });
    publishEvent("OrganisationCreated", { organisationId: organisation._id.toString(), tenantId, name, performedBy: userId || null });

    return organisation.toJSON();
  }

  static async listOrganisations(tenantId, query) {
    const config = getOrganisationConfig();
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    const { page, pageSize } = OrganisationService._paginate(query, config);

    const [items, total] = await Promise.all([
      OrganisationModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      OrganisationModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getOrganisationById(tenantId, organisationId) {
    const organisation = await OrganisationModel.findOne({ _id: organisationId, tenantId }).lean();
    if (!organisation) throw new Error("Organisation not found.");
    return organisation;
  }

  static async updateOrganisation(tenantId, organisationId, data, userId) {
    const config = getOrganisationConfig();
    const organisation = await OrganisationModel.findOne({ _id: organisationId, tenantId });
    if (!organisation) throw new Error("Organisation not found.");

    const { name, description, industry, status } = data;
    if (name !== undefined) organisation.name = name;
    if (description !== undefined) organisation.description = description;
    if (industry !== undefined) organisation.industry = industry;
    if (status !== undefined) {
      if (!config.organisationStatuses.includes(status)) throw new Error(`Invalid status "${status}".`);
      organisation.status = status;
      if (status === "Closed") { organisation.closedAt = new Date(); organisation.closedBy = userId || null; }
    }
    organisation.updatedBy = userId || null;
    organisation.timeline.push({ event: "OrganisationUpdated", description: "Organisation updated.", performedBy: userId || null });
    await organisation.save();

    await AuditLogModel.create({ action: "organisation.update", module: "Organisation", resource: "Organisation", resourceId: organisation._id.toString(), userId: userId || null, tenantId, details: data });
    publishEvent("OrganisationUpdated", { organisationId: organisation._id.toString(), tenantId, performedBy: userId || null });

    return organisation.toJSON();
  }

  // ---- Legal Entity ----

  static async createLegalEntity(tenantId, data, userId) {
    const config = getOrganisationConfig();
    const { organisationId, name, registrationNumber = null, taxNumber = null, country = null, reportingCurrency = null } = data;
    if (!name) throw new Error("name is required.");
    await OrganisationService._assertParent(OrganisationModel, organisationId, tenantId, "Organisation");

    const status = registrationNumber && taxNumber ? "Active" : "Pending";
    const legalEntity = await LegalEntityModel.create({
      legalEntityCode: OrganisationService._generateCode(config.legalEntityNumberPrefix),
      tenantId, organisationId, name, registrationNumber, taxNumber, country, reportingCurrency,
      status,
      activatedAt: status === "Active" ? new Date() : null,
      activatedBy: status === "Active" ? (userId || null) : null,
      timeline: [{ event: "LegalEntityCreated", description: `Legal entity ${name} created (${status}).`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "legalentity.create", module: "Organisation", resource: "LegalEntity", resourceId: legalEntity._id.toString(), userId: userId || null, tenantId, details: { name, status } });
    publishEvent("LegalEntityCreated", { legalEntityId: legalEntity._id.toString(), organisationId, tenantId, name, status, performedBy: userId || null });
    if (status === "Active") publishEvent("LegalEntityActivated", { legalEntityId: legalEntity._id.toString(), tenantId, performedBy: userId || null });

    return legalEntity.toJSON();
  }

  static async listLegalEntities(tenantId, query) {
    const config = getOrganisationConfig();
    const filter = { tenantId };
    if (query.organisationId) filter.organisationId = query.organisationId;
    if (query.status) filter.status = query.status;
    const { page, pageSize } = OrganisationService._paginate(query, config);

    const [items, total] = await Promise.all([
      LegalEntityModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      LegalEntityModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getLegalEntityById(tenantId, legalEntityId) {
    const legalEntity = await LegalEntityModel.findOne({ _id: legalEntityId, tenantId }).lean();
    if (!legalEntity) throw new Error("Legal entity not found.");
    return legalEntity;
  }

  static async updateLegalEntity(tenantId, legalEntityId, data, userId) {
    const config = getOrganisationConfig();
    const legalEntity = await LegalEntityModel.findOne({ _id: legalEntityId, tenantId });
    if (!legalEntity) throw new Error("Legal entity not found.");

    const { name, registrationNumber, taxNumber, country, reportingCurrency, status } = data;
    if (name !== undefined) legalEntity.name = name;
    if (registrationNumber !== undefined) legalEntity.registrationNumber = registrationNumber;
    if (taxNumber !== undefined) legalEntity.taxNumber = taxNumber;
    if (country !== undefined) legalEntity.country = country;
    if (reportingCurrency !== undefined) legalEntity.reportingCurrency = reportingCurrency;
    if (status !== undefined) {
      if (!config.legalEntityStatuses.includes(status)) throw new Error(`Invalid status "${status}".`);
      legalEntity.status = status;
      if (status === "Closed") { legalEntity.closedAt = new Date(); legalEntity.closedBy = userId || null; }
    }
    legalEntity.updatedBy = userId || null;
    legalEntity.timeline.push({ event: "LegalEntityUpdated", description: "Legal entity updated.", performedBy: userId || null });
    await legalEntity.save();

    await AuditLogModel.create({ action: "legalentity.update", module: "Organisation", resource: "LegalEntity", resourceId: legalEntity._id.toString(), userId: userId || null, tenantId, details: data });
    publishEvent("LegalEntityUpdated", { legalEntityId: legalEntity._id.toString(), tenantId, performedBy: userId || null });

    return legalEntity.toJSON();
  }

  /** Explicit Pending -> Active transition — requires real registrationNumber + taxNumber to already be on file, same "no fabricated verification" discipline as MerchantAccountService.verifyMerchant. */
  static async activateLegalEntity(tenantId, legalEntityId, userId) {
    const legalEntity = await LegalEntityModel.findOne({ _id: legalEntityId, tenantId });
    if (!legalEntity) throw new Error("Legal entity not found.");
    if (legalEntity.status === "Active") return legalEntity.toJSON();
    if (!legalEntity.registrationNumber || !legalEntity.taxNumber) throw new Error("Legal entity requires a registrationNumber and taxNumber before it can be activated.");
    if (CLOSED_STATUSES.has(legalEntity.status.toLowerCase())) throw new Error(`Cannot activate a legal entity in status "${legalEntity.status}".`);

    legalEntity.status = "Active";
    legalEntity.activatedAt = new Date();
    legalEntity.activatedBy = userId || null;
    legalEntity.updatedBy = userId || null;
    legalEntity.timeline.push({ event: "LegalEntityActivated", description: "Legal entity activated.", performedBy: userId || null });
    await legalEntity.save();

    await AuditLogModel.create({ action: "legalentity.activate", module: "Organisation", resource: "LegalEntity", resourceId: legalEntity._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("LegalEntityActivated", { legalEntityId: legalEntity._id.toString(), tenantId, performedBy: userId || null });

    return legalEntity.toJSON();
  }

  // ---- Business Unit ----

  static async createBusinessUnit(tenantId, data, userId) {
    const config = getOrganisationConfig();
    const { legalEntityId, name, description = null } = data;
    if (!name) throw new Error("name is required.");
    const legalEntity = await OrganisationService._assertParent(LegalEntityModel, legalEntityId, tenantId, "Legal entity");

    const businessUnit = await BusinessUnitModel.create({
      businessUnitCode: OrganisationService._generateCode(config.businessUnitNumberPrefix),
      tenantId, organisationId: legalEntity.organisationId, legalEntityId, name, description,
      status: "Active",
      timeline: [{ event: "BusinessUnitCreated", description: `Business unit ${name} created.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "businessunit.create", module: "Organisation", resource: "BusinessUnit", resourceId: businessUnit._id.toString(), userId: userId || null, tenantId, details: { name } });
    publishEvent("BusinessUnitCreated", { businessUnitId: businessUnit._id.toString(), legalEntityId, tenantId, name, performedBy: userId || null });

    return businessUnit.toJSON();
  }

  static async listBusinessUnits(tenantId, query) {
    const config = getOrganisationConfig();
    const filter = { tenantId };
    if (query.legalEntityId) filter.legalEntityId = query.legalEntityId;
    if (query.organisationId) filter.organisationId = query.organisationId;
    if (query.status) filter.status = query.status;
    const { page, pageSize } = OrganisationService._paginate(query, config);

    const [items, total] = await Promise.all([
      BusinessUnitModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      BusinessUnitModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getBusinessUnitById(tenantId, businessUnitId) {
    const businessUnit = await BusinessUnitModel.findOne({ _id: businessUnitId, tenantId }).lean();
    if (!businessUnit) throw new Error("Business unit not found.");
    return businessUnit;
  }

  static async updateBusinessUnit(tenantId, businessUnitId, data, userId) {
    const config = getOrganisationConfig();
    const businessUnit = await BusinessUnitModel.findOne({ _id: businessUnitId, tenantId });
    if (!businessUnit) throw new Error("Business unit not found.");

    const { name, description, status } = data;
    if (name !== undefined) businessUnit.name = name;
    if (description !== undefined) businessUnit.description = description;
    if (status !== undefined) {
      if (!config.businessUnitStatuses.includes(status)) throw new Error(`Invalid status "${status}".`);
      businessUnit.status = status;
      if (status === "Closed") { businessUnit.closedAt = new Date(); businessUnit.closedBy = userId || null; }
    }
    businessUnit.updatedBy = userId || null;
    businessUnit.timeline.push({ event: "BusinessUnitUpdated", description: "Business unit updated.", performedBy: userId || null });
    await businessUnit.save();

    await AuditLogModel.create({ action: "businessunit.update", module: "Organisation", resource: "BusinessUnit", resourceId: businessUnit._id.toString(), userId: userId || null, tenantId, details: data });
    publishEvent("BusinessUnitUpdated", { businessUnitId: businessUnit._id.toString(), tenantId, performedBy: userId || null });

    return businessUnit.toJSON();
  }

  // ---- Company ----

  static async createCompany(tenantId, data, userId) {
    const config = getOrganisationConfig();
    const { legalEntityId, businessUnitId = null, name, registrationNumber = null, taxNumber = null, country = null, currency = null } = data;
    if (!name) throw new Error("name is required.");
    const legalEntity = await OrganisationService._assertParent(LegalEntityModel, legalEntityId, tenantId, "Legal entity");

    if (businessUnitId) {
      const businessUnit = await OrganisationService._assertParent(BusinessUnitModel, businessUnitId, tenantId, "Business unit");
      if (businessUnit.legalEntityId.toString() !== legalEntityId.toString()) throw new Error("businessUnitId does not belong to the given legalEntityId.");
    }

    const company = await CompanyModel.create({
      companyCode: OrganisationService._generateCode(config.companyNumberPrefix),
      tenantId, organisationId: legalEntity.organisationId, legalEntityId, businessUnitId,
      name, registrationNumber, taxNumber, country, currency,
      status: "Active",
      timeline: [{ event: "CompanyCreated", description: `Company ${name} created.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "company.create", module: "Organisation", resource: "Company", resourceId: company._id.toString(), userId: userId || null, tenantId, details: { name } });
    publishEvent("CompanyCreated", { companyId: company._id.toString(), legalEntityId, tenantId, name, performedBy: userId || null });

    return company.toJSON();
  }

  static async listCompanies(tenantId, query) {
    const config = getOrganisationConfig();
    const filter = { tenantId };
    if (query.legalEntityId) filter.legalEntityId = query.legalEntityId;
    if (query.businessUnitId) filter.businessUnitId = query.businessUnitId;
    if (query.status) filter.status = query.status;
    const { page, pageSize } = OrganisationService._paginate(query, config);

    const [items, total] = await Promise.all([
      CompanyModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      CompanyModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getCompanyById(tenantId, companyId) {
    const company = await CompanyModel.findOne({ _id: companyId, tenantId }).lean();
    if (!company) throw new Error("Company not found.");
    return company;
  }

  static async updateCompany(tenantId, companyId, data, userId) {
    const config = getOrganisationConfig();
    const company = await CompanyModel.findOne({ _id: companyId, tenantId });
    if (!company) throw new Error("Company not found.");

    const { name, registrationNumber, taxNumber, country, currency, status } = data;
    if (name !== undefined) company.name = name;
    if (registrationNumber !== undefined) company.registrationNumber = registrationNumber;
    if (taxNumber !== undefined) company.taxNumber = taxNumber;
    if (country !== undefined) company.country = country;
    if (currency !== undefined) company.currency = currency;
    if (status !== undefined) {
      if (!config.companyStatuses.includes(status)) throw new Error(`Invalid status "${status}".`);
      company.status = status;
      if (status === "Closed") { company.closedAt = new Date(); company.closedBy = userId || null; }
    }
    company.updatedBy = userId || null;
    company.timeline.push({ event: "CompanyUpdated", description: "Company updated.", performedBy: userId || null });
    await company.save();

    await AuditLogModel.create({ action: "company.update", module: "Organisation", resource: "Company", resourceId: company._id.toString(), userId: userId || null, tenantId, details: data });
    publishEvent("CompanyUpdated", { companyId: company._id.toString(), tenantId, performedBy: userId || null });

    return company.toJSON();
  }

  // ---- Branch ----
  // Descriptive/organisational only — see models/BranchModel.js's own doc
  // comment. Never consulted by getAccessScope() or any access filter.

  static async createBranch(tenantId, data, userId) {
    const config = getOrganisationConfig();
    const { companyId, name, address = {} } = data;
    if (!name) throw new Error("name is required.");
    await OrganisationService._assertParent(CompanyModel, companyId, tenantId, "Company");

    const branch = await BranchModel.create({
      branchCode: OrganisationService._generateCode(config.branchNumberPrefix),
      tenantId, companyId, name, address,
      status: "Active",
      timeline: [{ event: "BranchCreated", description: `Branch ${name} created.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "branch.create", module: "Organisation", resource: "Branch", resourceId: branch._id.toString(), userId: userId || null, tenantId, details: { name } });
    publishEvent("BranchCreated", { branchId: branch._id.toString(), companyId, tenantId, name, performedBy: userId || null });

    return branch.toJSON();
  }

  static async listBranches(tenantId, query) {
    const config = getOrganisationConfig();
    const filter = { tenantId };
    if (query.companyId) filter.companyId = query.companyId;
    if (query.status) filter.status = query.status;
    const { page, pageSize } = OrganisationService._paginate(query, config);

    const [items, total] = await Promise.all([
      BranchModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      BranchModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getBranchById(tenantId, branchId) {
    const branch = await BranchModel.findOne({ _id: branchId, tenantId }).lean();
    if (!branch) throw new Error("Branch not found.");
    return branch;
  }

  static async updateBranch(tenantId, branchId, data, userId) {
    const branch = await BranchModel.findOne({ _id: branchId, tenantId });
    if (!branch) throw new Error("Branch not found.");

    const { name, address } = data;
    if (name !== undefined) branch.name = name;
    if (address !== undefined) branch.address = { ...branch.address, ...address };
    branch.updatedBy = userId || null;
    branch.timeline.push({ event: "BranchUpdated", description: "Branch updated.", performedBy: userId || null });
    await branch.save();

    await AuditLogModel.create({ action: "branch.update", module: "Organisation", resource: "Branch", resourceId: branch._id.toString(), userId: userId || null, tenantId, details: data });
    publishEvent("BranchUpdated", { branchId: branch._id.toString(), tenantId, performedBy: userId || null });

    return branch.toJSON();
  }

  static async closeBranch(tenantId, branchId, reason, userId) {
    const branch = await BranchModel.findOne({ _id: branchId, tenantId });
    if (!branch) throw new Error("Branch not found.");
    if (branch.status === "Closed") return branch.toJSON();

    branch.status = "Closed";
    branch.closedAt = new Date();
    branch.closedBy = userId || null;
    branch.updatedBy = userId || null;
    branch.timeline.push({ event: "BranchClosed", description: reason || "Branch closed.", performedBy: userId || null });
    await branch.save();

    await AuditLogModel.create({ action: "branch.close", module: "Organisation", resource: "Branch", resourceId: branch._id.toString(), userId: userId || null, tenantId, details: { reason } });
    publishEvent("BranchClosed", { branchId: branch._id.toString(), tenantId, reason, performedBy: userId || null });

    return branch.toJSON();
  }

  // ---- Department ----
  // Reuses the pre-existing models/Departmentmodel.js (already referenced
  // by EmployeeProfileModel/UserController.js) — this platform only adds
  // the optional companyId/branchId hierarchy links and a real CRUD
  // surface; it never touches that model's own pre-existing
  // active/inactive/suspended/deleted status enum.

  static async createDepartment(tenantId, data, userId) {
    const config = getOrganisationConfig();
    const { companyId = null, branchId = null, name, description = null } = data;
    if (!name) throw new Error("name is required.");
    if (companyId) await OrganisationService._assertParent(CompanyModel, companyId, tenantId, "Company");
    if (branchId) {
      const branch = await OrganisationService._assertParent(BranchModel, branchId, tenantId, "Branch");
      if (companyId && branch.companyId.toString() !== companyId.toString()) throw new Error("branchId does not belong to the given companyId.");
    }

    const department = await DepartmentModel.create({
      departmentKey: OrganisationService._generateCode(config.departmentNumberPrefix),
      tenantId, companyId, branchId, name, description,
      status: "active"
    });

    await AuditLogModel.create({ action: "department.create", module: "Organisation", resource: "Department", resourceId: department._id.toString(), userId: userId || null, tenantId, details: { name } });
    publishEvent("DepartmentCreated", { departmentId: department._id.toString(), companyId, branchId, tenantId, name, performedBy: userId || null });

    return department.toJSON();
  }

  static async listDepartments(tenantId, query) {
    const config = getOrganisationConfig();
    const filter = { tenantId };
    if (query.companyId) filter.companyId = query.companyId;
    if (query.branchId) filter.branchId = query.branchId;
    if (query.status) filter.status = query.status;
    const { page, pageSize } = OrganisationService._paginate(query, config);

    const [items, total] = await Promise.all([
      DepartmentModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      DepartmentModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getDepartmentById(tenantId, departmentId) {
    const department = await DepartmentModel.findOne({ _id: departmentId, tenantId }).lean();
    if (!department) throw new Error("Department not found.");
    return department;
  }

  static async updateDepartment(tenantId, departmentId, data, userId) {
    const department = await DepartmentModel.findOne({ _id: departmentId, tenantId });
    if (!department) throw new Error("Department not found.");

    const { name, description, companyId, branchId, status } = data;
    if (name !== undefined) department.name = name;
    if (description !== undefined) department.description = description;
    if (companyId !== undefined) {
      if (companyId) await OrganisationService._assertParent(CompanyModel, companyId, tenantId, "Company");
      department.companyId = companyId;
    }
    if (branchId !== undefined) {
      if (branchId) await OrganisationService._assertParent(BranchModel, branchId, tenantId, "Branch");
      department.branchId = branchId;
    }
    if (status !== undefined) {
      if (!["active", "inactive", "suspended", "deleted"].includes(status)) throw new Error(`Invalid status "${status}".`);
      department.status = status;
    }
    await department.save();

    await AuditLogModel.create({ action: "department.update", module: "Organisation", resource: "Department", resourceId: department._id.toString(), userId: userId || null, tenantId, details: data });
    publishEvent("DepartmentUpdated", { departmentId: department._id.toString(), tenantId, performedBy: userId || null });

    return department.toJSON();
  }

  // ---- Team ----

  static async createTeam(tenantId, data, userId) {
    const config = getOrganisationConfig();
    const { departmentId, name, description = null } = data;
    if (!name) throw new Error("name is required.");
    const department = await DepartmentModel.findOne({ _id: departmentId, tenantId }).lean();
    if (!department) throw new Error("Department not found.");
    if (department.status !== "active") throw new Error("Department is not active and cannot accept new teams.");

    const team = await TeamModel.create({
      teamCode: OrganisationService._generateCode(config.teamNumberPrefix),
      tenantId, departmentId, name, description,
      status: "Active",
      timeline: [{ event: "TeamCreated", description: `Team ${name} created.`, performedBy: userId || null }],
      createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "team.create", module: "Organisation", resource: "Team", resourceId: team._id.toString(), userId: userId || null, tenantId, details: { name } });
    publishEvent("TeamCreated", { teamId: team._id.toString(), departmentId, tenantId, name, performedBy: userId || null });

    return team.toJSON();
  }

  static async listTeams(tenantId, query) {
    const config = getOrganisationConfig();
    const filter = { tenantId };
    if (query.departmentId) filter.departmentId = query.departmentId;
    if (query.status) filter.status = query.status;
    const { page, pageSize } = OrganisationService._paginate(query, config);

    const [items, total] = await Promise.all([
      TeamModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      TeamModel.countDocuments(filter)
    ]);
    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getTeamById(tenantId, teamId) {
    const team = await TeamModel.findOne({ _id: teamId, tenantId }).lean();
    if (!team) throw new Error("Team not found.");
    return team;
  }

  static async updateTeam(tenantId, teamId, data, userId) {
    const config = getOrganisationConfig();
    const team = await TeamModel.findOne({ _id: teamId, tenantId });
    if (!team) throw new Error("Team not found.");

    const { name, description, status } = data;
    if (name !== undefined) team.name = name;
    if (description !== undefined) team.description = description;
    if (status !== undefined) {
      if (!config.teamStatuses.includes(status)) throw new Error(`Invalid status "${status}".`);
      team.status = status;
      if (status === "Closed") { team.closedAt = new Date(); team.closedBy = userId || null; }
    }
    team.updatedBy = userId || null;
    team.timeline.push({ event: "TeamUpdated", description: "Team updated.", performedBy: userId || null });
    await team.save();

    await AuditLogModel.create({ action: "team.update", module: "Organisation", resource: "Team", resourceId: team._id.toString(), userId: userId || null, tenantId, details: data });
    publishEvent("TeamUpdated", { teamId: team._id.toString(), tenantId, performedBy: userId || null });

    return team.toJSON();
  }
}

export default OrganisationService;
