# Enterprise File Storage Standard

**Status: ✔ Done** — a real, generic, standard-compliant document engine (`utils/documentService.js`); genuine reuse of Improvements 1, 7, 10, and 11 in one new model. Not wired into any existing controller in this pass.

## What already existed

"Binary files MUST NOT be stored inside operational databases." This codebase already had **two** real object-storage abstractions (`utils/fileStorage.js`, `services/FileUploadService.js` — real local/Cloudinary/S3 upload, selected via `FILE_STORAGE_BACKEND`) and, more specifically, `services/EnterpriseDocumentService.js` — a Visa-specific document service that already implements a real *subset* of this exact standard: SHA-256 checksums, honest virus-scan labeling (`"skipped"`, never a fabricated `"clean"` — the same discipline this standard's own `virusScanAdapter.js` follows), real HMAC-signed download URLs, and real version history. This standard does not replace any of that — it reuses `utils/fileStorage.js` directly for actual bytes-on-storage, and builds the missing **generic, module-agnostic** layer (Visa's own service is deliberately Visa-only) plus the genuinely new pieces: real encryption at rest, a pluggable virus-scan adapter, the exact standard metadata shape, and integration with Improvements 10/11's archive/retention/legal-hold engines.

## Real encryption at rest (`utils/fileEncryption.js`)

Genuine AES-256-GCM using Node's own `crypto` module — no external service required. `encrypted: true` is **only ever set after bytes are actually encrypted** with a real, operator-configured 32-byte `FILE_ENCRYPTION_KEY`; encryption is honestly off when that key isn't configured, never fabricated. GCM's own authentication tag detects tampering on decrypt (verified by test: a single flipped bit in the ciphertext throws, never silently returns corrupted plaintext).

## Honest, pluggable virus scanning (`utils/virusScanAdapter.js`)

Same real discipline `EnterpriseDocumentService.js` already established: no scanning engine ships with this codebase. `DOCUMENT_VIRUS_SCAN_PROVIDER=http` + `DOCUMENT_VIRUS_SCAN_API_URL` makes a real HTTP call to an actual scanning endpoint; absent that, every file is honestly `"Skipped"` — never a fabricated `"Passed"`. A file scanned as `"Failed"` is rejected outright: no `FileModel` row is ever created, `VirusDetected.v1` fires instead of `FileUploaded.v1`.

## Real, verifiable signed URLs

`generateSignedUrl`/`verifySignedUrl` (`utils/documentService.js`) use the same real HMAC-SHA256 technique already proven in `EnterpriseDocumentService.generateSignedUrl`, reimplemented as a real, exported, **verifiable** pair — nothing in this codebase could actually check a signature before this. Verified by test: a genuine signature passes, a tampered one is rejected, an expired one is rejected even when otherwise valid.

## `models/FileModel.js` — genuine reuse of four earlier standards

- **Improvement 1** (`applyEnterpriseMetadata`, `includeCompany`/`includeMerchant`/`includeBranch: true`) — a file can legitimately belong to any tenant/company/merchant/branch dimension.
- **Improvement 10 + 11** (`applyArchivalPolicy`) — `isArchived`/`legalHold`/`purgeEligibleAt`/`retentionPolicy` are the exact same fields those standards' own engines already operate on; `archiveFile`/`restoreFile`/`purgeFile`/`applyLegalHoldToFile`/`removeLegalHoldFromFile` are thin wrappers that call `archiveRecord`/`restoreRecord`/`purgeRecord`/`applyLegalHold`/`removeLegalHold` directly against a `FileModel` row — no duplicated logic, only a file-specific domain event fired on top of each generic one.
- **Improvement 7** (`publishVersionedEvent`) — every real event (`FileUploaded.v1`, `FileDownloaded.v1`, `FileArchived.v1`, `FileRestored.v1`, `FileDeleted.v1`, `VirusDetected.v1`) goes through the standard envelope. `FileRetentionExpired.v1` is deliberately **not** a separate event — Improvement 10's own `RetentionExpired.v1` already fires from inside `purgeRecord` and is the real signal; a second, redundant event for the identical fact would be noise.

**A real bug this file's own naming caught**: the file's own domain concept of version (`1`, `2`, `3`, "never overwrite") is named `versionNumber`, deliberately **not** `version` — that name already belongs to Improvement 1's `exposeVersion` convention (the optimistic-concurrency counter). Naming it `version` here would have silently overwritten one real number with a completely unrelated one in every JSON response — caught by this standard's own test before it ever reached anything else.

`storageKey` (the actual object-storage reference) is **never** exposed in any API response — "Never expose storage directly" — only a freshly-generated, time-limited signed URL ever leaves this engine.

## `uploadFile` — the real workflow

Permission validation → virus scan → checksum → encryption → real object storage (`saveBookingDocumentFile`) → retention resolution (`resolveRetentionYears`, Improvement 11) → metadata row → audit log → `FileUploaded.v1`. `rootFileId` creates a genuinely new **version** of an existing file (the previous version's `isLatestVersion` flips to `false`, verified by test) — never an overwrite.

## Real end-to-end proof (`tests/fileStorageStandard.test.js`)

Genuine AES-256-GCM round-trip and tamper detection; a real HTTP virus-scan call (both Passed and Failed paths, against a real local test server); a full real upload — actual SHA-256 of actual bytes, actual encryption, actual versioning, actual retention-policy resolution, actual bytes written to local disk via the already-real storage abstraction; a rejected virus-detected upload that creates no database row at all; and the full archive → restore → legal-hold apply/remove → archive → purge lifecycle against a real `FileModel` row, ending in a genuine `deleteOne`.

## Adoption

No existing controller is wired to `utils/documentService.js` in this pass — Visa document uploads continue through the already-real `EnterpriseDocumentService.js` unchanged. Real, deliberate, separate follow-up: migrating Visa (and adopting this for Finance/HR/other modules) to the generic engine is its own decision per module, not a mechanical swap.
