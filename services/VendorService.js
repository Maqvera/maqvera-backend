import VendorModel from "../models/VendorModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";

// Minimal Vendor CRUD — see models/VendorModel.js for why this exists ahead
// of a full Procurement module. updateVendor added for the Visa Module PRD
// §11 ("Vendor details") — the first real need to edit a vendor's own profile.
class VendorService {
  static async listVendors(query, tenantId) {
    const { status, search } = query;
    const filter = { tenantId };
    if (status) filter.status = status;
    if (search) filter.name = new RegExp(search, "i");

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      VendorModel.find(filter).sort({ name: 1 }).skip(skip).limit(pageSize).lean(),
      VendorModel.countDocuments(filter)
    ]);

    return { items, pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  static async getVendorById(vendorId, tenantId) {
    const vendor = await VendorModel.findOne({ _id: vendorId, tenantId }).lean();
    if (!vendor) throw new Error("Vendor not found.");
    return vendor;
  }

  static async createVendor(data, tenantId, userId) {
    const { name, contactEmail = null, contactPhone = null, contactPerson = null, whatsapp = null, visaVendorProfile = null, currency, paymentTermsDays } = data;
    if (!name || !currency) throw new Error("name and currency are required.");

    const vendor = await VendorModel.create({
      tenantId,
      name,
      contactEmail,
      contactPhone,
      contactPerson,
      whatsapp,
      // Visa Module PRD §11 — only populated when the caller actually
      // supplies it; every other vendor type (hotel/car suppliers) leaves
      // this null, matching the sub-object's own doc comment on VendorModel.
      visaVendorProfile: visaVendorProfile || undefined,
      currency,
      paymentTermsDays: paymentTermsDays !== undefined ? paymentTermsDays : 30,
      status: "Active",
      createdBy: userId || null,
      updatedBy: userId || null
    });

    await AuditLogModel.create({
      action: "finance.vendor.create",
      module: "Finance",
      resource: "Vendor",
      resourceId: vendor._id.toString(),
      userId: userId || null,
      tenantId,
      details: { name }
    });

    publishEvent("VendorCreated", { tenantId, vendorId: vendor._id.toString(), name, performedBy: userId || null });

    return vendor.toJSON();
  }

  /**
   * Update Vendor — first real editable-profile need this model has had
   * (Visa Module PRD §11). Editable fields only; tenantId/status transitions
   * are handled elsewhere (status via deactivate flows, not implemented yet
   * since nothing currently requires it).
   */
  static async updateVendor(vendorId, updateData, tenantId, userId) {
    const vendor = await VendorModel.findOne({ _id: vendorId, tenantId });
    if (!vendor) throw new Error("Vendor not found.");

    const editableFields = ["name", "contactEmail", "contactPhone", "contactPerson", "whatsapp", "currency", "paymentTermsDays", "status"];
    editableFields.forEach((key) => {
      if (updateData[key] !== undefined) vendor[key] = updateData[key];
    });
    if (updateData.visaVendorProfile !== undefined) {
      vendor.visaVendorProfile = { ...(vendor.visaVendorProfile?.toObject?.() || vendor.visaVendorProfile || {}), ...updateData.visaVendorProfile };
    }
    vendor.updatedBy = userId || null;

    await vendor.save();

    await AuditLogModel.create({
      action: "finance.vendor.update",
      module: "Finance",
      resource: "Vendor",
      resourceId: vendor._id.toString(),
      userId: userId || null,
      tenantId,
      details: updateData
    });

    publishEvent("VendorUpdated", { tenantId, vendorId: vendor._id.toString(), performedBy: userId || null });

    return vendor.toJSON();
  }
}

export default VendorService;
