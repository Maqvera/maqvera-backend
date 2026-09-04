import AgentModel from "../models/AgentModel.js";
import AgentWalletModel from "../models/AgentWalletModel.js";
import AgentWalletTransactionModel from "../models/AgentWalletTransactionModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";

// Agent Performance Reporting (gap-audit "Gap E") — was blocked on the
// Agent Portal existing at all (module 21's "agent performance ranking,
// revenue-by-agent" depends on AgentModel/AgentWalletTransactionModel,
// both now real). A read-only aggregation over already-real data — no new
// write path, no new domain concept — bookings are attributed to an agent
// via BookingHeaderModel.agentUserId (a bare string equal to
// AgentModel._id.toString(), the same convention AgentService.getMyBookings
// already reads), and commission earned comes from
// AgentWalletTransactionModel (direction:"Credit", the append-only ledger
// AgentCommissionService already writes on a qualifying booking).
class AgentAnalyticsService {
  static async getAgentPerformanceReport(tenantId, query = {}) {
    const { from = null, to = null, limit = 50 } = query;
    const bookingMatch = { tenantId, agentUserId: { $ne: null } };
    if (from || to) {
      bookingMatch.createdAt = {};
      if (from) bookingMatch.createdAt.$gte = new Date(from);
      if (to) bookingMatch.createdAt.$lte = new Date(to);
    }

    const [bookingStats, agents, wallets] = await Promise.all([
      BookingHeaderModel.aggregate([
        { $match: bookingMatch },
        { $group: { _id: "$agentUserId", bookingCount: { $sum: 1 }, revenue: { $sum: { $ifNull: ["$totalAmount", 0] } } } }
      ]),
      AgentModel.find({ tenantId }).select("name email status").lean(),
      AgentWalletModel.find({ tenantId }).select("agentId balance currency").lean()
    ]);

    const walletByAgentId = new Map(wallets.map((w) => [w.agentId.toString(), w]));
    const walletIds = wallets.map((w) => w._id);
    const commissionRows = walletIds.length > 0
      ? await AgentWalletTransactionModel.aggregate([
          // type:"CommissionEarned" specifically, not every Credit — a
          // manual "Adjustment" credit is real wallet balance but isn't
          // commission the agent earned from a booking, and reporting it
          // as such would overstate this agent's actual sales performance.
          { $match: { tenantId, walletId: { $in: walletIds }, type: "CommissionEarned", direction: "Credit" } },
          { $group: { _id: "$walletId", commissionEarned: { $sum: "$amount" } } }
        ])
      : [];
    const commissionByWalletId = new Map(commissionRows.map((r) => [r._id.toString(), r.commissionEarned]));

    const bookingStatsByAgentId = new Map(bookingStats.map((s) => [s._id, s]));

    const rows = agents.map((agent) => {
      const agentIdStr = agent._id.toString();
      const stats = bookingStatsByAgentId.get(agentIdStr) || { bookingCount: 0, revenue: 0 };
      const wallet = walletByAgentId.get(agentIdStr) || null;
      const commissionEarned = wallet ? (commissionByWalletId.get(wallet._id.toString()) || 0) : 0;
      return {
        agentId: agentIdStr,
        name: agent.name,
        email: agent.email,
        status: agent.status,
        bookingCount: stats.bookingCount,
        revenue: stats.revenue,
        commissionEarned,
        walletBalance: wallet?.balance ?? 0,
        walletCurrency: wallet?.currency ?? null
      };
    });

    rows.sort((a, b) => b.revenue - a.revenue);

    return {
      items: rows.slice(0, Math.min(Number(limit) || 50, 200)),
      totals: {
        agentCount: agents.length,
        totalBookings: rows.reduce((sum, r) => sum + r.bookingCount, 0),
        totalRevenue: rows.reduce((sum, r) => sum + r.revenue, 0),
        totalCommissionEarned: rows.reduce((sum, r) => sum + r.commissionEarned, 0)
      }
    };
  }
}

export default AgentAnalyticsService;
