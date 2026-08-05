import dotenv from 'dotenv';

dotenv.config();

const parseInteger = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJsonArray = (value, fallback) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const DEFAULT_ALLOWED_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
];

// "Supported Document Types ... All configurable." Was previously not
// modeled anywhere — documentType was a free-text string with no reference
// list at all.
const DEFAULT_SUPPORTED_DOCUMENT_TYPES = [
  "Passport", "CNIC", "National ID", "Photograph", "Visa Form", "Application Form",
  "Bank Statement", "Salary Slip", "Employment Letter", "Business Registration",
  "Invitation Letter", "Sponsor Letter", "Travel Insurance", "Vaccination Certificate",
  "Medical Report", "Hotel Reservation", "Flight Reservation", "Birth Certificate",
  "Marriage Certificate", "Police Clearance", "Educational Certificate", "Other"
];

export const getAllowedDocumentMimeTypes = () => parseJsonArray(process.env.DOCUMENT_ALLOWED_MIME_TYPES_JSON, DEFAULT_ALLOWED_DOCUMENT_MIME_TYPES);
export const getSupportedDocumentTypes = () => parseJsonArray(process.env.SUPPORTED_DOCUMENT_TYPES_JSON, DEFAULT_SUPPORTED_DOCUMENT_TYPES);

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
