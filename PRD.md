# PRD — Orphaned MongoDB Collection Cleanup

**Status:** DRAFT — awaiting manual approval. **No collection has been deleted, dropped, or modified as part of this analysis.** Everything below is read-only findings (code scan + live `listCollections`/`collStats`/`countDocuments` reads against the configured Atlas cluster).

**Trigger:** The dev/test Atlas cluster is at `cannot create a new collection -- already using 500 collections of 500` (hit during a prior test run — `notification_logs` failed to be created for this reason). This PRD identifies why, and what is safe to remove.

---

## 1. Method

1. **Code-side inventory** — dynamically imported all 242 files in `models/*.js` and read each registered Mongoose model's real `.collection.name` (the actual computed collection name, not a guessed pluralization) → 242 unique expected collection names, zero import errors.
2. **Static usage scan** — cross-referenced every model file against `controllers/`, `services/`, `routes/`, `middleware/`, `utils/`, `domain/`, `scripts/`, `config/`, `server.js` for static imports, dynamic `import()`, and cross-model `ref:` (populate) references. **Result: all 242 models are actively referenced in production code — zero unused model files.** (This scan alone found no candidates — see §2 for why the real problem is elsewhere.)
3. **Live DB diff** — connected read-only to the configured Atlas cluster (`URI` from `.env`), listed all actual collections (`db.listCollections()`), and diffed against the 242 expected names from step 1.
4. **Evidence gathering** — for every orphaned collection: `countDocuments({})`, `db.command({collStats: name})` (storage size), and for non-empty ones, first/last document approximate timestamps (decoded from the MongoDB ObjectId `_id`, which embeds a creation time).

## 2. Findings summary

| | Count |
|---|---|
| Model files in `models/` | 242 |
| Expected collections (from code) | 242 |
| **Live collections in Atlas** | **500 (at cap)** |
| **Orphaned collections (in DB, no model registers them)** | **260** |
| — matching test-scratch naming pattern | 258 |
| — unexplained / needs manual review | 2 (`branches`, `__mixed_update_tests`) |
| Models with no live collection yet (informational only, NOT a cleanup item — e.g. `notification_logs`, `package_templates` are real, current models that just haven't been written to) | 2 |

**Root cause (258 of 260 candidates):** Four test files each spin up a *brand-new, uniquely-named Mongoose model* per test run — `` `${domain}_scratch_${Date.now()}` `` — instead of reusing one fixed scratch collection. Their `t.after()` cleanup only runs `ScratchModel.deleteMany({})`, which empties the collection's documents but **never calls `dropCollection()`**, so the empty collection shell (plus its indexes) is left behind permanently after every single test run:

| Prefix | Collections found | Source (creates it) |
|---|---|---|
| `retention_scratch_*` | 28 | `tests/dataRetentionStandard.test.js:78` |
| `legalhold_scratch_*` | 28 | `tests/dataRetentionStandard.test.js:111` |
| `purgereq_scratch_*` | 28 | `tests/dataRetentionStandard.test.js:172` |
| `archival_scratch_*` | 32 | `tests/archivalStandard.test.js:47` |
| `archival_period_scratch_*` | 31 | `tests/archivalStandard.test.js:105` |
| `archival_purge_scratch_*` | 31 | `tests/archivalStandard.test.js:146` |
| `optimistic_locking_scratch_*` | 39 | `tests/optimisticLockingStandard.test.js:77` |
| `enterprise_metadata_scratch_*` | 41 | `tests/enterpriseMetadataStandard.test.js:107` |
| **Total** | **258** | 4 files |

All 258 confirmed **0 documents** (deleteMany worked as intended — only the shell + indexes are left), embedded creation timestamps range **2026-08-15 → 2026-08-21** (6 days of repeated `node --test` runs), consuming ~6.72 MB storage and roughly half of the 500-collection quota by count alone.

---

## 3. Candidate list

### 3a. Test-scratch collections — 258 collections, 8 groups (LOW risk)

| Candidate group | Collections | Last usage evidence | Risk |
|---|---|---|---|
| `retention_scratch_*` | 28 (full names in Appendix A) | Created by `tests/dataRetentionStandard.test.js:78`, one per test run; **0 documents in every instance** (test's own `deleteMany` already ran); no model file, no controller/service, no `ref:` anywhere registers this name — collections are dead the moment the test that created them finishes. | **Low** |
| `legalhold_scratch_*` | 28 | Same file, line 111. 0 documents in every instance. | **Low** |
| `purgereq_scratch_*` | 28 | Same file, line 172. 0 documents in every instance. | **Low** |
| `archival_scratch_*` | 32 | `tests/archivalStandard.test.js:47`. 0 documents in every instance. | **Low** |
| `archival_period_scratch_*` | 31 | `tests/archivalStandard.test.js:105`. 0 documents in every instance. | **Low** |
| `archival_purge_scratch_*` | 31 | `tests/archivalStandard.test.js:146`. 0 documents in every instance. | **Low** |
| `optimistic_locking_scratch_*` | 39 | `tests/optimisticLockingStandard.test.js:77`. 0 documents in every instance. | **Low** |
| `enterprise_metadata_scratch_*` | 41 | `tests/enterpriseMetadataStandard.test.js:107`. 0 documents in every instance. | **Low** |

Low risk because: (a) every single one is confirmed empty right now, (b) the exact test line that manufactures the name is identified and still does so on every future run — meaning even after cleanup, these are inherently disposable by design (the test never intended them to persist), and (c) nothing anywhere in the codebase references these dynamic names (they can't — the name only exists at test runtime).

### 3b. Individually-reviewed orphans (2 collections)

| Candidate | Last usage evidence | Risk | Notes |
|---|---|---|---|
| `__mixed_update_tests` | **No usage found** — zero matches anywhere in the current codebase (source or tests) for this literal string. 0 documents, 24,576 bytes storage (empty shell + indexes only). No corresponding model was ever found in `models/`. | **Low** | Reads as a leftover from a test that has since been renamed/removed. Nothing currently creates, reads, or could recreate it. |
| `branches` | **No usage found in current code.** `models/BranchModel.js` exists but registers collection `org_branch` → live collection `org_branches` (currently 0 docs itself) — i.e., the *active* branches collection today is `org_branches`, not `branches`. The bare `branches` collection holds **1 real document**, with an ObjectId-derived timestamp of **2026-07-28T14:00:41Z** (its only write). | **Medium** | Not test-scratch-shaped (no timestamp suffix, no matching test source) — most likely a pre-rename artifact from before the collection was renamed to `org_branch`, but this is **not confirmed** without reading the one document's content. Do **not** treat as low-risk without §4 review — this is the one candidate that could theoretically hold real data. |

### Appendix A — full list of the 258 test-scratch collection names

Grouped by prefix, exact names as returned by `listCollections()` at scan time — every single one, not a sample. (More may exist by the time §4 is executed if tests ran again since this report — re-run `db.listCollections()` fresh before deleting, per §4 step 1.)

<details>
<summary>Click to expand all 258 names</summary>

### archival_scratch_* (32 collections)

```
archival_scratch_1786837787074
archival_scratch_1786837822701
archival_scratch_1786837886573
archival_scratch_1786838099386
archival_scratch_1786838226151
archival_scratch_1786839222654
archival_scratch_1786840029032
archival_scratch_1786840696232
archival_scratch_1786841369371
archival_scratch_1786882147995
archival_scratch_1786883066056
archival_scratch_1786883841530
archival_scratch_1786885808137
archival_scratch_1786886992406
archival_scratch_1786887667502
archival_scratch_1786888557743
archival_scratch_1786889577793
archival_scratch_1786953272035
archival_scratch_1786954272757
archival_scratch_1786956133302
archival_scratch_1786956557445
archival_scratch_1786964892479
archival_scratch_1786992462294
archival_scratch_1786998247064
archival_scratch_1787038200809
archival_scratch_1787043068185
archival_scratch_1787043168484
archival_scratch_1787128594379
archival_scratch_1787341069247
archival_scratch_1787341998977
archival_scratch_1787343960046
archival_scratch_1787349804348
```

### legalhold_scratch_* (28 collections)

```
legalhold_scratch_1786838174621
legalhold_scratch_1786838283019
legalhold_scratch_1786839283869
legalhold_scratch_1786840085568
legalhold_scratch_1786840755762
legalhold_scratch_1786841429185
legalhold_scratch_1786882214359
legalhold_scratch_1786883127036
legalhold_scratch_1786883899397
legalhold_scratch_1786885877643
legalhold_scratch_1786887055970
legalhold_scratch_1786887720781
legalhold_scratch_1786888623952
legalhold_scratch_1786889631725
legalhold_scratch_1786953337642
legalhold_scratch_1786954348063
legalhold_scratch_1786956262836
legalhold_scratch_1786956695999
legalhold_scratch_1786964967818
legalhold_scratch_1786992537910
legalhold_scratch_1786998337175
legalhold_scratch_1787038273964
legalhold_scratch_1787043175227
legalhold_scratch_1787043320747
legalhold_scratch_1787128752543
legalhold_scratch_1787341214087
legalhold_scratch_1787342174354
legalhold_scratch_1787344117995
```

### enterprise_metadata_scratch_* (41 collections)

```
enterprise_metadata_scratch_1786820321636
enterprise_metadata_scratch_1786820364306
enterprise_metadata_scratch_1786820456452
enterprise_metadata_scratch_1786821355584
enterprise_metadata_scratch_1786821954848
enterprise_metadata_scratch_1786834959501
enterprise_metadata_scratch_1786835350756
enterprise_metadata_scratch_1786835597854
enterprise_metadata_scratch_1786836115910
enterprise_metadata_scratch_1786836615436
enterprise_metadata_scratch_1786836973048
enterprise_metadata_scratch_1786837313578
enterprise_metadata_scratch_1786837567726
enterprise_metadata_scratch_1786837950502
enterprise_metadata_scratch_1786838287460
enterprise_metadata_scratch_1786839288229
enterprise_metadata_scratch_1786840091998
enterprise_metadata_scratch_1786840761950
enterprise_metadata_scratch_1786841435473
enterprise_metadata_scratch_1786882227911
enterprise_metadata_scratch_1786883135835
enterprise_metadata_scratch_1786883906604
enterprise_metadata_scratch_1786885890549
enterprise_metadata_scratch_1786887067560
enterprise_metadata_scratch_1786887728803
enterprise_metadata_scratch_1786888633131
enterprise_metadata_scratch_1786889640541
enterprise_metadata_scratch_1786953349258
enterprise_metadata_scratch_1786954355339
enterprise_metadata_scratch_1786956262824
enterprise_metadata_scratch_1786956688651
enterprise_metadata_scratch_1786964969382
enterprise_metadata_scratch_1786992549297
enterprise_metadata_scratch_1786998362678
enterprise_metadata_scratch_1787038285205
enterprise_metadata_scratch_1787043192768
enterprise_metadata_scratch_1787043336680
enterprise_metadata_scratch_1787128771686
enterprise_metadata_scratch_1787341227879
enterprise_metadata_scratch_1787342190892
enterprise_metadata_scratch_1787344133013
```

### retention_scratch_* (28 collections)

```
retention_scratch_1786838173486
retention_scratch_1786838281883
retention_scratch_1786839282502
retention_scratch_1786840084506
retention_scratch_1786840754644
retention_scratch_1786841428154
retention_scratch_1786882213262
retention_scratch_1786883126042
retention_scratch_1786883898277
retention_scratch_1786885876628
retention_scratch_1786887054958
retention_scratch_1786887719588
retention_scratch_1786888622816
retention_scratch_1786889630742
retention_scratch_1786953336412
retention_scratch_1786954346859
retention_scratch_1786956261338
retention_scratch_1786956689081
retention_scratch_1786964966434
retention_scratch_1786992536897
retention_scratch_1786998336147
retention_scratch_1787038272917
retention_scratch_1787043173425
retention_scratch_1787043319423
retention_scratch_1787128749679
retention_scratch_1787341213114
retention_scratch_1787342173351
retention_scratch_1787344117003
```

### optimistic_locking_scratch_* (39 collections)

```
optimistic_locking_scratch_1786821074441
optimistic_locking_scratch_1786821380018
optimistic_locking_scratch_1786821974199
optimistic_locking_scratch_1786834797906
optimistic_locking_scratch_1786835002871
optimistic_locking_scratch_1786835376008
optimistic_locking_scratch_1786835627474
optimistic_locking_scratch_1786836154397
optimistic_locking_scratch_1786836690506
optimistic_locking_scratch_1786837014271
optimistic_locking_scratch_1786837335729
optimistic_locking_scratch_1786837595067
optimistic_locking_scratch_1786837975114
optimistic_locking_scratch_1786838311546
optimistic_locking_scratch_1786839316344
optimistic_locking_scratch_1786840117952
optimistic_locking_scratch_1786840790931
optimistic_locking_scratch_1786882265947
optimistic_locking_scratch_1786883163718
optimistic_locking_scratch_1786883936820
optimistic_locking_scratch_1786885938726
optimistic_locking_scratch_1786887105911
optimistic_locking_scratch_1786887768703
optimistic_locking_scratch_1786888674993
optimistic_locking_scratch_1786889681154
optimistic_locking_scratch_1786953394214
optimistic_locking_scratch_1786954406810
optimistic_locking_scratch_1786956306760
optimistic_locking_scratch_1786956728282
optimistic_locking_scratch_1786965001444
optimistic_locking_scratch_1786992594198
optimistic_locking_scratch_1786998435704
optimistic_locking_scratch_1787038326326
optimistic_locking_scratch_1787043256831
optimistic_locking_scratch_1787043414756
optimistic_locking_scratch_1787128869706
optimistic_locking_scratch_1787341365335
optimistic_locking_scratch_1787342329779
optimistic_locking_scratch_1787344261780
```

### archival_period_scratch_* (31 collections)

```
archival_period_scratch_1786837789920
archival_period_scratch_1786837824880
archival_period_scratch_1786837889551
archival_period_scratch_1786838102486
archival_period_scratch_1786838229453
archival_period_scratch_1786839225500
archival_period_scratch_1786840031702
archival_period_scratch_1786840698885
archival_period_scratch_1786841372130
archival_period_scratch_1786882151187
archival_period_scratch_1786883068951
archival_period_scratch_1786883845114
archival_period_scratch_1786885811521
archival_period_scratch_1786886995459
archival_period_scratch_1786887670362
archival_period_scratch_1786888560122
archival_period_scratch_1786889581139
archival_period_scratch_1786953275154
archival_period_scratch_1786954276251
archival_period_scratch_1786956144295
archival_period_scratch_1786956560976
archival_period_scratch_1786964897790
archival_period_scratch_1786992465691
archival_period_scratch_1786998249410
archival_period_scratch_1787038204380
archival_period_scratch_1787043071407
archival_period_scratch_1787043174509
archival_period_scratch_1787128598040
archival_period_scratch_1787341072598
archival_period_scratch_1787342002308
archival_period_scratch_1787343962331
```

### purgereq_scratch_* (28 collections)

```
purgereq_scratch_1786838177881
purgereq_scratch_1786838286228
purgereq_scratch_1786839287126
purgereq_scratch_1786840088763
purgereq_scratch_1786840758845
purgereq_scratch_1786841432217
purgereq_scratch_1786882217308
purgereq_scratch_1786883129819
purgereq_scratch_1786883902350
purgereq_scratch_1786885880541
purgereq_scratch_1786887059069
purgereq_scratch_1786887723885
purgereq_scratch_1786888627368
purgereq_scratch_1786889634531
purgereq_scratch_1786953341395
purgereq_scratch_1786954351782
purgereq_scratch_1786956266102
purgereq_scratch_1786956704863
purgereq_scratch_1786964971716
purgereq_scratch_1786992541023
purgereq_scratch_1786998340277
purgereq_scratch_1787038277223
purgereq_scratch_1787043179528
purgereq_scratch_1787043325790
purgereq_scratch_1787128757153
purgereq_scratch_1787341217132
purgereq_scratch_1787342177193
purgereq_scratch_1787344120866
```

### archival_purge_scratch_* (31 collections)

```
archival_purge_scratch_1786837790547
archival_purge_scratch_1786837825970
archival_purge_scratch_1786837890658
archival_purge_scratch_1786838103460
archival_purge_scratch_1786838230459
archival_purge_scratch_1786839226996
archival_purge_scratch_1786840033298
archival_purge_scratch_1786840700082
archival_purge_scratch_1786841373060
archival_purge_scratch_1786882152145
archival_purge_scratch_1786883069897
archival_purge_scratch_1786883846842
archival_purge_scratch_1786885812675
archival_purge_scratch_1786886996460
archival_purge_scratch_1786887671498
archival_purge_scratch_1786888561060
archival_purge_scratch_1786889582070
archival_purge_scratch_1786953276263
archival_purge_scratch_1786954277197
archival_purge_scratch_1786956146083
archival_purge_scratch_1786956562240
archival_purge_scratch_1786964898919
archival_purge_scratch_1786992466632
archival_purge_scratch_1786998250582
archival_purge_scratch_1787038205369
archival_purge_scratch_1787043072701
archival_purge_scratch_1787043176133
archival_purge_scratch_1787128599329
archival_purge_scratch_1787341073547
archival_purge_scratch_1787342003231
archival_purge_scratch_1787343963322
```

</details>

---

## 4. Verification steps before deleting ANYTHING (mandatory, in order)

Do all of these **again, fresh** at delete time — this report is a point-in-time snapshot and more scratch collections may exist by then if tests ran again.

1. **Re-list live collections** — `db.listCollections().toArray()` (or `mongosh`: `db.getCollectionNames()`) — confirm the candidate still exists and re-derive the current full list (test runs since this report may have added more `*_scratch_*` collections — same prefixes, same pattern, same treatment).
2. **Per-candidate `db.<name>.stats()`** in Atlas (or `db.collection.stats()` via a script) — reconfirm `count: 0` for every §3a collection immediately before dropping it. If any of them now shows `count > 0`, **stop and investigate** — it means something in the current codebase started writing to that exact dynamic name, which would be a new, unexpected finding this report did not account for.
3. **Last-write timestamp** — for §3a, the collection's own emptiness makes this moot (nothing to have a "last write" on but the now-deleted test rows). For **`branches`**, pull the 1 document and inspect: is it a real seeded org record, a leftover manual-test insert, or truly disposable? The July 28 ObjectId timestamp is a good anchor to cross-reference against `git log` around that date and against whichever developer/session was working on the branch/organisation feature then.
4. **`__mixed_update_tests`** — confirm again (grep) that no branch/PR in flight has re-added a reference to this name before dropping.
5. **Take a backup first, unconditionally** — even though §3a is verified-empty, back up before dropping in case a step-1 re-check surfaces surprise data:
   - Atlas UI: **Cluster → Backup → On-Demand Snapshot** (covers the whole cluster, cheapest safety net if the cluster is on a tier that supports it), OR
   - `mongodump --uri="<URI>" --db=<dbName> --collection=<name> --out=./backup-<name>-<date>` per collection being dropped (works on every tier, including M0).
   - For `branches` specifically: **also** export its single document individually — `mongoexport --uri="<URI>" --collection=branches --out=branches-backup-<date>.json` — small enough to keep indefinitely regardless of which backup route is used for the rest.
6. **Confirm nothing else on the cluster is mid-migration or mid-deploy** that could be actively writing into a `*_scratch_*`-shaped name for a legitimate reason right now (check for any running deploy/CI job before dropping).
7. Only after 1–6 pass: drop via `db.<name>.drop()` (or `mongosh`/Compass), one collection at a time for `branches` and `__mixed_update_tests`; §3a can be scripted as a batch (`db.listCollections().toArray()` filtered by the 8 known prefixes, then `.drop()` each) since they're homogeneous and independently verified in step 2.

## 5. Rollback plan

- **Before any drop:** the backups from §4.5 are the rollback path. `mongorestore` (for `mongodump` backups) or the Atlas on-demand snapshot's point-in-time/full-cluster restore (for the Atlas-UI route) bring a dropped collection back exactly as it was at backup time.
- **§3a (258 test-scratch collections):** rollback risk is effectively zero — they were confirmed empty at drop time, so "restoring" one only brings back an empty shell with no data loss exposure. No urgency to actually keep these backups long; a short retention (e.g. 7 days) is enough.
- **`__mixed_update_tests`:** same — confirmed empty, same low-urgency backup retention.
- **`branches`:** keep the individual `mongoexport` backup **indefinitely** (or per your org's data-retention policy) since this is the one candidate with real data and an unconfirmed origin. If it turns out post-drop that this document was needed, restore via `mongoimport --uri="<URI>" --collection=branches --file=branches-backup-<date>.json`, or manually re-insert into `org_branches` (the currently-active collection) if investigation concludes that's where it actually belongs.
- **If a drop turns out to be wrong for any other reason:** every step above is additive-safe until step 7 — nothing before the actual `.drop()` call touches live data, so the only irreversible action in this entire plan is step 7 itself, which is exactly why it's gated last and behind a fresh backup.

## 6. Recommended follow-up (not applied — separate approval, separate change)

The 258 test-scratch collections **will reaccumulate** on every future run of `tests/dataRetentionStandard.test.js`, `tests/archivalStandard.test.js`, `tests/optimisticLockingStandard.test.js`, and `tests/enterpriseMetadataStandard.test.js` unless their cleanup is fixed — deleting today's 258 only buys time before the 500-cap is hit again. The minimal fix, once you're ready to approve a separate code change: add `await ScratchModel.collection.drop().catch(() => {})` (or `mongoose.connection.deleteModel(...)` + `dropCollection`) alongside the existing `deleteMany({})` in each `t.after()` block in those 4 files — or switch them to one fixed, reused scratch collection name instead of a fresh `Date.now()`-suffixed one per run. Flagging this here per this PRD's own scope (analysis + plan only); not implementing it without your separate go-ahead.

---

**Approval gate:** No `db.collection.drop()` (or equivalent) will be run against any collection named in §3 until you explicitly approve this PRD.
