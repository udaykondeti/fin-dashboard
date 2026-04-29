# fin.kirakon.com - Personal Finance Dashboard

## Quick Deploy to EC2

### 1. SSH into your EC2 instance
```bash
ssh -i your-key.pem ubuntu@YOUR_EC2_IP
```

### 2. Run first-time setup (new EC2 only)
```bash
# On the EC2 instance (after copying files — see step 3):
bash scripts/ec2-first-time-setup.sh
```

### 3. On your Mac, copy files to EC2
```bash
rsync -avz --exclude node_modules --exclude .git \
  fin-dashboard/ ubuntu@YOUR_EC2_IP:/var/www/fin-dashboard/
```

### 4. On EC2, run deploy
```bash
cd /var/www/fin-dashboard
bash scripts/deploy.sh
```

### 5. Point DNS
Add an A record at your DNS provider for kirakon.com:

```
Type:  A
Name:  fin
Value: YOUR_EC2_IP
TTL:   300
```

### 6. Default login
```
Email:    kondetiudaykiran@gmail.com
Password: Admin@123
```
> Warning: Change your password immediately after first login!

---

## DNS Setup (kirakon.com)

Add this record wherever kirakon.com is managed (Route 53, Cloudflare, etc.):

| Field | Value         |
|-------|---------------|
| Type  | A             |
| Name  | fin           |
| Value | YOUR_EC2_IP   |
| TTL   | 300           |

SSL is handled automatically by Certbot (Let's Encrypt) during `deploy.sh`.

---

## Future Updates

After the initial deploy, push updates with:
```bash
# On your Mac — sync new files to EC2
rsync -avz --exclude node_modules --exclude .git \
  fin-dashboard/ ubuntu@YOUR_EC2_IP:/var/www/fin-dashboard/

# On EC2
cd /var/www/fin-dashboard
bash scripts/update.sh
```

---

## Local Development

```bash
# From the project root on your Mac
bash scripts/setup-local-dev.sh

# Visit http://localhost:3001
```

---

## Directory Structure

```
fin-dashboard/
├── server/
│   └── index.js          # Express server entry point
├── public/               # Static frontend files (HTML/CSS/JS)
├── data/                 # SQLite database (gitignored)
├── nginx/
│   └── fin.kirakon.com.conf
├── scripts/
│   ├── deploy.sh
│   ├── update.sh
│   ├── setup-local-dev.sh
│   └── ec2-first-time-setup.sh
├── ecosystem.config.js   # PM2 config
├── .env.example
├── .gitignore
└── package.json
```

---

## EC2 Instance Recommendations

- **AMI:** Ubuntu 22.04 LTS (ami-0c7217cdde317cfec in us-east-1)
- **Instance type:** t3.micro (free tier) or t3.small
- **Storage:** 20 GB gp3
- **Security group inbound rules:**
  - Port 22  (SSH) — your IP only
  - Port 80  (HTTP) — 0.0.0.0/0
  - Port 443 (HTTPS) — 0.0.0.0/0

---

## PM2 Cheat Sheet

```bash
pm2 list                    # Show running apps
pm2 logs fin-dashboard      # Tail logs
pm2 restart fin-dashboard   # Restart app
pm2 stop fin-dashboard      # Stop app
pm2 delete fin-dashboard    # Remove from PM2
pm2 monit                   # Live monitoring dashboard
```
