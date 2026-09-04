import express from "express";
import rateLimit from "express-rate-limit";
import authenticateAccessToken from "../middleware/authenticateAccessToken.js";
import validate, { organisationSchemas } from "../middleware/validateRequest.js";
import idempotency from "../middleware/idempotency.js";
import {
  createOrganisation, listOrganisations, getOrganisation, updateOrganisation,
  createLegalEntity, listLegalEntities, getLegalEntity, updateLegalEntity, activateLegalEntity,
  createBusinessUnit, listBusinessUnits, getBusinessUnit, updateBusinessUnit,
  createCompany, listCompanies, getCompany, updateCompany,
  createBranch, listBranches, getBranch, updateBranch, closeBranch,
  createDepartment, listDepartments, getDepartment, updateDepartment,
  createTeam, listTeams, getTeam, updateTeam
} from "../controllers/OrganisationController.js";

const router = express.Router();
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 10 minutes."
});

// Enterprise Organisation Structure Platform (Improvement 4). File 0's own
// literal `/api/v1/organisations`, `/api/v1/legal-entities`,
// `/api/v1/business-units`, `/api/v1/companies`, `/api/v1/branches`,
// `/api/v1/departments`, `/api/v1/teams` contract. Mounted at `/api/v1` in
// server.js. Every route requires a real authenticated tenant — same
// discipline as routes/MerchantPlatformRoutes.js.
router.use(authenticateAccessToken);

router.post("/organisations", limiter, idempotency(), validate(organisationSchemas.createOrganisation), createOrganisation);
router.get("/organisations", limiter, listOrganisations);
router.get("/organisations/:organisationId", limiter, getOrganisation);
router.patch("/organisations/:organisationId", limiter, validate(organisationSchemas.updateOrganisation), updateOrganisation);

router.post("/legal-entities", limiter, idempotency(), validate(organisationSchemas.createLegalEntity), createLegalEntity);
router.get("/legal-entities", limiter, listLegalEntities);
router.get("/legal-entities/:legalEntityId", limiter, getLegalEntity);
router.patch("/legal-entities/:legalEntityId", limiter, validate(organisationSchemas.updateLegalEntity), updateLegalEntity);
router.post("/legal-entities/:legalEntityId/activate", limiter, activateLegalEntity);

router.post("/business-units", limiter, idempotency(), validate(organisationSchemas.createBusinessUnit), createBusinessUnit);
router.get("/business-units", limiter, listBusinessUnits);
router.get("/business-units/:businessUnitId", limiter, getBusinessUnit);
router.patch("/business-units/:businessUnitId", limiter, validate(organisationSchemas.updateBusinessUnit), updateBusinessUnit);

router.post("/companies", limiter, idempotency(), validate(organisationSchemas.createCompany), createCompany);
router.get("/companies", limiter, listCompanies);
router.get("/companies/:companyId", limiter, getCompany);
router.patch("/companies/:companyId", limiter, validate(organisationSchemas.updateCompany), updateCompany);

router.post("/branches", limiter, idempotency(), validate(organisationSchemas.createBranch), createBranch);
router.get("/branches", limiter, listBranches);
router.get("/branches/:branchId", limiter, getBranch);
router.patch("/branches/:branchId", limiter, validate(organisationSchemas.updateBranch), updateBranch);
router.post("/branches/:branchId/close", limiter, validate(organisationSchemas.closeBranch), closeBranch);

router.post("/departments", limiter, idempotency(), validate(organisationSchemas.createDepartment), createDepartment);
router.get("/departments", limiter, listDepartments);
router.get("/departments/:departmentId", limiter, getDepartment);
router.patch("/departments/:departmentId", limiter, validate(organisationSchemas.updateDepartment), updateDepartment);

router.post("/teams", limiter, idempotency(), validate(organisationSchemas.createTeam), createTeam);
router.get("/teams", limiter, listTeams);
router.get("/teams/:teamId", limiter, getTeam);
router.patch("/teams/:teamId", limiter, validate(organisationSchemas.updateTeam), updateTeam);

export default router;
