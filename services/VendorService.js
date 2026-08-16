import VendorModel from "../models/VendorModel.js";
import AuditLogModel from "../models/AuditLogmodel.js";
import { publishEvent } from "../utils/eventBus.js";

// Minimal Vendor CRUD — see models/VendorModel.js for why this exists ahead
// of a full Procurement module. Read + create only; no update/deactivate
// endpoint yet since nothing in Part 6's contract requires editing a
// vendor's own profile.
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
    const { name, contactEmail = null, contactPhone = null, currency, paymentTermsDays } = data;
    if (!name || !currency) throw new Error("name and currency are required.");

    const vendor = await VendorModel.create({
      tenantId,
      name,
      contactEmail,
      contactPhone,
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
}

export default VendorService;
