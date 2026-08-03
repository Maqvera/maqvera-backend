import VisaRequirementModel from "../models/VisaRequirementModel.js";
import VisaTypeModel from "../models/VisaTypeModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";

class VisaRequirementService {
  /**
   * Returns supported visa types catalog (from DB or default constants)
   */
  static async getVisaTypes(query, tenantId) {
    const { page = 1, pageSize = 20, status, search } = query;
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
    const { visaTypeId, visaType, nationalityId, nationality, travelerCategory = "Adult", embassyId } = query;
    const destCountry = countryId || query.destinationCountry;
    const vType = visaType || visaTypeId;
    const nat = nationality || nationalityId || "ALL";

    // Precedence Search:
    // 1. Exact Match: Country + VisaType + Nationality + TravelerCategory (+ Embassy if provided)
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
      // 1. Exact match
      matchedProfile = profiles.find(p =>
        p.nationality.toUpperCase() === nat.toUpperCase() &&
        (p.travelerCategory === travelerCategory || p.travelerCategory === "ALL") &&
        (!embassyId || p.embassyId === embassyId)
      );

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
    const { countryId, destinationCountry, visaTypeId, visaType, embassyId, nationalityId, nationality, travelerCategory = "Adult", processingDays = 7, requiresInterview = false, requiresMedical = false, requiresBiometrics = false, requiresInsurance = false, requiredDocuments = [], eligibilityRules = [], processingRules = [], validityRules = {}, fees = {}, specialNotes = null } = data;

    const destCountry = destinationCountry || countryId;
    const vType = visaType || visaTypeId;
    const nat = nationality || nationalityId || "ALL";

    if (!destCountry || !vType) {
      throw new Error("Destination country (countryId) and visaType (visaTypeId) are required.");
    }

    // Check existing profiles for versioning
    const existing = await VisaRequirementModel.findOne({
      tenantId,
      destinationCountry: new RegExp(`^${destCountry}$`, "i"),
      visaType: new RegExp(`^${vType}$`, "i"),
      nationality: new RegExp(`^${nat}$`, "i"),
      travelerCategory
    }).sort({ version: -1 });

    const newVersion = existing ? existing.version + 1 : 1;

    const newProfile = new VisaRequirementModel({
      tenantId,
      destinationCountry: destCountry,
      embassyId: embassyId || null,
      visaType: vType,
      nationality: nat,
      travelerCategory,
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
      action: "CREATE_REQUIREMENT_PROFILE",
      resource: "VisaRequirementProfile",
      resourceId: newProfile._id.toString(),
      details: { destinationCountry: destCountry, visaType: vType, version: newVersion }
    }).catch(err => console.error("Audit error:", err));

    publishEvent("RequirementProfileCreated", {
      profileId: newProfile._id,
      tenantId,
      destinationCountry: destCountry,
      visaType: vType,
      version: newVersion
    });

    return newProfile;
  }
}

export default VisaRequirementService;
