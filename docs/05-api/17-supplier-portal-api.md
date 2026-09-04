# Supplier Self-Service Portal API

PRD "CRM Feature Map by Phase" Phase 3 module 24. Routes live in `routes/SupplierPortalRoutes.js`, mounted at `/api/v1/supplier-portal`.

**Built against `VendorModel` ("vendor"), not `SupplierModel` ("package_supplier").** These are two real, independent models in this codebase describing a similar real-world entity — `SupplierModel` is the Package Pricing Engine's own rate-sourcing record; `VendorModel` is the Finance domain's accounts-payable record, the one `VendorPaymentModel` actually references. `GET /supplier-portal/payments` needs a real payment history, so this portal is deliberately the `VendorModel` one.

## Authentication

Two separate credential types on this one router, same split as the Agent Portal:

- **Staff-side** (`authenticateAccessToken`, existing tenant JWT) — issues/lists/revokes a supplier's own portal token.
- **Supplier-side** (`authenticateVendorPortalToken`, `middleware/authenticateVendorPortalToken.js`) — an `X-Supplier-Token` header, resolved to `req.vendorAuth = {tenantId, vendorId}` (never `req.auth`). Only the SHA-256 hash of the raw token is ever stored (`models/VendorPortalTokenModel.js`, same discipline as `ApiKeyModel.js`) — the raw token is returned exactly once, at issuance, and cannot be recovered afterward. Every supplier-side query is scoped to `{tenantId, vendorId}` together via `getVendorAccessScope(req)` (`utils/accessScope.js`) — a supplier can never see another supplier's or the tenant's shared data.

### Staff-side (tenant JWT, `finance.vendorportal.manage` or `admin`)

- `POST /api/v1/supplier-portal/vendors/{vendorId}/tokens` — `{name?, expiresAt?}`. Returns the raw token (`token` field) once.
- `GET /api/v1/supplier-portal/vendors/{vendorId}/tokens` — list a vendor's tokens (secrets never included).
- `POST /api/v1/supplier-portal/tokens/{tokenId}/revoke` — immediate; a revoked token is rejected by the auth middleware on its very next use.

### Supplier-side (`X-Supplier-Token` header)

- `GET /api/v1/supplier-portal/me` — own vendor profile (name/contact/status).
- `POST /api/v1/supplier-portal/invoices` — `{supplierInvoiceNumber, amount, currency, description?, attachments?}`. Creates a `VendorInvoiceModel` row, `status: "Submitted"`. This is the supplier's own claim for payment — distinct from `VendorPaymentModel` (the agency's own internally-created payment run against a vendor); approving a submitted invoice is a staff action through the existing vendor-payment tooling, not automated by this endpoint.
- `GET /api/v1/supplier-portal/invoices` — the supplier's own submission history only.
- `GET /api/v1/supplier-portal/payments?status=&currency=&page=&pageSize=` — reuses `VendorPaymentService.listVendorPayments` directly (the same service a staff member's own vendor-payments screen calls), with `vendorId` force-set to the caller's own — never a client-suppliable filter.
