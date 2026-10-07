# girllm — phone app (Android)

Chat with your characters from your phone: her replies as she writes them,
her photos (↻ retake), 🔊 her voice, and the character editor (card, voice
designed or recorded, face and background).

**Everything stays on your network.** The app talks to one machine only:
your PC, at the private address read from the pairing QR code.

| Protection       | How                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No internet use  | The app only accepts private IPv4 addresses (10/8, 172.16/12, 192.168/16), ignores any proxy, has no analytics and no Google services (the QR scanner is zxing on the phone, not ML Kit). |
| Encrypted        | HTTPS with the PC's own self-signed certificate. Its SHA-256 is **pinned** from the QR code: another machine on the Wi-Fi can't pretend to be your PC. Cleartext HTTP is refused.         |
| Only your phones | Pairing gives the phone a random token (the PC keeps only its hash). Remove a phone in the PC settings and it stops working at once.                                                      |
| PC side          | The phone listener is off by default, only answers private addresses, refuses browsers (any `Origin`), and has no settings or pairing routes.                                             |
| On the phone     | The connection is in the Android Keystore (flutter_secure_storage); app backups are off. Recorded voices and photos aren't stored on the phone.                                           |

## 1. Turn phone access on, on the PC

In girllm's `.env`:

```env
LAN_ENABLED=true
# LAN_PORT=3211
```

Restart girllm. The first time, **Windows Firewall** asks whether Node.js
may accept connections: allow **Private networks** only (not Public).

If the phone then says "Your PC is not reachable", Windows is almost always
blocking it. In PowerShell:

```powershell
# 1. Is girllm listening? (expect a line ending in LISTENING)
netstat -ano | findstr :3211
# 2. Is your Wi-Fi marked Private? A "Public" network blocks it.
Get-NetConnectionProfile   # NetworkCategory must be Private
#    If it says Public: Settings → Network & internet → Wi-Fi (or Ethernet)
#    → your network → Network profile type: Private.
```

Then, in PowerShell **as administrator**, open only this port, only to your
own network, only on Private networks:

```powershell
New-NetFirewallRule -DisplayName "girllm phone (local network)" -Direction Inbound `
  -Protocol TCP -LocalPort 3211 -Profile Private -RemoteAddress LocalSubnet -Action Allow
```

If you clicked "Cancel" on the Windows prompt, Windows also added a **Block**
rule for Node.js, and a block always wins over an allow. Check with
`Get-NetFirewallRule -DisplayName "*node*" | Format-Table DisplayName,Action,Profile`
and remove those Block rules in _Windows Defender Firewall → Inbound Rules_.

## 2. Build the app (once)

You need a recent stable Flutter whose Dart is 3.9 or newer (`flutter --version` shows it), with
`flutter doctor` OK for Android. In this folder:

```powershell
cd mobile
# Creates the Android project around the code here (existing files are kept).
flutter create --platforms=android --org dev.girllm --project-name girllm_mobile .
flutter pub get
flutter analyze
flutter test
flutter build apk --release
```

The APK is `build/app/outputs/flutter-apk/app-release.apk`. Copy it to the
phone (USB cable) and open it, or with the phone plugged in and USB
debugging on: `flutter install`.

If the build asks for a higher `minSdk`, set `minSdk = 24` in
`android/app/build.gradle.kts` (Android 7.0+).

> `flutter build apk --release` signs with the debug key, fine for your own
> phone. To keep it, see Flutter's "Build and release an Android app".

## 3. Pair the phone

1. PC: girllm → ⚙ Settings → **Phone app** → **Pair a phone**: a QR code
   appears (valid 5 minutes, one use).
2. Phone on the **same Wi-Fi** as the PC: open girllm → **Scan the QR code**.

Done. The PC lists the paired phones; **Remove** one to revoke it. On the
phone, ⋮ → _Unpair this phone_ forgets the PC.

## Troubleshooting

| Problem                                       | Fix                                                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Your PC is not reachable"                    | See the firewall steps in section 1. Also: same Wi-Fi (not a guest network, which isolates devices)? VPN off on the phone (it sends 192.168.x.x through the tunnel)? |
| The PC's address changed                      | The app tries every address from the QR code. If none answers any more, pair again.                                                                                  |
| "This phone was removed on the PC"            | Pair again.                                                                                                                                                          |
| The PC's certificate was deleted (`data/lan`) | A new one is made: phones refuse it (it isn't the pinned one). Pair them again.                                                                                      |

## Code

```
lib/
  main.dart                    pairing screen, or your characters
  src/api/pinned_client.dart   HTTPS to the PC: pinned certificate, token, no proxy
  src/api/girllm_api.dart      the PC's API (same routes as the PC page)
  src/api/sse.dart             her reply stream (Server-Sent Events)
  src/pairing/                 QR code parsing and checks, scanner screen
  src/media/                   her voice player, picture cache
  src/audio/pcm.dart           recorded voice → what the PC expects
  src/ui/                      characters, chat, editor, voice recorder
test/                          pure-Dart tests (pairing, SSE, PCM)
```
