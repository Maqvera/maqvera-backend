import dotenv from "dotenv";
import mongoose from "mongoose";
import RoleModel from "../models/Rolemodel.js";

dotenv.config();

// One-time migration for two pre-EXT "globally unique, should be per-tenant"
// schema bugs (Role.name and Branch.branchKey). Run manually once per
// environment after deploying the tenant-scoped Role/Branch change
// (models/Rolemodel.js, models/Branchmodel.js): `npm run migrate:tenant-scope`.
const migrate = async () => {
  const uri = process.env.URI;
  if (!uri) throw new Error("URI is required for migration.");
  await mongoose.connect(uri);

  const dropStaleGlobalUniqueIndex = async (collectionName, indexName) => {
    const collection = mongoose.connection.db.collection(collectionName);
    const existingIndexes = await collection.indexes();
    const staleIndex = existingIndexes.find((idx) => idx.name === indexName && idx.unique && Object.keys(idx.key).length === 1);
    if (staleIndex) {
      await collection.dropIndex(indexName);
      console.log(`Dropped stale global-unique index ${collectionName}.${indexName}.`);
    } else {
      console.log(`No stale global-unique index ${collectionName}.${indexName} found — nothing to drop.`);
    }
  };

  await dropStaleGlobalUniqueIndex("roles", "name_1");
  await dropStaleGlobalUniqueIndex("branches", "branchKey_1");

  // Any Role document with no tenantId predates tenant-scoped roles and is
  // schema-invalid under the new model (tenantId is required). These can
  // only be pre-EXT reference-role artifacts (e.g. a shared "Administrator"
  // role created before this migration) — they carry no real tenant
  // assignment to preserve, so they're removed rather than left as
  // permanently un-savable documents. New tenants get their own
  // tenant-scoped "Administrator" role via POST /auth/setup or the seed
  // script (utils/authDomainDefaults.js), so nothing is lost functionally.
  const orphaned = await RoleModel.find({ $or: [{ tenantId: { $exists: false } }, { tenantId: null }] }).lean();
  if (orphaned.length > 0) {
    console.log(`Removing ${orphaned.length} pre-migration role document(s) with no tenantId:`, orphaned.map((r) => r.name));
    await RoleModel.deleteMany({ $or: [{ tenantId: { $exists: false } }, { tenantId: null }] });
  } else {
    console.log("No orphaned (tenantId-less) role documents found.");
  }

  // Branch documents always carried tenantKey already (it was required from
  // the start), so there is no equivalent orphan cleanup needed for branches
  // — only the index was wrong.

  console.log("Tenant-scope uniqueness migration complete.");
  await mongoose.disconnect();
};

migrate().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
