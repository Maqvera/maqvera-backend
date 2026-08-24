import mongoose from "mongoose";
import FinancialReportService from "../services/FinancialReportService.js";
import FinancialReportExportService from "../services/FinancialReportExportService.js";
import ReportScheduleModel from "../models/ReportScheduleModel.js";
import FinancialReportModel from "../models/FinancialReportModel.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";
import { getFinanceConfig } from "../utils/financeConfig.js";
import { publishEvent } from "../utils/eventBus.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import ReportAuditService from "../services/ReportAuditService.js";

// Reporting Platform Part 13 fix — listReports/getFinancialReport/
// drillDownReport had no audit logging at all before this (only
// export/schedule actions did). Same fire-and-forget, readyState-guarded
// discipline as every other audit call site in this file/codebase;
// ReportAuditService is the additional tamper-evident layer alongside
// AuditLogModel.
const auditReportAccess = (tenantId, userId, action, reportId, reportType, details = {}) => {
  if (mongoose.connection?.readyState === 1) {
    AuditLogModel.create({ tenantId, userId: userId || null, action, module: "Finance", resource: "FinancialReport", resourceId: reportId || null, details })
      .catch((err) => console.error("Financial report audit log error:", err));
  }
  ReportAuditService.recordEvent({
    tenantId, module: "Finance", resourceType: "Report", resourceKey: reportType || reportId || "unknown",
    action: "VIEW", userId
  }).catch((err) => console.error("Financial report report-audit error:", err));
};

const hasPermission = (req, ...keys) => {
  const permissions = req.auth?.permissions || [];
  return permissions.includes("admin") || keys.some((key) => permissions.includes(key));
};

const statusFromError = (error) => {
  const message = error.message || "";
  if (message.includes("already")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("required") || message.includes("cannot") || message.includes("Cannot") || message.includes("Invalid") || message.includes("not yet supported") || message.includes("Unrecognized") || message.includes("not supported")) return 400;
  return 500;
};

// ---- Reports ----

export const generateReport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.report.create")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const report = await FinancialReportService.generateReport(req.body, scope.tenantId, userId);
    return sendSuccess(res, 201, "Financial report generated successfully.", report, requestId);
  } catch (error) {
    console.error("generateReport error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to generate financial report.", requestId);
  }
};

export const listReports = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.report.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const result = await FinancialReportService.listReports(req.query, scope.tenantId);
    auditReportAccess(scope.tenantId, req.auth?.userId || req.auth?.id || null, "LIST_REPORTS", null, null, { query: req.query });
    return sendSuccess(res, 200, "Financial reports retrieved successfully.", result, requestId);
  } catch (error) {
    console.error("listReports error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve financial reports.", requestId);
  }
};

export const getFinancialReport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.report.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const report = await FinancialReportService.getReportById(req.params.reportId, scope.tenantId);
    auditReportAccess(scope.tenantId, req.auth?.userId || req.auth?.id || null, "VIEW_REPORT", req.params.reportId, report?.reportType);
    return sendSuccess(res, 200, "Financial report retrieved successfully.", report, requestId);
  } catch (error) {
    console.error("getReport error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to retrieve financial report.", requestId);
  }
};

export const archiveReport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.report.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const report = await FinancialReportService.archiveReport(req.params.reportId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Financial report archived successfully.", report, requestId);
  } catch (error) {
    console.error("archiveReport error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to archive financial report.", requestId);
  }
};

export const cancelReport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.report.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const report = await FinancialReportService.cancelReport(req.params.reportId, scope.tenantId, userId);
    return sendSuccess(res, 200, "Financial report cancelled successfully.", report, requestId);
  } catch (error) {
    console.error("cancelReport error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel financial report.", requestId);
  }
};

export const drillDownReport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.report.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const items = await FinancialReportService.drillDown(req.params.reportId, req.query, scope.tenantId);
    auditReportAccess(scope.tenantId, req.auth?.userId || req.auth?.id || null, "DRILL_DOWN_REPORT", req.params.reportId, null, { query: req.query });
    return sendSuccess(res, 200, "Drill-down entries retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("drillDownReport error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to drill down on financial report.", requestId);
  }
};

export const exportReport = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.report.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const config = getFinanceConfig();
    const { format } = req.body;
    if (!config.reportExportFormats.includes(format)) return sendError(res, 400, `Invalid format "${format}".`, requestId);

    const reportDoc = await FinancialReportModel.findOne({ _id: req.params.reportId, tenantId: scope.tenantId });
    if (!reportDoc) return sendError(res, 404, "Financial report not found.", requestId);

    const exportResult = await FinancialReportExportService.exportAndStore(reportDoc, format, scope.tenantId, { permissions: req.auth?.permissions || [] });
    reportDoc.exports.push(exportResult);
    reportDoc.timeline.push({ event: "ReportExported", description: `Exported as ${format}.`, performedBy: userId || null });
    await reportDoc.save();

    await AuditLogModel.create({ action: "finance.report.export", module: "Finance", resource: "FinancialReport", resourceId: reportDoc._id.toString(), userId: userId || null, tenantId: scope.tenantId, details: { format } });
    publishEvent("ReportExported", { tenantId: scope.tenantId, reportId: reportDoc._id.toString(), reportType: reportDoc.reportType, format, performedBy: userId || null, module: "Finance" });

    return sendSuccess(res, 201, "Financial report exported successfully.", exportResult, requestId);
  } catch (error) {
    console.error("exportReport error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to export financial report.", requestId);
  }
};

// ---- Report Schedules ----

export const createSchedule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.report.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const config = getFinanceConfig();
    const { name, reportType, parameters = {}, frequency, recipientEmails = [], format } = req.body;
    if (!name || !reportType || !frequency || !format) return sendError(res, 400, "name, reportType, frequency, and format are required.", requestId);
    if (!config.reportTypes.includes(reportType)) return sendError(res, 400, `Invalid reportType "${reportType}".`, requestId);
    if (!config.reportScheduleFrequencies.includes(frequency)) return sendError(res, 400, `Invalid frequency "${frequency}".`, requestId);
    if (!config.reportExportFormats.includes(format)) return sendError(res, 400, `Invalid format "${format}".`, requestId);

    const nextRunAt = new Date();
    const schedule = await ReportScheduleModel.create({ tenantId: scope.tenantId, name, reportType, parameters, frequency, recipientEmails, format, nextRunAt, status: "Active", createdBy: userId || null, updatedBy: userId || null });

    await AuditLogModel.create({ action: "finance.report.create_schedule", module: "Finance", resource: "ReportSchedule", resourceId: schedule._id.toString(), userId: userId || null, tenantId: scope.tenantId, details: { name, reportType, frequency } });
    publishEvent("ReportScheduleCreated", { tenantId: scope.tenantId, scheduleId: schedule._id.toString() });

    return sendSuccess(res, 201, "Report schedule created successfully.", schedule.toJSON(), requestId);
  } catch (error) {
    console.error("createSchedule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to create report schedule.", requestId);
  }
};

export const listSchedules = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.report.read", "finance.read")) return sendError(res, 403, "Permission denied.", requestId);

    const filter = { tenantId: scope.tenantId };
    if (req.query.status) filter.status = req.query.status;
    const items = await ReportScheduleModel.find(filter).sort({ createdAt: -1 }).lean();

    return sendSuccess(res, 200, "Report schedules retrieved successfully.", { items }, requestId);
  } catch (error) {
    console.error("listSchedules error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve report schedules.", requestId);
  }
};

export const cancelSchedule = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!hasPermission(req, "finance.report.manage")) return sendError(res, 403, "Permission denied.", requestId);
    const userId = req.auth?.userId || req.auth?.id || null;

    const schedule = await ReportScheduleModel.findOne({ _id: req.params.scheduleId, tenantId: scope.tenantId });
    if (!schedule) return sendError(res, 404, "Report schedule not found.", requestId);
    if (schedule.status === "Cancelled") return sendError(res, 400, "Report schedule is already Cancelled.", requestId);

    schedule.status = "Cancelled";
    schedule.updatedBy = userId || null;
    await schedule.save();

    await AuditLogModel.create({ action: "finance.report.cancel_schedule", module: "Finance", resource: "ReportSchedule", resourceId: schedule._id.toString(), userId: userId || null, tenantId: scope.tenantId, details: {} });
    publishEvent("ReportScheduleCancelled", { tenantId: scope.tenantId, scheduleId: schedule._id.toString() });

    return sendSuccess(res, 200, "Report schedule cancelled successfully.", schedule.toJSON(), requestId);
  } catch (error) {
    console.error("cancelSchedule error:", error);
    return sendError(res, statusFromError(error), error.message || "Failed to cancel report schedule.", requestId);
  }
};
