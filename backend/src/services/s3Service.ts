import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

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
const TYPE_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  txt: 'text/plain', csv: 'text/csv', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * What a file actually is. Every upload used to be stored as
 * application/pdf whatever it was, so a tenant's ID photo opened as a PDF
 * viewer saying "Failed to load PDF document". The bytes say what the file
 * is; the name is the fallback.
 */
export function detectContentType(buffer: Buffer, filename?: string | null): string {
  const h = buffer.subarray(0, 12);
  if (h.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image/jpeg';
  if (h[0] === 0x89 && h.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (h.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (h.subarray(4, 8).toString('latin1') === 'ftyp') return 'image/heic';
  const ext = (filename ?? '').split('.').pop()?.toLowerCase() ?? '';
  return TYPE_BY_EXT[ext] ?? 'application/octet-stream';
}

function contentTypeForKey(key: string): string | undefined {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return TYPE_BY_EXT[ext];
}

export async function uploadDocument(
  key: string,
  buffer: Buffer,
  contentType?: string
): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType ?? detectContentType(buffer, key),
    ServerSideEncryption: 'AES256',
  }));
  return key;
}

/**
 * Generate a signed URL for temporary document access (1 hour).
 */
export async function getSignedDocumentUrl(key: string, expiresIn = 3600): Promise<string> {
  // Override the stored type from the key's extension: objects uploaded
  // before types were detected are all labelled PDF, and the browser trusts
  // the label. Shown inline either way, so a photo opens as a photo.
  const type = contentTypeForKey(key);
  const command = new GetObjectCommand({
    Bucket: BUCKET, Key: key,
    ...(type ? { ResponseContentType: type } : {}),
    ResponseContentDisposition: 'inline',
  });
  return getSignedUrl(s3, command, { expiresIn });
}

/**
 * Download an S3 object and return its contents as a Buffer.
 */
export async function downloadDocument(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const stream = res.Body as Readable;
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
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
