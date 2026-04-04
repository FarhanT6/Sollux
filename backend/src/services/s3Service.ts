import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET || 'sollux-documents';

/**
 * Upload a PDF buffer to S3.
 * Key format: userId/propertyId/utilityAccountId/YYYY-MM/filename.pdf
 */
export async function uploadDocument(
  key: string,
  buffer: Buffer,
  contentType = 'application/pdf'
): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ServerSideEncryption: 'AES256',
  }));
  return key;
}

/**
 * Generate a signed URL for temporary document access (1 hour).
 */
export async function getSignedDocumentUrl(key: string, expiresIn = 3600): Promise<string> {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn });
}

/**
 * Build an S3 key for a statement PDF.
 */
export function buildStatementKey(
  userId: string,
  propertyId: string,
  utilityAccountId: string,
  statementDate: Date,
  filename: string
): string {
  const year = statementDate.getFullYear();
  const month = String(statementDate.getMonth() + 1).padStart(2, '0');
  return `${userId}/${propertyId}/${utilityAccountId}/${year}-${month}/${filename}`;
}
