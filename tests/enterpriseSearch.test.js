import test from "node:test";
import assert from "node:assert/strict";
import SearchEngineService from "../services/SearchEngineService.js";
import SearchIndexModel from "../models/SearchIndexModel.js";
import SavedSearchModel from "../models/SavedSearchModel.js";
import SearchHistoryModel from "../models/SearchHistoryModel.js";

test("enterprise search exposes read-model and indexer operations", () => {
  for (const method of ["init", "globalSearch", "indexEntity", "removeEntity", "recordSearch", "getSuggestions", "saveSearch", "listSavedSearches", "deleteSavedSearch"]) {
    assert.equal(typeof SearchEngineService[method], "function", `${method} should exist`);
  }
});

test("enterprise search models are persistent and tenant scoped", () => {
  assert.equal(SearchIndexModel.modelName, "search_index");
  assert.equal(SavedSearchModel.modelName, "saved_search");
  assert.equal(SearchHistoryModel.modelName, "search_history");
  assert.ok(SearchIndexModel.schema.indexes().some(([keys]) => keys.tenantId === 1 && keys.entityType === 1 && keys.entityId === 1));
});
