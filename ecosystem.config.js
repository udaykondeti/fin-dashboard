module.exports = {
  apps: [{
    name: 'fin-dashboard',
    script: 'server/index.js',
    cwd: '/var/www/fin-dashboard',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      // JWT_SECRET must be supplied via the EC2 environment / .env file —
      // never commit a default. The app will refuse to boot if it's missing.
      DB_PATH: '/var/www/fin-dashboard/data/finance.db'
    }
  }]
};
