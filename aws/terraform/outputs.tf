# =============================================================
# fin-kirakon-vault — Terraform Outputs
# =============================================================

output "bucket_name" {
  description = "Name of the created S3 bucket."
  value       = aws_s3_bucket.fin_vault.id
}

output "bucket_arn" {
  description = "ARN of the created S3 bucket."
  value       = aws_s3_bucket.fin_vault.arn
}

output "bucket_region" {
  description = "AWS region the bucket was created in."
  value       = aws_s3_bucket.fin_vault.region
}

output "app_user_arn" {
  description = "ARN of the fin-dashboard-app IAM user."
  value       = aws_iam_user.app_user.arn
}

output "app_access_key_id" {
  description = "AWS Access Key ID for the fin-dashboard-app IAM user. Add to .env as AWS_ACCESS_KEY_ID."
  value       = aws_iam_access_key.app_user.id
}

output "app_secret_access_key" {
  description = "AWS Secret Access Key for the fin-dashboard-app IAM user. Add to .env as AWS_SECRET_ACCESS_KEY. Marked sensitive — use 'terraform output -raw app_secret_access_key' to retrieve."
  value       = aws_iam_access_key.app_user.secret
  sensitive   = true
}

output "ca_user_arn" {
  description = "ARN of the fin-ca-readonly IAM user."
  value       = aws_iam_user.ca_user.arn
}

output "env_block" {
  description = "Ready-to-paste .env block for the fin-dashboard app. Secret key is redacted — run: terraform output -raw app_secret_access_key"
  value       = <<-ENV
    AWS_REGION=${aws_s3_bucket.fin_vault.region}
    AWS_S3_BUCKET=${aws_s3_bucket.fin_vault.id}
    AWS_ACCESS_KEY_ID=${aws_iam_access_key.app_user.id}
    AWS_SECRET_ACCESS_KEY=<run: terraform output -raw app_secret_access_key>
  ENV
}
