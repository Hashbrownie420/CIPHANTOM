module.exports = {
  apps: [
    {
      name: 'cipherphantom-bot',
      cwd: '/home/ecliptic/Dokumente/Projekte/CIPHERPHANTOM',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production'
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000
    },
    {
      name: 'cipherphantom-owner-remote',
      cwd: '/home/ecliptic/Dokumente/Projekte/CIPHERPHANTOM/owner-app',
      script: './start_remote.sh',
      env: {
        OWNER_APP_HOST: '0.0.0.0',
        OWNER_APP_PORT: '8787',
        OWNER_AUTO_IP: '1',
        OWNER_HOTSPOT_MODE: '1',
        OWNER_LOCAL_IP: '',
        OWNER_APP_FALLBACK_URL: '',
        OWNER_UPDATE_URL: '',
        OWNER_CF_TUNNEL_TOKEN: '',
        OWNER_PUBLIC_URL: '',
        OWNER_TUNNEL_PROVIDER: 'cloudflared',
        OWNER_NGROK_AUTHTOKEN: '',
        OWNER_NGROK_DOMAIN: '',
        OWNER_VERSION_BUMP_ON_URL_CHANGE: 'patch',
        OWNER_AUTO_VERSION_ON_RESTART: '1',
        OWNER_ANDROID_LOCAL_PROPERTIES: '/home/ecliptic/Dokumente/Projekte/CIPHERPHANTOM/owner-app/android/local.properties'
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000
    }
  ]
};
