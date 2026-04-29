const {
  S3Client,
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

/**
 * Returns a configured S3Client instance using environment variables.
 * Throws a descriptive error if required env vars are missing.
 */
function getS3Client() {
  const region = process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS S3 is not configured. Please set AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY in your environment.'
    );
  }

  return new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey }
  });
}

/**
 * Checks if S3 env vars are present without throwing.
 */
function isS3Configured() {
  return !!(
    process.env.AWS_REGION &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY
  );
}

/**
 * Ensures the given bucket exists. Creates it if not, then sets CORS and bucket policy.
 * @param {string} bucketName
 */
async function ensureBucketExists(bucketName) {
  const client = getS3Client();
  const region = process.env.AWS_REGION;

  // Check if bucket already exists
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucketName }));
    // Bucket exists, nothing to do
    return { created: false, bucket: bucketName };
  } catch (err) {
    if (err.$metadata && err.$metadata.httpStatusCode === 404) {
      // Bucket does not exist — create it
    } else if (err.name === 'NotFound' || err.name === 'NoSuchBucket') {
      // Bucket does not exist — create it
    } else {
      throw err;
    }
  }

  // Create bucket
  const createParams = { Bucket: bucketName };
  // ap-south-1 and other non-us-east-1 regions require LocationConstraint
  if (region !== 'us-east-1') {
    createParams.CreateBucketConfiguration = { LocationConstraint: region };
  }
  await client.send(new CreateBucketCommand(createParams));

  // Set CORS
  await client.send(new PutBucketCorsCommand({
    Bucket: bucketName,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedHeaders: ['*'],
          AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
          AllowedOrigins: [process.env.CORS_ORIGIN || '*'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3000
        }
      ]
    }
  }));

  // Set bucket policy — deny public access, allow authenticated access only
  const accountId = process.env.AWS_ACCOUNT_ID;
  if (accountId) {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyPublicAccess',
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:GetObject',
          Resource: `arn:aws:s3:::${bucketName}/*`,
          Condition: {
            StringNotEquals: {
              'aws:PrincipalAccount': accountId
            }
          }
        }
      ]
    };
    await client.send(new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(policy)
    }));
  }

  return { created: true, bucket: bucketName };
}

/**
 * Generates a presigned PUT URL for client-side direct upload to S3.
 * @param {string} bucket
 * @param {string} key
 * @param {string} contentType
 * @param {number} expiresIn - seconds (default 3600)
 */
async function getUploadPresignedUrl(bucket, key, contentType, expiresIn = 3600) {
  const client = getS3Client();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType
  });
  const url = await getSignedUrl(client, command, { expiresIn });
  return url;
}

/**
 * Generates a presigned GET URL for downloading a file.
 * @param {string} bucket
 * @param {string} key
 * @param {number} expiresIn - seconds (default 3600)
 */
async function getDownloadPresignedUrl(bucket, key, expiresIn = 3600) {
  const client = getS3Client();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const url = await getSignedUrl(client, command, { expiresIn });
  return url;
}

/**
 * Lists objects in a bucket under a given prefix.
 * @param {string} bucket
 * @param {string} prefix
 * @returns {Array} list of S3 objects
 */
async function listFiles(bucket, prefix) {
  const client = getS3Client();
  const allObjects = [];
  let continuationToken;

  do {
    const params = {
      Bucket: bucket,
      Prefix: prefix
    };
    if (continuationToken) params.ContinuationToken = continuationToken;

    const response = await client.send(new ListObjectsV2Command(params));
    if (response.Contents) {
      allObjects.push(...response.Contents);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
  } while (continuationToken);

  return allObjects;
}

/**
 * Deletes an object from S3.
 * @param {string} bucket
 * @param {string} key
 */
async function deleteFile(bucket, key) {
  const client = getS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  return { deleted: true, key };
}

/**
 * Returns the Indian Financial Year folder name for a given date.
 * India FY runs April 1 → March 31.
 * E.g. date in Jan 2026 → "FY2025-26", date in May 2026 → "FY2026-27"
 * @param {Date|string} date - defaults to now
 * @returns {string} e.g. "FY2025-26"
 */
function getFYFolder(date) {
  const d = date ? new Date(date) : new Date();
  const month = d.getMonth() + 1; // 1-12
  const year = d.getFullYear();

  let fyStart, fyEnd;
  if (month >= 4) {
    // April or later — FY started this year
    fyStart = year;
    fyEnd = year + 1;
  } else {
    // Jan-Mar — FY started last year
    fyStart = year - 1;
    fyEnd = year;
  }

  return `FY${fyStart}-${String(fyEnd).slice(2)}`;
}

/**
 * Returns the S3 folder path for a given category and subcategory.
 * @param {string} category  e.g. "stocks", "tax"
 * @param {string} subcategory e.g. "nse-bse", "advance-tax"
 * @returns {string} e.g. "stocks/nse-bse/" or "tax/advance-tax/"
 */
function getCategoryPath(category, subcategory) {
  if (!category) return 'receipts/other/';
  const cat = category.toLowerCase().trim();
  if (!subcategory) return `${cat}/`;
  const sub = subcategory.toLowerCase().trim();
  return `${cat}/${sub}/`;
}

module.exports = {
  getS3Client,
  isS3Configured,
  ensureBucketExists,
  getUploadPresignedUrl,
  getDownloadPresignedUrl,
  listFiles,
  deleteFile,
  getFYFolder,
  getCategoryPath
};
