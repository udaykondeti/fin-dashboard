# AWS S3 Setup for fin.kirakon.com File Vault

This document covers everything needed to provision and manage the `fin-kirakon-vault`
S3 bucket used by the fin.kirakon.com personal finance dashboard.

---

## Quick Setup (AWS CLI)

**Prerequisites:** AWS CLI installed and configured with admin credentials.

```bash
cd aws/
bash setup-aws.sh YOUR_AWS_ACCOUNT_ID ap-south-1
```

Copy the output keys to your app environment file:

```
/var/www/fin-dashboard/.env
```

The script will print an env block you can paste directly.

---

## Quick Setup (Terraform)

```bash
cd aws/terraform/
terraform init
terraform plan -var="account_id=YOUR_AWS_ACCOUNT_ID"
terraform apply -var="account_id=YOUR_AWS_ACCOUNT_ID"

# Retrieve the secret key after apply
terraform output -raw app_secret_access_key
```

---

## Manual Setup (AWS Console)

### Step 1 — Create the S3 Bucket

1. Go to **S3** → **Create bucket**
2. Bucket name: `fin-kirakon-vault`
3. Region: `ap-south-1` (Mumbai) — or your preferred region
4. **Object Ownership**: ACLs disabled (recommended)
5. **Block Public Access**: check all four boxes
6. **Versioning**: Enable
7. **Encryption**: Server-side encryption with Amazon S3 managed keys (SSE-S3), AES-256
8. Click **Create bucket**

### Step 2 — Apply CORS Configuration

1. Open the bucket → **Permissions** tab → **Cross-origin resource sharing (CORS)**
2. Paste the contents of `s3-cors-config.json` and save

### Step 3 — Apply Bucket Policy

1. Open the bucket → **Permissions** tab → **Bucket policy**
2. Paste the contents of `s3-bucket-policy.json`
3. Replace `ACCOUNT_ID` with your 12-digit AWS account ID
4. Save

### Step 4 — Set Lifecycle Rules

1. Open the bucket → **Management** tab → **Lifecycle rules** → **Create lifecycle rule**
2. Rule name: `FinancialDocsLifecycle`
3. Apply to all objects
4. Add transitions:
   - After **90 days** → Move to **Standard-IA**
   - After **365 days** → Move to **Glacier**
5. Also add noncurrent version transitions (30d → IA, 180d → Glacier)
6. Save

### Step 5 — Create App IAM User

1. Go to **IAM** → **Users** → **Create user**
2. Username: `fin-dashboard-app`
3. Skip console access (this is a programmatic-only user)
4. **Permissions**: Add inline policy → paste `iam-app-user-policy.json`
5. Create user, then go to **Security credentials** → **Create access key**
6. Choose **Application running outside AWS** → create key
7. Copy the Access Key ID and Secret Access Key — they will NOT be shown again

### Step 6 — Create CA Read-Only IAM User

1. Go to **IAM** → **Users** → **Create user**
2. Username: `fin-ca-readonly`
3. **Permissions**: Add inline policy → paste `iam-ca-user-policy.json`
4. Create user

---

## S3 Folder Structure

The bucket uses a fiscal-year / category structure for easy CA access:

```
fin-kirakon-vault/
├── tax/
│   ├── FY2024-25/
│   │   ├── form16.pdf
│   │   ├── itr-acknowledgement.pdf
│   │   └── ...
│   └── FY2025-26/
├── statements/
│   ├── FY2024-25/
│   │   ├── hdfc-savings-apr2024.pdf
│   │   ├── zerodha-capital-gains.pdf
│   │   └── ...
│   └── FY2025-26/
├── receipts/
│   ├── FY2024-25/
│   │   ├── 80C-investments/
│   │   ├── 80D-insurance/
│   │   └── ...
│   └── FY2025-26/
└── personal/         ← NOT accessible to CA user
    ├── insurance/
    ├── property/
    └── ...
```

The CA user (`fin-ca-readonly`) can only see and download files under
`tax/`, `statements/`, and `receipts/`. All other prefixes are inaccessible.

---

## Security Features

| Feature | Details |
|---|---|
| Encryption at rest | AES-256 (SSE-S3) applied to all objects |
| Encryption in transit | HTTPS-only enforced via bucket policy (`DenyNonHTTPS`) |
| Versioning | Enabled — protects against accidental deletes and overwrites |
| Public access | Fully blocked at bucket and account level |
| CA access | Read-only, restricted to `tax/`, `statements/`, `receipts/` prefixes |
| CA write denied | Explicit Deny on PutObject and DeleteObject for CA user |
| Presigned URLs | App generates time-limited URLs (expire in 1 hour) for sharing |

---

## Lifecycle Cost Savings

Objects automatically move to cheaper storage tiers:

| Tier | Triggers after | Cost (ap-south-1) |
|---|---|---|
| Standard | Upload | ~$0.025/GB/month |
| Standard-IA | 90 days | ~$0.0138/GB/month |
| Glacier | 365 days | ~$0.005/GB/month |

**Typical monthly cost for personal finance use: under $1/month.**

For example, 5 GB of documents mostly older than 1 year ≈ $0.025.

---

## CA Access

### Option 1 — App-Generated Presigned URLs (Recommended)

The fin-dashboard app can generate temporary presigned URLs for any file:

```js
// Server-side — never expose in frontend
const url = await s3.getSignedUrlPromise('getObject', {
  Bucket: 'fin-kirakon-vault',
  Key: 'tax/FY2024-25/form16.pdf',
  Expires: 3600   // 1 hour
});
// Send this URL to your CA via secure message
```

- URLs expire automatically — no need to revoke manually
- Works for any single file
- CA does not need an AWS account

### Option 2 — IAM User Console Access

If you want to give your CA ongoing S3 Console access:

1. Create IAM user `fin-ca-readonly` (see Step 6 above)
2. Additionally attach the `IAMUserChangePassword` managed policy so they can set their own password
3. Share credentials via a secure channel (1Password, Signal, etc.)
4. They log in at: `https://YOUR_ACCOUNT_ID.signin.aws.amazon.com/console`
5. They can browse S3 Console in read-only mode for allowed prefixes

### Revoking CA Access

**Presigned URLs:** expire automatically — nothing to do.

**IAM Console Access:**

```bash
# Disable the user (preserves audit trail)
aws iam update-user --user-name fin-ca-readonly --no-console-access

# Or delete entirely
aws iam delete-user-policy --user-name fin-ca-readonly --policy-name FinCAReadOnlyPolicy
aws iam delete-user --user-name fin-ca-readonly
```

---

## Files in This Directory

| File | Purpose |
|---|---|
| `s3-bucket-policy.json` | Bucket policy — app full access, CA read-only, HTTPS-only |
| `iam-app-user-policy.json` | IAM policy for `fin-dashboard-app` user |
| `iam-ca-user-policy.json` | IAM policy for `fin-ca-readonly` user |
| `s3-cors-config.json` | CORS rules for browser uploads from fin.kirakon.com |
| `setup-aws.sh` | CLI script to provision everything in one command |
| `terraform/main.tf` | Terraform equivalent of all the above |
| `terraform/variables.tf` | Terraform input variables |
| `terraform/outputs.tf` | Terraform outputs including app credentials |

---

## Troubleshooting

**"Access Denied" on PutObject:** Confirm the app is authenticating with the
`fin-dashboard-app` keys, not a personal user or root account.

**CORS errors in browser:** Ensure the origin matches exactly
(`https://fin.kirakon.com` — no trailing slash). Check CORS is applied to the
bucket, not just configured in code.

**Bucket policy conflicts with public access block:** The `BlockPublicPolicy`
flag must be `false` when initially applying the bucket policy via CLI. The
`setup-aws.sh` script handles this correctly by setting it to `true` only after
the policy is applied.

**Terraform: "BucketAlreadyExists":** The bucket name is globally unique. If
someone else has `fin-kirakon-vault`, choose a different suffix and update
`variables.tf`.
