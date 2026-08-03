import dotenv from "dotenv";
dotenv.config();

// Offline MaxMind-derived dataset — no API key, no outbound network call,
// so there is nothing to configure beyond the on/off toggle below.
const isEnabled = process.env.SESSION_GEO_LOCATION_ENABLED !== "false";

let geoip = null;
if (isEnabled) {
  try {
    geoip = (await import("geoip-lite")).default;
  } catch {
    geoip = null;
  }
}

// Private/loopback/unresolvable IPs correctly resolve to null — that is
// real, honest data (the request had no public-routable origin), never a
// fabricated country/city.
export const resolveGeoLocation = (ipAddress) => {
  if (!geoip || !ipAddress) return { country: null, city: null };
  const cleanIp = ipAddress.split(",")[0].trim();
  try {
    const result = geoip.lookup(cleanIp);
    if (!result) return { country: null, city: null };
    return { country: result.country || null, city: result.city || null };
  } catch {
    return { country: null, city: null };
  }
};
