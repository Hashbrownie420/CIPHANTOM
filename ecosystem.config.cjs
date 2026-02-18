const path = require("path");

const ROOT = process.env.CIPHERPHANTOM_ROOT || __dirname;
const OWNER = path.join(ROOT, "owner-app");

module.exports = {
  apps: [
    {
      name: "cipherphantom-bot",
      cwd: ROOT,
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
    },
    {
      name: "cipherphantom-owner-app",
      cwd: OWNER,
      script: "node",
      args: "api/server.mjs",
      env: {
        OWNER_APP_HOST: "0.0.0.0",
        OWNER_APP_PORT: "8787",
        OWNER_SESSION_TTL_HOURS: "12",
        OWNER_ALLOW_SERVER_REBOOT: "0",
        OWNER_SERVER_REBOOT_CMD: "sudo /sbin/shutdown -r +1",
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
    },
  ],
};
