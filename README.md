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

- `SERVER_USER` (default: `owner`)
- `SERVER_HOST` (**erforderlich**, kein Default)
- `REMOTE_DIR` (default: `~/CIPHERPHANTOM`)
- `BRANCH` (nur deploy, default: `main`)
- `SERVER_BASE_URL` (nur release, optional; default: `http://<SERVER_HOST>`)

## Befehle

Standard-Prefix: `-`

- `-help`
- `-ping`
- `-prefix <neues_prefix>` (pro Chat)

Beispiel: `-prefix !` setzt den Prefix nur für den aktuellen Chat auf `!`.

## Docker/Compose (Server)

Voraussetzung: Docker + Compose Plugin installiert.

```bash
# im Repo
cp .env.example .env
docker compose build
docker compose up -d
docker compose ps
```

Logs:

```bash
docker compose logs -f owner-app
docker compose logs -f bot
```

Hinweise:

- App wird nur lokal auf `127.0.0.1:8787` veröffentlicht (für Nginx Reverse Proxy).
- Persistente Daten liegen außerhalb der Container in `./data` und `./auth`.
- `OWNER_APK_AUTOBUILD` ist im Bot-Container standardmäßig deaktiviert.
- Empfehlung: Server-URLs über `.env` setzen (`OWNER_PUBLIC_BASE_URL`, `OWNER_APK_DOWNLOAD_URL`, `OWNER_UPDATE_URL`).
