import test from "node:test";
import assert from "node:assert/strict";
import ApprovalNotificationListener from "../services/ApprovalNotificationListener.js";
import InAppNotificationService from "../services/InAppNotificationService.js";
import ApprovalRequestModel from "../models/ApprovalRequestModel.js";
import AIApprovalRequestModel from "../models/AIApprovalRequestModel.js";
import RoleModel from "../models/Rolemodel.js";
import UserModel from "../models/Usermodel.js";

const tenantId = "TENANT-TEST-APPROVALNOTIF-001";

const selectLean = (result) => ({ select: () => ({ lean: async () => result }) });

test("ApprovalNotificationListener._handleApprovalAssigned — notifies every approver in the level", async () => {
  const origFindById = ApprovalRequestModel.findById;
  const origCreate = InAppNotificationService.createNotification;
  const notified = [];

  try {
    ApprovalRequestModel.findById = () => selectLean({ module: "Finance", entityRef: "INV-1001", entityId: "ENT-1" });
    InAppNotificationService.createNotification = async (payload) => { notified.push(payload); return payload; };

    await ApprovalNotificationListener._handleApprovalAssigned({
      tenantId, approvalId: "APR-1", levelName: "Manager", approverIds: ["USER-A", "USER-B"]
    });

    assert.equal(notified.length, 2);
    assert.deepEqual(notified.map((n) => n.userId).sort(), ["USER-A", "USER-B"]);
    assert.equal(notified[0].category, "Approval");
    assert.match(notified[0].title, /Approval required: Manager/);
    assert.match(notified[0].body, /INV-1001/);
    assert.equal(notified[0].actionUrl, "/approvals/APR-1");
    assert.equal(notified[0].groupKey, "approval:APR-1");
  } finally {
    ApprovalRequestModel.findById = origFindById;
    InAppNotificationService.createNotification = origCreate;
  }
});

test("ApprovalNotificationListener._handleApprovalOutcome — notifies the original requester, not the approver", async () => {
  const origFindById = ApprovalRequestModel.findById;
  const origCreate = InAppNotificationService.createNotification;
  const notified = [];

  try {
    ApprovalRequestModel.findById = () => selectLean({ module: "Finance", entityRef: "INV-1001", entityId: "ENT-1", requestedBy: "USER-REQUESTER" });
    InAppNotificationService.createNotification = async (payload) => { notified.push(payload); return payload; };

    await ApprovalNotificationListener._handleApprovalOutcome({ tenantId, approvalId: "APR-1" }, "Rejected");

    assert.equal(notified.length, 1);
    assert.equal(notified[0].userId, "USER-REQUESTER");
    assert.match(notified[0].title, /rejected/i);
  } finally {
    ApprovalRequestModel.findById = origFindById;
    InAppNotificationService.createNotification = origCreate;
  }
});

test("ApprovalNotificationListener._handleApprovalOutcome — silently no-ops when the request has no requestedBy on file (never crashes the listener)", async () => {
  const origFindById = ApprovalRequestModel.findById;
  const origCreate = InAppNotificationService.createNotification;
  let createCalled = false;

  try {
    ApprovalRequestModel.findById = () => selectLean({ module: "Finance", requestedBy: null });
    InAppNotificationService.createNotification = async () => { createCalled = true; };

    await ApprovalNotificationListener._handleApprovalOutcome({ tenantId, approvalId: "APR-2" }, "Approved");
    assert.equal(createCalled, false);
  } finally {
    ApprovalRequestModel.findById = origFindById;
    InAppNotificationService.createNotification = origCreate;
  }
});

test("ApprovalNotificationListener._handleAIApprovalRequested — resolves requiredRole to eligible users and notifies each", async () => {
  const origFindByIdAI = AIApprovalRequestModel.findById;
  const origRoleFind = RoleModel.find;
  const origUserFind = UserModel.find;
  const origCreate = InAppNotificationService.createNotification;
  const notified = [];

  try {
    AIApprovalRequestModel.findById = () => selectLean({ requiredRole: "Finance Manager", requestedByName: "Ali", riskLevel: "high" });
    RoleModel.find = () => ({ select: () => ({ lean: async () => [{ name: "Finance Manager", permissions: ["finance.read"] }, { name: "Sales Rep", permissions: [] }] }) });
    UserModel.find = () => ({ select: () => ({ lean: async () => [{ _id: "USER-FM-1" }, { _id: "USER-FM-2" }] }) });
    InAppNotificationService.createNotification = async (payload) => { notified.push(payload); return payload; };

    await ApprovalNotificationListener._handleAIApprovalRequested({ tenantId, approvalRequestId: "AIAPR-1", toolName: "propose_refund" });

    assert.equal(notified.length, 2);
    assert.equal(notified[0].category, "AIApproval");
    assert.match(notified[0].title, /propose_refund/);
    assert.match(notified[0].body, /Ali/);
  } finally {
    AIApprovalRequestModel.findById = origFindByIdAI;
    RoleModel.find = origRoleFind;
    UserModel.find = origUserFind;
    InAppNotificationService.createNotification = origCreate;
  }
});

test("ApprovalNotificationListener._resolveUsersByRole — also includes users whose role holds admin/superadmin permission, matching AIOrchestrationService's own decideApproval authorization rule", async () => {
  const origRoleFind = RoleModel.find;
  const origUserFind = UserModel.find;

  try {
    RoleModel.find = () => ({ select: () => ({ lean: async () => [{ name: "Ops Admin", permissions: ["admin"] }, { name: "Finance Manager", permissions: [] }] }) });
    UserModel.find = (query) => {
      assert.deepEqual(query.role.$in.sort(), ["Ops Admin"]);
      return { select: () => ({ lean: async () => [{ _id: "USER-ADMIN-1" }] }) };
    };

    const userIds = await ApprovalNotificationListener._resolveUsersByRole(tenantId, "Someone Else's Role");
    assert.deepEqual(userIds, ["USER-ADMIN-1"]);
  } finally {
    RoleModel.find = origRoleFind;
    UserModel.find = origUserFind;
  }
});

test("ApprovalNotificationListener._handleAIApprovalOutcome — notifies the requester of the AI proposal", async () => {
  const origFindByIdAI = AIApprovalRequestModel.findById;
  const origCreate = InAppNotificationService.createNotification;
  const notified = [];

  try {
    AIApprovalRequestModel.findById = () => selectLean({ requestedBy: "USER-REQUESTER-AI" });
    InAppNotificationService.createNotification = async (payload) => { notified.push(payload); return payload; };

    await ApprovalNotificationListener._handleAIApprovalOutcome({ tenantId, approvalRequestId: "AIAPR-2", toolName: "propose_booking_cancel" }, "Approved");

    assert.equal(notified.length, 1);
    assert.equal(notified[0].userId, "USER-REQUESTER-AI");
    assert.match(notified[0].body, /propose_booking_cancel/);
  } finally {
    AIApprovalRequestModel.findById = origFindByIdAI;
    InAppNotificationService.createNotification = origCreate;
  }
});
