import mongoose from "mongoose";
import ExcelJS from "exceljs";
import RoomTypeModel from "../models/RoomTypeModel.js";
import HotelRateModel from "../models/HotelRateModel.js";
import TransportVehicleModel from "../models/TransportVehicleModel.js";
import TransportRateModel from "../models/TransportRateModel.js";
import FlightRateModel from "../models/FlightRateModel.js";
import VisaRateModel from "../models/VisaRateModel.js";
import ServiceRateModel from "../models/ServiceRateModel.js";
import MarkupRuleModel from "../models/MarkupRuleModel.js";
import PackageModel from "../models/PackageModel.js";
import PackageTemplateModel from "../models/PackageTemplateModel.js";
import RateSnapshotModel from "../models/RateSnapshotModel.js";
import HotelCatalogModel from "../models/HotelCatalogModel.js";
import SupplierModel from "../models/SupplierModel.js";
import CommissionRuleModel from "../models/CommissionRuleModel.js";
import QuotationModel from "../models/QuotationModel.js";
import CustomerModel from "../models/CustomerModel.js";
import BookingHeaderModel from "../models/BookingHeaderModel.js";
import BookingServiceModel from "../models/BookingServiceModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import CurrencyService from "./CurrencyService.js";
import NumberGeneratorService from "./NumberGeneratorService.js";
import QuotationPdfService from "./QuotationPdfService.js";
import EmailPlatformService from "./EmailPlatformService.js";
import WhatsAppPlatformService from "./WhatsAppPlatformService.js";
import { storeDocumentPdf } from "../utils/documentPdfStorage.js";
import { resolveTenantBranding, resolveTenantDocumentSettings } from "../utils/tenantBranding.js";
import { recalculateBookingFinancials } from "../controllers/BookingController.js";
import { getBookingConfig } from "../utils/bookingConfig.js";
import { getHotelConfig } from "../utils/hotelConfig.js";
import { publishEvent } from "../utils/eventBus.js";
import { getPackagePricingConfig } from "../utils/packagePricingConfig.js";
import { getIslamicSeason } from "../utils/hijriCalendar.js";

export const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Pure helpers — no DB access, unit-testable directly (see
// tests/packagePricingService.test.js). Mirrors services/PricingService.js's
// own file layout convention (pure helpers first, orchestration after).
// ---------------------------------------------------------------------------

export const isRateUsable = (rate, config = getPackagePricingConfig()) => !!rate && config.usableRateStatuses.includes(rate.status);

const sameCalendarDay = (a, b) => {
  const da = new Date(a);
  const db = new Date(b);
  return da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth() && da.getUTCDate() === db.getUTCDate();
};

const isWithinWindow = (date, validFrom, validTo) => {
  const d = new Date(date).getTime();
  if (validFrom && d < new Date(validFrom).getTime()) return false;
  if (validTo && d > new Date(validTo).getTime()) return false;
  return true;
};

export const computeNights = (checkIn, checkOut) => Math.max(0, Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000));

/**
 * PRD §5 rate resolution priority: Exact Date -> Date Range -> Season ->
 * Weekend/Weekday -> Standard (utils/packagePricingConfig.js's
 * hotelRateBasisPriority — admin-visible/overridable, never hardcoded
 * here). Only "usable" (Active) rates are ever considered — a missing or
 * Stop-Sale/expired rate resolves to `null`, never a silent zero.
 */
const matchRateByPriority = (candidates, date, config) => {
  const targetDate = new Date(date);
  const dayOfWeek = targetDate.getUTCDay();
  for (const basis of config.hotelRateBasisPriority) {
    const tier = candidates.filter((r) => r.rateBasis === basis);
    let match = null;
    if (basis === "ExactDate") match = tier.find((r) => r.date && sameCalendarDay(r.date, targetDate));
    else if (basis === "Weekend" || basis === "Weekday") match = tier.find((r) => Array.isArray(r.daysOfWeek) && r.daysOfWeek.includes(dayOfWeek) && isWithinWindow(targetDate, r.validFrom, r.validTo));
    else match = tier.find((r) => isWithinWindow(targetDate, r.validFrom, r.validTo)); // DateRange, Season, Standard
    if (match) return match;
  }
  return null;
};

export const resolveHotelRate = (rates, { roomTypeId, date }, config = getPackagePricingConfig()) => {
  const targetRoomTypeId = roomTypeId?.toString();
  const candidates = (rates || []).filter((r) => r.roomTypeId?.toString() === targetRoomTypeId && isRateUsable(r, config));
  return matchRateByPriority(candidates, date, config);
};

/**
 * Same priority resolution as resolveHotelRate, but also matches On
 * Request/Stop Sale/Sold Out rates (never Draft/Expired/Archived) so a
 * caller can distinguish "genuinely missing" from "exists but not
 * auto-confirmable" (PRD §54/§78-79). Never price a row directly off this
 * result — check classifyRateAvailability() first and only use the rate
 * when it comes back "usable".
 */
export const resolveHotelRateAnyStatus = (rates, { roomTypeId, date }, config = getPackagePricingConfig()) => {
  const targetRoomTypeId = roomTypeId?.toString();
  const nonResolvable = new Set(config.rateStatuses.filter((s) => !config.usableRateStatuses.includes(s) && !config.onRequestLikeStatuses.includes(s)));
  const candidates = (rates || []).filter((r) => r.roomTypeId?.toString() === targetRoomTypeId && !nonResolvable.has(r.status));
  return matchRateByPriority(candidates, date, config);
};

/** Classifies a resolved rate's real-world availability (PRD §54/§78-79): "usable" (Active), one of the on-request-like statuses, or "missing" (no rate / Draft / Expired / Archived). */
export const classifyRateAvailability = (rate, config = getPackagePricingConfig()) => {
  if (!rate) return "missing";
  if (config.usableRateStatuses.includes(rate.status)) return "usable";
  if (config.onRequestLikeStatuses.includes(rate.status)) return rate.status;
  return "missing";
};

const RATE_AVAILABILITY_ISSUE_CODES = { OnRequest: "RATE_ON_REQUEST", StopSale: "RATE_STOP_SALE", SoldOut: "RATE_SOLD_OUT" };

/** "Overlapping/conflicting rates must be detected and flagged, never silently resolved" (PRD §5). */
export const detectOverlappingHotelRates = (rates) => {
  const overlaps = [];
  const groups = new Map();
  for (const r of rates || []) {
    if (!["DateRange", "Season"].includes(r.rateBasis)) continue;
    const key = `${r.hotelCatalogId}:${r.roomTypeId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const aFrom = a.validFrom ? new Date(a.validFrom).getTime() : -Infinity;
        const aTo = a.validTo ? new Date(a.validTo).getTime() : Infinity;
        const bFrom = b.validFrom ? new Date(b.validFrom).getTime() : -Infinity;
        const bTo = b.validTo ? new Date(b.validTo).getTime() : Infinity;
        if (aFrom <= bTo && bFrom <= aTo) overlaps.push({ rateIds: [a._id, b._id] });
      }
    }
  }
  return overlaps;
};

/** `pricePerNight` (already in the target currency) x nights x rooms, divided across `occupancy` guests — PRD §5-§6. */
export const computeHotelCostPerPerson = (pricePerNight, nights, rooms, occupancy) => {
  if (!occupancy || occupancy <= 0) return 0;
  return roundCurrency((Number(pricePerNight) * Number(nights) * Number(rooms || 1)) / occupancy);
};

/** PRD §23 "Extra Bed" — total charge (not yet divided across occupants) for `extraOccupants` beyond a room's own occupancy, already in the target currency. */
export const computeExtraBedCost = (extraOccupants, extraBedRate, extraBedBasis, nights) => {
  const count = Number(extraOccupants) || 0;
  const rate = Number(extraBedRate) || 0;
  if (count <= 0 || rate <= 0) return 0;
  if (extraBedBasis === "PerNight") return roundCurrency(count * rate * (Number(nights) || 0));
  return roundCurrency(count * rate); // PerStay / PerPerson — one flat charge per extra occupant for the stay.
};

/**
 * PRD §7 — "the engine automatically recommends a vehicle (or a
 * combination...) using a configurable rule." `Cheapest` requires
 * `ratesByVehicleId` (vehicleId -> cost, already normalized to one
 * currency by the caller); `MinimumVehicles`/`Manual`/`PreferredVehicle`
 * work off capacity alone. Deliberately repeats a single vehicle type
 * rather than mixing types within one combination — a documented MVP
 * simplification, not a hidden gap.
 */
export const selectVehicles = (vehicles, passengerCount, rule, { preferredVehicleId = null, ratesByVehicleId = null } = {}) => {
  const active = (vehicles || []).filter((v) => v.active !== false && v.maxCapacity > 0);
  if (active.length === 0 || passengerCount <= 0) return { vehicleId: null, vehicleCount: 0, totalCapacity: 0 };

  if ((rule === "PreferredVehicle" || rule === "Manual") && preferredVehicleId) {
    const preferred = active.find((v) => v._id?.toString() === preferredVehicleId.toString());
    if (preferred) {
      const count = Math.ceil(passengerCount / preferred.maxCapacity);
      return { vehicleId: preferred._id, vehicleCount: count, totalCapacity: count * preferred.maxCapacity };
    }
  }

  if (rule === "Cheapest" && ratesByVehicleId) {
    const priced = active.filter((v) => ratesByVehicleId[v._id.toString()] !== undefined);
    if (priced.length > 0) {
      let best = null;
      for (const v of priced) {
        const count = Math.ceil(passengerCount / v.maxCapacity);
        const totalCost = count * ratesByVehicleId[v._id.toString()];
        if (!best || totalCost < best.totalCost) best = { vehicleId: v._id, vehicleCount: count, totalCapacity: count * v.maxCapacity, totalCost };
      }
      return best;
    }
  }

  // MinimumVehicles (default) — largest-capacity vehicle minimizes vehicle count.
  const sorted = [...active].sort((a, b) => b.maxCapacity - a.maxCapacity);
  const chosen = sorted[0];
  const count = Math.ceil(passengerCount / chosen.maxCapacity);
  return { vehicleId: chosen._id, vehicleCount: count, totalCapacity: count * chosen.maxCapacity };
};

export const computeAgeBand = (age, bands = getPackagePricingConfig().ageBands) => {
  if (age === null || age === undefined) return "adult";
  if (age <= bands.infantMaxAge) return "infant";
  if (age <= bands.childMaxAge) return "child";
  return "adult";
};

/** adult/child/infant unit costs -> one package-wide visa total (child/infant fall back to adultCost/0 when unset). */
export const computeVisaCost = ({ adults = 0, children = 0, infants = 0 }, { adultCost = 0, childCost = null, infantCost = null }) => {
  const childRate = childCost !== null && childCost !== undefined ? childCost : adultCost;
  const infantRate = infantCost !== null && infantCost !== undefined ? infantCost : 0;
  return roundCurrency(adults * adultCost + children * childRate + infants * infantRate);
};

/** PRD §8 "Services" charge-basis dispatch. `Percentage` is applied against `ctx.runningSubtotal`, computed by the caller AFTER every other component for the same room-wise row. */
export const computeServiceCost = (serviceRate, ctx = {}) => {
  const amount = Number(serviceRate.amount) || 0;
  const quantity = ctx.quantity ?? 1;
  switch (serviceRate.chargeBasis) {
    case "PerPerson": return roundCurrency(amount * quantity);
    case "PerRoom": return roundCurrency((amount * quantity) / (ctx.occupancy || 1));
    case "PerNight": return roundCurrency(amount * (ctx.nights || 0) * quantity);
    case "PerVehicle": return roundCurrency((amount * (ctx.vehicleCount || 0) * quantity) / (ctx.totalPax || 1));
    case "PerGroup":
    case "PerBooking": return roundCurrency((amount * quantity) / (ctx.totalPax || 1));
    case "Percentage": return roundCurrency(((ctx.runningSubtotal || 0) * amount) / 100);
    default: return 0;
  }
};

/**
 * PRD §46 "Room Allocation" — given a total passenger count and the
 * occupancy of every room type available for a segment/package, suggests
 * reasonable room-count combinations that sleep everyone: one homogeneous
 * combination per room type, plus exact-fit 2-room-type mixes. Deliberately
 * bounded, not an exhaustive subset-sum search — an agent picks one option,
 * they don't need every mathematically possible mix.
 */
export const suggestRoomCombinations = (totalPax, availableRoomTypes) => {
  const pax = Number(totalPax) || 0;
  const types = (availableRoomTypes || []).filter((rt) => rt.defaultOccupancy > 0);
  if (pax <= 0 || types.length === 0) return [];

  const results = [];
  const pushResult = (combination) => {
    const key = combination.map((c) => `${c.roomTypeId}:${c.count}`).sort().join("|");
    if (results.some((r) => r.key === key)) return;
    const totalCapacity = combination.reduce((sum, c) => sum + c.count * c.occupancy, 0);
    results.push({ key, combination: combination.map((c) => ({ roomTypeId: c.roomTypeId, count: c.count })), totalCapacity });
  };

  for (const rt of types) {
    pushResult([{ roomTypeId: rt.roomTypeId, occupancy: rt.defaultOccupancy, count: Math.ceil(pax / rt.defaultOccupancy) }]);
  }

  for (let i = 0; i < types.length; i += 1) {
    for (let j = 0; j < types.length; j += 1) {
      if (i === j) continue;
      const a = types[i];
      const b = types[j];
      for (let countA = 1; countA * a.defaultOccupancy < pax; countA += 1) {
        const remaining = pax - countA * a.defaultOccupancy;
        if (remaining <= 0 || remaining % b.defaultOccupancy !== 0) continue;
        pushResult([
          { roomTypeId: a.roomTypeId, occupancy: a.defaultOccupancy, count: countA },
          { roomTypeId: b.roomTypeId, occupancy: b.defaultOccupancy, count: remaining / b.defaultOccupancy }
        ]);
      }
    }
  }

  return results
    .map(({ key, ...rest }) => rest)
    .sort((x, y) => x.combination.reduce((s, c) => s + c.count, 0) - y.combination.reduce((s, c) => s + c.count, 0))
    .slice(0, 8);
};

export const computeMarkupAmount = (baseAmount, type, value) => {
  if (type === "Percentage") return roundCurrency((Number(baseAmount) || 0) * (Number(value) / 100));
  if (type === "Fixed") return roundCurrency(Number(value) || 0);
  return 0;
};

/**
 * PRD §91 "Discount Engine". `Percentage` is always a share of
 * `finalPricePerPerson` regardless of scope (a % of the total is
 * mathematically identical whether expressed per-person, per-room, or for
 * the whole package). `Fixed` is split according to `scope`: PerPerson
 * subtracts `value` directly, PerRoom divides it across the room's own
 * occupancy, TotalPackage divides it across every traveler in the package.
 */
export const computeDiscountPerPerson = (discount, { finalPricePerPerson = 0, occupancy = 1, totalPax = 1 } = {}) => {
  if (!discount || !discount.type || discount.value === null || discount.value === undefined) return 0;
  if (discount.type === "Percentage") return roundCurrency(finalPricePerPerson * (discount.value / 100));
  if (discount.scope === "PerRoom") return roundCurrency(discount.value / (occupancy || 1));
  if (discount.scope === "TotalPackage") return roundCurrency(discount.value / (totalPax || 1));
  return roundCurrency(discount.value);
};

/** PRD §9 "Rounding engine: nearest 10/100/500/1,000... admin-controlled." `Custom`/`None` fall back to plain 2-decimal rounding — a caller-supplied custom step isn't modeled in this MVP. */
export const applyRounding = (amount, rule) => {
  const step = { Nearest10: 10, Nearest100: 100, Nearest500: 500, Nearest1000: 1000 }[rule];
  if (!step) return roundCurrency(amount);
  return Math.round(Number(amount) / step) * step;
};

// ---------------------------------------------------------------------------
// Service — DB-touching CRUD + orchestration.
// ---------------------------------------------------------------------------

/**
 * PRD §75 "Rate Audit Trail" / Golden Rule 9 — "every manual override needs
 * an audit trail... old value, new value, user, timestamp, reason." Shared
 * by every `updateX` method below rather than each one hand-rolling its own
 * diff, the same "one real implementation, not a copy per module" judgment
 * this codebase already applies to utils/documentPdfStorage.js.
 */
const auditFieldChanges = async ({ tenantId, userId, resource, resourceId, before, after, fields, reason = null }) => {
  const changes = [];
  for (const field of fields) {
    const oldValue = before[field];
    const newValue = after[field];
    if (JSON.stringify(oldValue ?? null) !== JSON.stringify(newValue ?? null)) changes.push({ field, oldValue: oldValue ?? null, newValue: newValue ?? null });
  }
  if (changes.length === 0) return changes;
  await AuditLogModel.create({
    action: `package.pricing.update_${resource.toLowerCase()}`, module: "PackagePricing", resource, resourceId,
    userId: userId || null, tenantId, details: { changes, reason }
  });
  return changes;
};

class PackagePricingService {
  // ---- Room Types ----

  static async createRoomType(data, tenantId, userId) {
    const { name, defaultOccupancy, sortOrder = 0 } = data;
    if (!name || !defaultOccupancy) throw new Error("name and defaultOccupancy are required.");
    const existing = await RoomTypeModel.findOne({ tenantId, name }).lean();
    if (existing) throw new Error(`Room type "${name}" already exists.`);

    const roomType = await RoomTypeModel.create({ tenantId, name, defaultOccupancy, sortOrder, createdBy: userId || null, updatedBy: userId || null });
    await AuditLogModel.create({ action: "package.pricing.create_room_type", module: "PackagePricing", resource: "RoomType", resourceId: roomType._id.toString(), userId: userId || null, tenantId, details: { name } });
    return roomType.toJSON();
  }

  static async listRoomTypes(query, tenantId) {
    const filter = { tenantId };
    if (query.active !== undefined) filter.active = query.active === "true" || query.active === true;
    return RoomTypeModel.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
  }

  static async updateRoomType(roomTypeId, data, tenantId, userId, reason = null) {
    const roomType = await RoomTypeModel.findOne({ _id: roomTypeId, tenantId });
    if (!roomType) throw new Error("Room type not found.");
    const before = roomType.toObject();
    const fields = ["name", "defaultOccupancy", "sortOrder", "active"];
    for (const field of fields) if (data[field] !== undefined) roomType[field] = data[field];
    roomType.updatedBy = userId || null;
    await roomType.save();
    await auditFieldChanges({ tenantId, userId, resource: "RoomType", resourceId: roomType._id.toString(), before, after: roomType.toObject(), fields, reason });
    return roomType.toJSON();
  }

  // ---- Transport Vehicles ----

  static async createTransportVehicle(data, tenantId, userId) {
    const { name, minCapacity, maxCapacity, luggageCapacity = null, category = null } = data;
    if (!name || !minCapacity || !maxCapacity) throw new Error("name, minCapacity, and maxCapacity are required.");
    if (minCapacity > maxCapacity) throw new Error("minCapacity cannot be greater than maxCapacity.");
    const existing = await TransportVehicleModel.findOne({ tenantId, name }).lean();
    if (existing) throw new Error(`Vehicle "${name}" already exists.`);

    const vehicle = await TransportVehicleModel.create({ tenantId, name, minCapacity, maxCapacity, luggageCapacity, category, createdBy: userId || null, updatedBy: userId || null });
    await AuditLogModel.create({ action: "package.pricing.create_transport_vehicle", module: "PackagePricing", resource: "TransportVehicle", resourceId: vehicle._id.toString(), userId: userId || null, tenantId, details: { name } });
    return vehicle.toJSON();
  }

  static async listTransportVehicles(query, tenantId) {
    const filter = { tenantId };
    if (query.active !== undefined) filter.active = query.active === "true" || query.active === true;
    return TransportVehicleModel.find(filter).sort({ maxCapacity: 1 }).lean();
  }

  static async updateTransportVehicle(vehicleId, data, tenantId, userId, reason = null) {
    const vehicle = await TransportVehicleModel.findOne({ _id: vehicleId, tenantId });
    if (!vehicle) throw new Error("Vehicle not found.");
    const before = vehicle.toObject();
    const fields = ["name", "minCapacity", "maxCapacity", "luggageCapacity", "category", "active"];
    for (const field of fields) if (data[field] !== undefined) vehicle[field] = data[field];
    if (vehicle.minCapacity > vehicle.maxCapacity) throw new Error("minCapacity cannot be greater than maxCapacity.");
    vehicle.updatedBy = userId || null;
    await vehicle.save();
    await auditFieldChanges({ tenantId, userId, resource: "TransportVehicle", resourceId: vehicle._id.toString(), before, after: vehicle.toObject(), fields, reason });
    return vehicle.toJSON();
  }

  // ---- Suppliers ----

  static async createSupplier(data, tenantId, userId) {
    const config = getPackagePricingConfig();
    const { name, category, contactName = null, phone = null, email = null, currency = null, notes = null } = data;
    if (!name || !category) throw new Error("name and category are required.");
    if (!config.supplierCategories.includes(category)) throw new Error(`Invalid category "${category}".`);

    const supplier = await SupplierModel.create({
      tenantId, name, category, contactName, phone, email, currency: currency ? currency.toUpperCase() : null, notes,
      createdBy: userId || null, updatedBy: userId || null
    });
    await AuditLogModel.create({ action: "package.pricing.create_supplier", module: "PackagePricing", resource: "Supplier", resourceId: supplier._id.toString(), userId: userId || null, tenantId, details: { name, category } });
    return supplier.toJSON();
  }

  static async listSuppliers(query, tenantId) {
    const filter = { tenantId };
    if (query.category) filter.category = query.category;
    if (query.active !== undefined) filter.active = query.active === "true" || query.active === true;
    return SupplierModel.find(filter).sort({ name: 1 }).lean();
  }

  static async updateSupplier(supplierId, data, tenantId, userId, reason = null) {
    const config = getPackagePricingConfig();
    const supplier = await SupplierModel.findOne({ _id: supplierId, tenantId });
    if (!supplier) throw new Error("Supplier not found.");
    if (data.category !== undefined && !config.supplierCategories.includes(data.category)) throw new Error(`Invalid category "${data.category}".`);

    const before = supplier.toObject();
    const fields = ["name", "category", "contactName", "phone", "email", "currency", "notes", "active"];
    for (const field of fields) if (data[field] !== undefined) supplier[field] = field === "currency" && data[field] ? data[field].toUpperCase() : data[field];
    supplier.updatedBy = userId || null;
    await supplier.save();
    await auditFieldChanges({ tenantId, userId, resource: "Supplier", resourceId: supplier._id.toString(), before, after: supplier.toObject(), fields, reason });
    return supplier.toJSON();
  }

  // ---- Commission Rules ----

  static async createCommissionRule(data, tenantId, userId) {
    const config = getPackagePricingConfig();
    const { name = null, scope, type, value, agentUserId = null, destinationCountry = null, hotelCatalogId = null } = data;
    if (!scope || !type || value === undefined || value === null) throw new Error("scope, type, and value are required.");
    if (!config.commissionScopeTypes.includes(scope)) throw new Error(`Invalid scope "${scope}".`);
    if (!config.markupTypes.includes(type)) throw new Error(`Invalid type "${type}".`);

    const rule = await CommissionRuleModel.create({ tenantId, name, scope, type, value, agentUserId, destinationCountry, hotelCatalogId, createdBy: userId || null, updatedBy: userId || null });
    await AuditLogModel.create({ action: "package.pricing.create_commission_rule", module: "PackagePricing", resource: "CommissionRule", resourceId: rule._id.toString(), userId: userId || null, tenantId, details: { scope, type } });
    return rule.toJSON();
  }

  static async listCommissionRules(query, tenantId) {
    const filter = { tenantId };
    if (query.scope) filter.scope = query.scope;
    if (query.active !== undefined) filter.active = query.active === "true" || query.active === true;
    return CommissionRuleModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  // ---- Hotel Catalog (PRD §8 "Hotel Database") ----

  static async createHotelCatalog(data, tenantId, userId) {
    const hotelConfig = getHotelConfig();
    const {
      name, city, country = "Saudi Arabia", starRating = 5, address = null, supplier = "Direct Hotel Contract",
      amenities = [], contacts = {}, latitude = null, longitude = null, distanceFromLandmark = null, distanceFromAirport = null,
      checkInTime = null, checkOutTime = null, description = null, images = [], logoUrl = null, shuttleAvailable = false,
      mealPlansOffered = [], cancellationPolicy = null, supplierHotelCode = null
    } = data;
    if (!name || !city) throw new Error("name and city are required.");
    if (Array.isArray(mealPlansOffered)) {
      for (const plan of mealPlansOffered) {
        if (!hotelConfig.mealPlans.includes(plan)) throw new Error(`Invalid mealPlansOffered value "${plan}".`);
      }
    }

    const hotel = await HotelCatalogModel.create({
      tenantId, name, city, country, starRating, address, supplier, amenities, contacts, latitude, longitude,
      distanceFromLandmark, distanceFromAirport, checkInTime, checkOutTime, description, images, logoUrl, shuttleAvailable,
      mealPlansOffered, cancellationPolicy, supplierHotelCode
    });
    await AuditLogModel.create({ action: "package.pricing.create_hotel_catalog", module: "PackagePricing", resource: "HotelCatalog", resourceId: hotel._id.toString(), userId: userId || null, tenantId, details: { name, city } });
    return hotel.toJSON();
  }

  static async listHotelCatalog(query, tenantId) {
    const filter = { tenantId };
    if (query.city) filter.city = query.city;
    if (query.isActive !== undefined) filter.isActive = query.isActive === "true" || query.isActive === true;
    return HotelCatalogModel.find(filter).sort({ name: 1 }).lean();
  }

  static async updateHotelCatalog(hotelCatalogId, data, tenantId, userId, reason = null) {
    const hotelConfig = getHotelConfig();
    if (data.mealPlansOffered !== undefined) {
      for (const plan of data.mealPlansOffered || []) {
        if (!hotelConfig.mealPlans.includes(plan)) throw new Error(`Invalid mealPlansOffered value "${plan}".`);
      }
    }
    const hotel = await HotelCatalogModel.findOne({ _id: hotelCatalogId, tenantId });
    if (!hotel) throw new Error("Hotel not found.");

    const before = hotel.toObject();
    const fields = [
      "name", "city", "country", "starRating", "address", "supplier", "amenities", "contacts", "latitude", "longitude",
      "distanceFromLandmark", "distanceFromAirport", "checkInTime", "checkOutTime", "description", "images", "logoUrl",
      "shuttleAvailable", "mealPlansOffered", "cancellationPolicy", "supplierHotelCode", "isActive"
    ];
    for (const field of fields) if (data[field] !== undefined) hotel[field] = data[field];
    await hotel.save();
    await auditFieldChanges({ tenantId, userId, resource: "HotelCatalog", resourceId: hotel._id.toString(), before, after: hotel.toObject(), fields, reason });
    return hotel.toJSON();
  }

  // ---- Hotel Rates ----

  static async createHotelRate(data, tenantId, userId) {
    const config = getPackagePricingConfig();
    const { hotelCatalogId, roomTypeId, mealPlan = null, currency, pricePerNight, occupancy, rateBasis, date = null, validFrom = null, validTo = null, daysOfWeek = [], season = null, supplier = null, status, source } = data;

    if (!hotelCatalogId || !roomTypeId || !currency || pricePerNight === undefined || pricePerNight === null || !occupancy || !rateBasis) {
      throw new Error("hotelCatalogId, roomTypeId, currency, pricePerNight, occupancy, and rateBasis are required.");
    }
    if (!config.hotelRateBasisTypes.includes(rateBasis)) throw new Error(`Invalid rateBasis "${rateBasis}".`);
    if (rateBasis === "ExactDate" && !date) throw new Error("date is required when rateBasis is ExactDate.");
    if ((rateBasis === "Weekend" || rateBasis === "Weekday") && (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0)) throw new Error("daysOfWeek is required when rateBasis is Weekend/Weekday.");

    const resolvedStatus = status || config.defaultRateStatus;
    if (!config.rateStatuses.includes(resolvedStatus)) throw new Error(`Invalid status "${resolvedStatus}".`);
    const resolvedSource = source || config.defaultRateSource;
    if (!config.rateSourceTypes.includes(resolvedSource)) throw new Error(`Invalid source "${resolvedSource}".`);

    const hotel = await HotelCatalogModel.findOne({ _id: hotelCatalogId, tenantId }).lean();
    if (!hotel) throw new Error("Hotel not found.");
    const roomType = await RoomTypeModel.findOne({ _id: roomTypeId, tenantId }).lean();
    if (!roomType) throw new Error("Room type not found.");

    const rate = await HotelRateModel.create({
      tenantId, hotelCatalogId, roomTypeId, mealPlan, currency: currency.toUpperCase(), pricePerNight, occupancy, rateBasis,
      date: date ? new Date(date) : null, validFrom: validFrom ? new Date(validFrom) : null, validTo: validTo ? new Date(validTo) : null,
      daysOfWeek, season, supplier, status: resolvedStatus, source: resolvedSource, createdBy: userId || null, updatedBy: userId || null
    });
    await AuditLogModel.create({ action: "package.pricing.create_hotel_rate", module: "PackagePricing", resource: "HotelRate", resourceId: rate._id.toString(), userId: userId || null, tenantId, details: { hotelCatalogId, roomTypeId } });
    return rate.toJSON();
  }

  static async listHotelRates(query, tenantId) {
    const filter = { tenantId };
    if (query.hotelCatalogId) filter.hotelCatalogId = query.hotelCatalogId;
    if (query.roomTypeId) filter.roomTypeId = query.roomTypeId;
    if (query.status) filter.status = query.status;
    return HotelRateModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async updateHotelRate(rateId, data, tenantId, userId, reason = null) {
    const config = getPackagePricingConfig();
    const rate = await HotelRateModel.findOne({ _id: rateId, tenantId });
    if (!rate) throw new Error("Hotel rate not found.");
    if (data.status !== undefined && !config.rateStatuses.includes(data.status)) throw new Error(`Invalid status "${data.status}".`);
    if (data.rateBasis !== undefined && !config.hotelRateBasisTypes.includes(data.rateBasis)) throw new Error(`Invalid rateBasis "${data.rateBasis}".`);

    const before = rate.toObject();
    const fields = ["mealPlan", "currency", "pricePerNight", "occupancy", "rateBasis", "date", "validFrom", "validTo", "daysOfWeek", "season", "supplier", "supplierId", "contractRef", "receivedDate", "notes", "documentUrl", "status"];
    for (const field of fields) {
      if (data[field] === undefined) continue;
      rate[field] = field === "currency" && data[field] ? data[field].toUpperCase() : data[field];
    }
    rate.updatedBy = userId || null;
    await rate.save();
    await auditFieldChanges({ tenantId, userId, resource: "HotelRate", resourceId: rate._id.toString(), before, after: rate.toObject(), fields, reason });
    return rate.toJSON();
  }

  // ---- Transport Rates ----

  static async createTransportRate(data, tenantId, userId) {
    const config = getPackagePricingConfig();
    const { origin, destination, vehicleId, currency, rate, direction, validFrom = null, validTo = null, supplier = null, status, source } = data;
    if (!origin || !destination || !vehicleId || !currency || rate === undefined || rate === null) {
      throw new Error("origin, destination, vehicleId, currency, and rate are required.");
    }
    const resolvedDirection = direction || config.defaultTransportDirection;
    if (!config.transportDirectionTypes.includes(resolvedDirection)) throw new Error(`Invalid direction "${resolvedDirection}".`);
    const resolvedStatus = status || config.defaultRateStatus;
    if (!config.rateStatuses.includes(resolvedStatus)) throw new Error(`Invalid status "${resolvedStatus}".`);
    const resolvedSource = source || config.defaultRateSource;
    if (!config.rateSourceTypes.includes(resolvedSource)) throw new Error(`Invalid source "${resolvedSource}".`);

    const vehicle = await TransportVehicleModel.findOne({ _id: vehicleId, tenantId }).lean();
    if (!vehicle) throw new Error("Vehicle not found.");

    const record = await TransportRateModel.create({
      tenantId, origin, destination, vehicleId, currency: currency.toUpperCase(), rate, direction: resolvedDirection,
      validFrom: validFrom ? new Date(validFrom) : null, validTo: validTo ? new Date(validTo) : null,
      supplier, status: resolvedStatus, source: resolvedSource, createdBy: userId || null, updatedBy: userId || null
    });
    await AuditLogModel.create({ action: "package.pricing.create_transport_rate", module: "PackagePricing", resource: "TransportRate", resourceId: record._id.toString(), userId: userId || null, tenantId, details: { origin, destination, vehicleId } });
    return record.toJSON();
  }

  static async listTransportRates(query, tenantId) {
    const filter = { tenantId };
    if (query.origin) filter.origin = query.origin;
    if (query.destination) filter.destination = query.destination;
    if (query.status) filter.status = query.status;
    return TransportRateModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async updateTransportRate(rateId, data, tenantId, userId, reason = null) {
    const config = getPackagePricingConfig();
    const rate = await TransportRateModel.findOne({ _id: rateId, tenantId });
    if (!rate) throw new Error("Transport rate not found.");
    if (data.status !== undefined && !config.rateStatuses.includes(data.status)) throw new Error(`Invalid status "${data.status}".`);
    if (data.direction !== undefined && !config.transportDirectionTypes.includes(data.direction)) throw new Error(`Invalid direction "${data.direction}".`);

    const before = rate.toObject();
    const fields = ["origin", "destination", "vehicleId", "currency", "rate", "direction", "validFrom", "validTo", "supplier", "supplierId", "contractRef", "receivedDate", "notes", "documentUrl", "status"];
    for (const field of fields) {
      if (data[field] === undefined) continue;
      rate[field] = field === "currency" && data[field] ? data[field].toUpperCase() : data[field];
    }
    rate.updatedBy = userId || null;
    await rate.save();
    await auditFieldChanges({ tenantId, userId, resource: "TransportRate", resourceId: rate._id.toString(), before, after: rate.toObject(), fields, reason });
    return rate.toJSON();
  }

  // ---- Flight Rates ----

  static async createFlightRate(data, tenantId, userId) {
    const config = getPackagePricingConfig();
    const { route, airline = null, cabin = "Economy", currency, costPerPerson, direction, validFrom = null, validTo = null, status, source } = data;
    if (!route || !currency || costPerPerson === undefined || costPerPerson === null) throw new Error("route, currency, and costPerPerson are required.");
    const resolvedDirection = direction || config.defaultTransportDirection;
    if (!config.transportDirectionTypes.includes(resolvedDirection)) throw new Error(`Invalid direction "${resolvedDirection}".`);
    const resolvedStatus = status || config.defaultRateStatus;
    if (!config.rateStatuses.includes(resolvedStatus)) throw new Error(`Invalid status "${resolvedStatus}".`);
    const resolvedSource = source || config.defaultRateSource;
    if (!config.rateSourceTypes.includes(resolvedSource)) throw new Error(`Invalid source "${resolvedSource}".`);

    const record = await FlightRateModel.create({
      tenantId, route, airline, cabin, currency: currency.toUpperCase(), costPerPerson, direction: resolvedDirection,
      validFrom: validFrom ? new Date(validFrom) : null, validTo: validTo ? new Date(validTo) : null,
      status: resolvedStatus, source: resolvedSource, createdBy: userId || null, updatedBy: userId || null
    });
    await AuditLogModel.create({ action: "package.pricing.create_flight_rate", module: "PackagePricing", resource: "FlightRate", resourceId: record._id.toString(), userId: userId || null, tenantId, details: { route } });
    return record.toJSON();
  }

  static async listFlightRates(query, tenantId) {
    const filter = { tenantId };
    if (query.route) filter.route = query.route;
    if (query.status) filter.status = query.status;
    return FlightRateModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async updateFlightRate(rateId, data, tenantId, userId, reason = null) {
    const config = getPackagePricingConfig();
    const rate = await FlightRateModel.findOne({ _id: rateId, tenantId });
    if (!rate) throw new Error("Flight rate not found.");
    if (data.status !== undefined && !config.rateStatuses.includes(data.status)) throw new Error(`Invalid status "${data.status}".`);
    if (data.direction !== undefined && !config.transportDirectionTypes.includes(data.direction)) throw new Error(`Invalid direction "${data.direction}".`);

    const before = rate.toObject();
    const fields = ["route", "airline", "cabin", "currency", "costPerPerson", "direction", "validFrom", "validTo", "supplierId", "contractRef", "receivedDate", "notes", "documentUrl", "status"];
    for (const field of fields) {
      if (data[field] === undefined) continue;
      rate[field] = field === "currency" && data[field] ? data[field].toUpperCase() : data[field];
    }
    rate.updatedBy = userId || null;
    await rate.save();
    await auditFieldChanges({ tenantId, userId, resource: "FlightRate", resourceId: rate._id.toString(), before, after: rate.toObject(), fields, reason });
    return rate.toJSON();
  }

  // ---- Visa Rates ----

  static async createVisaRate(data, tenantId, userId) {
    const config = getPackagePricingConfig();
    const { country, visaType, nationality = null, currency, adultCost, childCost = null, infantCost = null, processingTime = null, validFrom = null, validTo = null, status, source } = data;
    if (!country || !visaType || !currency || adultCost === undefined || adultCost === null) throw new Error("country, visaType, currency, and adultCost are required.");
    const resolvedStatus = status || config.defaultRateStatus;
    if (!config.rateStatuses.includes(resolvedStatus)) throw new Error(`Invalid status "${resolvedStatus}".`);
    const resolvedSource = source || config.defaultRateSource;
    if (!config.rateSourceTypes.includes(resolvedSource)) throw new Error(`Invalid source "${resolvedSource}".`);

    const record = await VisaRateModel.create({
      tenantId, country, visaType, nationality, currency: currency.toUpperCase(), adultCost, childCost, infantCost, processingTime,
      validFrom: validFrom ? new Date(validFrom) : null, validTo: validTo ? new Date(validTo) : null,
      status: resolvedStatus, source: resolvedSource, createdBy: userId || null, updatedBy: userId || null
    });
    await AuditLogModel.create({ action: "package.pricing.create_visa_rate", module: "PackagePricing", resource: "VisaRate", resourceId: record._id.toString(), userId: userId || null, tenantId, details: { country, visaType } });
    return record.toJSON();
  }

  static async listVisaRates(query, tenantId) {
    const filter = { tenantId };
    if (query.country) filter.country = query.country;
    if (query.status) filter.status = query.status;
    return VisaRateModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async updateVisaRate(rateId, data, tenantId, userId, reason = null) {
    const config = getPackagePricingConfig();
    const rate = await VisaRateModel.findOne({ _id: rateId, tenantId });
    if (!rate) throw new Error("Visa rate not found.");
    if (data.status !== undefined && !config.rateStatuses.includes(data.status)) throw new Error(`Invalid status "${data.status}".`);

    const before = rate.toObject();
    const fields = ["country", "visaType", "nationality", "currency", "adultCost", "childCost", "infantCost", "processingTime", "validFrom", "validTo", "supplierId", "contractRef", "receivedDate", "notes", "documentUrl", "status"];
    for (const field of fields) {
      if (data[field] === undefined) continue;
      rate[field] = field === "currency" && data[field] ? data[field].toUpperCase() : data[field];
    }
    rate.updatedBy = userId || null;
    await rate.save();
    await auditFieldChanges({ tenantId, userId, resource: "VisaRate", resourceId: rate._id.toString(), before, after: rate.toObject(), fields, reason });
    return rate.toJSON();
  }

  // ---- Service Rates ----

  static async createServiceRate(data, tenantId, userId) {
    const config = getPackagePricingConfig();
    const { name, chargeBasis, currency, amount, validFrom = null, validTo = null, status, source } = data;
    if (!name || !chargeBasis || !currency || amount === undefined || amount === null) throw new Error("name, chargeBasis, currency, and amount are required.");
    if (!config.serviceChargeBasisTypes.includes(chargeBasis)) throw new Error(`Invalid chargeBasis "${chargeBasis}".`);
    const resolvedStatus = status || config.defaultRateStatus;
    if (!config.rateStatuses.includes(resolvedStatus)) throw new Error(`Invalid status "${resolvedStatus}".`);
    const resolvedSource = source || config.defaultRateSource;
    if (!config.rateSourceTypes.includes(resolvedSource)) throw new Error(`Invalid source "${resolvedSource}".`);

    const record = await ServiceRateModel.create({
      tenantId, name, chargeBasis, currency: currency.toUpperCase(), amount,
      validFrom: validFrom ? new Date(validFrom) : null, validTo: validTo ? new Date(validTo) : null,
      status: resolvedStatus, source: resolvedSource, createdBy: userId || null, updatedBy: userId || null
    });
    await AuditLogModel.create({ action: "package.pricing.create_service_rate", module: "PackagePricing", resource: "ServiceRate", resourceId: record._id.toString(), userId: userId || null, tenantId, details: { name, chargeBasis } });
    return record.toJSON();
  }

  static async listServiceRates(query, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    return ServiceRateModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async updateServiceRate(rateId, data, tenantId, userId, reason = null) {
    const config = getPackagePricingConfig();
    const rate = await ServiceRateModel.findOne({ _id: rateId, tenantId });
    if (!rate) throw new Error("Service rate not found.");
    if (data.status !== undefined && !config.rateStatuses.includes(data.status)) throw new Error(`Invalid status "${data.status}".`);
    if (data.chargeBasis !== undefined && !config.serviceChargeBasisTypes.includes(data.chargeBasis)) throw new Error(`Invalid chargeBasis "${data.chargeBasis}".`);

    const before = rate.toObject();
    const fields = ["name", "chargeBasis", "currency", "amount", "validFrom", "validTo", "supplierId", "contractRef", "receivedDate", "notes", "documentUrl", "status"];
    for (const field of fields) {
      if (data[field] === undefined) continue;
      rate[field] = field === "currency" && data[field] ? data[field].toUpperCase() : data[field];
    }
    rate.updatedBy = userId || null;
    await rate.save();
    await auditFieldChanges({ tenantId, userId, resource: "ServiceRate", resourceId: rate._id.toString(), before, after: rate.toObject(), fields, reason });
    return rate.toJSON();
  }

  // ---- Markup Rules ----

  static async createMarkupRule(data, tenantId, userId) {
    const config = getPackagePricingConfig();
    const { name = null, scope, type, value, priceListType } = data;
    if (!scope || !type || value === undefined || value === null || !priceListType) throw new Error("scope, type, value, and priceListType are required.");
    if (!config.markupScopeTypes.includes(scope)) throw new Error(`Invalid scope "${scope}".`);
    if (!config.markupTypes.includes(type)) throw new Error(`Invalid type "${type}".`);
    if (!config.priceListTypes.includes(priceListType)) throw new Error(`Invalid priceListType "${priceListType}".`);

    const record = await MarkupRuleModel.create({ tenantId, name, scope, type, value, priceListType, createdBy: userId || null, updatedBy: userId || null });
    await AuditLogModel.create({ action: "package.pricing.create_markup_rule", module: "PackagePricing", resource: "MarkupRule", resourceId: record._id.toString(), userId: userId || null, tenantId, details: { scope, type, priceListType } });
    return record.toJSON();
  }

  static async listMarkupRules(query, tenantId) {
    const filter = { tenantId };
    if (query.priceListType) filter.priceListType = query.priceListType;
    if (query.scope) filter.scope = query.scope;
    if (query.active !== undefined) filter.active = query.active === "true" || query.active === true;
    return MarkupRuleModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  static async updateMarkupRule(ruleId, data, tenantId, userId, reason = null) {
    const config = getPackagePricingConfig();
    const rule = await MarkupRuleModel.findOne({ _id: ruleId, tenantId });
    if (!rule) throw new Error("Markup rule not found.");
    if (data.scope !== undefined && !config.markupScopeTypes.includes(data.scope)) throw new Error(`Invalid scope "${data.scope}".`);
    if (data.type !== undefined && !config.markupTypes.includes(data.type)) throw new Error(`Invalid type "${data.type}".`);
    if (data.priceListType !== undefined && !config.priceListTypes.includes(data.priceListType)) throw new Error(`Invalid priceListType "${data.priceListType}".`);

    const before = rule.toObject();
    const fields = ["name", "scope", "type", "value", "priceListType", "active"];
    for (const field of fields) if (data[field] !== undefined) rule[field] = data[field];
    rule.updatedBy = userId || null;
    await rule.save();
    await auditFieldChanges({ tenantId, userId, resource: "MarkupRule", resourceId: rule._id.toString(), before, after: rule.toObject(), fields, reason });
    return rule.toJSON();
  }

  // ---- Bulk rate management (PRD §112 / PRD v2 §14) ----

  static _rateModelFor(rateType) {
    const map = { "hotel-rates": HotelRateModel, "transport-rates": TransportRateModel, "flight-rates": FlightRateModel, "visa-rates": VisaRateModel, "service-rates": ServiceRateModel };
    const model = map[rateType];
    if (!model) throw new Error(`Unknown rate type "${rateType}".`);
    return model;
  }

  static _createMethodFor(rateType) {
    const map = { "hotel-rates": "createHotelRate", "transport-rates": "createTransportRate", "flight-rates": "createFlightRate", "visa-rates": "createVisaRate", "service-rates": "createServiceRate" };
    const methodName = map[rateType];
    if (!methodName) throw new Error(`Unknown rate type "${rateType}".`);
    return methodName;
  }

  /**
   * POST /{rate-type}/bulk — all-or-nothing per tenant. Uses a real Mongo
   * transaction when the deployment supports one (replica set/Atlas);
   * standalone MongoDB has no transaction support, so this falls back to
   * best-effort sequential inserts (same graceful-degrade discipline this
   * codebase already applies to optional infra elsewhere, e.g.
   * services/packageRateExpiryScheduler.js's node-cron fallback) rather
   * than hard-failing the whole bulk-import feature on dev/standalone setups.
   */
  static async bulkCreateRates(rateType, items, tenantId, userId) {
    if (!Array.isArray(items) || items.length === 0) throw new Error("items must be a non-empty array.");
    const methodName = PackagePricingService._createMethodFor(rateType);

    let session = null;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
    } catch {
      session = null;
    }

    const created = [];
    try {
      for (const item of items) {
        const record = await PackagePricingService[methodName](item, tenantId, userId);
        created.push(record);
      }
      if (session) await session.commitTransaction();
    } catch (error) {
      if (session) await session.abortTransaction();
      throw new Error(`Bulk create failed at item ${created.length + 1} of ${items.length}: ${error.message}`);
    } finally {
      if (session) session.endSession();
    }

    await AuditLogModel.create({ action: "package.pricing.bulk_create_rates", module: "PackagePricing", resource: rateType, resourceId: null, userId: userId || null, tenantId, details: { count: created.length } });
    return created;
  }

  /** PATCH /{rate-type}/bulk-status — one audit entry for the whole batch, never one per row. */
  static async bulkUpdateRateStatus(rateType, ids, status, tenantId, userId, reason = null) {
    const config = getPackagePricingConfig();
    const model = PackagePricingService._rateModelFor(rateType);
    if (!status || !config.rateStatuses.includes(status)) throw new Error(`Invalid status "${status}".`);
    if (!Array.isArray(ids) || ids.length === 0) throw new Error("ids must be a non-empty array.");

    const result = await model.updateMany({ _id: { $in: ids }, tenantId }, { $set: { status, updatedBy: userId || null } });
    await AuditLogModel.create({ action: "package.pricing.bulk_update_rate_status", module: "PackagePricing", resource: rateType, resourceId: null, userId: userId || null, tenantId, details: { ids: ids.map(String), status, reason, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount } });
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  /** POST /{rate-type}/:id/clone — duplicates one rate row with overridden fields (new dates/validity typically), mirroring ExchangeRateModel's own "new row, never edit history" precedent. */
  static async cloneRate(rateType, rateId, overrides, tenantId, userId) {
    const model = PackagePricingService._rateModelFor(rateType);
    const source = await model.findOne({ _id: rateId, tenantId }).lean();
    if (!source) throw new Error("Rate not found.");

    const { _id, createdAt, updatedAt, __v, ...rest } = source;
    const clone = await model.create({ ...rest, ...(overrides || {}), tenantId, createdBy: userId || null, updatedBy: userId || null });
    await AuditLogModel.create({ action: "package.pricing.clone_rate", module: "PackagePricing", resource: rateType, resourceId: clone._id.toString(), userId: userId || null, tenantId, details: { clonedFrom: rateId } });
    return clone.toJSON();
  }

  /** Shared by exportRatesToCsv/exportRatesToXlsx so their column list/row set can never drift apart — one query, one header derivation. */
  static async _fetchExportRows(rateType, query, tenantId) {
    const model = PackagePricingService._rateModelFor(rateType);
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    const rows = await model.find(filter).lean();
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((h) => h !== "__v");
    return { rows, headers };
  }

  /** GET /{rate-type}/export?format=csv — a plain data dump, no OCR/review workflow (that's Import, explicitly Phase 2). */
  static async exportRatesToCsv(rateType, query, tenantId) {
    const { rows, headers } = await PackagePricingService._fetchExportRows(rateType, query, tenantId);

    const toCsvValue = (value) => {
      if (value === null || value === undefined) return "";
      if (value instanceof Date) return value.toISOString();
      const str = typeof value === "object" ? JSON.stringify(value) : String(value);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = [headers.join(","), ...rows.map((row) => headers.map((h) => toCsvValue(row[h])).join(","))];
    return { content: lines.join("\n"), filename: `${rateType}-${tenantId}-${Date.now()}.csv` };
  }

  /** GET /{rate-type}/export?format=xlsx — PRD §113. Same headers/rows as exportRatesToCsv (via _fetchExportRows), real cell values via exceljs, mirroring FinancialReportExportService.generateExcel's own pattern. */
  static async exportRatesToXlsx(rateType, query, tenantId) {
    const { rows, headers } = await PackagePricingService._fetchExportRows(rateType, query, tenantId);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(rateType.slice(0, 31));
    worksheet.addRow(headers);
    worksheet.getRow(1).font = { bold: true };
    for (const row of rows) {
      worksheet.addRow(headers.map((h) => {
        const value = row[h];
        return value instanceof Date || (typeof value !== "object" && value !== undefined) ? value ?? "" : JSON.stringify(value);
      }));
    }
    worksheet.columns.forEach((column) => { column.width = 18; });

    const buffer = await workbook.xlsx.writeBuffer();
    return { buffer: Buffer.from(buffer), filename: `${rateType}-${tenantId}-${Date.now()}.xlsx` };
  }

  // ---- Packages ----

  /** Fields createPackage/updatePackage both validate and accept — shared so the two never drift apart. */
  static async _resolveAndValidatePackageInput(data, tenantId, config) {
    const {
      name = null, customerId = null, agentUserId = null, travelStartDate, travelEndDate, travelers, segments = [], transportLegs = [],
      flightSelections = [], visaSelections = [], serviceSelections = [], vehicleSelectionRule, priceListType, sellingCurrency,
      markupRuleIds = [], commissionRuleIds = [], roundingRule, discount = null
    } = data;

    if (!travelStartDate || !travelEndDate) throw new Error("travelStartDate and travelEndDate are required.");
    if (!travelers || !travelers.adults || travelers.adults < 1) throw new Error("travelers.adults is required and must be at least 1.");
    if (!sellingCurrency) throw new Error("sellingCurrency is required.");
    if (!Array.isArray(segments)) throw new Error("segments must be an array.");
    for (const segment of segments) {
      if (!segment.city || !segment.hotelCatalogId || !segment.checkIn || !segment.checkOut) throw new Error("Each segment requires city, hotelCatalogId, checkIn, and checkOut.");
    }
    if (customerId) {
      const customer = await CustomerModel.findOne({ _id: customerId, tenantId }).lean();
      if (!customer) throw new Error("Customer not found.");
    }
    if (discount && discount.type) {
      if (!config.discountTypes.includes(discount.type)) throw new Error(`Invalid discount.type "${discount.type}".`);
      if (discount.type === "Fixed" && !config.discountScopeTypes.includes(discount.scope)) throw new Error(`Invalid discount.scope "${discount.scope}".`);
      if (discount.value === undefined || discount.value === null || discount.value < 0) throw new Error("discount.value is required and must be >= 0.");
    }

    const resolvedVehicleSelectionRule = vehicleSelectionRule || config.defaultVehicleSelectionRule;
    if (!config.vehicleSelectionRules.includes(resolvedVehicleSelectionRule)) throw new Error(`Invalid vehicleSelectionRule "${resolvedVehicleSelectionRule}".`);
    const resolvedPriceListType = priceListType || config.defaultPriceListType;
    if (!config.priceListTypes.includes(resolvedPriceListType)) throw new Error(`Invalid priceListType "${resolvedPriceListType}".`);
    const resolvedRoundingRule = roundingRule || config.defaultRoundingRule;
    if (!config.roundingRuleTypes.includes(resolvedRoundingRule)) throw new Error(`Invalid roundingRule "${resolvedRoundingRule}".`);

    return {
      name, customerId, agentUserId, travelStartDate: new Date(travelStartDate), travelEndDate: new Date(travelEndDate),
      travelers: { adults: travelers.adults, children: travelers.children || 0, infants: travelers.infants || 0 },
      segments, transportLegs, flightSelections, visaSelections, serviceSelections,
      vehicleSelectionRule: resolvedVehicleSelectionRule, priceListType: resolvedPriceListType, sellingCurrency: sellingCurrency.toUpperCase(),
      markupRuleIds, commissionRuleIds, roundingRule: resolvedRoundingRule, discount: discount && discount.type ? discount : null
    };
  }

  static async createPackage(data, tenantId, userId) {
    const config = getPackagePricingConfig();
    const resolved = await PackagePricingService._resolveAndValidatePackageInput(data, tenantId, config);

    const pkg = await PackageModel.create({ tenantId, ...resolved, status: config.defaultPackageStatus, createdBy: userId || null, updatedBy: userId || null });

    await AuditLogModel.create({ action: "package.pricing.create_package", module: "PackagePricing", resource: "Package", resourceId: pkg._id.toString(), userId: userId || null, tenantId, details: { sellingCurrency: pkg.sellingCurrency } });
    return pkg.toJSON();
  }

  /** PATCH /packages/:id — only while the package is Draft and unlocked; a Calculated/finalized package goes through calculate/finalize's own versioning instead (PRD §51). */
  static async updatePackage(packageId, data, tenantId, userId, reason = null) {
    const config = getPackagePricingConfig();
    const pkg = await PackageModel.findOne({ _id: packageId, tenantId });
    if (!pkg) throw new Error("Package not found.");
    if (pkg.status !== "Draft" || pkg.locked) throw new Error(`Package cannot be edited from status "${pkg.status}" — only a Draft, unlocked package may be updated directly.`);

    const merged = { ...pkg.toObject(), ...data, travelers: { ...pkg.travelers.toObject?.() || pkg.travelers, ...(data.travelers || {}) } };
    const resolved = await PackagePricingService._resolveAndValidatePackageInput(merged, tenantId, config);

    const before = pkg.toObject();
    const fields = Object.keys(resolved);
    Object.assign(pkg, resolved);
    pkg.updatedBy = userId || null;
    await pkg.save();
    await auditFieldChanges({ tenantId, userId, resource: "Package", resourceId: pkg._id.toString(), before, after: pkg.toObject(), fields, reason });
    return pkg.toJSON();
  }

  /** POST /packages/:id/link-booking — PRD §87 CRM Integration; only records the link, never mutates booking/invoice data itself. */
  static async linkPackageToBooking(packageId, bookingId, tenantId, userId) {
    const pkg = await PackageModel.findOne({ _id: packageId, tenantId });
    if (!pkg) throw new Error("Package not found.");
    const booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId }).lean();
    if (!booking) throw new Error("Booking not found.");

    pkg.linkedBookingId = booking._id;
    pkg.updatedBy = userId || null;
    await pkg.save();
    await AuditLogModel.create({ action: "package.pricing.link_booking", module: "PackagePricing", resource: "Package", resourceId: pkg._id.toString(), userId: userId || null, tenantId, details: { bookingId: booking._id.toString() } });
    return pkg.toJSON();
  }

  /**
   * POST /packages/:id/convert-to-booking — the seam into the Booking
   * domain: picks one calculated room-wise matrix row and turns it into
   * real `BookingServiceModel` line items (never a second, parallel price
   * calculation — the numbers are exactly what calculatePackage already
   * produced), then calls the Booking domain's own
   * `recalculateBookingFinancials` (controllers/BookingController.js) so
   * the booking's totals are computed the one real way this codebase
   * already computes them, rather than a duplicate summation here.
   * Creates a new Draft booking when `bookingId` is omitted, or appends to
   * an existing one when supplied (e.g. attaching a package to a booking a
   * sales agent already opened for the customer).
   */
  static async convertPackageToBooking(packageId, data, tenantId, userId) {
    const bookingConfig = getBookingConfig();
    const { roomTypeId, rooms = 1, bookingId = null, bookingType = null } = data;
    if (!roomTypeId) throw new Error("roomTypeId is required.");

    const pkg = await PackageModel.findOne({ _id: packageId, tenantId }).lean();
    if (!pkg) throw new Error("Package not found.");
    if (!pkg.customerId && !bookingId) throw new Error("Package must have a customerId (or an existing bookingId must be supplied) before it can be converted to a booking.");
    const row = (pkg.roomWisePriceMatrix || []).find((r) => r.roomTypeId.toString() === roomTypeId.toString());
    if (!row) throw new Error("Selected room type is not part of this package's calculated price matrix — calculate the package first.");

    const lowerCurrency = pkg.sellingCurrency.toLowerCase();
    if (!bookingConfig.supportedCurrencies.includes(lowerCurrency)) throw new Error(`Package sellingCurrency "${pkg.sellingCurrency}" is not a supported booking currency. Allowed: ${bookingConfig.supportedCurrencies.join(", ")}.`);

    let booking;
    if (bookingId) {
      booking = await BookingHeaderModel.findOne({ _id: bookingId, tenantId });
      if (!booking) throw new Error("Booking not found.");
    } else {
      const customer = await CustomerModel.findOne({ _id: pkg.customerId, tenantId, status: { $ne: "archived" } }).lean();
      if (!customer) throw new Error("Customer not found.");
      const resolvedBookingType = (bookingType || bookingConfig.defaultBookingType).toLowerCase();
      if (!bookingConfig.bookingTypes.includes(resolvedBookingType)) throw new Error(`Invalid bookingType "${resolvedBookingType}".`);

      const generated = await NumberGeneratorService.generateNumber(tenantId, { resourceType: "Booking" }, userId || null);
      const bookingNumber = generated.documentNumber;
      try {
        booking = await BookingHeaderModel.create({
          tenantId, bookingReference: bookingNumber, bookingNumber, customerId: customer._id, customerCode: customer.customerCode,
          customerName: `${customer.firstName || ""} ${customer.lastName || ""}`.trim(), packageId: pkg._id, bookingType: resolvedBookingType,
          status: bookingConfig.defaultBookingStatus, priority: bookingConfig.defaultPriority, paymentStatus: bookingConfig.defaultPaymentStatus,
          visaStatus: bookingConfig.defaultVisaStatus, assignedTo: pkg.agentUserId || userId || null, assignedConsultant: pkg.agentUserId || userId || null,
          travelDate: pkg.travelStartDate, returnDate: pkg.travelEndDate, currency: lowerCurrency
        });
      } catch (createError) {
        await NumberGeneratorService.rollbackSequence(tenantId, generated._id, "Package-to-booking conversion failed.", userId || null).catch(() => {});
        throw createError;
      }
      await NumberGeneratorService.registerResource(tenantId, generated._id, booking._id.toString(), userId || null).catch(() => {});
    }

    // One BookingServiceModel line per real cost component. Selling price
    // is allocated proportionally to each component's own pre-markup cost
    // share of the row's markup+discount delta — same "remainder handling"
    // discipline services/PricingService.js's allocateProportionally
    // already uses elsewhere in this codebase for splitting one amount
    // across several lines, applied here inline since the split is a
    // simple two-array proportional share rather than a remainder-on-
    // last-line allocation.
    const components = [
      { serviceType: "hotel", serviceCategory: "accommodation", name: "Hotel", cost: row.hotelCostPerPerson },
      { serviceType: "transport", serviceCategory: "transportation", name: "Transport", cost: row.transportCostPerPerson },
      { serviceType: "flight", serviceCategory: "other", name: "Flight", cost: row.flightCostPerPerson },
      { serviceType: "visa", serviceCategory: "immigration", name: "Visa", cost: row.visaCostPerPerson },
      { serviceType: "other", serviceCategory: "other", name: "Services", cost: row.servicesCostPerPerson }
    ].filter((c) => c.cost > 0);
    const totalCost = components.reduce((sum, c) => sum + c.cost, 0);
    const markupAndAdjustmentPerPerson = roundCurrency(row.finalPricePerPerson - totalCost);

    const lines = components.map((c) => {
      const share = totalCost > 0 ? c.cost / totalCost : 0;
      const sellingPerPerson = roundCurrency(c.cost + markupAndAdjustmentPerPerson * share);
      const totalPax = row.occupancy * rooms;
      return {
        tenantId, bookingId: booking._id, serviceType: c.serviceType, serviceCategory: c.serviceCategory,
        serviceName: `${c.name} — ${pkg.name || "Package"} (${row.roomTypeName})`,
        costPrice: roundCurrency(c.cost * totalPax), sellingPrice: roundCurrency(sellingPerPerson * totalPax),
        quantity: 1, totalPrice: roundCurrency(sellingPerPerson * totalPax), currencyId: pkg.sellingCurrency,
        startDate: pkg.travelStartDate, endDate: pkg.travelEndDate, status: "active",
        details: { packageId: pkg._id.toString(), roomTypeId: row.roomTypeId.toString(), roomTypeName: row.roomTypeName, rooms, occupancy: row.occupancy }
      };
    });
    const createdLines = await BookingServiceModel.insertMany(lines);
    await recalculateBookingFinancials(booking._id, tenantId);

    const updatedPkg = await PackageModel.findOne({ _id: packageId, tenantId });
    updatedPkg.linkedBookingId = booking._id;
    updatedPkg.status = "Booked";
    updatedPkg.updatedBy = userId || null;
    await updatedPkg.save();

    await AuditLogModel.create({
      action: "package.pricing.convert_to_booking", module: "PackagePricing", resource: "Package", resourceId: pkg._id.toString(),
      userId: userId || null, tenantId, details: { bookingId: booking._id.toString(), roomTypeId, rooms, lineCount: createdLines.length }
    });
    publishEvent("PackageConvertedToBooking", { tenantId, packageId: pkg._id.toString(), bookingId: booking._id.toString(), performedBy: userId || null });

    return { package: updatedPkg.toJSON(), bookingId: booking._id.toString(), bookingNumber: booking.bookingNumber, bookingServiceIds: createdLines.map((l) => l._id.toString()) };
  }

  static async getPackageById(packageId, tenantId) {
    const pkg = await PackageModel.findOne({ _id: packageId, tenantId }).lean();
    if (!pkg) throw new Error("Package not found.");
    return pkg;
  }

  static async listPackages(query, tenantId) {
    const filter = { tenantId };
    if (query.status) filter.status = query.status;
    if (query.customerId) filter.customerId = query.customerId;
    return PackageModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  /** Clones every editable field of a locked package into a fresh Draft, links the two, then calculates the clone. See calculatePackage's own lock-branch above. */
  static async _calculateNewVersion(previousPkg, tenantId, userId) {
    // .toObject() first — passing a hydrated document's own subdocument
    // getters (e.g. `previousPkg.discount`) straight into a second
    // `Model.create()` call throws a spurious CastError on a null single-
    // nested path ("Cast to Object failed for value null") that a plain
    // object with the same null value does not; a real regression test
    // (tests/packagePricingController.test.js's versioning case) caught this.
    const source = previousPkg.toObject();
    const clone = await PackageModel.create({
      tenantId, name: source.name, customerId: source.customerId, agentUserId: source.agentUserId,
      travelStartDate: source.travelStartDate, travelEndDate: source.travelEndDate, travelers: source.travelers,
      segments: source.segments, transportLegs: source.transportLegs, flightSelections: source.flightSelections,
      visaSelections: source.visaSelections, serviceSelections: source.serviceSelections,
      vehicleSelectionRule: source.vehicleSelectionRule, priceListType: source.priceListType, sellingCurrency: source.sellingCurrency,
      markupRuleIds: source.markupRuleIds, commissionRuleIds: source.commissionRuleIds, discount: source.discount,
      roundingRule: source.roundingRule, status: "Draft", version: (source.version || 1) + 1,
      rootPackageId: source.rootPackageId || previousPkg._id, previousVersionId: previousPkg._id,
      createdBy: userId || null, updatedBy: userId || null
    });

    previousPkg.supersededBy = clone._id;
    await previousPkg.save();
    await AuditLogModel.create({ action: "package.pricing.new_version", module: "PackagePricing", resource: "Package", resourceId: clone._id.toString(), userId: userId || null, tenantId, details: { previousVersionId: previousPkg._id.toString(), version: clone.version } });

    const result = await PackagePricingService.calculatePackage(clone._id, tenantId, userId, {});
    return { ...result, newVersionOf: previousPkg._id.toString() };
  }

  /**
   * POST /packages/:id/calculate — PRD §4 build-spec item 6: Rate resolver
   * -> Hotel cost -> Transport cost -> Flight/Visa/Services -> Markup +
   * rounding -> room-wise matrix -> RateSnapshot. Never throws for a
   * business-rule gap (a missing rate, a missing exchange rate) — those
   * accumulate as `validationIssues` and the row is simply skipped/zeroed,
   * per PRD §11 "never a silent wrong number."
   */
  static async calculatePackage(packageId, tenantId, userId, options = {}) {
    const config = getPackagePricingConfig();
    const pkg = await PackageModel.findOne({ _id: packageId, tenantId });
    if (!pkg) throw new Error("Package not found.");
    if (pkg.locked) {
      if (!options.recalculate) throw new Error("Package is finalized and locked — pass recalculate to override.");
      // PRD §51 "Package Versioning" — never overwrite a finalized package
      // in place; recalculating one creates and calculates a new version
      // instead, leaving the old, already-sent quotation untouched.
      return PackagePricingService._calculateNewVersion(pkg, tenantId, userId);
    }
    if (!pkg.segments || pkg.segments.length === 0) throw new Error("Package requires at least one segment before it can be calculated.");

    const issues = [];
    const adults = pkg.travelers.adults;
    const children = pkg.travelers.children || 0;
    const infants = pkg.travelers.infants || 0;
    const totalPax = adults + children + infants;

    const roomTypes = await RoomTypeModel.find({ tenantId, active: true }).lean();
    const roomTypeById = new Map(roomTypes.map((rt) => [rt._id.toString(), rt]));

    const rateCache = new Map();
    const usedExchangeRates = [];
    const resolveFx = async (fromCurrency) => {
      if (fromCurrency === pkg.sellingCurrency) return 1;
      if (rateCache.has(fromCurrency)) return rateCache.get(fromCurrency);
      try {
        const result = await CurrencyService.getRate(tenantId, fromCurrency, pkg.sellingCurrency);
        rateCache.set(fromCurrency, result.rate);
        usedExchangeRates.push({ fromCurrency, toCurrency: pkg.sellingCurrency, rate: result.rate, rateId: result.rateId, rateType: result.rateType, rateDate: result.rateDate });
        return result.rate;
      } catch {
        issues.push({ code: "NO_EXCHANGE_RATE", message: `No exchange rate available for ${fromCurrency} -> ${pkg.sellingCurrency}.` });
        rateCache.set(fromCurrency, null);
        return null;
      }
    };

    // ---- Hotel segments: resolve every segment's available room types, then intersect. ----
    const segmentResolutions = [];
    const usedHotelRateIds = new Set();
    for (const segment of pkg.segments) {
      const nights = computeNights(segment.checkIn, segment.checkOut);
      if (nights <= 0) {
        issues.push({ code: "INVALID_SEGMENT_DATES", message: `Segment in "${segment.city}": checkOut must be after checkIn.` });
        continue;
      }
      const hotelRates = await HotelRateModel.find({ tenantId, hotelCatalogId: segment.hotelCatalogId }).lean();
      const overlaps = detectOverlappingHotelRates(hotelRates);
      if (overlaps.length > 0) issues.push({ code: "OVERLAPPING_HOTEL_RATES", message: `Segment in "${segment.city}": ${overlaps.length} overlapping rate window(s) detected for its hotel — resolve before finalizing.` });

      const availableRoomTypeIds = [];
      for (const rt of roomTypes) {
        const anyStatusMatch = resolveHotelRateAnyStatus(hotelRates, { roomTypeId: rt._id, date: segment.checkIn }, config);
        const availability = classifyRateAvailability(anyStatusMatch, config);
        if (availability === "usable") { availableRoomTypeIds.push(rt._id.toString()); continue; }
        if (availability !== "missing") {
          // A real, currently-relevant rate exists but isn't auto-confirmable
          // — surfaced as its own issue, never silently priced or silently dropped.
          issues.push({ code: RATE_AVAILABILITY_ISSUE_CODES[availability], message: `${rt.name} at the hotel for "${segment.city}" is ${availability} for these dates — confirm availability before quoting.` });
        }
      }
      if (availableRoomTypeIds.length === 0) issues.push({ code: "NO_HOTEL_RATE", message: `Segment in "${segment.city}": no active hotel rate found for the selected dates.` });

      segmentResolutions.push({ segment, nights, hotelRates, availableRoomTypeIds });
    }

    let commonRoomTypeIds = segmentResolutions.length > 0 ? segmentResolutions[0].availableRoomTypeIds : [];
    for (const res of segmentResolutions.slice(1)) commonRoomTypeIds = commonRoomTypeIds.filter((id) => res.availableRoomTypeIds.includes(id));
    if (segmentResolutions.length > 0 && commonRoomTypeIds.length === 0) issues.push({ code: "NO_COMMON_ROOM_TYPE", message: "No room type has an active hotel rate across every segment for the selected dates." });

    const totalNights = segmentResolutions.reduce((sum, r) => sum + r.nights, 0);

    // ---- Transport ----
    let transportCostPerPerson = 0;
    let transportVehicleCount = 0;
    const usedTransportRates = [];
    if (pkg.transportLegs.length > 0) {
      const vehicles = await TransportVehicleModel.find({ tenantId, active: true }).lean();
      let legTotal = 0;
      for (const leg of pkg.transportLegs) {
        const routeRates = (await TransportRateModel.find({ tenantId, origin: leg.origin, destination: leg.destination }).lean())
          .filter((r) => isWithinWindow(pkg.travelStartDate, r.validFrom, r.validTo));
        const candidateRates = routeRates.filter((r) => isRateUsable(r, config));
        if (candidateRates.length === 0) {
          const onRequestLike = routeRates.find((r) => config.onRequestLikeStatuses.includes(r.status));
          if (onRequestLike) {
            issues.push({ code: RATE_AVAILABILITY_ISSUE_CODES[onRequestLike.status], message: `Transport "${leg.origin}" -> "${leg.destination}" is ${onRequestLike.status} for these dates — confirm availability before quoting.` });
          } else {
            issues.push({ code: "NO_TRANSPORT_RATE", message: `No active transport rate found for "${leg.origin}" -> "${leg.destination}".` });
          }
          continue;
        }

        const ratesByVehicleId = {};
        for (const r of candidateRates) {
          const fx = await resolveFx(r.currency);
          if (fx !== null) ratesByVehicleId[r.vehicleId.toString()] = roundCurrency(r.rate * fx);
        }

        const selection = selectVehicles(vehicles, totalPax, pkg.vehicleSelectionRule, { preferredVehicleId: leg.vehicleId, ratesByVehicleId });
        if (!selection.vehicleId) {
          issues.push({ code: "NO_TRANSPORT_VEHICLE", message: `No vehicle available for "${leg.origin}" -> "${leg.destination}".` });
          continue;
        }
        const chosenRate = candidateRates.find((r) => r.vehicleId.toString() === selection.vehicleId.toString());
        if (!chosenRate) {
          issues.push({ code: "NO_TRANSPORT_RATE", message: `No rate found for the selected vehicle on "${leg.origin}" -> "${leg.destination}".` });
          continue;
        }
        const fx = await resolveFx(chosenRate.currency);
        if (fx === null) continue;

        legTotal += roundCurrency(chosenRate.rate * fx * selection.vehicleCount);
        transportVehicleCount += selection.vehicleCount;
        usedTransportRates.push({ rateId: chosenRate._id, origin: leg.origin, destination: leg.destination, vehicleId: chosenRate.vehicleId, rate: chosenRate.rate, currency: chosenRate.currency, vehicleCount: selection.vehicleCount });
      }
      transportCostPerPerson = totalPax > 0 ? roundCurrency(legTotal / totalPax) : 0;
    }

    // ---- Flights ----
    let flightCostPerPerson = 0;
    const usedFlightRates = [];
    for (const selection of pkg.flightSelections) {
      const rate = await FlightRateModel.findOne({ _id: selection.flightRateId, tenantId }).lean();
      const flightWithinWindow = rate && isWithinWindow(pkg.travelStartDate, rate.validFrom, rate.validTo);
      if (!rate || !flightWithinWindow || !isRateUsable(rate, config)) {
        if (rate && flightWithinWindow && config.onRequestLikeStatuses.includes(rate.status)) {
          issues.push({ code: RATE_AVAILABILITY_ISSUE_CODES[rate.status], message: `Flight rate "${rate.route}" is ${rate.status} — confirm availability before quoting.` });
        } else {
          issues.push({ code: "INVALID_FLIGHT_RATE", message: "A selected flight rate is missing, inactive, or expired." });
        }
        continue;
      }
      const fx = await resolveFx(rate.currency);
      if (fx === null) continue;
      flightCostPerPerson = roundCurrency(flightCostPerPerson + rate.costPerPerson * fx);
      usedFlightRates.push({ rateId: rate._id, route: rate.route, costPerPerson: rate.costPerPerson, currency: rate.currency });
    }

    // ---- Visa ----
    let visaCostPerPerson = 0;
    const usedVisaRates = [];
    for (const selection of pkg.visaSelections) {
      const rate = await VisaRateModel.findOne({ _id: selection.visaRateId, tenantId }).lean();
      const visaWithinWindow = rate && isWithinWindow(pkg.travelStartDate, rate.validFrom, rate.validTo);
      if (!rate || !visaWithinWindow || !isRateUsable(rate, config)) {
        if (rate && visaWithinWindow && config.onRequestLikeStatuses.includes(rate.status)) {
          issues.push({ code: RATE_AVAILABILITY_ISSUE_CODES[rate.status], message: `Visa rate for "${rate.country}" (${rate.visaType}) is ${rate.status} — confirm availability before quoting.` });
        } else {
          issues.push({ code: "INVALID_VISA_RATE", message: "A selected visa rate is missing, inactive, or expired." });
        }
        continue;
      }
      const fx = await resolveFx(rate.currency);
      if (fx === null) continue;
      const total = computeVisaCost({ adults, children, infants }, { adultCost: rate.adultCost * fx, childCost: rate.childCost !== null ? rate.childCost * fx : null, infantCost: rate.infantCost !== null ? rate.infantCost * fx : null });
      visaCostPerPerson = roundCurrency(visaCostPerPerson + (totalPax > 0 ? total / totalPax : 0));
      usedVisaRates.push({ rateId: rate._id, country: rate.country, visaType: rate.visaType, adultCost: rate.adultCost, childCost: rate.childCost, infantCost: rate.infantCost, currency: rate.currency });
    }

    // ---- Services (currency-converted, chargeBasis kept for per-room-type application) ----
    const convertedServiceRates = [];
    for (const selection of pkg.serviceSelections) {
      const rate = await ServiceRateModel.findOne({ _id: selection.serviceRateId, tenantId }).lean();
      const serviceWithinWindow = rate && isWithinWindow(pkg.travelStartDate, rate.validFrom, rate.validTo);
      if (!rate || !serviceWithinWindow || !isRateUsable(rate, config)) {
        if (rate && serviceWithinWindow && config.onRequestLikeStatuses.includes(rate.status)) {
          issues.push({ code: RATE_AVAILABILITY_ISSUE_CODES[rate.status], message: `Service rate "${rate.name}" is ${rate.status} — confirm availability before quoting.` });
        } else {
          issues.push({ code: "INVALID_SERVICE_RATE", message: "A selected service rate is missing, inactive, or expired." });
        }
        continue;
      }
      const fx = rate.chargeBasis === "Percentage" ? 1 : await resolveFx(rate.currency);
      if (fx === null) continue;
      convertedServiceRates.push({ chargeBasis: rate.chargeBasis, amount: rate.chargeBasis === "Percentage" ? rate.amount : roundCurrency(rate.amount * fx), quantity: selection.quantity || 1, rateId: rate._id, name: rate.name });
    }

    // ---- Markup rules for this priceListType ----
    const markupRules = pkg.markupRuleIds.length > 0
      ? await MarkupRuleModel.find({ tenantId, _id: { $in: pkg.markupRuleIds }, active: true, priceListType: pkg.priceListType }).lean()
      : await MarkupRuleModel.find({ tenantId, active: true, priceListType: pkg.priceListType }).lean();
    const markupFor = (scope) => markupRules.filter((m) => m.scope === scope);
    const sumMarkup = (rules, base) => rules.reduce((sum, m) => sum + computeMarkupAmount(base, m.type, m.value), 0);

    // ---- Commission rules (PRD §41) — internal only, never affects finalPricePerPerson ----
    const commissionRules = pkg.commissionRuleIds.length > 0
      ? await CommissionRuleModel.find({ tenantId, _id: { $in: pkg.commissionRuleIds }, active: true }).lean()
      : await CommissionRuleModel.find({ tenantId, active: true }).lean();
    const segmentCountries = pkg.segments.map((s) => s.country).filter(Boolean);
    const segmentHotelIds = pkg.segments.map((s) => s.hotelCatalogId?.toString()).filter(Boolean);
    const applicableCommissionRules = commissionRules.filter((rule) => {
      if (rule.scope === "Global") return true;
      if (rule.scope === "Agent") return pkg.agentUserId && rule.agentUserId === pkg.agentUserId;
      if (rule.scope === "Destination") return rule.destinationCountry && segmentCountries.includes(rule.destinationCountry);
      if (rule.scope === "Hotel") return rule.hotelCatalogId && segmentHotelIds.includes(rule.hotelCatalogId.toString());
      return false;
    });

    // ---- Room-wise matrix ----
    const matrix = [];
    const reportedExtraBedIssues = new Set();
    for (const roomTypeId of commonRoomTypeIds) {
      const roomType = roomTypeById.get(roomTypeId);
      let hotelCostPerPerson = 0;
      for (const res of segmentResolutions) {
        const rate = resolveHotelRate(res.hotelRates, { roomTypeId, date: res.segment.checkIn }, config);
        if (!rate) continue;
        usedHotelRateIds.add(rate._id.toString());
        const fx = await resolveFx(rate.currency);
        if (fx === null) continue;

        const extraBeds = res.segment.extraBeds || 0;
        const rooms = res.segment.rooms || 1;
        const occupancy = rate.occupancy || roomType.defaultOccupancy;
        if (extraBeds > 0 && rate.extraBedRate) {
          if (rate.maxExtraBeds && extraBeds > rate.maxExtraBeds) {
            const issueKey = `EXTRA_BEDS_EXCEED_MAX:${res.segment.city}:${rate._id}`;
            if (!reportedExtraBedIssues.has(issueKey)) {
              reportedExtraBedIssues.add(issueKey);
              issues.push({ code: "EXTRA_BEDS_EXCEED_MAX", message: `Segment in "${res.segment.city}": requested ${extraBeds} extra bed(s) exceeds this rate's max of ${rate.maxExtraBeds}.` });
            }
            hotelCostPerPerson += computeHotelCostPerPerson(rate.pricePerNight * fx, res.nights, rooms, occupancy);
          } else {
            const roomTotal = rate.pricePerNight * fx * res.nights * rooms + computeExtraBedCost(extraBeds, rate.extraBedRate * fx, rate.extraBedBasis, res.nights);
            hotelCostPerPerson += roundCurrency(roomTotal / (occupancy + extraBeds));
          }
        } else if (extraBeds > 0) {
          const issueKey = `EXTRA_BEDS_NOT_AVAILABLE:${res.segment.city}:${rate._id}`;
          if (!reportedExtraBedIssues.has(issueKey)) {
            reportedExtraBedIssues.add(issueKey);
            issues.push({ code: "EXTRA_BEDS_NOT_AVAILABLE", message: `Segment in "${res.segment.city}": ${extraBeds} extra bed(s) requested, but this rate has no extra bed option.` });
          }
          hotelCostPerPerson += computeHotelCostPerPerson(rate.pricePerNight * fx, res.nights, rooms, occupancy);
        } else {
          hotelCostPerPerson += computeHotelCostPerPerson(rate.pricePerNight * fx, res.nights, rooms, occupancy);
        }
      }
      hotelCostPerPerson = roundCurrency(hotelCostPerPerson);

      let servicesNonPct = 0;
      const pctServices = [];
      for (const svc of convertedServiceRates) {
        if (svc.chargeBasis === "Percentage") { pctServices.push(svc); continue; }
        servicesNonPct += computeServiceCost(svc, { occupancy: roomType.defaultOccupancy, nights: totalNights, vehicleCount: transportVehicleCount, totalPax, quantity: svc.quantity });
      }
      servicesNonPct = roundCurrency(servicesNonPct);

      const preRunning = roundCurrency(hotelCostPerPerson + transportCostPerPerson + flightCostPerPerson + visaCostPerPerson + servicesNonPct);
      const pctAmount = roundCurrency(pctServices.reduce((sum, svc) => sum + computeServiceCost(svc, { runningSubtotal: preRunning, quantity: svc.quantity }), 0));
      const servicesCostPerPerson = roundCurrency(servicesNonPct + pctAmount);

      const hotelWithMarkup = roundCurrency(hotelCostPerPerson + sumMarkup(markupFor("Hotel"), hotelCostPerPerson));
      const transportWithMarkup = roundCurrency(transportCostPerPerson + sumMarkup(markupFor("Transport"), transportCostPerPerson));
      const flightWithMarkup = roundCurrency(flightCostPerPerson + sumMarkup(markupFor("Flight"), flightCostPerPerson));
      const visaWithMarkup = roundCurrency(visaCostPerPerson + sumMarkup(markupFor("Visa"), visaCostPerPerson));
      const servicesWithMarkup = roundCurrency(servicesCostPerPerson + sumMarkup(markupFor("Services"), servicesCostPerPerson));

      const runningTotal = roundCurrency(hotelWithMarkup + transportWithMarkup + flightWithMarkup + visaWithMarkup + servicesWithMarkup);
      const entirePackageMarkupAmount = roundCurrency(sumMarkup(markupFor("EntirePackage"), runningTotal));
      const preDiscountTotal = roundCurrency(runningTotal + entirePackageMarkupAmount);
      // PRD §48 formula order — Discount is applied after Markup, before Rounding.
      const discountAmount = computeDiscountPerPerson(pkg.discount, { finalPricePerPerson: preDiscountTotal, occupancy: roomType.defaultOccupancy, totalPax });
      const finalBeforeRounding = roundCurrency(preDiscountTotal - discountAmount);
      const finalPricePerPerson = applyRounding(finalBeforeRounding, pkg.roundingRule);

      const totalMarkupAmount = roundCurrency(
        (hotelWithMarkup - hotelCostPerPerson) + (transportWithMarkup - transportCostPerPerson) + (flightWithMarkup - flightCostPerPerson)
        + (visaWithMarkup - visaCostPerPerson) + (servicesWithMarkup - servicesCostPerPerson) + entirePackageMarkupAmount
      );
      const commissionPerPerson = roundCurrency(applicableCommissionRules.reduce((sum, rule) => sum + computeMarkupAmount(finalPricePerPerson, rule.type, rule.value), 0));

      matrix.push({
        roomTypeId, roomTypeName: roomType.name, occupancy: roomType.defaultOccupancy,
        hotelCostPerPerson, transportCostPerPerson, flightCostPerPerson, visaCostPerPerson, servicesCostPerPerson,
        subtotalPerPerson: preRunning, markupAmount: totalMarkupAmount, discountAmount, finalPricePerPerson,
        roomTotal: roundCurrency(finalPricePerPerson * roomType.defaultOccupancy), commissionPerPerson
      });
    }

    const usedHotelRates = usedHotelRateIds.size > 0 ? await HotelRateModel.find({ _id: { $in: [...usedHotelRateIds] } }).lean() : [];

    // PRD §52 "Rate Change Alert" — if this package was already calculated
    // before, compare every rate this run actually used against the value
    // recorded in the LAST snapshot. A silent recalculation must never hide
    // that a supplier rate moved underneath an already-shared quotation.
    const previousSnapshot = await RateSnapshotModel.findOne({ tenantId, packageId: pkg._id, snapshotType: "Calculate" }).sort({ createdAt: -1 }).lean();
    if (previousSnapshot) {
      const flagChange = (label, prevValue, currentValue) => {
        if (prevValue !== undefined && prevValue !== null && currentValue !== undefined && currentValue !== null && prevValue !== currentValue) {
          issues.push({ code: "RATE_CHANGED_SINCE_LAST_CALCULATION", message: `${label} changed from ${prevValue} to ${currentValue} since this package was last calculated.` });
        }
      };
      const prevHotelById = new Map((previousSnapshot.hotelRates || []).map((r) => [r.rateId?.toString(), r]));
      for (const r of usedHotelRates) flagChange(`Hotel rate ${r._id}`, prevHotelById.get(r._id.toString())?.pricePerNight, r.pricePerNight);
      const prevTransportById = new Map((previousSnapshot.transportRates || []).map((r) => [r.rateId?.toString(), r]));
      for (const r of usedTransportRates) flagChange(`Transport rate ${r.origin} -> ${r.destination}`, prevTransportById.get(r.rateId?.toString())?.rate, r.rate);
      const prevFlightById = new Map((previousSnapshot.flightRates || []).map((r) => [r.rateId?.toString(), r]));
      for (const r of usedFlightRates) flagChange(`Flight rate ${r.route}`, prevFlightById.get(r.rateId?.toString())?.costPerPerson, r.costPerPerson);
      const prevVisaById = new Map((previousSnapshot.visaRates || []).map((r) => [r.rateId?.toString(), r]));
      for (const r of usedVisaRates) flagChange(`Visa rate ${r.country}/${r.visaType}`, prevVisaById.get(r.rateId?.toString())?.adultCost, r.adultCost);
    }

    // RATE_CHANGED_SINCE_LAST_CALCULATION is informational (PRD §52 — "user
    // can choose Update or Keep Old Rate") — it's surfaced in
    // validationIssues so the UI can show it, but never blocks `ready` or
    // finalize the way a genuinely missing/invalid rate does.
    const ready = issues.filter((i) => i.code !== "RATE_CHANGED_SINCE_LAST_CALCULATION").length === 0 && matrix.length > 0;
    pkg.validationIssues = issues;
    pkg.roomWisePriceMatrix = matrix;
    pkg.status = ready ? "Calculated" : pkg.status === "Draft" ? "Draft" : pkg.status;
    pkg.lastCalculatedAt = new Date();
    pkg.priceValidUntil = ready ? new Date(Date.now() + config.priceValidityHours * 3600000) : null;
    pkg.locked = false;
    pkg.finalizedAt = null;
    pkg.updatedBy = userId || null;
    await pkg.save();

    await RateSnapshotModel.create({
      tenantId, packageId: pkg._id, snapshotType: "Calculate",
      hotelRates: usedHotelRates.map((r) => ({ rateId: r._id, hotelCatalogId: r.hotelCatalogId, roomTypeId: r.roomTypeId, pricePerNight: r.pricePerNight, currency: r.currency, rateBasis: r.rateBasis })),
      transportRates: usedTransportRates, flightRates: usedFlightRates, visaRates: usedVisaRates, exchangeRates: usedExchangeRates,
      roomWisePriceMatrix: matrix, performedBy: userId || null
    });

    await AuditLogModel.create({ action: "package.pricing.calculate", module: "PackagePricing", resource: "Package", resourceId: pkg._id.toString(), userId: userId || null, tenantId, details: { ready, issueCount: issues.length } });
    publishEvent("PackageCalculated", { tenantId, packageId: pkg._id.toString(), ready, issueCount: issues.length, performedBy: userId || null });

    return { ...pkg.toJSON(), ready };
  }

  /**
   * POST /packages/:id/finalize — locks the package against silent
   * downstream rate drift and persists a second, "Finalize"-tagged
   * RateSnapshot (PRD §7 Golden Rule 7 / §10 versioning). Only callable
   * from a clean "Calculated" state with zero open validation issues.
   */
  static async finalizePackage(packageId, tenantId, userId) {
    const pkg = await PackageModel.findOne({ _id: packageId, tenantId });
    if (!pkg) throw new Error("Package not found.");
    if (pkg.status !== "Calculated") throw new Error(`Package cannot be finalized from status "${pkg.status}" — calculate it first.`);
    const blockingIssues = (pkg.validationIssues || []).filter((i) => i.code !== "RATE_CHANGED_SINCE_LAST_CALCULATION");
    if (blockingIssues.length > 0) throw new Error("Package has unresolved validation issues and cannot be finalized.");
    if (!pkg.roomWisePriceMatrix || pkg.roomWisePriceMatrix.length === 0) throw new Error("Package has no calculated price matrix to finalize.");

    const lastSnapshot = await RateSnapshotModel.findOne({ tenantId, packageId: pkg._id, snapshotType: "Calculate" }).sort({ createdAt: -1 }).lean();
    await RateSnapshotModel.create({
      tenantId, packageId: pkg._id, snapshotType: "Finalize",
      hotelRates: lastSnapshot?.hotelRates || [], transportRates: lastSnapshot?.transportRates || [], flightRates: lastSnapshot?.flightRates || [],
      visaRates: lastSnapshot?.visaRates || [], exchangeRates: lastSnapshot?.exchangeRates || [], roomWisePriceMatrix: pkg.roomWisePriceMatrix, performedBy: userId || null
    });

    pkg.locked = true;
    pkg.finalizedAt = new Date();
    pkg.status = "Quoted";
    pkg.updatedBy = userId || null;
    await pkg.save();

    await AuditLogModel.create({ action: "package.pricing.finalize", module: "PackagePricing", resource: "Package", resourceId: pkg._id.toString(), userId: userId || null, tenantId, details: {} });
    publishEvent("PackageFinalized", { tenantId, packageId: pkg._id.toString(), performedBy: userId || null });

    return pkg.toJSON();
  }

  /** GET /packages/:id/room-combinations — PRD §46, read-only. */
  static async getRoomCombinations(packageId, tenantId) {
    const pkg = await PackageModel.findOne({ _id: packageId, tenantId }).lean();
    if (!pkg) throw new Error("Package not found.");
    if (!pkg.roomWisePriceMatrix || pkg.roomWisePriceMatrix.length === 0) throw new Error("Package has no calculated price matrix — calculate the package first.");

    const totalPax = pkg.travelers.adults + (pkg.travelers.children || 0) + (pkg.travelers.infants || 0);
    const availableRoomTypes = pkg.roomWisePriceMatrix.map((r) => ({ roomTypeId: r.roomTypeId.toString(), defaultOccupancy: r.occupancy }));
    return suggestRoomCombinations(totalPax, availableRoomTypes);
  }

  /**
   * POST /packages/compare — PRD §83. Not a new "tier" concept — comparison
   * is just N already-calculated Package documents (e.g. a 3-star-hotel
   * package and a 5-star-hotel package) viewed side by side. Never
   * recalculates either package.
   */
  static async comparePackages(packageIds, tenantId) {
    if (!Array.isArray(packageIds) || packageIds.length < 2) throw new Error("At least two packageIds are required to compare.");
    const packages = await PackageModel.find({ _id: { $in: packageIds }, tenantId }).lean();
    if (packages.length !== packageIds.length) throw new Error("One or more packages were not found.");

    const byId = new Map(packages.map((pkg) => [pkg._id.toString(), pkg]));
    return packageIds.map((id) => {
      const pkg = byId.get(id.toString());
      return {
        packageId: pkg._id.toString(), name: pkg.name, status: pkg.status, sellingCurrency: pkg.sellingCurrency,
        travelStartDate: pkg.travelStartDate, travelEndDate: pkg.travelEndDate, roomWisePriceMatrix: pkg.roomWisePriceMatrix
      };
    });
  }

  // ---- Package Templates (PRD §82) ----

  static async saveAsTemplate(packageId, name, tenantId, userId) {
    if (!name) throw new Error("name is required.");
    const pkg = await PackageModel.findOne({ _id: packageId, tenantId }).lean();
    if (!pkg) throw new Error("Package not found.");
    if (!pkg.segments || pkg.segments.length === 0) throw new Error("Package has no segments to save as a template.");

    const startTime = new Date(pkg.travelStartDate).getTime();
    const segments = pkg.segments.map((s) => ({
      city: s.city, country: s.country || null, hotelCatalogId: s.hotelCatalogId, mealPlan: s.mealPlan,
      rooms: s.rooms || 1, extraBeds: s.extraBeds || 0,
      offsetDays: Math.max(0, Math.round((new Date(s.checkIn).getTime() - startTime) / 86400000)),
      nights: Math.max(1, computeNights(s.checkIn, s.checkOut)), sortOrder: s.sortOrder || 0
    }));

    const template = await PackageTemplateModel.create({
      tenantId, name, segments, transportLegs: pkg.transportLegs, flightSelections: pkg.flightSelections,
      visaSelections: pkg.visaSelections, serviceSelections: pkg.serviceSelections, vehicleSelectionRule: pkg.vehicleSelectionRule,
      priceListType: pkg.priceListType, sellingCurrency: pkg.sellingCurrency, markupRuleIds: pkg.markupRuleIds,
      commissionRuleIds: pkg.commissionRuleIds, roundingRule: pkg.roundingRule, discount: pkg.discount,
      sourcePackageId: pkg._id, createdBy: userId || null, updatedBy: userId || null
    });

    await AuditLogModel.create({ action: "package.pricing.save_as_template", module: "PackagePricing", resource: "PackageTemplate", resourceId: template._id.toString(), userId: userId || null, tenantId, details: { packageId: pkg._id.toString(), name } });
    return template.toJSON();
  }

  /**
   * PATCH /packages/package-templates/:id — the only way a template ever
   * becomes reachable from the Public B2C Booking Site (PRD "CRM Feature
   * Map by Phase" Phase 2 module 15): saveAsTemplate above has no
   * marketing-facing fields of its own, so a template stays
   * publicVisible:false (its schema default) until a staff member
   * explicitly opts it in here.
   */
  static async updatePackageTemplate(templateId, data, tenantId, userId) {
    const template = await PackageTemplateModel.findOne({ _id: templateId, tenantId });
    if (!template) throw new Error("Package template not found.");

    const { name, description, active, publicVisible, packageType, images, displayPriceFrom, displayCurrency } = data;
    if (name !== undefined) template.name = name;
    if (description !== undefined) template.description = description;
    if (active !== undefined) template.active = active;
    if (publicVisible !== undefined) template.publicVisible = publicVisible;
    if (packageType !== undefined) template.packageType = packageType;
    if (images !== undefined) template.images = images;
    if (displayPriceFrom !== undefined) template.displayPriceFrom = displayPriceFrom;
    if (displayCurrency !== undefined) template.displayCurrency = displayCurrency;
    template.updatedBy = userId || null;

    if (template.publicVisible && (!template.displayPriceFrom || !template.sellingCurrency)) {
      throw new Error("A template cannot be made publicVisible without a displayPriceFrom and a sellingCurrency already set (sellingCurrency comes from the source package this template was saved from).");
    }

    await template.save();
    await AuditLogModel.create({ action: "package.pricing.update_template", module: "PackagePricing", resource: "PackageTemplate", resourceId: template._id.toString(), userId: userId || null, tenantId, details: { publicVisible: template.publicVisible } });
    return template.toJSON();
  }

  static async listPackageTemplates(query, tenantId) {
    const filter = { tenantId };
    if (query.active !== undefined) filter.active = query.active === "true" || query.active === true;
    return PackageTemplateModel.find(filter).sort({ createdAt: -1 }).lean();
  }

  /** Clones a template into a new Draft Package, recomputing real segment dates from `travelStartDate` — never mutates the template itself. */
  static async cloneFromTemplate(templateId, data, tenantId, userId) {
    const { travelStartDate, customerId = null, agentUserId = null, travelers = { adults: 1 }, name = null } = data;
    if (!travelStartDate) throw new Error("travelStartDate is required.");
    const template = await PackageTemplateModel.findOne({ _id: templateId, tenantId }).lean();
    if (!template) throw new Error("Package template not found.");

    const start = new Date(travelStartDate);
    const segments = template.segments.map((s) => {
      const checkIn = new Date(start.getTime() + s.offsetDays * 86400000);
      const checkOut = new Date(checkIn.getTime() + s.nights * 86400000);
      return { city: s.city, country: s.country, hotelCatalogId: s.hotelCatalogId, checkIn, checkOut, mealPlan: s.mealPlan, rooms: s.rooms, extraBeds: s.extraBeds, sortOrder: s.sortOrder };
    });
    const travelEndDate = segments.reduce((max, s) => (s.checkOut > max ? s.checkOut : max), start);

    return PackagePricingService.createPackage({
      name: name || `${template.name} (cloned)`, customerId, agentUserId, travelStartDate: start, travelEndDate, travelers,
      segments, transportLegs: template.transportLegs, flightSelections: template.flightSelections, visaSelections: template.visaSelections,
      serviceSelections: template.serviceSelections, vehicleSelectionRule: template.vehicleSelectionRule, priceListType: template.priceListType,
      sellingCurrency: template.sellingCurrency, markupRuleIds: template.markupRuleIds, commissionRuleIds: template.commissionRuleIds,
      roundingRule: template.roundingRule, discount: template.discount
    }, tenantId, userId);
  }

  // ---- Quotations ----

  /**
   * POST /packages/:id/quotations — PRD §89. Picks ONE row out of the
   * package's last-calculated `roomWisePriceMatrix` and freezes it, the
   * agency's branding, and the tenant's terms into a customer-facing
   * document — never the supplier cost/markup/commission fields (PRD §117).
   */
  static async createQuotation(packageId, data, tenantId, userId) {
    const config = getPackagePricingConfig();
    const { roomTypeId, paymentTerms = null, validUntil = null, termsAndConditions = null } = data;
    if (!roomTypeId) throw new Error("roomTypeId is required.");

    const pkg = await PackageModel.findOne({ _id: packageId, tenantId }).lean();
    if (!pkg) throw new Error("Package not found.");
    const row = (pkg.roomWisePriceMatrix || []).find((r) => r.roomTypeId.toString() === roomTypeId.toString());
    if (!row) throw new Error("Selected room type is not part of this package's calculated price matrix — calculate the package first.");

    const [customer, company, documentSettings, hotels] = await Promise.all([
      pkg.customerId ? CustomerModel.findOne({ _id: pkg.customerId, tenantId }).lean() : null,
      resolveTenantBranding(tenantId),
      resolveTenantDocumentSettings(tenantId),
      HotelCatalogModel.find({ _id: { $in: [...new Set(pkg.segments.map((s) => s.hotelCatalogId?.toString()).filter(Boolean))] } }).lean()
    ]);
    const hotelNameById = new Map(hotels.map((h) => [h._id.toString(), h.name]));

    const includedComponents = [];
    if (row.hotelCostPerPerson > 0) includedComponents.push("Hotel");
    if (row.transportCostPerPerson > 0) includedComponents.push("Transport");
    if (row.flightCostPerPerson > 0) includedComponents.push("Flight");
    if (row.visaCostPerPerson > 0) includedComponents.push("Visa");
    if (row.servicesCostPerPerson > 0) includedComponents.push("Services");

    const generated = await NumberGeneratorService.generateNumber(tenantId, { resourceType: "Quotation" }, userId || null);
    const quotationNumber = generated.documentNumber;
    const generatedAt = new Date();
    const resolvedValidUntil = validUntil ? new Date(validUntil) : pkg.priceValidUntil;
    const resolvedTerms = termsAndConditions || documentSettings?.termsAndConditions || null;

    const snapshotData = {
      quotationNumber, generatedAt,
      company: company || {},
      customer: customer ? { name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.companyName || null } : {},
      package: {
        name: pkg.name, travelStartDate: pkg.travelStartDate, travelEndDate: pkg.travelEndDate, travelers: pkg.travelers,
        sellingCurrency: pkg.sellingCurrency,
        segments: pkg.segments.map((s) => ({ city: s.city, hotelName: hotelNameById.get(s.hotelCatalogId?.toString()) || null, checkIn: s.checkIn, checkOut: s.checkOut }))
      },
      roomType: { roomTypeName: row.roomTypeName, occupancy: row.occupancy, finalPricePerPerson: row.finalPricePerPerson, roomTotal: row.roomTotal },
      includedComponents, paymentTerms, termsAndConditions: resolvedTerms, validUntil: resolvedValidUntil
    };

    const quotation = await QuotationModel.create({
      tenantId, packageId: pkg._id, customerId: pkg.customerId, quotationNumber, roomTypeId, snapshotData,
      termsAndConditions: resolvedTerms, paymentTerms, validUntil: resolvedValidUntil,
      status: config.defaultQuotationStatus, generatedAt, generatedBy: userId || null
    });

    await AuditLogModel.create({ action: "package.pricing.create_quotation", module: "PackagePricing", resource: "Quotation", resourceId: quotation._id.toString(), userId: userId || null, tenantId, details: { packageId: pkg._id.toString(), quotationNumber } });
    publishEvent("QuotationCreated", { tenantId, quotationId: quotation._id.toString(), packageId: pkg._id.toString(), performedBy: userId || null });

    return quotation.toJSON();
  }

  static async getQuotationById(quotationId, tenantId) {
    const quotation = await QuotationModel.findOne({ _id: quotationId, tenantId }).lean();
    if (!quotation) throw new Error("Quotation not found.");
    return quotation;
  }

  static async listQuotationsForPackage(packageId, tenantId) {
    return QuotationModel.find({ tenantId, packageId }).sort({ createdAt: -1 }).lean();
  }

  static async generateQuotationPdf(quotationId, tenantId, userId) {
    const quotation = await QuotationModel.findOne({ _id: quotationId, tenantId });
    if (!quotation) throw new Error("Quotation not found.");

    const buffer = await QuotationPdfService.generatePdfBuffer(quotation.snapshotData);
    const stored = await storeDocumentPdf({ tenantId, folder: "package-quotations", filename: `${quotation.quotationNumber}.pdf`, buffer });

    quotation.pdfUrl = stored.url;
    await quotation.save();

    await AuditLogModel.create({ action: "package.pricing.generate_quotation_pdf", module: "PackagePricing", resource: "Quotation", resourceId: quotation._id.toString(), userId: userId || null, tenantId, details: {} });
    return quotation.toJSON();
  }

  /**
   * POST /packages/quotations/:id/send — dispatches an already-generated
   * quotation to the customer via Email and/or WhatsApp, reusing the
   * platform's own EmailPlatformService/WhatsAppPlatformService rather than
   * owning any send/provider logic here (same "consumer of the Communication
   * Platform" relationship as PackageWhatsAppMessageService.sendPackageMessage
   * above). Generates the PDF first if one hasn't been generated yet.
   */
  static async sendQuotation(quotationId, data, tenantId, userId) {
    const { channel = "email", email = null, phone = null, message = null } = data;
    let quotation = await QuotationModel.findOne({ _id: quotationId, tenantId });
    if (!quotation) throw new Error("Quotation not found.");

    if (!quotation.pdfUrl) {
      await PackagePricingService.generateQuotationPdf(quotationId, tenantId, userId);
      quotation = await QuotationModel.findOne({ _id: quotationId, tenantId });
    }

    const customer = quotation.customerId ? await CustomerModel.findOne({ _id: quotation.customerId, tenantId }).lean() : null;
    const company = await resolveTenantBranding(tenantId);
    const noteText = message || `Please find your quotation ${quotation.quotationNumber} from ${company?.name || "us"} attached.`;

    const results = {};

    if (channel === "email" || channel === "both") {
      const resolvedEmail = email || customer?.email;
      if (!resolvedEmail) throw new Error("Recipient email is required — supply one, or set a customer with an email on file on the quotation.");
      results.email = await EmailPlatformService.sendEmail({
        tenantId,
        sourceModule: "PackagePricing",
        to: resolvedEmail,
        subject: `Quotation ${quotation.quotationNumber}`,
        content: noteText,
        attachments: [{ filename: `${quotation.quotationNumber}.pdf`, path: quotation.pdfUrl }],
        emailType: "Transactional",
        userId: userId || null
      });
    }

    if (channel === "whatsapp" || channel === "both") {
      const resolvedPhone = phone || customer?.phone;
      if (!resolvedPhone) throw new Error("Recipient phone is required — supply one, or set a customer with a phone on file on the quotation.");
      results.whatsapp = await WhatsAppPlatformService.sendWhatsApp({
        tenantId, sourceModule: "PackagePricing", phone: resolvedPhone, content: `${noteText}\n${quotation.pdfUrl}`, priority: "Normal", userId: userId || null
      });
    }

    quotation.status = "Sent";
    await quotation.save();

    await AuditLogModel.create({ action: "package.pricing.send_quotation", module: "PackagePricing", resource: "Quotation", resourceId: quotation._id.toString(), userId: userId || null, tenantId, details: { channel } });
    publishEvent("QuotationSent", { tenantId, quotationId: quotation._id.toString(), performedBy: userId || null, channel });

    return { quotation: quotation.toJSON(), delivery: results };
  }

  /**
   * POST /quotations/:id/convert-to-booking — PRD "CRM Feature Map by
   * Phase" Phase 2 module 18 (Quotation & Proposal System). Deliberately a
   * thin wrapper around the already-existing convertPackageToBooking (the
   * same conversion logic a direct package-to-booking flow uses) rather
   * than a second, parallel booking-creation path — the quotation just
   * supplies the roomTypeId it already froze at generation time, so the
   * caller never has to re-specify which room-wise matrix row was quoted.
   */
  static async convertQuotationToBooking(quotationId, data, tenantId, userId) {
    const quotation = await QuotationModel.findOne({ _id: quotationId, tenantId });
    if (!quotation) throw new Error("Quotation not found.");
    if (quotation.convertedBookingId) throw new Error("This quotation cannot be converted again — it was already converted to a booking.");

    const { rooms = 1, bookingId = null, bookingType = null } = data;
    const result = await PackagePricingService.convertPackageToBooking(
      quotation.packageId.toString(),
      { roomTypeId: quotation.roomTypeId.toString(), rooms, bookingId, bookingType },
      tenantId, userId
    );

    quotation.status = "Accepted";
    quotation.convertedBookingId = result.bookingId;
    await quotation.save();

    await AuditLogModel.create({ action: "package.pricing.convert_quotation_to_booking", module: "PackagePricing", resource: "Quotation", resourceId: quotation._id.toString(), userId: userId || null, tenantId, details: { bookingId: result.bookingId } });
    publishEvent("QuotationConvertedToBooking", { tenantId, quotationId: quotation._id.toString(), bookingId: result.bookingId, performedBy: userId || null });

    return { ...result, quotationId: quotation._id.toString(), quotationStatus: quotation.status };
  }

  /**
   * GET /packages/:id/dynamic-pricing-suggestion — PRD "CRM Feature Map by
   * Phase" Phase 4 module 27 (AI Dynamic Pricing). Deliberately ADVISORY
   * ONLY: returns a suggested multiplier and what the package's own
   * last-calculated room-wise price matrix would look like under it, but
   * never writes to PackageModel or touches calculatePackage's own real
   * pricing pipeline — a human decides whether to actually apply it (e.g.
   * via a markup rule or a manual rate override), the same "suggestion, not
   * an automatic price change" framing the PDF itself uses for this module.
   */
  static async computeDynamicMultiplier(packageId, tenantId) {
    const config = getPackagePricingConfig();
    const pkg = await PackageModel.findOne({ _id: packageId, tenantId }).lean();
    if (!pkg) throw new Error("Package not found.");

    const season = getIslamicSeason(pkg.travelStartDate);
    const seasonMultiplier = season === "Ramadan" ? config.ramadanPriceMultiplier : season === "Hajj" ? config.hajjPriceMultiplier : 1;

    const windowMs = config.highDemandWindowDays * 24 * 60 * 60 * 1000;
    const nearbyBookingCount = await BookingHeaderModel.countDocuments({
      tenantId,
      travelDate: { $gte: new Date(pkg.travelStartDate.getTime() - windowMs), $lte: new Date(pkg.travelStartDate.getTime() + windowMs) },
      status: { $nin: ["cancelled", "draft"] }
    });
    const isHighDemand = nearbyBookingCount >= config.highDemandBookingThreshold;
    const demandMultiplier = isHighDemand ? config.highDemandPriceMultiplier : 1;

    const combinedMultiplier = roundCurrency(seasonMultiplier * demandMultiplier);
    const suggestedMatrix = (pkg.roomWisePriceMatrix || []).map((row) => ({
      roomTypeId: row.roomTypeId, roomTypeName: row.roomTypeName,
      currentFinalPricePerPerson: row.finalPricePerPerson,
      suggestedFinalPricePerPerson: roundCurrency(row.finalPricePerPerson * combinedMultiplier)
    }));

    return {
      packageId: pkg._id, travelStartDate: pkg.travelStartDate,
      season, seasonMultiplier, nearbyBookingCount, isHighDemand, demandMultiplier, combinedMultiplier,
      suggestedMatrix
    };
  }
}

export default PackagePricingService;
