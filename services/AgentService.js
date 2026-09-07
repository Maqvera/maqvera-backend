import bcrypt from "bcryptjs";
import AgentModel from "../models/AgentModel.js";
import AgentWalletModel from "../models/AgentWalletModel.js";
import AgentWalletTransactionModel from "../models/AgentWalletTransactionModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import FinanceSequenceModel from "../models/FinanceSequenceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { getAuthConfig } from "../utils/authConfig.js";
import { validatePasswordPolicy } from "../utils/passwordPolicy.js";
import { createAgentAccessToken } from "../utils/authTokens.js";
import { publishEvent } from "../utils/eventBus.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

class AgentService {
  // ---- Staff-side management ----

  static async createAgent(data, tenantId, userId) {
    const { name, email, phone = null, password, parentAgentId = null, creditLimit = 0 } = data;
    if (!name || !email || !password) throw new Error("name, email, and password are required.");

    const policy = validatePasswordPolicy(password);
    if (!policy.valid) throw new Error(policy.errors.join(" "));

    const existing = await AgentModel.findOne({ email });
    if (existing) throw new Error(`An agent with email "${email}" already exists.`);

    if (parentAgentId) {
      const parent = await AgentModel.findOne({ _id: parentAgentId, tenantId });
      if (!parent) throw new Error("parentAgentId does not refer to an agent on this tenant.");
    }

    const passwordHash = await bcrypt.hash(password, getAuthConfig().bcryptSaltRounds);
    const agent = await AgentModel.create({
      tenantId, name, email, phone, passwordHash, parentAgentId, creditLimit: roundCurrency(creditLimit), createdBy: userId || null
    });

    await AuditLogModel.create({ action: "agent.create", module: "Agent", resource: "Agent", resourceId: agent._id.toString(), userId: userId || null, tenantId, details: { email } });
    publishEvent("AgentCreated", { tenantId, agentId: agent._id.toString(), performedBy: userId || null });

    return agent.toJSON();
  }

  static async listAgents(query = {}, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    return AgentModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async suspendAgent(agentId, tenantId, userId) {
    const agent = await AgentModel.findOne({ _id: agentId, tenantId });
    if (!agent) throw new Error("Agent not found.");
    agent.status = "Suspended";
    agent.updatedBy = userId || null;
    await agent.save();

    await AuditLogModel.create({ action: "agent.suspend", module: "Agent", resource: "Agent", resourceId: agent._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("AgentSuspended", { tenantId, agentId: agent._id.toString(), performedBy: userId || null });

    return agent.toJSON();
  }

  static async getAgentById(agentId, tenantId) {
    const agent = await AgentModel.findOne({ _id: agentId, tenantId }).lean();
    if (!agent) throw new Error("Agent not found.");

    const [wallet, recentBookings, bookingStats] = await Promise.all([
      AgentWalletModel.findOne({ tenantId, agentId }).lean(),
      BookingHeaderModel.find({ tenantId, agentUserId: agentId }).sort({ createdAt: -1 }).limit(10)
        .select("bookingReference customerName packageId status totalAmount currency travelDate createdAt").lean(),
      BookingHeaderModel.aggregate([
        { $match: { tenantId, agentUserId: agentId } },
        { $group: { _id: null, totalBookings: { $sum: 1 }, totalRevenue: { $sum: { $ifNull: ["$totalAmount", 0] } } } }
      ])
    ]);

    const stats = bookingStats[0] || { totalBookings: 0, totalRevenue: 0 };
    return {
      ...agent,
      wallet,
      recentBookings,
      stats
    };
  }

  static async updateAgent(agentId, tenantId, data, userId) {
    const agent = await AgentModel.findOne({ _id: agentId, tenantId });
    if (!agent) throw new Error("Agent not found.");

    const { name, phone, creditLimit, status, parentAgentId } = data;
    if (name !== undefined) agent.name = name;
    if (phone !== undefined) agent.phone = phone;
    if (creditLimit !== undefined) agent.creditLimit = roundCurrency(creditLimit);
    if (status !== undefined) {
      if (!["Active", "Suspended"].includes(status)) throw new Error("Invalid status. Must be Active or Suspended.");
      agent.status = status;
    }
    if (parentAgentId !== undefined) {
      if (parentAgentId) {
        const parent = await AgentModel.findOne({ _id: parentAgentId, tenantId });
        if (!parent) throw new Error("parentAgentId does not refer to an agent on this tenant.");
        if (parent._id.toString() === agentId) throw new Error("An agent cannot be its own parent.");
        agent.parentAgentId = parentAgentId;
      } else {
        agent.parentAgentId = null;
      }
    }

    agent.updatedBy = userId || null;
    await agent.save();

    await AuditLogModel.create({
      action: "agent.update", module: "Agent", resource: "Agent", resourceId: agent._id.toString(),
      userId: userId || null, tenantId, details: data
    });
    publishEvent("AgentUpdated", { tenantId, agentId: agent._id.toString(), performedBy: userId || null });

    return agent.toJSON();
  }

  static async adjustWalletBalance(agentId, tenantId, { amount, direction = "Credit", type = "Adjustment", description }, userId) {
    const agent = await AgentModel.findOne({ _id: agentId, tenantId }).lean();
    if (!agent) throw new Error("Agent not found.");

    const parsedAmount = roundCurrency(amount);
    if (parsedAmount <= 0) throw new Error("Adjustment amount must be greater than 0.");

    const wallet = await AgentService.getOrCreateWallet(agentId, agent.name, "SAR", tenantId, userId);

    if (direction === "Debit" && wallet.balance < parsedAmount) {
      throw new Error(`Insufficient wallet balance (Current: ${wallet.balance} SAR, Attempted debit: ${parsedAmount} SAR).`);
    }

    const delta = direction === "Credit" ? parsedAmount : -parsedAmount;
    wallet.balance = roundCurrency(wallet.balance + delta);
    wallet.updatedBy = userId || null;
    await wallet.save();

    const transaction = await AgentWalletTransactionModel.create({
      tenantId,
      walletId: wallet._id,
      type: type || "Adjustment",
      direction,
      amount: parsedAmount,
      balanceAfter: wallet.balance,
      currency: wallet.currency || "SAR",
      description: description || `Manual staff ${direction.toLowerCase()} adjustment`,
      performedBy: userId || "staff"
    });

    await AuditLogModel.create({
      action: "agent.wallet.adjusted",
      module: "Agent",
      resource: "AgentWallet",
      resourceId: wallet._id.toString(),
      userId: userId || null,
      tenantId,
      details: { amount: parsedAmount, direction, balanceAfter: wallet.balance }
    });
    publishEvent("AgentWalletAdjusted", { tenantId, agentId, walletId: wallet._id.toString(), amount: parsedAmount, direction });

    return { wallet, transaction: transaction.toJSON() };
  }

  // ---- Agent-side auth ----

  /** email is globally unique (same as Usermodel) — tenant is resolved from the matched agent, never supplied by the caller. */
  static async login(email, password) {
    const agent = await AgentModel.findOne({ email });
    if (!agent) throw new Error("Invalid email or password.");
    if (agent.status !== "Active") throw new Error(`Agent account is ${agent.status.toLowerCase()}.`);

    const valid = await bcrypt.compare(password, agent.passwordHash);
    if (!valid) throw new Error("Invalid email or password.");

    agent.lastLoginAt = new Date();
    await agent.save();

    const token = createAgentAccessToken({ agentId: agent._id.toString(), tenantId: agent.tenantId });
    return { token, agent: agent.toJSON() };
  }

  // ---- Agent-side portal ----

  static async getDashboard(agentId, tenantId) {
    const [bookingsCount, wallet] = await Promise.all([
      BookingHeaderModel.countDocuments({ tenantId, agentUserId: agentId }),
      AgentWalletModel.findOne({ tenantId, agentId }).lean()
    ]);

    return {
      bookingsCount,
      totalCommissionEarned: wallet?.balance || 0,
      walletCurrency: wallet?.currency || null
    };
  }

  static async getMyBookings(agentId, tenantId, query = {}) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 25, 1), 100);

    const filter = { tenantId, agentUserId: agentId };
    const [items, total] = await Promise.all([
      BookingHeaderModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize)
        .select("bookingReference customerName packageId status totalAmount currency travelDate createdAt").lean(),
      BookingHeaderModel.countDocuments(filter)
    ]);

    return { items, total, page, pageSize };
  }

  static async getMyWallet(agentId, tenantId) {
    const wallet = await AgentWalletModel.findOne({ tenantId, agentId }).lean();
    const transactions = wallet
      ? await AgentWalletTransactionModel.find({ tenantId, walletId: wallet._id }).sort({ createdAt: -1 }).limit(50).lean()
      : [];
    return { wallet, transactions };
  }

  // ---- Shared with AgentCommissionService.js ----

  static async _generateWalletNumber(tenantId) {
    const year = `${new Date().getUTCFullYear()}`;
    const seq = await FinanceSequenceModel.getNext(tenantId, "agentWalletNumber", year);
    return `AGT-WAL-${year}-${String(seq).padStart(6, "0")}`;
  }

  /** Find-or-create the one real wallet for this agent/currency — same idempotent shape as WalletService.createWallet/getOrCreateWallet. */
  static async getOrCreateWallet(agentId, agentName, currency, tenantId, userId = null) {
    let wallet = await AgentWalletModel.findOne({ tenantId, agentId, currency });
    if (wallet) return wallet;

    const walletNumber = await AgentService._generateWalletNumber(tenantId);
    wallet = await AgentWalletModel.create({ tenantId, walletNumber, agentId, agentName, currency, createdBy: userId });
    publishEvent("AgentWalletCreated", { tenantId, walletId: wallet._id.toString(), agentId, performedBy: userId });
    return wallet;
  }
}

export default AgentService;
