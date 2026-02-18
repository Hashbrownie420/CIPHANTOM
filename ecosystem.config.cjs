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
      name: "cipherphantom-owner-remote",
      cwd: OWNER,
      script: "./start_remote.sh",
      env: {
        OWNER_APP_HOST: "0.0.0.0",
        OWNER_APP_PORT: "8787",
        OWNER_AUTO_IP: "1",
        OWNER_HOTSPOT_MODE: "1",
        OWNER_LOCAL_IP: "",
        OWNER_APP_FALLBACK_URL: "",
        OWNER_UPDATE_URL: "",
        OWNER_CF_TUNNEL_TOKEN: "",
        OWNER_PUBLIC_URL: "",
        OWNER_TUNNEL_PROVIDER: "cloudflared",
        OWNER_NGROK_AUTHTOKEN: "",
        OWNER_NGROK_DOMAIN: "",
        OWNER_VERSION_BUMP_ON_URL_CHANGE: "patch",
        OWNER_AUTO_VERSION_ON_RESTART: "1",
        OWNER_HEALTH_CHECK_INTERVAL_SEC: "5",
        OWNER_HEALTH_FAIL_THRESHOLD: "3",
        OWNER_APP_RESTART_MAX_CONSEC: "6",
        OWNER_ANDROID_LOCAL_PROPERTIES: path.join(OWNER, "android", "local.properties"),
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
    },
  ],
};
