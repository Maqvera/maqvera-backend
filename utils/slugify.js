// Per-Tenant Domain-Masked Landing Page (PRD v2 §Task B) — a small,
// dependency-free helper (checked first: no equivalent existed anywhere
// under utils/ before this) shared by anything that needs to turn a
// human-entered name into a DNS-label-safe slug, e.g. "abc-1"; not just
// TenantProfileModel.publicSlug — any future caller with the same need
// should import this rather than writing a third copy of the same regex.
export const slugify = (input) => {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "") || "tenant";
};
