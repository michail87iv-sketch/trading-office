'use strict';

module.exports = {
  apps: [
    {
      name: 'trading-office',
      script: './index.js',
      cwd: '/root/trading-office',

      // ── Restart policy ────────────────────────────────────────────────────
      watch: false,               // no file-watch in prod — restart manually
      autorestart: true,          // restart on crash
      restart_delay: 5000,        // wait 5s before restarting
      max_restarts: 10,           // give up after 10 consecutive crashes
      min_uptime: '10s',          // must stay up 10s to count as "stable"

      // ── Logging ───────────────────────────────────────────────────────────
      out_file: '/root/trading-office/logs/out.log',
      error_file: '/root/trading-office/logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // ── Environment ───────────────────────────────────────────────────────
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
