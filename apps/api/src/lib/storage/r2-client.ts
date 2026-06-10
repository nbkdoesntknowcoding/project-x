import { S3Client } from '@aws-sdk/client-s3';
import { config } from '../../config/env.js';

export function isR2Configured(): boolean {
  return !!(
    config.R2_ACCOUNT_ID &&
    config.R2_ACCESS_KEY_ID &&
    config.R2_SECRET_ACCESS_KEY &&
    config.R2_BUCKET_NAME &&
    config.R2_PUBLIC_URL
  );
}

// Cloudflare R2 is S3-compatible. The endpoint is the account-specific R2 URL.
// Lazily initialised — routes must call isR2Configured() and return 503 if false.
export function getR2Client(): S3Client {
  if (!isR2Configured()) throw new Error('R2 is not configured');
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.R2_ACCOUNT_ID!}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     config.R2_ACCESS_KEY_ID!,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
    },
  });
}

let _r2: S3Client | null = null;
export function r2(): S3Client {
  if (!_r2) _r2 = getR2Client();
  return _r2;
}

export const R2_BUCKET      = () => config.R2_BUCKET_NAME!;
export const R2_PUBLIC_URL  = () => (config.R2_PUBLIC_URL ?? '').replace(/\/$/, '');
