# Pi Agent — native mobile app (Expo / React Native)

A standalone native client for the Pi Agent WebUI bridge. It speaks the exact
same WebSocket RPC protocol as the browser UI, so it can drive the same agent,
sessions and models — plus it does the thing a browser fundamentally cannot:
**play the real shorts feeds in-app.**

---

## Why this exists (the shorts problem)

Browsers cannot embed Instagram Reels / TikTok / YouTube Shorts feeds:

- Instagram and TikTok send `X-Frame-Options: DENY`, so an `<iframe>` refuses to
  render their feeds.
- Only *single-video* official embeds work in a browser.

A native `WebView` does not have that limitation. It is a **top-level browser
context**, not a nested frame — `X-Frame-Options` simply does not apply. So the
app loads the genuine, infinite, logged-in feed inside the app, next to the
chat. No new tabs, no popups, no "open in app" round-trips.

---

## Running it

```bash
cd pi-desktop
npm install
npx expo start          # then scan the QR with Expo Go, or press "a" for Android
```

You need the bridge running on your PC first:

```bat
start-webui.bat
```

### Connecting

On first launch the app asks for:

| field | value |
| --- | --- |
| Host / IP | your PC's LAN IP, e.g. `192.168.1.12` (not `localhost` — that would be the phone) |
| Port | `3080` (the default in `start-webui.bat`) |

The choice is stored with AsyncStorage and reused on every later launch; change
it any time from the ⚙ button.

The phone and the PC must be on the same network, and the PC firewall must
allow inbound TCP on the bridge port.

---

## What the app does

**Chat**
- Live streaming assistant output, including thinking blocks
- Tool-call cards (expandable) and tool results
- Markdown rendering (headings, code fences, lists, quotes, links)
- User / assistant / tool / system message styling

**Agent control**
- Model picker, grouped by provider with the active model ticked
- Session list, switch, and **new session**
- **Rename the current session** (updates the WebUI sidebar too — pi writes a
  `session_info` entry that the bridge now reads from the file tail)
- **Stop** button (`clear_queue` + `abort`)
- Send while streaming → the message is sent with `streamingBehavior: 'steer'`,
  so it steers the running turn instead of being swallowed
- Live context percentage pill in the header: green → amber (≥75%) → red (≥90%)

**Shorts (the important part)**
- One tap on ▶ opens the panel; landscape docks it to the right, portrait opens
  a bottom sheet you can drag open to ~92% height
- Tabs for **Reels / TikTok / Shorts**; one WebView instance per provider is kept
  mounted, so switching tabs is instant and each feed keeps its own state
- Cookies, DOM storage and cache are shared with the platform browser engine, so
  a login made once inside the panel persists
- `setSupportMultipleWindows={false}` keeps `target=_blank` and `window.open()`
  inside the panel instead of spawning blank windows
- Off-site link taps are handed to the OS (`Linking.openURL`) so a reel can never
  trap you in the panel
- Loading progress bar, error state with **Retry**, and an **Open in app**
  fallback that deep-links into the native Instagram / TikTok / YouTube app
- Hidden providers have their `<video>` elements paused so two feeds never play
  audio at once

**Other**
- Android hardware back closes the shorts panel / modals instead of exiting
- Setup screen, dark theme, safe-area aware

---

## Project layout

```
pi-desktop/
├── App.js                 # app shell, chat, modals, event wiring
├── index.js               # Expo entry (registerRootComponent)
├── app.json               # Expo config (cleartext + local networking enabled)
├── babel.config.js
└── src/
    ├── bridge.js          # WS client: connect / rpc / events / auto-reconnect
    ├── config.js          # ws:// and http:// URL builders
    ├── store.js           # AsyncStorage-backed settings
    ├── feeds.js           # feed URLs, user agents, injected CSS/JS
    ├── ShortsPanel.js     # the seamless in-app shorts feed
    ├── MessageBubble.js   # chat message rendering
    └── Markdown.js        # minimal markdown renderer
```

---

## Protocol notes

The bridge spawns one `pi --mode rpc` child per WebSocket client, so the app is
fully independent of any browser session. Requests are
`{ id, type, ... }` and correlate to `{ type: 'response', id, success, data }`.
Agent events (`message_start`, `message_update`, `message_end`, `agent_start`,
`agent_settled`, `compaction_end`, `session_info_changed`, …) arrive
unsolicited.

REST endpoints used by the app:

| endpoint | purpose |
| --- | --- |
| `GET /api/sessions` | session list (names include explicit renames) |

---

## Building a standalone binary

```bash
npx expo run:android        # needs Android Studio / SDK
npx expo run:ios            # needs macOS + Xcode
# or a cloud build with EAS:
npx eas build -p android
```

`usesCleartextTraffic` (Android) and `NSAllowsLocalNetworking` (iOS) are already
set, because the bridge is plain `ws://` on your LAN.
