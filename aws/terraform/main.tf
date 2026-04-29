# =============================================================
# fin-kirakon-vault — Terraform Infrastructure
# S3 bucket + IAM users for fin.kirakon.com personal finance dashboard
# =============================================================

terraform {
  required_version = ">= 1.3.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ── S3 Bucket ─────────────────────────────────────────────────

resource "aws_s3_bucket" "fin_vault" {
  bucket = var.bucket_name

  tags = {
    Project     = "fin-dashboard"
    Environment = "production"
    ManagedBy   = "terraform"
  }
}

# ── Versioning ────────────────────────────────────────────────

resource "aws_s3_bucket_versioning" "fin_vault" {
  bucket = aws_s3_bucket.fin_vault.id

  versioning_configuration {
    status = "Enabled"
  }
}

# ── Server-Side Encryption ────────────────────────────────────

resource "aws_s3_bucket_server_side_encryption_configuration" "fin_vault" {
  bucket = aws_s3_bucket.fin_vault.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ── Block Public Access ───────────────────────────────────────

resource "aws_s3_bucket_public_access_block" "fin_vault" {
  bucket = aws_s3_bucket.fin_vault.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

# ── CORS Configuration ────────────────────────────────────────

resource "aws_s3_bucket_cors_configuration" "fin_vault" {
  bucket = aws_s3_bucket.fin_vault.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "DELETE", "HEAD"]
    allowed_origins = [
      "https://fin.kirakon.com",
      "http://localhost:3001"
    ]
    expose_headers = [
      "ETag",
      "x-amz-server-side-encryption",
      "x-amz-request-id",
      "x-amz-id-2"
    ]
    max_age_seconds = 3000
  }
}

# ── Lifecycle Configuration ───────────────────────────────────

resource "aws_s3_bucket_lifecycle_configuration" "fin_vault" {
  bucket = aws_s3_bucket.fin_vault.id

  # Depends on versioning being enabled first
  depends_on = [aws_s3_bucket_versioning.fin_vault]

  rule {
    id     = "FinancialDocsLifecycle"
    status = "Enabled"

    filter {
      prefix = ""
    }

    # Current version transitions
    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 365
      storage_class = "GLACIER"
    }

    # Noncurrent version transitions (older versions after overwrite/delete)
    noncurrent_version_transition {
      noncurrent_days = 30
      storage_class   = "STANDARD_IA"
    }

    noncurrent_version_transition {
      noncurrent_days = 180
      storage_class   = "GLACIER"
    }

    # Expire old noncurrent versions after 2 years
    noncurrent_version_expiration {
      noncurrent_days = 730
    }
  }
}

# ── Bucket Policy ─────────────────────────────────────────────

resource "aws_s3_bucket_policy" "fin_vault" {
  bucket = aws_s3_bucket.fin_vault.id

  # Must wait for public access block to be applied first
  depends_on = [aws_s3_bucket_public_access_block.fin_vault]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AppUserFullAccess"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_user.app_user.arn
        }
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:ListBucket",
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:ListBucketVersions",
          "s3:ListBucketMultipartUploads",
          "s3:AbortMultipartUpload"
        ]
        Resource = [
          aws_s3_bucket.fin_vault.arn,
          "${aws_s3_bucket.fin_vault.arn}/*"
        ]
      },
      {
        Sid    = "CAUserReadOnlyAccess"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_user.ca_user.arn
        }
        Action = ["s3:GetObject"]
        Resource = [
          "${aws_s3_bucket.fin_vault.arn}/tax/*",
          "${aws_s3_bucket.fin_vault.arn}/statements/*",
          "${aws_s3_bucket.fin_vault.arn}/receipts/*"
        ]
      },
      {
        Sid    = "CAUserListBucket"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_user.ca_user.arn
        }
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.fin_vault.arn
        Condition = {
          StringLike = {
            "s3:prefix" = ["tax/*", "statements/*", "receipts/*"]
          }
        }
      },
      {
        Sid    = "DenyCAUserDelete"
        Effect = "Deny"
        Principal = {
          AWS = aws_iam_user.ca_user.arn
        }
        Action = [
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:PutObject"
        ]
        Resource = [
          aws_s3_bucket.fin_vault.arn,
          "${aws_s3_bucket.fin_vault.arn}/*"
        ]
      },
      {
        Sid       = "DenyNonHTTPS"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.fin_vault.arn,
          "${aws_s3_bucket.fin_vault.arn}/*"
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}

# ── IAM: App User ─────────────────────────────────────────────

resource "aws_iam_user" "app_user" {
  name = "fin-dashboard-app"

  tags = {
    Project   = "fin-dashboard"
    ManagedBy = "terraform"
  }
}

resource "aws_iam_user_policy" "app_user_policy" {
  name = "FinDashboardS3Policy"
  user = aws_iam_user.app_user.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3BucketLevelAccess"
        Effect = "Allow"
        Action = [
          "s3:CreateBucket",
          "s3:ListBucket",
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:PutBucketVersioning",
          "s3:GetBucketCORS",
          "s3:PutBucketCORS",
          "s3:GetBucketPolicy",
          "s3:PutBucketPolicy",
          "s3:GetBucketPublicAccessBlock",
          "s3:PutBucketPublicAccessBlock",
          "s3:GetEncryptionConfiguration",
          "s3:PutEncryptionConfiguration",
          "s3:GetLifecycleConfiguration",
          "s3:PutLifecycleConfiguration",
          "s3:ListBucketVersions",
          "s3:ListBucketMultipartUploads"
        ]
        Resource = "arn:aws:s3:::${var.bucket_name}"
      },
      {
        Sid    = "S3ObjectLevelAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:GetObjectAcl",
          "s3:PutObjectAcl",
          "s3:RestoreObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts"
        ]
        Resource = "arn:aws:s3:::${var.bucket_name}/*"
      },
      {
        Sid       = "DenyAllOtherAWSServices"
        Effect    = "Deny"
        NotAction = ["s3:*"]
        Resource  = "*"
      }
    ]
  })
}

resource "aws_iam_access_key" "app_user" {
  user = aws_iam_user.app_user.name
}

# ── IAM: CA Read-Only User ────────────────────────────────────

resource "aws_iam_user" "ca_user" {
  name = "fin-ca-readonly"

  tags = {
    Project   = "fin-dashboard"
    ManagedBy = "terraform"
  }
}

resource "aws_iam_user_policy" "ca_user_policy" {
  name = "FinCAReadOnlyPolicy"
  user = aws_iam_user.ca_user.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3ListBucketRestrictedPrefixes"
        Effect = "Allow"
        Action = "s3:ListBucket"
        Resource = "arn:aws:s3:::${var.bucket_name}"
        Condition = {
          StringLike = {
            "s3:prefix" = ["tax/*", "statements/*", "receipts/*"]
          }
          StringEquals = {
            "s3:delimiter" = "/"
          }
        }
      },
      {
        Sid    = "S3GetObjectRestrictedPrefixes"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion"
        ]
        Resource = [
          "arn:aws:s3:::${var.bucket_name}/tax/*",
          "arn:aws:s3:::${var.bucket_name}/statements/*",
          "arn:aws:s3:::${var.bucket_name}/receipts/*"
        ]
      },
      {
        Sid    = "ExplicitDenyWrite"
        Effect = "Deny"
        Action = [
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:PutObjectAcl",
          "s3:AbortMultipartUpload",
          "s3:CreateMultipartUpload",
          "s3:UploadPart",
          "s3:CompleteMultipartUpload"
        ]
        Resource = [
          "arn:aws:s3:::${var.bucket_name}",
          "arn:aws:s3:::${var.bucket_name}/*"
        ]
      },
      {
        Sid       = "DenyAllOtherAWSServices"
        Effect    = "Deny"
        NotAction = ["s3:ListBucket", "s3:GetObject", "s3:GetObjectVersion"]
        Resource  = "*"
      }
    ]
  })
}
