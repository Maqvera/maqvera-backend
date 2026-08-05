import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import { getStorageConfig, getAllowedDocumentMimeTypes } from "../utils/storageConfig.js";
import logger from "../utils/logger.js";
dotenv.config();

const storageConfig = getStorageConfig();
const storageBackend = storageConfig.backend;
const localUploadDir = storageConfig.localUploadDir;

// Was a separately hardcoded literal, independent of (and previously
// slightly re-typed from) EnterpriseDocumentService's own copy — a single
// mismatch between the two would let multer accept a file the document
// service then rejects, or vice versa. Both now read the same env-driven list.
const ALLOWED_MIME_TYPES = getAllowedDocumentMimeTypes();

const MAX_FILE_SIZE = storageConfig.maxFileSizeBytes;

let cloudinaryUploader = null;
let s3Client = null;
let storage = null;

if (storageBackend === "cloudinary") {
  try {
    const cloudinary = (await import("cloudinary")).v2;
    const { CloudinaryStorage } = await import("multer-storage-cloudinary");

    cloudinary.config({
      cloud_name: storageConfig.cloudinaryCloudName,
      api_key: storageConfig.cloudinaryApiKey,
      api_secret: storageConfig.cloudinaryApiSecret,
    });

    cloudinaryUploader = cloudinary.uploader;

    storage = new CloudinaryStorage({
      cloudinary,
      params: {
        folder: storageConfig.cloudinaryFolder,
        allowed_formats: ["jpg", "jpeg", "png", "webp", "heic", "tiff", "pdf"],
        public_id: (_req, file) => `${uuidv4()}-${Date.now()}`,
      },
    });
  } catch (err) {
    logger.error("Failed to initialize Cloudinary, falling back to local storage:", { error: err.message });
    storage = null;
  }
} else if (storageBackend === "s3") {
  try {
    const { S3Client } = await import("@aws-sdk/client-s3");
    const multerS3 = (await import("multer-s3")).default;

    const clientParams = {
      region: storageConfig.s3Region,
      credentials: {
        accessKeyId: storageConfig.s3AccessKeyId,
        secretAccessKey: storageConfig.s3SecretAccessKey,
      },
    };
    if (storageConfig.s3Endpoint) {
      clientParams.endpoint = storageConfig.s3Endpoint;
      clientParams.forcePathStyle = true;
    }

    s3Client = new S3Client(clientParams);

    storage = multerS3({
      s3: s3Client,
      bucket: storageConfig.s3Bucket,
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (_req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${storageConfig.s3Folder}/${uuidv4()}-${Date.now()}${ext}`);
      },
    });
  } catch (err) {
    logger.error("Failed to initialize S3, falling back to local storage:", { error: err.message });
    storage = null;
  }
}

if (!storage) {
  if (!fs.existsSync(localUploadDir)) {
    fs.mkdirSync(localUploadDir, { recursive: true });
  }

  storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, localUploadDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${uuidv4()}-${Date.now()}${ext}`);
    },
  });
}

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} is not allowed. Allowed: PDF, JPEG, PNG, WebP, HEIC, TIFF, DOCX`), false);
  }
};

export const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
});

export const uploadToCloud = async (localFilePath) => {
  if (storageBackend === "cloudinary" && cloudinaryUploader) {
    const result = await cloudinaryUploader.upload(localFilePath, {
      folder: storageConfig.cloudinaryFolder,
      resource_type: "auto",
    });
    if (localFilePath && fs.existsSync(localFilePath) && localFilePath.startsWith(localUploadDir)) {
      fs.unlinkSync(localFilePath);
    }
    return { url: result.secure_url, publicId: result.public_id, bytes: result.bytes };
  }

  if (storageBackend === "s3" && s3Client) {
    const { PutObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const fileContent = fs.readFileSync(localFilePath);
    const key = `${storageConfig.s3Folder}/${uuidv4()}-${Date.now()}${path.extname(localFilePath)}`;
    const bucketParams = {
      Bucket: storageConfig.s3Bucket,
      Key: key,
      Body: fileContent,
    };
    const command = new PutObjectCommand(bucketParams);
    const result = await s3Client.send(command);

    if (localFilePath && fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
    }

    const url = storageConfig.storageBaseUrl
      ? `${storageConfig.storageBaseUrl}/${key}`
      : `https://${storageConfig.s3Bucket}.s3.${storageConfig.s3Region}.amazonaws.com/${key}`;
    return { url, key: key, bytes: fileContent.length, etag: result.ETag };
  }

  throw new Error("No cloud storage backend is configured");
};

export const deleteFromCloud = async (identifier) => {
  if (storageBackend === "cloudinary" && cloudinaryUploader) {
    return cloudinaryUploader.destroy(identifier);
  }

  if (storageBackend === "s3" && s3Client) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const command = new DeleteObjectCommand({
      Bucket: storageConfig.s3Bucket,
      Key: identifier,
    });
    return s3Client.send(command);
  }

  throw new Error("No cloud storage backend is configured");
};

export default upload;
