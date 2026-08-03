import crypto from "crypto";
import jwt from "jsonwebtoken";
import { getAuthConfig } from "./authConfig.js";

const authConfig = getAuthConfig();

// A "type" claim keeps access and refresh tokens from being interchangeable
// even if both secrets ever resolved to the same value (e.g. PRIVATE_KEY
// fallback) — refresh contract Section 46 requires access tokens are never
// usable for refreshing.
export const createAccessToken = (payload) => {
  return jwt.sign({ ...payload, type: "access" }, authConfig.accessTokenSecret, { expiresIn: authConfig.accessTokenExpiresIn });
};

export const createRefreshToken = (payload, rememberMe = false) => {
  const expiresIn = rememberMe ? authConfig.refreshTokenRememberMeExpiresIn : authConfig.refreshTokenExpiresIn;
  return jwt.sign({ ...payload, type: "refresh" }, authConfig.refreshTokenSecret, { expiresIn });
};

export const hashToken = (token) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

export const createRequestId = () => crypto.randomUUID();

export const getRefreshTokenExpiryDate = (rememberMe = false) => {
  const days = rememberMe ? authConfig.refreshTokenRememberMeExpiresDays : authConfig.refreshTokenExpiresDays;
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + days);
  return expiry;
};

export const getAccessTokenExpiresInSeconds = () => {
  const match = authConfig.accessTokenExpiresIn.match(/^(\d+)([smhd])$/);
  if (!match) return 900;
  const val = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return val * (multipliers[unit] || 60);
};
