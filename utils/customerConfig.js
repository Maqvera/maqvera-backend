import dotenv from 'dotenv';

dotenv.config();

const parseBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
};

const parseNotificationPreferences = (value) => {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (error) {
      return { email: true, sms: true, whatsapp: true, push: false };
    }
  }

  if (value && typeof value === 'object') return value;

  return { email: true, sms: true, whatsapp: true, push: false };
};

const parseList = (value, fallback = []) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return fallback;
};

export const getCustomerConfig = () => ({
  customerCodePrefix: process.env.CUSTOMER_CODE_PREFIX || 'CUS',
  defaultCategory: process.env.DEFAULT_CUSTOMER_CATEGORY || 'regular',
  defaultStatus: process.env.DEFAULT_CUSTOMER_STATUS || 'active',
  defaultLanguage: process.env.DEFAULT_CUSTOMER_LANGUAGE || 'en',
  defaultCurrency: process.env.DEFAULT_CUSTOMER_CURRENCY || 'USD',
  defaultTimezone: process.env.DEFAULT_CUSTOMER_TIMEZONE || 'UTC',
  enableDuplicateDetection: parseBoolean(process.env.CUSTOMER_ENABLE_DUPLICATE_DETECTION, true),
  duplicateScoreThreshold: Number.parseInt(process.env.CUSTOMER_DUPLICATE_SCORE_THRESHOLD || '85', 10),
  defaultPageSize: Number.parseInt(process.env.CUSTOMER_DEFAULT_PAGE_SIZE || '20', 10),
  maxPageSize: Number.parseInt(process.env.CUSTOMER_MAX_PAGE_SIZE || '100', 10),
  enableVersioning: parseBoolean(process.env.CUSTOMER_ENABLE_VERSIONING, true),
  enableTimeline: parseBoolean(process.env.CUSTOMER_ENABLE_TIMELINE, true),
  defaultCommunicationChannel: process.env.DEFAULT_CUSTOMER_COMMUNICATION_CHANNEL || 'whatsapp',
  defaultDocumentStatus: process.env.DEFAULT_CUSTOMER_DOCUMENT_STATUS || 'pending_scan',
  defaultDocumentVisibility: process.env.DEFAULT_CUSTOMER_DOCUMENT_VISIBILITY || 'internal',
  defaultDocumentCategory: process.env.DEFAULT_CUSTOMER_DOCUMENT_CATEGORY || 'Identity',
  defaultNoteCategory: process.env.DEFAULT_CUSTOMER_NOTE_CATEGORY || 'General',
  defaultNoteVisibility: process.env.DEFAULT_CUSTOMER_NOTE_VISIBILITY || 'Internal',
  allowedNoteCategories: parseList(process.env.CUSTOMER_ALLOWED_NOTE_CATEGORIES, [
    'Customer Service', 'Sales', 'Finance', 'Visa', 'Travel', 'Medical', 'Operations', 'Support', 'General'
  ]),
  allowedNoteVisibilities: parseList(process.env.CUSTOMER_ALLOWED_NOTE_VISIBILITIES, ['Internal', 'Management', 'Branch', 'Private']),
  defaultMealPreference: process.env.DEFAULT_CUSTOMER_MEAL_PREFERENCE || 'halal',
  defaultSeatPreference: process.env.DEFAULT_CUSTOMER_SEAT_PREFERENCE || 'no_preference',
  defaultNotificationPreferences: parseNotificationPreferences(process.env.DEFAULT_CUSTOMER_NOTIFICATION_PREFERENCES),
  documentStorageBackend: process.env.DOCUMENT_STORAGE_BACKEND || process.env.FILE_STORAGE_BACKEND || 'local',
  defaultDocumentStorageProvider: process.env.DOCUMENT_STORAGE_PROVIDER || process.env.FILE_STORAGE_PROVIDER || 'Local',
  allowedFamilyRelationships: parseList(process.env.CUSTOMER_ALLOWED_FAMILY_RELATIONSHIPS, [
    'father', 'mother', 'husband', 'wife', 'spouse', 'son', 'daughter', 'brother', 'sister', 'guardian', 'mahram', 'friend', 'other'
  ]),
  allowedDocumentMimeTypes: parseList(process.env.CUSTOMER_ALLOWED_DOCUMENT_MIME_TYPES, [
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/tiff',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]),
  signedDocumentUrlTtlSeconds: Number.parseInt(process.env.CUSTOMER_DOCUMENT_SIGNED_URL_TTL_SECONDS || '900', 10)
});

export default getCustomerConfig;
