import { getDashboardConfig } from "./dashboardConfig.js";

/**
 * Reporting Platform Part 4 fix — Dashboard Management. This is the
 * common `DashboardWidgetContract` the gap analysis asked for:
 * `{ widgetKey, type, title, value, series?, meta }`. It is a pure
 * shape-normalizing helper, NOT a model and NOT a rewrite of the three
 * existing analytics engines (services/AnalyticsEngine.js,
 * services/FinanceAnalyticsEngine.js, services/VisaAnalyticsEngine.js) —
 * merging those into one facade is an explicitly excluded, later,
 * larger refactor. Instead, each dashboard controller projects its
 * existing flat KPI object through `toWidgetArray()` using its own
 * small keyMap, so callers get an additive `widgets` array without any
 * of the 40+ existing compute methods changing.
 */

export const normalizeWidget = ({ widgetKey, type, title, value = null, series = null, meta = {} } = {}) => {
  if (!widgetKey || typeof widgetKey !== "string") throw new Error("widgetKey is required.");
  if (!type || typeof type !== "string") throw new Error("type is required.");
  if (!title || typeof title !== "string") throw new Error("title is required.");

  const config = getDashboardConfig();
  if (!config.widgetTypes.includes(type)) throw new Error(`Invalid widget type "${type}".`);

  return { widgetKey, type, title, value, series, meta };
};

/**
 * Projects a flat KPI object (e.g. FinanceAnalyticsEngine.calculateKPIs's
 * output) into a widget array using a per-controller `keyMap`:
 * `{ resultKey: { title, type } }`. Only keys actually present (and not
 * undefined) on `flatObject` produce a widget — never fabricates one for
 * a missing source field, so this stays correct across the many
 * differently-shaped objects the three engines return.
 */
export const toWidgetArray = (flatObject = {}, keyMap = {}) => {
  if (!flatObject || typeof flatObject !== "object") return [];

  return Object.entries(keyMap)
    .filter(([resultKey]) => flatObject[resultKey] !== undefined)
    .map(([resultKey, { title, type = "metric" }]) =>
      normalizeWidget({
        widgetKey: resultKey,
        type,
        title,
        value: flatObject[resultKey],
        meta: { fromCache: flatObject.fromCache ?? null, generatedAt: flatObject.generatedAt ?? null },
      })
    );
};

export default { normalizeWidget, toWidgetArray };
