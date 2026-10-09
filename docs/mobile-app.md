# Phone app (Android)

Chat with your characters from your phone, over **your own Wi-Fi only**. The app talks to one machine: your PC,
running girllm. There is no server in between, no cloud account and no analytics.

- [What it does](#what-it-does)
- [How it stays private](#how-it-stays-private)
- [Setup](#setup)
  - [1. Turn phone access on, on the PC](#1-turn-phone-access-on-on-the-pc)
  - [2. Build the app](#2-build-the-app)
  - [3. Install it on the phone](#3-install-it-on-the-phone)
  - [4. Pair the phone](#4-pair-the-phone)
- [Everyday use](#everyday-use)
- [Updating the app](#updating-the-app)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Code and tests](#code-and-tests)

## What it does

| On the phone       | Details                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Your characters    | The list from your PC, with their faces                                                          |
| Chat               | Her replies as she writes them, Stop, Regenerate, New chat, and every previous chat              |
| Photos             | Her photos (old and new), 📷 to ask for one, ↻ retake, tap to open full screen                   |
| Her picture behind | Same rules as the PC page: her scene or her latest photo, and the PC's "Chat background" setting |
| Her voice          | 🔊 on each message and "Voice on"                                                                |
| Character editor   | Card fields, her voice (designed, or recorded with the phone's mic), face and background, delete |

Everything is computed on the PC (the phone only displays it), so the PC must be on with girllm running, and the
phone on the same Wi-Fi. Settings, the memory panel, card import/export, 🎤 dictation and calls stay on the PC
page. Fields the phone doesn't show (her lorebook…) are kept when you save a character from the phone.

## How it stays private

| Protection       | How                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No internet use  | The app only accepts private IPv4 addresses (10/8, 172.16/12, 192.168/16), ignores any proxy, has no analytics and no Google services (the QR scanner is zxing on the phone, not ML Kit). |
| Encrypted        | HTTPS with the PC's own self-signed certificate. Its SHA-256 is **pinned** from the QR code: another machine on the Wi-Fi can't pretend to be your PC. Cleartext HTTP is refused.         |
| Only your phones | Pairing gives the phone a random token (the PC keeps only its hash). Remove a phone in the PC settings and it stops working at once.                                                      |
| PC side          | The phone listener is off by default, only answers private addresses, refuses browsers (any `Origin`), and has no settings or pairing routes: those exist on the PC page only.            |
| On the phone     | The connection is in the Android Keystore (flutter_secure_storage); app backups are off. Recorded voices and photos aren't stored on the phone (photos are cached in memory only).        |

Your router doesn't forward anything from the internet to your PC unless you set up port forwarding, so only
devices on your Wi-Fi can reach the phone listener, and only paired phones get an answer. Details:
[Security → Phone listener](security.md#phone-listener).

## Setup

You need: the PC with girllm installed ([Installation](installation.md)), an Android phone (7.0 or newer) on the
same Wi-Fi, and [Flutter](https://docs.flutter.dev/get-started/install/windows) on the PC to build the app once.

### 1. Turn phone access on, on the PC

In girllm's `.env`:

```env
LAN_ENABLED=true
# LAN_PORT=3211
```

Restart girllm. The startup log says `Phone app: on (https://<your PC's address>:3211, …)`. The first time, **Windows Firewall** asks
whether Node.js may accept connections: allow **Private networks** only (not Public).

**Your Wi-Fi must be a Private network in Windows.** Windows applies a firewall rule only to the network profiles
it was made for: with your home Wi-Fi marked _Public_, a rule for _Private_ networks is ignored and the phone can't
connect. Marking your home Wi-Fi as Private only changes which rules apply to devices on that network; your PC's
internet access is the same either way. Keep _Public_ for café, train or hotel Wi-Fi.

```powershell
Get-NetConnectionProfile   # NetworkCategory must be Private
# If it says Public: Settings → Network & internet → Wi-Fi (or Ethernet) → your network
#                    → Network profile type: Private
```

If the Windows prompt didn't appear (or the phone later says "Your PC is not reachable"), add the rule yourself, in
PowerShell **as administrator**. It opens only this port, only to devices on your own network, only on Private
networks; outgoing connections (browsing, downloads) are not affected:

```powershell
New-NetFirewallRule -DisplayName "girllm phone (local network)" -Direction Inbound `
  -Protocol TCP -LocalPort 3211 -Profile Private -RemoteAddress LocalSubnet -Action Allow
```

To remove it later: `Remove-NetFirewallRule -DisplayName "girllm phone (local network)"`.

> If you clicked **Cancel** on the Windows prompt, Windows also added a **Block** rule for Node.js, and a block
> always wins over an allow. Check with
> `Get-NetFirewallRule -DisplayName "*node*" | Format-Table DisplayName,Action,Profile` and remove those Block
> rules in _Windows Defender Firewall → Inbound Rules_.

### 2. Build the app

You need a recent stable Flutter whose Dart is 3.9 or newer (`flutter --version` shows it), with `flutter doctor`
OK for Android. The repository holds the app's code and its Android settings; the first time,
`flutter create` adds the rest of the Android project around them (existing files are kept):

```powershell
cd mobile
flutter create --platforms=android --org dev.girllm --project-name girllm_mobile .   # first time only
flutter pub get
flutter analyze
flutter test
flutter build apk --release
```

The APK is `mobile\build\app\outputs\flutter-apk\app-release.apk`.

- If the build asks for a higher `minSdk`, set `minSdk = 24` in `android/app/build.gradle.kts` (Android 7.0+).
- `flutter build apk --release` signs with the debug key, which is fine for your own phone. To publish it, see
  Flutter's "Build and release an Android app".

### 3. Install it on the phone

**With a USB cable** (easiest when you rebuild often):

1. On the phone, turn on developer mode: Settings → About phone → tap **Build number** 7 times.
2. Settings → System → Developer options → **USB debugging** on.
3. Plug the phone in and accept "Allow USB debugging?" (tick "Always allow from this computer").
4. `flutter devices` should list it. Then, in `mobile`: `flutter install`.

`flutter run --release` builds, installs and starts the app in one go, and shows its logs in the terminal.

**Without a cable**: copy `app-release.apk` to the phone (USB file transfer, a cloud drive…), open it from the
**Files** app and allow that app to **install unknown apps** when Android asks. Google Play Protect may warn that the
app is unknown: that's expected for an app you built yourself (**More details → Install anyway**). You can switch
the "install unknown apps" permission off again afterwards.

### 4. Pair the phone

1. PC: girllm → ⚙ Settings → **Phone app** → **Pair a phone**. A QR code appears (valid 5 minutes, one use).
2. Phone, on the same Wi-Fi: open girllm → **Scan the QR code**. Fill most of the camera frame with the code. If
   live scanning struggles (glare on the screen), take a photo of the QR code and pick it with the gallery button.

Done: the app shows your characters. The PC lists the paired phones.

## Everyday use

- Start girllm on the PC as usual (`start.bat`), open the app on the phone. If your PC's address changed, the app
  tries every address the QR code listed.
- **Revoke a phone**: PC → ⚙ Settings → Phone app → **Remove**. Its token stops working immediately.
- **Forget the PC on the phone**: ⋮ → _Unpair this phone_. Pair again with a new QR code.
- Away from home, set `LAN_ENABLED=false` if the PC is a laptop you take to other networks.

## Updating the app

After a code change, rebuild (`flutter build apk --release`) and install again (`flutter install`, or copy the new
APK). Android updates the app in place and keeps the pairing, as long as it is signed with the same key (same PC).
Uninstalling the app forgets the pairing: pair again.

## Troubleshooting

| Problem                                     | Fix                                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Your PC is not reachable"                  | The connection never reached girllm, almost always the firewall: see [step 1](#1-turn-phone-access-on-on-the-pc). Same Wi-Fi (not a guest network, which isolates devices)? VPN off on the phone? |
| Is girllm listening?                        | `netstat -ano \| findstr :3211` should show a line ending in `LISTENING`. If not, `LAN_ENABLED=true` wasn't picked up: restart girllm.                                                            |
| "Only devices on your private network…"     | The phone reached the PC from a non-private address (a VPN, a mobile hotspot with odd addressing): use your home Wi-Fi.                                                                           |
| The QR code expired / "wrong or expired"    | Codes last 5 minutes and work once: show a new one.                                                                                                                                               |
| "This phone was removed on the PC"          | Pair again.                                                                                                                                                                                       |
| "Your PC's certificate is not the one…"     | The PC's certificate changed (`data/lan` deleted, or another PC answered): pair again.                                                                                                            |
| A photo shows "Couldn't load this picture"  | The reason is written under the icon; tap to retry.                                                                                                                                               |
| No 🔊 / no 📷 in the chat                   | Her voice or photos aren't available on the PC right now (ComfyUI not running or not installed): same as on the PC page.                                                                          |
| `flutter pub get`: "requires SDK version …" | Your Flutter is older than a package needs: `flutter upgrade`, or lower that package's version range in `pubspec.yaml`.                                                                           |

## How it works

```
PC (girllm)                                               Phone (Flutter app)
────────────────────────────────────────────              ─────────────────────────────────────────
127.0.0.1:3210   the PC page (unchanged)
   Settings → Phone app → "Pair a phone"
     ─► one-time code (5 min, 5 tries) ─► QR code ─────►  scan: girllm://pair?v=1&a=<PC IPs>&p=3211
                                                                 &c=<code>&f=<certificate SHA-256>
                                                          checks: private IPv4 only, valid port/code/hash
0.0.0.0:3211     the phone listener (HTTPS)       ◄─────  POST /api/pair {code, name}
   self-signed certificate (data/lan)                     (TLS accepted only if its SHA-256 = f)
   ─► random 32-byte token, only its SHA-256 stored ───►  token saved in the Android Keystore
                                                  ◄─────  every request: Authorization: Bearer <token>
   same API as the PC page (chat, SSE, photos, voice, editor)
```

- **Two listeners, one API.** The phone listener is a second instance of the same server code, so the phone gets
  exactly the PC page's validation, limits and safety checks. It skips the web page, the settings routes and the
  pairing management routes, and checks every request first: private client address, no `Origin` header (no
  browser), valid token.
- **Certificate pinning.** The app trusts no certificate authority at all: it accepts only the certificate whose
  SHA-256 came in the QR code. The certificate is made on the PC's first start with phone access (10 years);
  deleting `data/lan` makes a new one, and phones must then pair again.
- **Her replies** stream over Server-Sent Events, like on the PC page; Stop closes the request.
- **Pictures** are downloaded with the pinned client (3 at a time), cached in memory and decoded at the size they
  are shown. **Her voice** (FLAC) is written to a temporary file and played.
- **Recording a voice**: 16-bit PCM at 24 kHz from the microphone, converted to float32 and sent with the same
  consent confirmation as the PC page; the PC trims, checks and transcribes it. **Uploading a face** uses Android's
  photo picker (no storage permission) with the same consent confirmation.
- **Android permissions**: Internet (to reach your PC), Camera (to scan the QR code), Microphone (only when you
  record a voice). Camera and microphone are asked the first time they're needed.

More internals: [Architecture → Step 8](ARCHITECTURE.md#step-8-the-phone-app-on-your-local-network).

## Code and tests

```
mobile/
  lib/main.dart                    the app: pairing screen, or your characters (GirllmShell)
  lib/src/api/pinned_client.dart   HTTPS to the PC: pinned certificate, token, no proxy, address rotation
  lib/src/api/girllm_api.dart      the PC's API (same routes as the PC page)
  lib/src/api/sse.dart             her reply stream (Server-Sent Events parser)
  lib/src/pairing/                 QR code parsing and checks, scanner screen
  lib/src/media/                   her voice player, picture cache and RemoteImage
  lib/src/audio/pcm.dart           recorded voice → what the PC expects
  lib/src/ui/                      characters, chat, editor, voice recorder, theme
  lib/src/services.dart            what every screen shares (API, player, cache, saved connection)
  test/                            pairing, SSE, PCM, picture cache, navigation and pairing-screen tests
  android/app/src/main/            AndroidManifest.xml (permissions, no backups, no cleartext)
```

Dependencies were chosen to work fully on the phone, with nothing sent anywhere else: `flutter_zxing` (QR scanner on
zxing-cpp), `flutter_secure_storage` (Keystore), `just_audio`, `record`, `image_picker`, `path_provider`, `crypto`.

Run `flutter analyze` and `flutter test` in `mobile/` after a change. The PC side of the phone listener is tested in
`tests/lan8.test.ts` (part of `npm test` and CI).
