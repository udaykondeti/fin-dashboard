module.exports = {
  apps: [
    {
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
    },
    {
      // Groq-powered DB-change watcher. PM2 runs this script every 5 minutes
      // and *only* keeps it alive long enough to process one tick (the
      // script exits after each run). cron_restart fires the next tick.
      // Requires GROQ_API_KEY in the EC2 env (the script no-ops without it).
      name: 'groq-watcher',
      script: 'scripts/groq-watcher.js',
      cwd: '/var/www/fin-dashboard',
      instances: 1,
      autorestart: false,
      cron_restart: '*/5 * * * *',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        DB_PATH: '/var/www/fin-dashboard/data/finance.db'
      }
    }
  ]
};
