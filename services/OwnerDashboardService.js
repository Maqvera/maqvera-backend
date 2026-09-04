import BookingHeaderModel from "../models/BookingHeaderModel.js";
import CustomerModel from "../models/CustomerModel.js";
import VisaCaseModel from "../models/VisaCaseModel.js";
import PaymentModel from "../models/PaymentModel.js";
import PackageModel from "../models/PackageModel.js";
import FinancialReportService, { groupRowsForProfitAndLoss } from "./FinancialReportService.js";

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Visa case statuses that mean "no longer awaiting agency/embassy action" —
// mirrors utils/visaConstants.js's own VISA_CASE_STATUSES values (that file
// exports the identifiers, not a "which ones are terminal" grouping, so
// this is the one place that decision is made).
const TERMINAL_VISA_STATUSES = ["completed", "rejected", "cancelled", "expired", "withdrawn", "blacklisted"];

const startOfDay = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const startOfMonth = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
const addDays = (date, days) => new Date(date.getTime() + days * 86400000);

const monthLabel = (date) => date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** Last `count` calendar months (oldest first), each as { start, end, label } — end is exclusive. */
const lastNMonths = (count, referenceDate) => {
  const months = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() - i + 1, 1));
    months.push({ start, end, label: monthLabel(start) });
  }
  return months;
};

/**
 * PRD "CRM Feature Map by Phase" Phase 1 module 2 — single-screen agency
 * owner overview, distinct from the ops-role-specific Travel/Visa/Finance
 * dashboards. Revenue/profit figures are read through
 * FinancialReportService (the same real GL period-movement + Profit&Loss
 * grouping every other financial report/dashboard in this codebase uses)
 * rather than re-deriving them from Payment/Expense records directly — a
 * tenant with no Chart of Accounts / journal postings yet honestly reports
 * 0, not a fabricated figure.
 */
class OwnerDashboardService {
  static async getOverview(tenantId) {
    const now = new Date();
    const today = startOfDay(now);
    const monthStart = startOfMonth(now);
    const yearAgo = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));
    const weekFromNow = addDays(now, 7);

    const [
      bookingsToday,
      bookingsThisMonth,
      totalCustomers,
      pendingVisasCount,
      upcomingDeparturesThisWeek,
      recentBookingsRaw,
      recentPaymentsRaw,
      monthlyBookingsAgg,
      monthPnl,
      packageSalesAgg
    ] = await Promise.all([
      BookingHeaderModel.countDocuments({ tenantId, createdAt: { $gte: today } }),
      BookingHeaderModel.countDocuments({ tenantId, createdAt: { $gte: monthStart } }),
      CustomerModel.countDocuments({ tenantId }),
      VisaCaseModel.countDocuments({ tenantId, status: { $nin: TERMINAL_VISA_STATUSES } }),
      BookingHeaderModel.countDocuments({ tenantId, travelDate: { $gte: now, $lte: weekFromNow } }),
      BookingHeaderModel.find({ tenantId }).sort({ createdAt: -1 }).limit(10)
        .select("bookingReference customerName packageId totalAmount currency status createdAt").lean(),
      PaymentModel.find({ tenantId }).sort({ createdAt: -1 }).limit(10)
        .select("paymentNumber amount currency status paymentType transactionDate").lean(),
      BookingHeaderModel.aggregate([
        { $match: { tenantId, createdAt: { $gte: yearAgo } } },
        { $group: { _id: { y: { $year: "$createdAt" }, m: { $month: "$createdAt" } }, count: { $sum: 1 } } }
      ]),
      FinancialReportService.getPeriodMovement(tenantId, monthStart, now, null, ["Revenue", "Expense"]),
      BookingHeaderModel.aggregate([
        { $match: { tenantId, createdAt: { $gte: monthStart } } },
        { $group: { _id: "$packageId", bookingCount: { $sum: 1 }, revenue: { $sum: "$totalAmount" } } },
        { $sort: { revenue: -1 } },
        { $limit: 10 }
      ])
    ]);

    const { totalRevenue: revenueThisMonth, netIncome: profitThisMonth } = groupRowsForProfitAndLoss(monthPnl);

    const packageIds = [...new Set([...recentBookingsRaw.map((b) => b.packageId?.toString()), ...packageSalesAgg.map((p) => p._id?.toString())].filter(Boolean))];
    const packages = packageIds.length > 0 ? await PackageModel.find({ _id: { $in: packageIds }, tenantId }).select("name").lean() : [];
    const packageNameById = new Map(packages.map((p) => [p._id.toString(), p.name]));

    const recentBookings = recentBookingsRaw.map((b) => ({
      _id: b._id, bookingReference: b.bookingReference, customerName: b.customerName,
      packageName: b.packageId ? packageNameById.get(b.packageId.toString()) || null : null,
      totalAmount: b.totalAmount, currency: b.currency, status: b.status, createdAt: b.createdAt
    }));

    const recentPayments = recentPaymentsRaw.map((p) => ({
      _id: p._id, paymentNumber: p.paymentNumber, amount: p.amount, currency: p.currency,
      status: p.status, paymentType: p.paymentType, transactionDate: p.transactionDate
    }));

    const bookingCountByMonthKey = new Map(monthlyBookingsAgg.map((row) => [`${row._id.y}-${row._id.m}`, row.count]));
    const months = lastNMonths(12, now);
    const monthlyBookingsChart = months.map(({ start, label }) => ({
      month: label, count: bookingCountByMonthKey.get(`${start.getUTCFullYear()}-${start.getUTCMonth() + 1}`) || 0
    }));

    const revenueTrendChart = await Promise.all(months.map(async ({ start, end, label }) => {
      const rows = await FinancialReportService.getPeriodMovement(tenantId, start, end, null, ["Revenue"]);
      const { totalRevenue } = groupRowsForProfitAndLoss(rows);
      return { month: label, revenue: totalRevenue };
    }));

    const packageSalesBreakdown = packageSalesAgg.map((row) => ({
      packageId: row._id, packageName: row._id ? packageNameById.get(row._id.toString()) || null : null,
      bookingCount: row.bookingCount, revenue: roundCurrency(row.revenue)
    }));

    return {
      bookingsToday, bookingsThisMonth, totalCustomers,
      revenueThisMonth, profitThisMonth,
      pendingVisasCount, upcomingDeparturesThisWeek,
      recentBookings, recentPayments,
      monthlyBookingsChart, revenueTrendChart, packageSalesBreakdown,
      generatedAt: now
    };
  }
}

export default OwnerDashboardService;
