import BookingHeaderModel from "../models/BookingHeaderModel.js";
import CustomerStatisticsSummaryModel from "../models/CustomerStatisticsSummaryModel.js";
import { subscribeEvent } from "../utils/eventBus.js";

const ZERO_METRICS = {
  totalBookings: 0,
  completedTrips: 0,
  upcomingTrips: 0,
  cancelledTrips: 0,
  visaApplications: 0,
  approvedVisas: 0,
  rejectedVisas: 0,
  totalRevenue: 0,
  outstandingBalance: 0,
  refundAmount: 0,
  averageBookingValue: 0
};

class CustomerStatisticsEngine {
  static initialized = false;

  static init() {
    if (this.initialized) return;
    this.initialized = true;

    // Booking is the only module with a real customerId FK today (see the
    // same note in CustomerTimelineEventBus.js). Refresh is async and never
    // blocks the request that triggered the underlying booking change.
    const refreshEvents = [
      "BookingCreated", "BookingUpdated", "BookingConfirmed", "BookingCancelled",
      "BookingStatusChanged", "BookingArchived", "BookingRescheduled", "BookingFinancialRecalculated"
    ];

    refreshEvents.forEach((eventName) =>
      subscribeEvent(eventName, (payload) => {
        if (!payload?.bookingId || !payload?.tenantId) return;
        queueMicrotask(async () => {
          try {
            const booking = await BookingHeaderModel.findOne({ _id: payload.bookingId, tenantId: payload.tenantId }).select("customerId").lean();
            if (!booking?.customerId) return;
            await CustomerStatisticsEngine.refreshCustomerStatistics({ customerId: booking.customerId, tenantId: payload.tenantId });
          } catch (error) {
            console.error("Customer statistics refresh failed:", error);
          }
        });
      })
    );
  }

  static async refreshCustomerStatistics({ customerId, tenantId }) {
    const bookings = await BookingHeaderModel.find({ customerId, tenantId }).select("status visaStatus totalAmount travelDate financialSnapshot").lean();

    const now = new Date();
    const metrics = { ...ZERO_METRICS };
    metrics.totalBookings = bookings.length;
    metrics.completedTrips = bookings.filter((b) => b.status === "completed").length;
    metrics.cancelledTrips = bookings.filter((b) => ["cancelled", "rejected"].includes(b.status)).length;
    metrics.upcomingTrips = bookings.filter((b) => b.travelDate && new Date(b.travelDate) > now && !["cancelled", "rejected", "archived"].includes(b.status)).length;
    metrics.visaApplications = bookings.filter((b) => b.visaStatus && b.visaStatus !== "not_required").length;
    metrics.approvedVisas = bookings.filter((b) => b.visaStatus === "approved").length;
    metrics.rejectedVisas = bookings.filter((b) => b.visaStatus === "rejected").length;

    const revenueBookings = bookings.filter((b) => !["cancelled", "rejected"].includes(b.status));
    metrics.totalRevenue = revenueBookings.reduce((sum, b) => sum + (b.financialSnapshot?.totalAmount || b.totalAmount || 0), 0);
    metrics.outstandingBalance = bookings.reduce((sum, b) => sum + (b.financialSnapshot?.outstandingBalance || 0), 0);
    metrics.refundAmount = bookings.reduce((sum, b) => sum + (b.financialSnapshot?.refundAmount || 0), 0);
    metrics.averageBookingValue = revenueBookings.length > 0 ? Math.round((metrics.totalRevenue / revenueBookings.length) * 100) / 100 : 0;

    await CustomerStatisticsSummaryModel.findOneAndUpdate(
      { tenantId, customerId },
      { tenantId, customerId, metrics, lastRefreshedAt: new Date() },
      { upsert: true, setDefaultsOnInsert: true }
    );

    return metrics;
  }

  /**
   * Read-side accessor for GET /customers/{id}/statistics. Never computes
   * synchronously — on a cold start (no summary row yet) it returns zeroed
   * booking metrics immediately and schedules an async refresh so the next
   * read is accurate, matching "Never block user requests while recalculating."
   */
  static async ensureBookingMetrics({ customerId, tenantId }) {
    const summary = await CustomerStatisticsSummaryModel.findOne({ tenantId, customerId }).lean();
    if (!summary) {
      queueMicrotask(() =>
        CustomerStatisticsEngine.refreshCustomerStatistics({ customerId, tenantId }).catch((error) =>
          console.error("Initial customer statistics refresh failed:", error)
        )
      );
      return { ...ZERO_METRICS, lastRefreshedAt: null };
    }
    return { ...ZERO_METRICS, ...summary.metrics, lastRefreshedAt: summary.lastRefreshedAt };
  }
}

export default CustomerStatisticsEngine;
