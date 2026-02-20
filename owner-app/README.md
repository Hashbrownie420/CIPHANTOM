# CIPHERPHANTOM Owner App

Owner-Panel mit Login und Admin-Tools.

## Features
- Login mit Owner-Username (registrierter Profilname)
- Passwort wird im Bot gesetzt: `-ownerpass <passwort>`
- Datenbanken anzeigen
- Nutzer per Handynummer bannen / entbannen
- Nachrichten-Tool (Einzelnachricht mit Signatur)
- Broadcast (an alle User, Gruppen oder beide)
- Outbox-Status (pending/sent/failed mit Fehlertext)
- Server- und Bot-Infos anzeigen
- API-Basisschutz: Rate-Limits auf Login/API + Security-Header
- Server-Admin-Tab (Bot/App/Alles restart, Logs, IPs, optional Server-Reboot)
  - Hinweis: Prozesssteuerung benötigt PM2. Im reinen Docker-Modus zeigt das Panel stattdessen "unmanaged"-Status.
- Erweiterte Admin-API:
  - `GET /api/admin/summary`
  - `GET /api/admin/alerts`
  - `GET/POST /api/admin/flags`
  - `POST /api/admin/op`
  - `GET/POST/DELETE /api/admin/jobs`
  - `GET /api/admin/audit`
  - `GET /api/admin/users`
  - `POST /api/admin/users/:chat_id/role`
  - `GET /api/process/:target/stream` (SSE live logs)

## Start
```bash
cd owner-app
npm start
```

Dann im Browser:
- `http://127.0.0.1:8787`

## Wichtig
- Erst im Bot als Owner Passwort setzen:
  - `-ownerpass MeinSicheresPasswort123`
- Username im Login ist dein `profile_name` aus dem Bot.
- Der Bot-Prozess (`npm start` im Hauptprojekt) muss laufen, damit Nachrichten/Broadcast aus der Queue versendet werden.

## Remote Zugriff (Handy-Hotspot / unterwegs)
Wenn Handy als Hotspot genutzt wird, ist die Laptop-IP oft nicht direkt erreichbar.

Nutze Tunnel:
```bash
cd owner-app
./start_remote.sh
```
Dann die ausgegebene `https://...trycloudflare.com` URL in `owner-app/android/local.properties` als `OWNER_APP_URL` eintragen und APK neu bauen.

Die aktive Tunnel-URL wird auch in `owner-app/tunnel_url.txt` gespeichert.
Zusätzlich wird `owner-app/android/local.properties` automatisch auf die aktuelle `OWNER_APP_URL` aktualisiert.
Beim Start wird ausserdem die aktuelle lokale IP automatisch erkannt und in `OWNER_APP_FALLBACK_URL` + `OWNER_UPDATE_URL` geschrieben.
Runtime-Logs liegen unter `owner-app/runtime/logs/`:
- `owner-app/runtime/logs/owner-app.log`
- `owner-app/runtime/logs/ngrok.log` (nur bei ngrok)
Schnell anzeigen:
```bash
cd owner-app
./show_tunnel_url.sh
```

### Stabiler Link (empfohlen)

Für einen festen Link ohne URL-Wechsel nutze einen **Named Tunnel**:

1. In Cloudflare Zero Trust einen Tunnel anlegen und Hostname (z. B. `owner.deinedomain.tld`) auf `http://localhost:8787` routen.
2. Tunnel-Token kopieren.
3. In PM2-Env setzen:
   - `OWNER_CF_TUNNEL_TOKEN=<dein-token>`
   - `OWNER_PUBLIC_URL=https://owner.deinedomain.tld`
4. Neustarten:
```bash
pm2 restart ecosystem.config.cjs --only cipherphantom-owner-remote --update-env
```

Wenn du die Owner-App ohne Tunnel direkt als PM2-App laufen lässt, kann der Prozess auch `cipherphantom-owner-app` heißen.

Dann bleibt `OWNER_APP_URL` stabil und der In-App-Updater ist deutlich zuverlässiger.

### Alternative: ngrok (ohne Domain)

Du kannst statt Cloudflared auch ngrok nutzen:

- `OWNER_TUNNEL_PROVIDER=ngrok`
- optional `OWNER_NGROK_AUTHTOKEN=<token>`
- optional `OWNER_NGROK_DOMAIN=<deine-domain>` (nur mit passendem ngrok Plan)

Dann startet `start_remote.sh` automatisch ngrok, liest die HTTPS-URL über `http://127.0.0.1:4040/api/tunnels` und schreibt sie in:
- `OWNER_APP_URL`
- `OWNER_UPDATE_URL`
- `OWNER_APK_DOWNLOAD_URL`

Optional fuer robusteren Start/Update-Pruefung in der APK:
- `OWNER_APP_FALLBACK_URL=http://10.17.86.221:8787`
- `OWNER_UPDATE_URL=https://DEIN-STABILER-ENDPOINT/api/app-meta`

## Security-Optionen
- Session-TTL (Stunden) per Env:
  - `OWNER_SESSION_TTL_HOURS=12`
- Optionaler Server-Reboot aus dem Panel:
  - `OWNER_ALLOW_SERVER_REBOOT=1`
  - `OWNER_SERVER_REBOOT_CMD="sudo /sbin/shutdown -r +1"`

## Observability
- Erweiterter Healthcheck: `GET /api/healthz`
  - liefert DB-/PM2-/Disk-Checks sowie Runtime-Stats
  - HTTP `200` wenn gesund, sonst `503`
- Prometheus-Format:
  - `GET /metrics`

## DB-Wartung (Punkt 7)
- Backup-Status/Übersicht (auth): `GET /api/db/maintenance`
- Integritätscheck (auth): `GET /api/db/maintenance/check`
- Backup erstellen (auth): `POST /api/db/backup`
- Backup-Liste (auth): `GET /api/db/backups?limit=50`
- Backup herunterladen (auth): `GET /api/db/backups/<datei>.db`

Env:
- `OWNER_DB_BACKUP_KEEP=20` (wie viele Backups behalten werden)

## Struktur
- `web/` UI
- `api/` HTTP-API + statischer Webserver
- `android/` fertiges Android-Studio Projekt (WebView APK)
- `assets/` reserviert
