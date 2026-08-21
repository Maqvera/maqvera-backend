import VisaRequirementModel from "../models/VisaRequirementModel.js";
import VisaTypeModel from "../models/VisaTypeModel.js";
import CountryMasterModel from "../models/CountryMasterModel.js";
import EmbassyMasterModel from "../models/EmbassyMasterModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";
import mongoose from "mongoose";

// Visa Module PRD §8/§12 pricing formula — Vendor Cost + Government Fee +
// Insurance + Service Charges + Other Charges - Discount = Selling Price.
// Pure function so both VisaType admin pricing (createVisaType/updateVisaType
// below) and per-case application pricing (VisaService.updateApplicationPricing)
// compute it identically, never duplicated inline.
export const calculateVisaSellingPrice = ({ vendorCost = 0, governmentFee = 0, insuranceFee = 0, serviceCharges = 0, otherCharges = 0, discount = 0 }) =>
  Math.max(0, (Number(vendorCost) || 0) + (Number(governmentFee) || 0) + (Number(insuranceFee) || 0) + (Number(serviceCharges) || 0) + (Number(otherCharges) || 0) - (Number(discount) || 0));

class VisaRequirementService {
  /**
   * Returns supported visa types catalog (from DB or default constants)
   */
  static async getVisaTypes(query, tenantId) {
    const { page = 1, pageSize = 20, status, search, lang } = query;
    const limit = Math.min(Math.max(parseInt(pageSize, 10), 1), 100);
    const skip = (Math.max(parseInt(page, 10), 1) - 1) * limit;

    const filter = { tenantId };
    if (status !== undefined && status !== null && status !== "") {
      filter.isActive = status === "true" || status === true || status === "active";
    }
    if (search) {
      filter.$or = [
        { name: new RegExp(search, "i") },
        { code: new RegExp(search, "i") },
        { category: new RegExp(search, "i") }
      ];
    }

    let [items, total] = await Promise.all([
      VisaTypeModel.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
      VisaTypeModel.countDocuments(filter)
    ]);

    // Business Rule "Supports localization" — was previously a completely
    // unused Map field on the model (nothing ever read it). ?lang= overrides
    // name/description/category from the type's own localization data when
    // an entry exists for that language; falls back to the base fields
    // otherwise rather than erroring on an unconfigured language.
    if (lang) {
      items = items.map((item) => {
        const localized = item.localization && (item.localization[lang] || item.localization instanceof Map && item.localization.get(lang));
        if (!localized) return item;
        return {
          ...item,
          name: localized.name || item.name,
          description: localized.description || item.description,
          category: localized.category || item.category
        };
      });
    }

    return {
      items,
      pagination: {
        total,
        page: parseInt(page, 10),
        pageSize: limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Requirement Resolver Engine for Country
   * Returns requirement profiles using precedence logic.
   */
  static async getRequirementProfilesForCountry(countryId, query, tenantId) {
    const { visaTypeId, visaType, nationalityId, nationality, travelerCategory = "Adult", embassyId, travelPurpose } = query;
    const destCountry = countryId || query.destinationCountry;
    const vType = visaType || visaTypeId;
    const nat = nationality || nationalityId || "ALL";

    // Precedence Search:
    // 1. Exact Match: Country + VisaType + Nationality + TravelerCategory (+ Embassy/TravelPurpose if provided)
    // 2. Match: Country + VisaType + Nationality + TravelerCategory: ALL
    // 3. Fallback: Country + VisaType + Nationality: ALL + TravelerCategory: ALL
    if (!destCountry || !vType) throw new Error("countryId and visaTypeId are required to resolve requirements.");
    const profiles = await VisaRequirementModel.find({
      tenantId,
      destinationCountry: new RegExp(`^${destCountry}$`, "i"),
      visaType: new RegExp(`^${vType}$`, "i"),
      isActive: true
    }).sort({ version: -1, updatedAt: -1 }).lean();

    let matchedProfile = null;

    if (profiles.length > 0) {
      // 1. Exact match — every tier-1-compatible candidate (nationality,
      // category, embassy all match-or-wildcard), then within that set
      // prefer one whose travelPurpose matches exactly over one that's just
      // ALL/unset. A plain .find() here would return whichever came first
      // by version/updatedAt regardless of purpose-specificity, silently
      // picking a generic profile over a more specific one that happens to
      // sort later — "most specific profile takes precedence" requires this
      // second, explicit specificity pass rather than relying on find()'s
      // encounter order.
      const tier1Candidates = profiles.filter(p =>
        p.nationality.toUpperCase() === nat.toUpperCase() &&
        (p.travelerCategory === travelerCategory || p.travelerCategory === "ALL") &&
        (!embassyId || p.embassyId === embassyId)
      );
      if (tier1Candidates.length > 0) {
        const exactPurposeMatch = travelPurpose && tier1Candidates.find(p => p.travelPurpose && p.travelPurpose.toUpperCase() === travelPurpose.toUpperCase());
        const wildcardPurposeMatch = tier1Candidates.find(p => !p.travelPurpose || p.travelPurpose.toUpperCase() === "ALL");
        matchedProfile = exactPurposeMatch || wildcardPurposeMatch || tier1Candidates[0];
      }

      // 2. Nationality match
      if (!matchedProfile) {
        matchedProfile = profiles.find(p => p.nationality.toUpperCase() === nat.toUpperCase());
      }

      // 3. Default fallback profile
      if (!matchedProfile) {
        matchedProfile = profiles.find(p => p.nationality.toUpperCase() === "ALL");
      }

      if (!matchedProfile) {
        matchedProfile = profiles[0];
      }
    }

    return {
      destinationCountry: destCountry,
      resolvedProfile: matchedProfile
    };
  }

  static toCaseSnapshot(profile) {
    if (!profile) throw new Error("No active requirement profile matched this case. Configure a profile before creating the Visa Case.");
    return {
      profileId: profile._id.toString(), version: profile.version, resolvedAt: new Date(),
      processingDays: profile.processingDays, requiresInterview: profile.requiresInterview,
      requiresMedical: profile.requiresMedical, requiresBiometrics: profile.requiresBiometrics,
      requiresInsurance: profile.requiresInsurance, eligibilityRules: profile.eligibilityRules,
      processingRules: profile.processingRules, validityRules: profile.validityRules, fees: profile.fees
    };
  }

  /**
   * Create or Update Configurable Requirement Profile
   */
  static async createRequirementProfile(data, tenantId, userId) {
    const { countryId, destinationCountry, visaTypeId, visaType, embassyId, nationalityId, nationality, travelerCategory = "Adult", travelPurpose = "ALL", processingDays = 7, requiresInterview = false, requiresMedical = false, requiresBiometrics = false, requiresInsurance = false, requiredDocuments = [], eligibilityRules = [], processingRules = [], validityRules = {}, fees = {}, specialNotes = null } = data;

    const rawCountry = destinationCountry || countryId;
    const rawVisaType = visaType || visaTypeId;
    const nat = nationality || nationalityId || "ALL";

    if (!rawCountry || !rawVisaType) {
      throw new Error("Destination country (countryId) and visaType (visaTypeId) are required.");
    }

    // Validation Rules: Country Exists, Visa Type Exists, Embassy Exists,
    // Nationality Exists — none of these were validated at all; any
    // free-text string was accepted and stored as-is. Resolved the same way
    // VisaService.resolveCountry/resolveVisaType do, so requirement profiles
    // and Visa Cases end up storing the identical canonical strings (needed
    // for getRequirementProfilesForCountry's matching to actually connect
    // the two later). Skipped only when there's no live DB connection,
    // matching the same resilience convention used elsewhere.
    let destCountry = rawCountry;
    let vType = rawVisaType;
    if (mongoose.connection.readyState === 1) {
      const country = await CountryMasterModel.findOne({
        tenantId, isActive: true,
        $or: [{ countryId: rawCountry }, { code: String(rawCountry).toUpperCase() }, { name: new RegExp(`^${rawCountry}$`, "i") }]
      });
      if (!country) throw new Error("Country not found or inactive for this tenant.");
      destCountry = country.name;

      const typeFilter = { tenantId, isActive: true, $or: [{ code: rawVisaType }, { name: new RegExp(`^${rawVisaType}$`, "i") }] };
      if (mongoose.Types.ObjectId.isValid(rawVisaType)) typeFilter.$or.push({ _id: rawVisaType });
      const visaTypeRecord = await VisaTypeModel.findOne(typeFilter);
      if (!visaTypeRecord) throw new Error("Visa type not found or inactive for this tenant.");
      vType = visaTypeRecord.code;

      if (embassyId) {
        const embassy = await EmbassyMasterModel.findOne({ tenantId, embassyId, isActive: true });
        if (!embassy) throw new Error("Embassy processing center not found or inactive.");
      }

      if (nat && nat.toUpperCase() !== "ALL") {
        const nationalityCountry = await CountryMasterModel.findOne({
          tenantId, isActive: true,
          $or: [{ countryId: nat }, { code: String(nat).toUpperCase() }, { name: new RegExp(`^${nat}$`, "i") }]
        });
        if (!nationalityCountry) throw new Error("Nationality not found or inactive for this tenant.");
      }
    }

    // Check existing profiles for versioning
    const existing = await VisaRequirementModel.findOne({
      tenantId,
      destinationCountry: new RegExp(`^${destCountry}$`, "i"),
      visaType: new RegExp(`^${vType}$`, "i"),
      nationality: new RegExp(`^${nat}$`, "i"),
      travelerCategory,
      travelPurpose
    }).sort({ version: -1 });

    const newVersion = existing ? existing.version + 1 : 1;

    const newProfile = new VisaRequirementModel({
      tenantId,
      destinationCountry: destCountry,
      embassyId: embassyId || null,
      visaType: vType,
      nationality: nat,
      travelerCategory,
      travelPurpose,
      version: newVersion,
      processingDays,
      requiresInterview,
      requiresMedical,
      requiresBiometrics,
      requiresInsurance,
      requiredDocuments,
      eligibilityRules,
      processingRules,
      validityRules,
      fees,
      specialNotes,
      isActive: true
    });

    await newProfile.save();

    await AuditLogModel.create({
      tenantId,
      userId: userId || "system",
      action: existing ? "UPDATE_REQUIREMENT_PROFILE" : "CREATE_REQUIREMENT_PROFILE",
      resource: "VisaRequirementProfile",
      resourceId: newProfile._id.toString(),
      details: { destinationCountry: destCountry, visaType: vType, version: newVersion, previousVersion: existing?.version || null }
    }).catch(err => console.error("Audit error:", err));

    // Append-only versioning means "updating" a profile is really creating a
    // new version in the same lineage — existing being found distinguishes
    // that (RequirementProfileUpdated) from the first version ever created
    // for this combination (RequirementProfileCreated), mirroring the same
    // isNew ternary EnterpriseDocumentService already uses for document
    // versions.
    publishEvent(existing ? "RequirementProfileUpdated" : "RequirementProfileCreated", {
      profileId: newProfile._id,
      tenantId,
      destinationCountry: destCountry,
      visaType: vType,
      version: newVersion,
      previousVersion: existing?.version || null
    });

    return newProfile;
  }

  /**
   * Create Visa Type — PRD §8 "Admin define kare" (Vendor Cost, Selling
   * Price, Currency per Visa Type). sellingPrice is computed server-side
   * from the pricing fields, never trusted from the client.
   */
  static async createVisaType(data, tenantId, userId) {
    const { code, name, category = "Tourism", description = null, defaultProcessingDays = 7, defaultValidityDays = 90,
      vendorCost = 0, governmentFee = 0, insuranceFee = 0, serviceCharges = 0, otherCharges = 0, discount = 0, currency = "USD" } = data;

    if (!code || !name) throw new Error("code and name are required.");

    const existing = await VisaTypeModel.findOne({ tenantId, code: code.toLowerCase() }).lean();
    if (existing) throw new Error(`Visa type "${code}" already exists for this tenant.`);

    const sellingPrice = calculateVisaSellingPrice({ vendorCost, governmentFee, insuranceFee, serviceCharges, otherCharges, discount });

    const visaType = await VisaTypeModel.create({
      tenantId, code: code.toLowerCase(), name, category, description,
      defaultProcessingDays, defaultValidityDays,
      vendorCost, governmentFee, insuranceFee, serviceCharges, otherCharges, discount, sellingPrice, currency: currency.toUpperCase(),
      isActive: true
    });

    await AuditLogModel.create({
      tenantId, userId: userId || "system", action: "CREATE_VISA_TYPE", resource: "VisaType",
      resourceId: visaType._id.toString(), details: { code: visaType.code, sellingPrice }
    }).catch((err) => console.error("Audit error:", err));

    publishEvent("VisaTypeCreated", { visaTypeId: visaType._id, tenantId, code: visaType.code, sellingPrice });

    return visaType;
  }

  /**
   * Update Visa Type — recomputes sellingPrice whenever any pricing field
   * changes, same formula as createVisaType.
   */
  static async updateVisaType(visaTypeId, updateData, tenantId, userId) {
    const visaType = await VisaTypeModel.findOne({ _id: visaTypeId, tenantId });
    if (!visaType) throw new Error("Visa type not found.");

    const editableFields = ["name", "category", "description", "defaultProcessingDays", "defaultValidityDays",
      "vendorCost", "governmentFee", "insuranceFee", "serviceCharges", "otherCharges", "discount", "isActive"];
    const pricingFields = ["vendorCost", "governmentFee", "insuranceFee", "serviceCharges", "otherCharges", "discount"];
    let pricingChanged = false;

    editableFields.forEach((key) => {
      if (updateData[key] === undefined) return;
      visaType[key] = updateData[key];
      if (pricingFields.includes(key)) pricingChanged = true;
    });
    if (updateData.currency !== undefined) {
      visaType.currency = updateData.currency.toUpperCase();
      pricingChanged = true;
    }

    if (pricingChanged) {
      visaType.sellingPrice = calculateVisaSellingPrice({
        vendorCost: visaType.vendorCost, governmentFee: visaType.governmentFee, insuranceFee: visaType.insuranceFee,
        serviceCharges: visaType.serviceCharges, otherCharges: visaType.otherCharges, discount: visaType.discount
      });
    }

    await visaType.save();

    await AuditLogModel.create({
      tenantId, userId: userId || "system", action: "UPDATE_VISA_TYPE", resource: "VisaType",
      resourceId: visaType._id.toString(), details: { updateData, sellingPrice: visaType.sellingPrice }
    }).catch((err) => console.error("Audit error:", err));

    publishEvent("VisaTypeUpdated", { visaTypeId: visaType._id, tenantId, sellingPrice: visaType.sellingPrice });

    return visaType;
  }

  /**
   * List Countries — PRD §7. CountryMasterModel was already the real country
   * master (VisaService.resolveCountry, createRequirementProfile both
   * validate against it) but had no admin-facing read/write surface.
   */
  static async listCountries(query, tenantId) {
    const { page = 1, pageSize = 50, status, search } = query;
    const limit = Math.min(Math.max(parseInt(pageSize, 10), 1), 200);
    const skip = (Math.max(parseInt(page, 10), 1) - 1) * limit;

    const filter = { tenantId };
    if (status !== undefined && status !== null && status !== "") {
      filter.isActive = status === "true" || status === true || status === "active";
    }
    if (search) {
      filter.$or = [{ name: new RegExp(search, "i") }, { code: new RegExp(search, "i") }];
    }

    const [items, total] = await Promise.all([
      CountryMasterModel.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
      CountryMasterModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page: parseInt(page, 10), pageSize: limit, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Create Country — PRD §7 "Country Name, Currency, Processing Time, Active/Inactive".
   */
  static async createCountry(data, tenantId, userId) {
    const { countryId, code, name, defaultCurrency = "USD", defaultProcessingDays = 7 } = data;
    if (!countryId || !code || !name) throw new Error("countryId, code, and name are required.");

    const existing = await CountryMasterModel.findOne({ tenantId, $or: [{ countryId }, { code: code.toUpperCase() }] }).lean();
    if (existing) throw new Error(`Country "${code}" already exists for this tenant.`);

    const country = await CountryMasterModel.create({
      tenantId, countryId, code: code.toUpperCase(), name,
      defaultCurrency: defaultCurrency.toUpperCase(), defaultProcessingDays, isActive: true
    });

    await AuditLogModel.create({
      tenantId, userId: userId || "system", action: "CREATE_COUNTRY", resource: "CountryMaster",
      resourceId: country._id.toString(), details: { code: country.code, name: country.name }
    }).catch((err) => console.error("Audit error:", err));

    publishEvent("CountryCreated", { countryId: country._id, tenantId, code: country.code });

    return country;
  }

  /**
   * Update Country — PRD §7. Editable fields only; countryId/code are
   * immutable identifiers other records (Visa Cases, Requirement Profiles)
   * already reference by value.
   */
  static async updateCountry(countryMasterId, updateData, tenantId, userId) {
    const country = await CountryMasterModel.findOne({ _id: countryMasterId, tenantId });
    if (!country) throw new Error("Country not found.");

    if (updateData.name !== undefined) country.name = updateData.name;
    if (updateData.defaultProcessingDays !== undefined) country.defaultProcessingDays = updateData.defaultProcessingDays;
    if (updateData.defaultCurrency !== undefined) country.defaultCurrency = updateData.defaultCurrency.toUpperCase();
    if (updateData.isActive !== undefined) country.isActive = Boolean(updateData.isActive);

    await country.save();

    await AuditLogModel.create({
      tenantId, userId: userId || "system", action: "UPDATE_COUNTRY", resource: "CountryMaster",
      resourceId: country._id.toString(), details: updateData
    }).catch((err) => console.error("Audit error:", err));

    publishEvent("CountryUpdated", { countryId: country._id, tenantId, isActive: country.isActive });

    return country;
  }
}

export default VisaRequirementService;
