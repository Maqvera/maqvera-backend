import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { getStorageConfig } from "./storageConfig.js";
import { uploadToCloud } from "../services/FileUploadService.js";

// Bridges a generated-in-memory Buffer (pdfkit's output — not a
// multipart-upload landing on disk) into this codebase's existing storage
// abstraction. services/FileUploadService.js's uploadToCloud() already
// handles cloudinary/s3 for real, but expects a local file path (it's
// built for the multer-disk-storage upload flow); rather than
// reimplementing cloud upload logic here, this writes the buffer to a temp
// file first and reuses that function as-is. The "local" backend has no
// equivalent in FileUploadService (nothing there ever needed to serve a
// server-generated file directly), so that path is genuinely new here.
//
// Originally written for Receipts only (Part 8, as utils/receiptPdfStorage.js);
// generalized here with a `folder` param when Invoices (Part 9) needed the
// exact same bridge — one implementation for every server-generated PDF
// document type, not a copy per module.
export const storeDocumentPdf = async ({ tenantId, folder, filename, buffer }) => {
  const storageConfig = getStorageConfig();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeFolder = folder.replace(/[^a-zA-Z0-9._-]/g, "_");

  if (storageConfig.backend === "local") {
    const dir = path.join(process.cwd(), storageConfig.localUploadDir, safeFolder, tenantId);
    await fsp.mkdir(dir, { recursive: true });
    const fullPath = path.join(dir, safeName);
    await fsp.writeFile(fullPath, buffer);

    const baseUrl = storageConfig.storageBaseUrl || `http://localhost:${process.env.PORT || "7000"}`;
    return {
      url: `${baseUrl}/uploads/${safeFolder}/${tenantId}/${safeName}`,
      storageKey: fullPath,
      storageProvider: "local"
    };
  }

  // cloudinary / s3 — write to a real temp file, then delegate to the
  // existing, already-real cloud upload function.
  const tempPath = path.join(os.tmpdir(), `${crypto.randomBytes(8).toString("hex")}-${safeName}`);
  await fsp.writeFile(tempPath, buffer);
  try {
    const result = await uploadToCloud(tempPath);
    return {
      url: result.url,
      storageKey: result.publicId || result.key || null,
      storageProvider: storageConfig.backend
    };
  } finally {
    if (fs.existsSync(tempPath)) await fsp.unlink(tempPath).catch(() => {});
  }
};

export default storeDocumentPdf;
