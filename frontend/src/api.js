const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
export const OPENAPI_URL = import.meta.env.VITE_OPENAPI_URL || "/openapi.json";
const TOKEN_KEY = "maqvera_access_token";

export const getToken = () => sessionStorage.getItem(TOKEN_KEY) || "";
export const setToken = (token) => token ? sessionStorage.setItem(TOKEN_KEY, token) : sessionStorage.removeItem(TOKEN_KEY);

export async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE}${path.startsWith("/") ? path : `/${path}`}`, { ...options, headers, credentials: "include" });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json().catch(() => null) : await response.text().catch(() => "");
  if (!response.ok) {
    const message = data?.message || data?.error || (typeof data === "string" ? data : "") || `Request failed (${response.status})`;
    const error = new Error(message); error.status = response.status; error.data = data; throw error;
  }
  return { data, status: response.status, headers: response.headers };
}

export async function loadOpenApi() {
  const response = await fetch(OPENAPI_URL, { credentials: "include" });
  if (!response.ok) throw new Error(`Could not load OpenAPI document (${response.status}). Check that the backend is running and /openapi.json is reachable.`);
  return response.json();
}

export function resolvePath(path, values = {}) {
  return path.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(values[key] ?? `{${key}}`));
}
