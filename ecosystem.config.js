const path = require('path');
const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'fin-dashboard',
      script: path.join(root, 'server/index.js'),
      cwd: root,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        DB_PATH: path.join(root, 'data/finance.db'),
        OLLAMA_BASE_URL: 'http://localhost:11434/v1',
        OLLAMA_MODEL: 'mistral:latest',
      }
    },
    {
      name: 'ollama-watcher',
      script: path.join(root, 'scripts/groq-watcher.js'),
      cwd: root,
      instances: 1,
      autorestart: false,
      cron_restart: '*/5 * * * *',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        DB_PATH: path.join(root, 'data/finance.db'),
        OLLAMA_BASE_URL: 'http://localhost:11434/v1',
        OLLAMA_MODEL: 'mistral:latest',
      }
    }
  ]
};
