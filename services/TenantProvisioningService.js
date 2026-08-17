import TenantModel from "../models/Tenantmodel.js";
import UserModel from "../models/Usermodel.js";
import { ensureAdministratorRole } from "../utils/authDomainDefaults.js";
import { recordPasswordHistory } from "../utils/passwordPolicy.js";
import { issueEmailVerificationToken, createAudit } from "../controllers/Auth.js";
import { publishEvent } from "../utils/eventBus.js";

/**
 * Per-Tenant Payment Gateway Integration — PRD Issue 12. The real
 * tenant/role/user creation logic, extracted from `controllers/Auth.js#SetupTenant`
 * (now `SetupTenantIntent`, Phase 1 only) so BOTH the real payment-gated
 * webhook path (`controllers/PaymentWebhookController.js`, Phase 2) and
 * any future admin/manual provisioning path call the exact same real
 * function — never two competing implementations of "what does creating a
 * tenant actually involve." Reuses `issueEmailVerificationToken`/`createAudit`
 * directly from `Auth.js` (now exported) rather than a third copy.
 */
class TenantProvisioningService {
  /**
   * `passwordHash` is a real, already-computed bcrypt hash — Phase 1
   * (`SetupTenantIntent`) validates the real password policy and hashes it
   * BEFORE any payment happens; this method never re-validates or
   * re-hashes, so the exact password the user chose at signup is what
   * they log in with once payment completes, days later if need be.
   */
  static async provisionTenant({ companyName, tenantKey, username, email, passwordHash, requestId = null, ipAddress = null, deviceId = null, userAgent = null }) {
    const existingTenant = await TenantModel.findOne({ tenantKey });
    if (existingTenant) throw new Error("This company identifier is already in use.");
    const existingUser = await UserModel.findOne({ email });
    if (existingUser) throw new Error("User already exists.");

    // Same real "no transaction — sequential create + compensating delete
    // on failure" discipline `SetupTenant` already established (this
    // codebase assumes standalone MongoDB, not a replica set).
    let tenant = null;
    try {
      tenant = await TenantModel.create({ tenantKey, name: companyName, status: "active" });
      const role = await ensureAdministratorRole(tenant.tenantKey);

      const user = await UserModel.create({ username, email, password: passwordHash, tenantId: tenant.tenantKey, role: role.name });
      await recordPasswordHistory(user._id, passwordHash, "change", requestId);
      await issueEmailVerificationToken({ user, requestId, ipAddress, deviceId, userAgent });

      await createAudit({ action: "tenant.setup", outcome: "success", user, requestId, ipAddress, device: deviceId, browser: userAgent, metadata: { tenantKey: tenant.tenantKey } });
      publishEvent("TenantProvisioned", { tenantId: tenant.tenantKey, adminUserId: user._id.toString(), companyName: tenant.name, requestId });

      return { tenant, user };
    } catch (innerError) {
      if (tenant) await TenantModel.deleteOne({ _id: tenant._id }).catch(() => {});
      throw innerError;
    }
  }
}

export default TenantProvisioningService;
