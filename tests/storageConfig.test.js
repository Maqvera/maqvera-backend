import test from 'node:test';
import assert from 'node:assert/strict';
import { getStorageConfig } from '../utils/storageConfig.js';

test('getStorageConfig reads document storage settings from environment variables', () => {
  process.env.FILE_STORAGE_BACKEND = 'cloudinary';
  process.env.LOCAL_UPLOAD_DIR = 'tmp-uploads';
  process.env.DOCUMENT_MAX_SIZE_BYTES = '10485760';
  process.env.DOCUMENT_STORAGE_BASE_URL = 'https://cdn.example.com';
  process.env.DOCUMENT_SIGNING_SECRET = 'top-secret';
  process.env.CLOUDINARY_FOLDER = 'enterprise-docs';
  process.env.CLOUDINARY_CLOUD_NAME = 'demo-cloud';
  process.env.CLOUDINARY_API_KEY = 'demo-key';
  process.env.CLOUDINARY_API_SECRET = 'demo-secret';

  const config = getStorageConfig();

  assert.equal(config.backend, 'cloudinary');
  assert.equal(config.localUploadDir, 'tmp-uploads');
  assert.equal(config.maxFileSizeBytes, 10485760);
  assert.equal(config.storageBaseUrl, 'https://cdn.example.com');
  assert.equal(config.signedUrlSecret, 'top-secret');
  assert.equal(config.cloudinaryFolder, 'enterprise-docs');
});
