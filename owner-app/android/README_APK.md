# Android Studio: Direkt Builden

Du kannst diesen Ordner direkt in Android Studio öffnen:

- `owner-app/android`

## 1) Voraussetzungen

- Android Studio (aktuell)
- Handy + Laptop im gleichen WLAN
- Owner-App-Server läuft auf Laptop:
  - `cd owner-app`
  - `OWNER_APP_HOST=0.0.0.0 OWNER_APP_PORT=8787 npm start`

## 2) URL auf Laptop setzen

- Datei `local.properties` im Ordner `owner-app/android` öffnen.
- Diese Zeile eintragen (mit deiner Laptop-/Server-URL):
  - `OWNER_APP_URL=http://DEINE-URL`
- Optional (robuster bei URL-Problemen):
  - `OWNER_APP_FALLBACK_URL=http://DEINE-URL`
  - `OWNER_UPDATE_URL=https://DEIN-STABILER-ENDPOINT/api/app-meta`

Hinweis: Falls `local.properties` noch nicht existiert, Android Studio erzeugt sie beim ersten Öffnen. Du kannst dann `OWNER_APP_URL` ergänzen.

## 3) Projekt bauen

- Android Studio -> `Open` -> Ordner `owner-app/android`
- Warten bis Gradle Sync fertig ist.
- `Build` -> `Build APK(s)`

APK liegt danach in:

- `owner-app/android/app/build/outputs/apk/debug/app-debug.apk`

Release (signiert, empfohlen für echte Verteilung):

- In `owner-app/android/local.properties` setzen:
  - `OWNER_KEYSTORE_FILE=/pfad/zu/deinem-keystore.jks`
  - `OWNER_KEYSTORE_PASSWORD=...`
  - `OWNER_KEY_ALIAS=...`
  - `OWNER_KEY_PASSWORD=...`
- Dann bauen:
  - `./gradlew assembleRelease`
- Ausgabe:
  - `owner-app/android/app/build/outputs/apk/release/app-release.apk`

## 4) Auf Handy installieren

- APK aufs Handy kopieren und installieren.
- App starten.

## 5) Login

- Username: dein Bot-Profilname
- Passwort: via Bot setzen mit `-ownerpass <passwort>`

## Wenn nur schwarzer Bildschirm

- Die App zeigt jetzt eine Fehlerseite mit URL + Fehlertext, wenn keine Verbindung möglich ist.
- Die App prüft beim Start zuerst auf Pflicht-Updates (`minVersionCode`) und danach auf einen erreichbaren Server.
- Reihenfolge für Verbindungscheck:
  - zuletzt funktionierende URL (gespeichert in der App)
  - `OWNER_APP_URL`
  - `OWNER_APP_FALLBACK_URL` (falls gesetzt)
- Prüfe:
  - Owner-Server läuft: `OWNER_APP_HOST=0.0.0.0 OWNER_APP_PORT=8787 npm start`
  - Handy und Laptop sind im selben WLAN
  - `OWNER_APP_URL` in `owner-app/android/local.properties` ist korrekt

## Update-Check JSON

Dein `OWNER_UPDATE_URL` sollte JSON wie folgt liefern:

```json
{
  "ok": true,
  "latestVersionCode": 3,
  "minVersionCode": 2,
  "apkDownloadUrl": "https://example.com/app-debug.apk",
  "apkSha256": "64-hex-zeichen"
}
```

- `minVersionCode > aktuelle APK`: Update ist zwingend.
- `latestVersionCode > aktuelle APK`: Update wird ebenfalls angefordert.

Hinweis:
- Die API `/api/app-meta` im Owner-Server liest `OWNER_APK_VERSION_CODE` und `OWNER_APK_DOWNLOAD_URL` aus `local.properties`.
- Die API liefert zusätzlich `apkSha256` und `apkSizeBytes` für Integritätsprüfung.
- `start_remote.sh` erhöht `OWNER_APK_VERSION_CODE` automatisch, wenn sich die Tunnel-URL ändert.
- Download-Link in der App: `/downloads/latest.apk` (vom Owner-Server ausgeliefert).
