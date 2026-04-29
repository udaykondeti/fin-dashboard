# =============================================================
# fin-kirakon-vault — Terraform Variables
# =============================================================

variable "aws_region" {
  description = "AWS region to deploy the S3 bucket into."
  type        = string
  default     = "ap-south-1"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region must be a valid AWS region code (e.g. ap-south-1, us-east-1)."
  }
}

variable "bucket_name" {
  description = "Name of the S3 bucket used as the financial document vault."
  type        = string
  default     = "fin-kirakon-vault"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{2,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be a valid S3 bucket name (3-63 lowercase chars, hyphens, dots)."
  }
}

variable "account_id" {
  description = "AWS Account ID. Used to construct IAM ARNs in the bucket policy."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}
