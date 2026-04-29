#!/bin/bash
# ============================================================
# AWS Infrastructure Setup for fin-kirakon-vault
# Usage: bash setup-aws.sh <AWS_ACCOUNT_ID> [AWS_REGION]
# Prerequisites: AWS CLI configured with admin credentials
# chmod +x setup-aws.sh  (to make executable)
# ============================================================

set -e

ACCOUNT_ID=$1
REGION=${2:-ap-south-1}
BUCKET_NAME=fin-kirakon-vault
APP_USER=fin-dashboard-app
CA_USER=fin-ca-readonly

# Validate required arguments
if [ -z "$ACCOUNT_ID" ]; then
  echo "ERROR: AWS Account ID is required."
  echo "Usage: bash setup-aws.sh <AWS_ACCOUNT_ID> [AWS_REGION]"
  exit 1
fi

echo "======================================================"
echo " fin-kirakon-vault AWS Setup"
echo "======================================================"
echo " Account ID : $ACCOUNT_ID"
echo " Region     : $REGION"
echo " Bucket     : $BUCKET_NAME"
echo "======================================================"
echo ""

# ── 1. Create S3 bucket ──────────────────────────────────────
echo "[1/9] Creating S3 bucket: $BUCKET_NAME in $REGION ..."
if [ "$REGION" = "us-east-1" ]; then
  # us-east-1 does not accept LocationConstraint
  aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --region "$REGION"
else
  aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
fi
echo "    Bucket created."

# ── 2. Block all public access ───────────────────────────────
echo "[2/9] Blocking all public access ..."
aws s3api put-public-access-block \
  --bucket "$BUCKET_NAME" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
echo "    Public access blocked."

# ── 3. Enable versioning ─────────────────────────────────────
echo "[3/9] Enabling versioning (important for financial docs) ..."
aws s3api put-bucket-versioning \
  --bucket "$BUCKET_NAME" \
  --versioning-configuration Status=Enabled
echo "    Versioning enabled."

# ── 4. Apply CORS config ─────────────────────────────────────
echo "[4/9] Applying CORS configuration ..."
aws s3api put-bucket-cors \
  --bucket "$BUCKET_NAME" \
  --cors-configuration file://s3-cors-config.json
echo "    CORS applied."

# ── 5. Apply bucket policy (substitute account ID) ───────────
echo "[5/9] Applying bucket policy ..."
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" s3-bucket-policy.json > /tmp/fin-bucket-policy.json
aws s3api put-bucket-policy \
  --bucket "$BUCKET_NAME" \
  --policy file:///tmp/fin-bucket-policy.json
rm /tmp/fin-bucket-policy.json
echo "    Bucket policy applied."

# ── 6. Enable server-side encryption (AES-256) ───────────────
echo "[6/9] Enabling server-side encryption (AES-256) ..."
aws s3api put-bucket-encryption \
  --bucket "$BUCKET_NAME" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      },
      "BucketKeyEnabled": true
    }]
  }'
echo "    Encryption enabled."

# ── 7. Set lifecycle policy ───────────────────────────────────
echo "[7/9] Configuring lifecycle policy (IA at 90d, Glacier at 365d) ..."
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$BUCKET_NAME" \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "FinancialDocsLifecycle",
        "Status": "Enabled",
        "Filter": {"Prefix": ""},
        "Transitions": [
          {"Days": 90,  "StorageClass": "STANDARD_IA"},
          {"Days": 365, "StorageClass": "GLACIER"}
        ],
        "NoncurrentVersionTransitions": [
          {"NoncurrentDays": 30, "StorageClass": "STANDARD_IA"},
          {"NoncurrentDays": 180, "StorageClass": "GLACIER"}
        ],
        "NoncurrentVersionExpiration": {
          "NoncurrentDays": 730
        }
      }
    ]
  }'
echo "    Lifecycle policy applied."

# ── 8. Create app IAM user + attach policy + generate keys ───
echo "[8/9] Creating IAM user: $APP_USER ..."

# Create user (ignore error if already exists)
aws iam create-user --user-name "$APP_USER" 2>/dev/null || echo "    (User $APP_USER already exists, skipping creation)"

# Substitute account ID in policy and apply inline policy
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" iam-app-user-policy.json > /tmp/fin-app-user-policy.json
aws iam put-user-policy \
  --user-name "$APP_USER" \
  --policy-name FinDashboardS3Policy \
  --policy-document file:///tmp/fin-app-user-policy.json
rm /tmp/fin-app-user-policy.json

# Generate access keys
echo "    Generating access keys for $APP_USER ..."
APP_KEYS=$(aws iam create-access-key --user-name "$APP_USER")
APP_ACCESS_KEY=$(echo "$APP_KEYS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['AccessKey']['AccessKeyId'])")
APP_SECRET_KEY=$(echo "$APP_KEYS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['AccessKey']['SecretAccessKey'])")

echo "    IAM app user created and keys generated."

# ── 9. Create CA IAM user + attach read-only policy ──────────
echo "[9/9] Creating IAM user: $CA_USER ..."

aws iam create-user --user-name "$CA_USER" 2>/dev/null || echo "    (User $CA_USER already exists, skipping creation)"

sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" iam-ca-user-policy.json > /tmp/fin-ca-user-policy.json
aws iam put-user-policy \
  --user-name "$CA_USER" \
  --policy-name FinCAReadOnlyPolicy \
  --policy-document file:///tmp/fin-ca-user-policy.json
rm /tmp/fin-ca-user-policy.json

echo "    IAM CA user created."

# ── Done ─────────────────────────────────────────────────────
echo ""
echo "======================================================"
echo " Setup complete!"
echo "======================================================"
echo ""
echo " Bucket:    s3://$BUCKET_NAME"
echo " App User:  $APP_USER"
echo " CA User:   $CA_USER"
echo ""
echo " Add the following to your .env file:"
echo " (/var/www/fin-dashboard/.env)"
echo ""
echo "   AWS_REGION=$REGION"
echo "   AWS_S3_BUCKET=$BUCKET_NAME"
echo "   AWS_ACCESS_KEY_ID=$APP_ACCESS_KEY"
echo "   AWS_SECRET_ACCESS_KEY=$APP_SECRET_KEY"
echo ""
echo " IMPORTANT: Store these credentials securely."
echo "            Do NOT commit them to version control."
echo "======================================================"
