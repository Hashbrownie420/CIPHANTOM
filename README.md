# CIPHERPHANTOM

WhatsApp Bot (Baileys) mit Chat-spezifischem Prefix.

## Setup

```bash
npm install
npm start
```

Beim ersten Start wird ein QR-Code im Terminal angezeigt. Mit WhatsApp scannen.

## Deployment (Punkt 6)

Standardisierte Abläufe mit Skripten:

```bash
# Code auf Server deployen (git pull + pm2 restart)
npm run deploy:server

# Owner-APK lokal bauen, auf Server kopieren, App neu starten
npm run release:owner-apk
```

Optionale Variablen:

- `SERVER_USER` (default: `ubuntu`)
- `SERVER_HOST` (default: `130.61.157.46`)
- `REMOTE_DIR` (default: `~/CIPHERPHANTOM`)
- `BRANCH` (nur deploy, default: `main`)
- `SERVER_BASE_URL` (nur release, default: `http://<SERVER_HOST>:8787`)

## Befehle

Standard-Prefix: `-`

- `-help`
- `-ping`
- `-prefix <neues_prefix>` (pro Chat)

Beispiel: `-prefix !` setzt den Prefix nur fuer den aktuellen Chat auf `!`.
