import PackageModel from "../models/PackageModel.js";
import { roundCurrency } from "./PackagePricingService.js";

/**
 * Package Pricing Engine — PRD §86 "Package Analytics." Tenant-scoped
 * (every query below carries `tenantId`); computed in JS over a plain
 * `.find(...).lean()` rather than a Mongo aggregation pipeline — simpler
 * and safer to get right for a first-pass dashboard than an $unwind-heavy
 * pipeline, at the cost of pulling full documents into memory (acceptable
 * for a per-tenant package count in the thousands, not millions).
 * "Sold" = `status: "Booked"`, matching PRD §86's own wording. Social
 * media leads/conversion is deliberately NOT included — that metric would
 * be meaningless before social publishing itself ships (still Phase 3).
 */
class PackageAnalyticsService {
  static async getSummary(tenantId) {
    const allPackages = await PackageModel.find({ tenantId }).lean();
    const soldPackages = allPackages.filter((p) => p.status === "Booked");

    const soldRows = [];
    for (const pkg of soldPackages) {
      for (const row of pkg.roomWisePriceMatrix || []) {
        const cost = (row.hotelCostPerPerson || 0) + (row.transportCostPerPerson || 0) + (row.flightCostPerPerson || 0) + (row.visaCostPerPerson || 0) + (row.servicesCostPerPerson || 0);
        const profit = roundCurrency((row.finalPricePerPerson || 0) - cost);
        const marginPct = row.finalPricePerPerson > 0 ? roundCurrency((profit / row.finalPricePerPerson) * 100) : 0;
        soldRows.push({ packageId: pkg._id.toString(), packageName: pkg.name, value: row.finalPricePerPerson, profit, marginPct });
      }
    }

    const average = (values) => (values.length > 0 ? roundCurrency(values.reduce((sum, v) => sum + v, 0) / values.length) : 0);

    const byPackage = new Map();
    for (const r of soldRows) {
      if (!byPackage.has(r.packageId)) byPackage.set(r.packageId, { packageId: r.packageId, packageName: r.packageName, profits: [], margins: [] });
      const entry = byPackage.get(r.packageId);
      entry.profits.push(r.profit);
      entry.margins.push(r.marginPct);
    }
    const packageAverages = [...byPackage.values()].map((e) => ({
      packageId: e.packageId, packageName: e.packageName, avgProfit: average(e.profits), avgMarginPct: average(e.margins)
    }));
    const mostProfitablePackage = packageAverages.length > 0 ? packageAverages.reduce((max, p) => (p.avgProfit > max.avgProfit ? p : max)) : null;
    const lowestMarginPackage = packageAverages.length > 0 ? packageAverages.reduce((min, p) => (p.avgMarginPct < min.avgMarginPct ? p : min)) : null;

    // Popularity, counted across every Booked package's own segments/matrix.
    // No single "the customer chose this room type" field exists on
    // Package today, so room-type popularity counts every row the matrix
    // ever offered on a booked package — a documented best-effort proxy,
    // not a real per-booking room-type selection count.
    const destinationCounts = new Map();
    const hotelCounts = new Map();
    const roomTypeCounts = new Map();
    for (const pkg of soldPackages) {
      for (const seg of pkg.segments || []) {
        destinationCounts.set(seg.city, (destinationCounts.get(seg.city) || 0) + 1);
        const hotelKey = seg.hotelCatalogId?.toString();
        if (hotelKey) hotelCounts.set(hotelKey, (hotelCounts.get(hotelKey) || 0) + 1);
      }
      for (const row of pkg.roomWisePriceMatrix || []) {
        roomTypeCounts.set(row.roomTypeName, (roomTypeCounts.get(row.roomTypeName) || 0) + 1);
      }
    }
    const topOf = (map) => {
      let top = null;
      for (const [key, count] of map) if (!top || count > top.count) top = { key, count };
      return top;
    };

    return {
      packagesCreated: allPackages.length,
      packagesSold: soldPackages.length,
      averagePackageValue: average(soldRows.map((r) => r.value)),
      averageProfit: average(soldRows.map((r) => r.profit)),
      averageMarginPct: average(soldRows.map((r) => r.marginPct)),
      mostPopularDestination: topOf(destinationCounts),
      mostPopularHotelCatalogId: topOf(hotelCounts),
      mostPopularRoomType: topOf(roomTypeCounts),
      mostProfitablePackage,
      lowestMarginPackage
    };
  }
}

export default PackageAnalyticsService;
