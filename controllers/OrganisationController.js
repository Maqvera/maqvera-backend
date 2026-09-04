import OrganisationService from "../services/OrganisationService.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already") || message.includes("does not belong")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("Invalid") || message.includes("Cannot") || message.includes("cannot") || message.includes("closed and cannot")) return 400;
  return 500;
};

const userIdOf = (req) => req.auth?.userId || req.auth?.id || null;

// Enterprise Organisation Structure Platform (Improvement 4). Every
// handler resolves tenant identity from getAccessScope(req) only (never a
// request param/header) and gates on req.auth.permissions — same
// discipline as controllers/MerchantAccountController.js. Business logic
// (hierarchy/parent validation, code generation, events) lives entirely in
// services/OrganisationService.js; these handlers just translate
// HTTP <-> service calls.

// ---- Organisations ----

export const createOrganisation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "organisation.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const organisation = await OrganisationService.createOrganisation(scope.tenantId, req.body, userIdOf(req));
    return sendSuccess(res, 201, "Organisation created successfully.", organisation, requestId);
  } catch (error) {
    console.error("createOrganisation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create organisation.", requestId);
  }
};

export const listOrganisations = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "organisation.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await OrganisationService.listOrganisations(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Organisations retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listOrganisations error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve organisations.", requestId);
  }
};

export const getOrganisation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "organisation.read")) return sendError(res, 403, "Permission denied.", requestId);

    const organisation = await OrganisationService.getOrganisationById(scope.tenantId, req.params.organisationId);
    return sendSuccess(res, 200, "Organisation retrieved successfully.", organisation, requestId);
  } catch (error) {
    console.error("getOrganisation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve organisation.", requestId);
  }
};

export const updateOrganisation = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "organisation.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const organisation = await OrganisationService.updateOrganisation(scope.tenantId, req.params.organisationId, req.body, userIdOf(req));
    return sendSuccess(res, 200, "Organisation updated successfully.", organisation, requestId);
  } catch (error) {
    console.error("updateOrganisation error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update organisation.", requestId);
  }
};

// ---- Legal Entities ----

export const createLegalEntity = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "legalentity.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const legalEntity = await OrganisationService.createLegalEntity(scope.tenantId, req.body, userIdOf(req));
    return sendSuccess(res, 201, "Legal entity created successfully.", legalEntity, requestId);
  } catch (error) {
    console.error("createLegalEntity error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create legal entity.", requestId);
  }
};

export const listLegalEntities = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "legalentity.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await OrganisationService.listLegalEntities(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Legal entities retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listLegalEntities error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve legal entities.", requestId);
  }
};

export const getLegalEntity = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "legalentity.read")) return sendError(res, 403, "Permission denied.", requestId);

    const legalEntity = await OrganisationService.getLegalEntityById(scope.tenantId, req.params.legalEntityId);
    return sendSuccess(res, 200, "Legal entity retrieved successfully.", legalEntity, requestId);
  } catch (error) {
    console.error("getLegalEntity error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve legal entity.", requestId);
  }
};

export const updateLegalEntity = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "legalentity.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const legalEntity = await OrganisationService.updateLegalEntity(scope.tenantId, req.params.legalEntityId, req.body, userIdOf(req));
    return sendSuccess(res, 200, "Legal entity updated successfully.", legalEntity, requestId);
  } catch (error) {
    console.error("updateLegalEntity error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update legal entity.", requestId);
  }
};

export const activateLegalEntity = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "legalentity.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const legalEntity = await OrganisationService.activateLegalEntity(scope.tenantId, req.params.legalEntityId, userIdOf(req));
    return sendSuccess(res, 200, "Legal entity activated successfully.", legalEntity, requestId);
  } catch (error) {
    console.error("activateLegalEntity error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to activate legal entity.", requestId);
  }
};

// ---- Business Units ----

export const createBusinessUnit = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "businessunit.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const businessUnit = await OrganisationService.createBusinessUnit(scope.tenantId, req.body, userIdOf(req));
    return sendSuccess(res, 201, "Business unit created successfully.", businessUnit, requestId);
  } catch (error) {
    console.error("createBusinessUnit error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create business unit.", requestId);
  }
};

export const listBusinessUnits = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "businessunit.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await OrganisationService.listBusinessUnits(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Business units retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listBusinessUnits error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve business units.", requestId);
  }
};

export const getBusinessUnit = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "businessunit.read")) return sendError(res, 403, "Permission denied.", requestId);

    const businessUnit = await OrganisationService.getBusinessUnitById(scope.tenantId, req.params.businessUnitId);
    return sendSuccess(res, 200, "Business unit retrieved successfully.", businessUnit, requestId);
  } catch (error) {
    console.error("getBusinessUnit error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve business unit.", requestId);
  }
};

export const updateBusinessUnit = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "businessunit.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const businessUnit = await OrganisationService.updateBusinessUnit(scope.tenantId, req.params.businessUnitId, req.body, userIdOf(req));
    return sendSuccess(res, 200, "Business unit updated successfully.", businessUnit, requestId);
  } catch (error) {
    console.error("updateBusinessUnit error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update business unit.", requestId);
  }
};

// ---- Companies ----

export const createCompany = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "company.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const company = await OrganisationService.createCompany(scope.tenantId, req.body, userIdOf(req));
    return sendSuccess(res, 201, "Company created successfully.", company, requestId);
  } catch (error) {
    console.error("createCompany error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create company.", requestId);
  }
};

export const listCompanies = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "company.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await OrganisationService.listCompanies(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Companies retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listCompanies error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve companies.", requestId);
  }
};

export const getCompany = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "company.read")) return sendError(res, 403, "Permission denied.", requestId);

    const company = await OrganisationService.getCompanyById(scope.tenantId, req.params.companyId);
    return sendSuccess(res, 200, "Company retrieved successfully.", company, requestId);
  } catch (error) {
    console.error("getCompany error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve company.", requestId);
  }
};

export const updateCompany = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "company.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const company = await OrganisationService.updateCompany(scope.tenantId, req.params.companyId, req.body, userIdOf(req));
    return sendSuccess(res, 200, "Company updated successfully.", company, requestId);
  } catch (error) {
    console.error("updateCompany error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update company.", requestId);
  }
};

// ---- Branches ----
// Descriptive/organisational only (see models/BranchModel.js) — no
// handler here ever narrows a tenant-owned data query by branchId; that
// remains exclusively getAccessScope(req)'s job.

export const createBranch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "branch.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const branch = await OrganisationService.createBranch(scope.tenantId, req.body, userIdOf(req));
    return sendSuccess(res, 201, "Branch created successfully.", branch, requestId);
  } catch (error) {
    console.error("createBranch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create branch.", requestId);
  }
};

export const listBranches = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "branch.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await OrganisationService.listBranches(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Branches retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listBranches error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve branches.", requestId);
  }
};

export const getBranch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "branch.read")) return sendError(res, 403, "Permission denied.", requestId);

    const branch = await OrganisationService.getBranchById(scope.tenantId, req.params.branchId);
    return sendSuccess(res, 200, "Branch retrieved successfully.", branch, requestId);
  } catch (error) {
    console.error("getBranch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve branch.", requestId);
  }
};

export const updateBranch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "branch.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const branch = await OrganisationService.updateBranch(scope.tenantId, req.params.branchId, req.body, userIdOf(req));
    return sendSuccess(res, 200, "Branch updated successfully.", branch, requestId);
  } catch (error) {
    console.error("updateBranch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update branch.", requestId);
  }
};

export const closeBranch = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "branch.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const branch = await OrganisationService.closeBranch(scope.tenantId, req.params.branchId, req.body?.reason, userIdOf(req));
    return sendSuccess(res, 200, "Branch closed successfully.", branch, requestId);
  } catch (error) {
    console.error("closeBranch error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to close branch.", requestId);
  }
};

// ---- Departments ----

export const createDepartment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "department.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const department = await OrganisationService.createDepartment(scope.tenantId, req.body, userIdOf(req));
    return sendSuccess(res, 201, "Department created successfully.", department, requestId);
  } catch (error) {
    console.error("createDepartment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create department.", requestId);
  }
};

export const listDepartments = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "department.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await OrganisationService.listDepartments(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Departments retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listDepartments error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve departments.", requestId);
  }
};

export const getDepartment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "department.read")) return sendError(res, 403, "Permission denied.", requestId);

    const department = await OrganisationService.getDepartmentById(scope.tenantId, req.params.departmentId);
    return sendSuccess(res, 200, "Department retrieved successfully.", department, requestId);
  } catch (error) {
    console.error("getDepartment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve department.", requestId);
  }
};

export const updateDepartment = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "department.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const department = await OrganisationService.updateDepartment(scope.tenantId, req.params.departmentId, req.body, userIdOf(req));
    return sendSuccess(res, 200, "Department updated successfully.", department, requestId);
  } catch (error) {
    console.error("updateDepartment error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update department.", requestId);
  }
};

// ---- Teams ----

export const createTeam = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "team.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const team = await OrganisationService.createTeam(scope.tenantId, req.body, userIdOf(req));
    return sendSuccess(res, 201, "Team created successfully.", team, requestId);
  } catch (error) {
    console.error("createTeam error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create team.", requestId);
  }
};

export const listTeams = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "team.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await OrganisationService.listTeams(scope.tenantId, req.query);
    return sendSuccess(res, 200, "Teams retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listTeams error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve teams.", requestId);
  }
};

export const getTeam = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "team.read")) return sendError(res, 403, "Permission denied.", requestId);

    const team = await OrganisationService.getTeamById(scope.tenantId, req.params.teamId);
    return sendSuccess(res, 200, "Team retrieved successfully.", team, requestId);
  } catch (error) {
    console.error("getTeam error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve team.", requestId);
  }
};

export const updateTeam = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "team.manage")) return sendError(res, 403, "Permission denied.", requestId);

    const team = await OrganisationService.updateTeam(scope.tenantId, req.params.teamId, req.body, userIdOf(req));
    return sendSuccess(res, 200, "Team updated successfully.", team, requestId);
  } catch (error) {
    console.error("updateTeam error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to update team.", requestId);
  }
};
