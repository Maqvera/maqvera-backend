import mongoose from "mongoose";
import EmployeeAttendanceModel from "../models/EmployeeAttendanceModel.js";
import EmployeeProfileModel from "../models/EmployeeProfilemodel.js";
import { sendSuccess, sendError } from "../utils/apiResponse.js";
import { createRequestId } from "../utils/authTokens.js";
import { getAccessScope } from "../utils/accessScope.js";

/** Same identityId-then-_id resolution controllers/UserController.js's own findUserAndProfile uses for "which employee profile does this authenticated user own." */
const resolveOwnEmployeeProfile = async (req, scope) => {
  const userId = req.auth?.id || req.auth?.userId;
  if (!userId) return null;

  let profile = await EmployeeProfileModel.findOne({ identityId: userId, ...scope, status: { $ne: "archived" } });
  if (!profile && mongoose.Types.ObjectId.isValid(userId)) {
    profile = await EmployeeProfileModel.findOne({ _id: userId, ...scope, status: { $ne: "archived" } });
  }
  return profile;
};

const todayUtc = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

export const clockIn = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);

    const profile = await resolveOwnEmployeeProfile(req, scope);
    if (!profile) return sendError(res, 404, "No employee profile found for the requesting user.", requestId);

    const date = todayUtc();
    const existing = await EmployeeAttendanceModel.findOne({ tenantId: scope.tenantId, employeeId: profile._id, date });
    if (existing?.clockInAt) return sendError(res, 409, "Already clocked in today.", requestId);

    const record = existing
      ? Object.assign(existing, { clockInAt: new Date(), status: "present", updatedBy: req.auth?.id || null })
      : new EmployeeAttendanceModel({ tenantId: scope.tenantId, employeeId: profile._id, date, clockInAt: new Date(), status: "present", createdBy: req.auth?.id || null });
    await record.save();

    return sendSuccess(res, 200, "Clocked in successfully.", record.toJSON(), requestId);
  } catch (error) {
    console.error("clockIn error:", error);
    return sendError(res, 500, error.message || "Failed to clock in.", requestId);
  }
};

export const clockOut = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);

    const profile = await resolveOwnEmployeeProfile(req, scope);
    if (!profile) return sendError(res, 404, "No employee profile found for the requesting user.", requestId);

    const date = todayUtc();
    const record = await EmployeeAttendanceModel.findOne({ tenantId: scope.tenantId, employeeId: profile._id, date });
    if (!record || !record.clockInAt) return sendError(res, 400, "Must clock in before clocking out.", requestId);
    if (record.clockOutAt) return sendError(res, 409, "Already clocked out today.", requestId);

    record.clockOutAt = new Date();
    record.updatedBy = req.auth?.id || null;
    await record.save();

    return sendSuccess(res, 200, "Clocked out successfully.", record.toJSON(), requestId);
  } catch (error) {
    console.error("clockOut error:", error);
    return sendError(res, 500, error.message || "Failed to clock out.", requestId);
  }
};

/** GET /attendance/:employeeId?month=YYYY-MM — staff/HR view of one employee's attendance log. */
export const getAttendance = async (req, res) => {
  const requestId = req.requestId || createRequestId();
  try {
    const scope = getAccessScope(req);
    const permissions = req.auth?.permissions || [];
    if (!scope) return sendError(res, 403, "Tenant context is required.", requestId);
    if (!permissions.includes("employee.read") && !permissions.includes("admin")) {
      return sendError(res, 403, "Permission denied.", requestId);
    }

    const employee = await EmployeeProfileModel.findOne({ _id: req.params.employeeId, ...scope }).lean();
    if (!employee) return sendError(res, 404, "Employee not found.", requestId);

    const filter = { tenantId: scope.tenantId, employeeId: employee._id };
    if (req.query.month) {
      const match = /^(\d{4})-(\d{2})$/.exec(req.query.month);
      if (!match) return sendError(res, 400, `Invalid month "${req.query.month}" — use YYYY-MM.`, requestId);
      const [, year, month] = match;
      filter.date = { $gte: new Date(Date.UTC(Number(year), Number(month) - 1, 1)), $lt: new Date(Date.UTC(Number(year), Number(month), 1)) };
    }

    const records = await EmployeeAttendanceModel.find(filter).sort({ date: -1 }).lean();
    return sendSuccess(res, 200, "Attendance records retrieved successfully.", { items: records }, requestId);
  } catch (error) {
    console.error("getAttendance error:", error);
    return sendError(res, 500, error.message || "Failed to retrieve attendance records.", requestId);
  }
};
