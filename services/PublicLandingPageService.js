import TenantProfileModel from "../models/TenantProfileModel.js";
import HotelCatalogModel from "../models/HotelCatalogModel.js";
import ReviewModel from "../models/ReviewModel.js";
import PublicBookingService from "./PublicBookingService.js";

// Per-Tenant Domain-Masked Landing Page (PRD v2 §2.3/§2.4) — builds the
// exact view-model templates/landingPage/index.html expects. Deliberately
// reuses PublicBookingService.listPublicPackages for the featured-packages
// section (§7/§13) rather than querying PackageModel directly the way the
// PRD's draft sketch shows: PackageModel entries are one specific
// customer's calculated quote (private data, and not what "Featured
// Packages" means on a public marketing page) — PackageTemplateModel
// (publicVisible:true, already built for the Public B2C Booking Site) is
// the actual public catalog concept, and PublicBookingService already
// resolves+shapes it correctly. Reusing it here means one single source of
// truth for "what a public visitor is allowed to see about this tenant's
// packages," not two.
const initialsFrom = (name) => {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join("");
};

const truncate = (text, max = 170) => {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trim()}…`;
};

const starsLabel = (rating) => {
  const n = Math.max(0, Math.min(5, Math.round(Number(rating) || 5)));
  return "★".repeat(n) + "☆".repeat(5 - n);
};

const durationLabel = (nights) => (nights > 0 ? `${nights} night${nights === 1 ? "" : "s"}` : null);

// Landing Page follow-up audit, Gap 1 (Section 13 — Pricing/Plans
// Comparison). Marketing copy, not data that needs to be exact — splits
// the same description already shown as a single line in §7's card into
// up to 4 short bullets for the comparison table, on sentence boundaries.
const toHighlights = (description) => {
  if (!description) return [];
  return description.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 4);
};

class PublicLandingPageService {
  static async getLandingPageData(tenantId, tenantSlug) {
    const profile = await TenantProfileModel.findOne({ tenantId }).lean();
    if (!profile) throw new Error("Tenant profile not found.");

    const [packagesResult, hotels, reviews] = await Promise.all([
      tenantSlug ? PublicBookingService.listPublicPackages(tenantSlug, { pageSize: 6 }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
      HotelCatalogModel.find({ tenantId }).sort({ starRating: -1 }).limit(3).select("name city starRating distanceFromLandmark").lean(),
      ReviewModel.find({ tenantId, status: "published" }).sort({ createdAt: -1 }).limit(6).populate("customerId", "firstName lastName").lean()
    ]);

    const socialLinks = profile.socialLinks || {};
    const hasSocialLinks = Object.values(socialLinks).some(Boolean);

    return {
      companyName: profile.companyName,
      companyNameArabic: profile.companyNameArabic || null,
      logoUrl: profile.logoUrl || null,
      initials: initialsFrom(profile.companyName),
      tagline: profile.documentSettings?.tagline || null,
      aboutText: profile.documentSettings?.aboutText || null,
      aboutTextShort: truncate(profile.documentSettings?.aboutText, 170),
      primaryColor: profile.primaryColor || null,
      secondaryColor: profile.secondaryColor || null,
      registrationNumber: profile.registrationNumber || null,
      licenseNumber: profile.licenseNumber || null,
      vatNumber: profile.vatNumber || null,
      address: profile.address || null,
      city: profile.city || null,
      country: profile.country || null,
      phone: profile.phone || null,
      email: profile.email || null,
      tenantSlug: tenantSlug || profile.publicSlug || "",
      currentYear: new Date().getFullYear(),
      packageCount: packagesResult.pagination?.total ?? packagesResult.items.length,
      reviewCount: reviews.length,
      packages: packagesResult.items.map((pkg) => ({
        name: pkg.name,
        description: pkg.description,
        packageType: pkg.packageType,
        priceLabel: pkg.displayPriceFrom ? `From ${pkg.displayCurrency || ""} ${pkg.displayPriceFrom}`.trim() : null,
        durationLabel: durationLabel(pkg.durationNights)
      })),
      // Section 13 — same packagesResult.items already fetched above for §7,
      // no second query, reshaped for a comparison-table layout.
      pricingTiers: packagesResult.items.map((pkg) => ({
        name: pkg.name,
        packageType: pkg.packageType,
        priceLabel: pkg.displayPriceFrom ? `From ${pkg.displayCurrency || ""} ${pkg.displayPriceFrom}`.trim() : null,
        durationLabel: durationLabel(pkg.durationNights),
        highlights: toHighlights(pkg.description)
      })),
      hotels: hotels.map((hotel) => ({
        name: hotel.name,
        city: hotel.city,
        starsLabel: starsLabel(hotel.starRating),
        distanceLabel: hotel.distanceFromLandmark?.label && hotel.distanceFromLandmark?.km != null
          ? `${hotel.distanceFromLandmark.km}km from ${hotel.distanceFromLandmark.label}`
          : null
      })),
      reviews: reviews.filter((r) => r.comment).map((review) => ({
        starsLabel: starsLabel(review.packageRating || review.hotelRating || 5),
        comment: review.comment,
        customerName: review.customerId ? `${review.customerId.firstName || ""} ${(review.customerId.lastName || "").slice(0, 1)}${review.customerId.lastName ? "." : ""}`.trim() : "Verified Traveler"
      })),
      socialLinks,
      hasSocialLinks
    };
  }
}

export default PublicLandingPageService;
