import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { v2 as cloudinary } from "cloudinary";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { retryWithBackoff } from "./retryWithBackoff.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultStorageRoot = path.resolve(__dirname, "../uploads/booking-documents");

const isCloudinaryConfigured = () => Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
const isS3Configured = () => Boolean(process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET);

export const getFileStorageConfig = () => ({
  provider: (process.env.BOOKING_DOCUMENT_STORAGE_PROVIDER || "local").toLowerCase(),
  localRoot: process.env.BOOKING_DOCUMENT_STORAGE_PATH || defaultStorageRoot,
  publicBaseUrl: process.env.BOOKING_DOCUMENT_PUBLIC_BASE_URL || "http://localhost:5000/uploads/booking-documents"
});

export const saveBookingDocumentFile = async ({ fileName, mimeType, buffer, extension }) => {
  const storageConfig = getFileStorageConfig();
  const safeName = (fileName || "document").replace(/[^a-zA-Z0-9._-]/g, "_");
  const ext = extension || path.extname(safeName) || ".bin";

  if (storageConfig.provider === "cloudinary") {
    if (!isCloudinaryConfigured()) {
      throw new Error("Cloudinary storage is selected but the required credentials are not configured.");
    }

    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true
    });

    const result = await retryWithBackoff(() => new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream({ resource_type: "auto", public_id: `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}` }, (error, result) => {
        if (error) return reject(error);
        resolve(result);
      });
      uploadStream.end(buffer);
    }), { label: "Cloudinary upload" });

    return {
      fileName: safeName,
      storedFileName: result.public_id,
      mimeType: mimeType || "application/octet-stream",
      size: buffer.length,
      storageProvider: storageConfig.provider,
      storedPath: result.secure_url,
      publicUrl: result.secure_url
    };
  }

  if (storageConfig.provider === "s3") {
    if (!isS3Configured()) {
      throw new Error("S3 storage is selected but the required credentials are not configured.");
    }

    const s3Client = new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });

    const objectKey = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
    await retryWithBackoff(() => s3Client.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: objectKey,
      Body: buffer,
      ContentType: mimeType || "application/octet-stream"
    })), { label: "S3 upload" });

    const publicBaseUrl = process.env.AWS_S3_PUBLIC_BASE_URL || `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;

    return {
      fileName: safeName,
      storedFileName: objectKey,
      mimeType: mimeType || "application/octet-stream",
      size: buffer.length,
      storageProvider: storageConfig.provider,
      storedPath: objectKey,
      publicUrl: `${publicBaseUrl.replace(/\/$/, "")}/${objectKey}`
    };
  }

  const storageDir = path.resolve(storageConfig.localRoot);
  await fs.mkdir(storageDir, { recursive: true });

  const uniqueName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const absolutePath = path.join(storageDir, uniqueName);
  await fs.writeFile(absolutePath, buffer);

  const publicUrl = `${storageConfig.publicBaseUrl.replace(/\/$/, "")}/${uniqueName}`;

  return {
    fileName: safeName,
    storedFileName: uniqueName,
    mimeType: mimeType || "application/octet-stream",
    size: buffer.length,
    storageProvider: storageConfig.provider,
    storedPath: absolutePath,
    publicUrl
  };
};

export const resolveBookingDocumentUrl = (inputUrl) => {
  if (!inputUrl) return null;
  if (/^https?:\/\//i.test(inputUrl)) return inputUrl;
  const storageConfig = getFileStorageConfig();
  return `${storageConfig.publicBaseUrl.replace(/\/$/, "")}/${inputUrl.replace(/^\//, "")}`;
};
