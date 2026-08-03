// Lightweight, dependency-free User-Agent heuristics shared by session
// creation (SessionModel) and login history (LoginHistoryModel) so both
// models derive os/browser/deviceType the same way instead of duplicating
// ad-hoc regexes at each call site.
export const parseUserAgent = (userAgent) => {
  const ua = userAgent || "";

  if (!ua) {
    return { os: null, browser: "Unknown", deviceType: "other" };
  }

  const osMatch = ua.match(/\((.*?)\)/);
  const os = osMatch ? osMatch[1].split(";")[0].trim() : null;

  const browserMatch = ua.match(/(Chrome|Firefox|Safari|Edge|Opera|MSIE|Trident)[/\s]([\d.]+)/);
  const browser = browserMatch ? browserMatch[0] : ua;

  let deviceType = "desktop";
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) {
    deviceType = "tablet";
  } else if (/Mobi|iPhone|iPod|Android.*Mobile/i.test(ua)) {
    deviceType = "mobile";
  }

  return { os, browser, deviceType };
};
