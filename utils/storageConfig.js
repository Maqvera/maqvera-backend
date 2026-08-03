import dotenv from 'dotenv';

dotenv.config();

const parseInteger = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getStorageConfig = () => ({
  backend: process.env.FILE_STORAGE_BACKEND || 'local',
  localUploadDir: process.env.LOCAL_UPLOAD_DIR || 'uploads',
  maxFileSizeBytes: parseInteger(process.env.DOCUMENT_MAX_SIZE_BYTES, 25 * 1024 * 1024),
  // A URL must be explicitly configured for externally reachable files. Never
  // manufacture a provider URL: it would point users to a non-existent bucket.
  storageBaseUrl: process.env.DOCUMENT_STORAGE_BASE_URL || process.env.FILE_STORAGE_BASE_URL || '',
  signedUrlSecret: process.env.DOCUMENT_SIGNING_SECRET || '',
  cloudinaryFolder: process.env.CLOUDINARY_FOLDER || 'maqvera-documents',
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
  s3Bucket: process.env.S3_BUCKET || '',
  s3Region: process.env.S3_REGION || 'us-east-1',
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  s3Endpoint: process.env.S3_ENDPOINT || '',
  s3Folder: process.env.S3_FOLDER || 'maqvera-documents',
});
