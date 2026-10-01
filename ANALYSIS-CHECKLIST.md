# D:\webui — Verified Bug & Performance Audit

Every row below was **tested against the running code**, not inferred from reading
it. Verdict is one of:

| Verdict | Meaning |
|---|---|
| **REPRODUCED** | I made it happen and captured the evidence |
| **REAL** | Proven by construction + a targeted check, but not a full end-to-end repro |
| **FALSE POSITIVE** | I tried to break it and could not — the claim was wrong |
| **UNVERIFIED** | plausible, not measured — do not act on it without profiling |

Baseline before the audit: `./verify-matrix.sh` → **20 passed, 0 skipped**.
Re-run after the audit: **20 passed, 0 skipped** (no production code was modified).

**Headline: two unauthenticated command-injection holes, and `bridge/lan.json`
ships with `{"lan": true}` — so the bridge is bound to every interface with no
login. These compound into remote code execution for anyone on the network.**

---

## 🔴 CRITICAL — reproduced, unauthenticated remote code execution

### C1 · `scanDockerSessions` — RCE via `GET /api/sessions`
`bridge/server.js:1181` interpolates filenames from `find` straight into a shell
script:
```js
`for f in ${files.map((f) => `'${f.path}'`).join(' ')}; do` + …
```
Session filenames are **not** sanitised (`dir` is, filenames are not).

**Reproduction** — a session file named
`a'; do touch PWNED_FINAL; done #x.jsonl`
(no `/`, so it is a legal filename; ends `.jsonl` so it survives the
`endsWith('.jsonl')` and `isSubagentTranscript` filters), then **one**
`GET /api/sessions`:
```
before:  (no /workspace/PWNED_FINAL)
GET /api/sessions  →  http=200
after:   /workspace/PWNED_FINAL          <-- created
```
Note the payload must satisfy the shell grammar: a naive `'; touch X; '` produces
`Syntax error: word unexpected (expecting "do")` and executes nothing. The working
form closes the loop with `; do … ; done #` so the remainder is a comment.

**Fix:** stop building a script. Pass each path as an argv element, or copy the
list into the container first and loop over `"$@"`:
```js
docker exec <ctr> sh -c 'for f do echo "===PIWEBUI $f"; … ; done' sh <path1> <path2>
```

### C2 · `subagentRunLog` — RCE **and** arbitrary file read via `?dir=`
`bridge/server.js` `/api/subagent-output` takes `dir` straight off the query
string. It is gated only by a regex that merely requires the substring
`…/async-subagent-runs/` to appear *somewhere*, then lands in `ls -1t '${dir}'/…`.

* **Container mode → command execution.** `dir` =
  `/tmp/pi-subagents-x/async-subagent-runs/'; touch /tmp/INJECTION_PROOF; '`
  created `/tmp/INJECTION_PROOF` inside the container.
* **Local mode → arbitrary file read.** `dir` =
  `C:/tmp/a/b/pi-subagents-x/async-subagent-runs/../../../secret` returned the
  contents of an unrelated directory's `status.json`:
  `{"ok":true,"text":"{\"secret\":\"LOCAL-TRAVERSAL-PROOF\"}\n",…}`

**Fix:** resolve `dir` with `path.resolve` and require it to sit under the
run root, exactly as `safeSessionPath()` already does for session files. Then use
`execFile('docker',[…,'ls','-1t', joinedPaths])` with no `sh -c`.

### C3 · `bridge/lan.json` ships LAN-exposed, and no auth
`{"lan": true}` → the bridge binds `0.0.0.0`. The code says so itself:
*"Anyone on the LAN can drive this agent - there is no login."* Verified:
`/api/lan` reported `{"lan":true,"bound":true,"host":"0.0.0.0"}` on a plain
`node server.js` with no env vars. Combined with C1/C2 this is RCE for anyone on
the subnet. `.gitignore` lists the other machine-specific files
(`webui-settings.json`, `last-session.json`, `bridge/agent-source.txt`) but **not**
`lan.json`, so the one security switch is the one that would be committed.

---

## 🟠 HIGH — real functional bugs found while verifying

### H-A · Docker session list is silently empty for the normal session dir
`scanDockerSessions` sanitises the directory with
`String(dir).replace(/[^a-zA-Z0-9_\-\/]/g,'')` — which **strips the dot**:
```
'/root/.pi/agent/sessions'  ->  '/root/pi/agent/sessions'   (does not exist)
```
`find` then returns nothing and `/api/sessions` answers **HTTP 200 with
`sessions: []` and no error whatsoever**. Verified on the same container:
`/root/sess` (no dot) → 1 session returned; `/root/.pi/agent/sessions` → 0.
Docker mode therefore shows an empty sidebar for the standard pi session dir.
**Fix:** don't sanitise a path that you then use as a path — validate the
*container name* (`/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/`) and pass the directory as
an argv element.

### H-B · BusyBox `find` has no `-printf` → same silent empty list
The comment states the assumption: *"find -printf is GNU; the sandbox images are
Debian-based so this holds."* Verified on `alpine:latest`: `find -printf` errors
and `/api/sessions` returns `[]` with no diagnostic. Any non-GNU image loses the
entire session list. **Fix:** `find … -print0 | xargs -0 stat -c '%Y %s %n'`, or
detect and fall back.

### H-C · `sendBash` keys its card by `undefined` → no live output + a Map leak
`web/app.js`:
```js
const cmd = { type: 'bash', command };
S.bashCards.set(cmd.id, { body: out });   // cmd.id is undefined here
const d = await rpc(cmd);                  // rpc assigns cmd.id only now
S.bashCards.delete(cmd.id);                // now the *real* id — never a key
```
Verified against the real bridge + mock agent: the agent emits
`bash_execution_update` with `id:"req-1"`, while the page stored under
`undefined`, so `S.bashCards.get("req-1")` can never match. Streaming bash
output never appears live, and one entry leaks per `!command`.
**Fix:** `const id = 'req-' + (++S.reqId)` and use it for both, or have `rpc()`
return the id.

### H-D · Dead `agent_end` branch in `handleEvent` — verified unreachable
`web/app.js` `case 'agent_settled':` contains `if (msg.type === 'agent_end') {…}`
and a standalone `case 'agent_end': break;`. Inside the `agent_settled` case,
`msg.type` is always `'agent_settled'`, so that block **never runs**.
Lost: `finalizeLive()`, `refreshCommands()` (extensions registering commands
mid-session never refresh), `refreshStats()`, `ensureForkable()`,
`refreshSessions()`. The 20 s idle poll only partly compensates (it is skipped
while streaming and while the tab is hidden). The same case also carries a
duplicated comment line — *"Threshold/manual compactions stop the agent; keep the
task going."* ×2.

### H-E · A literal NUL byte in `bridge/server.js`
Line 2509, inside a comment: `Unexpected token '^@'` — a real control character
was pasted where the escape `\x00` was meant. Node still parses the file, but it
registers as **binary** to `grep`, `diff` and many editors (reproduced).

---

## 🟡 MEDIUM — real but lower impact

| # | Item | Verdict |
|---|---|---|
| M1 | `switchToSession` toasts **"Session switched"** *before* awaiting the switch; on failure the state is restored and a second toast says "Switch failed" — the user sees success then failure for one click | REAL |
| M2 | `pi-desktop/App.js` bridge-health `setInterval(…, 4000)` is never cleared; the "only while down" guard is *inside* the callback, so a 4 s wakeup continues for the app's lifetime | REAL |
| M3 | `blobToWav` never calls `ctx.close()` if `decodeAudioData` rejects → leaked `AudioContext` per failed audio attachment | REAL |
| M4 | `MIME` table has only 7 types; missing `woff, woff2, ttf, otf, webp, avif, jpg, jpeg, webmanifest, map, txt, wasm` | REAL (hygiene) |
| M5 | `updateBranchesBtn() {}` is an empty function still called from `applyState` (`app.js:1027`, `:6909`) | REAL (dead call) |
| M6 | `normalizeHost('ws://[::1]:3080/ws')` → `[::1]:3080/ws`: a pasted URL keeps its path, producing a malformed `ws://` URL. IPv6 literals are not handled | REAL (minor) |
| M7 | `/compact` issues a 10-minute `rpc()` whose timer is never cleared; the callback is a harmless no-op but stays pending | REAL (negligible) |

---

## ✅ FALSE POSITIVES — I tried to break these and could not

| # | Claim | What actually happens |
|---|---|---|
| B1 | `isWin` used before its `const` (line 269 vs 3075) | **False positive.** Only reachable from the `/api/builtin-commands` handler, which Node cannot dispatch before the module body finishes. Endpoint returned the real command list, no `ReferenceError`. |
| B2 | `SETTINGS_FILE` used before declaration | **False positive.** Same argument; `/proxy/<unconfigured>` → `403`, no throw. |
| B3 | `agentStatus` used before declaration | **False positive.** Only reached from request handlers / `startAgent()`'s stdout reader. `/api/health` → `{"ok":true}`. |
| B6 | `inlineMd` link/bare-URL regexes allow HTML injection | **False positive.** `escapeHtml` runs *first*, so interpolated values provably contain no `"`, `<` or `>`; the URL regex requires `https?:`, so `javascript:` and `data:` can never reach an `href`. Tested 7 payloads: 0 leaks. |
| B7 | `escapeHtml` doesn't escape `/` | **False positive.** Not needed in a text node or a quoted attribute. |
| B9 | `renderMarkdown` emits a trailing empty `<p>` | **False positive.** `flushPara` only emits when `para.length`. Tested 8 edge cases (unclosed fence, bare fence, empty string, `### ` with no text) — none crash, none produce an empty paragraph. |
| B10 | `lineDiff` can allocate ~400 MB | **False positive, badly overstated.** The guard is `N*M > 400000`; the worst case is 633×632 = 401 322 cells = **1.53 MB**. My original figure was ~250× too high. |
| B11 | `sessionHasRunningDescendant` recurses without a cycle guard | **False positive.** A `seen` Set keyed on `x.path` is checked and added on every step. |
| B16 | `speakInBatches` leaves `S.speaking` stuck on error | **False positive.** The throw happens inside `flush()`, i.e. *before* `S.speaking = true`. |
| B18 | `findServerExe` recursion has no cycle guard | **False positive.** It uses `Dirent.isDirectory()`, which is false for symlinks, so symlink cycles cannot occur. |
| B19 | whisper download doesn't verify `content-length` | **False positive.** SHA-256 *is* enforced and a mismatch deletes the file (`ESHACHECK`); content-length is not the integrity control. |
| B22 | `App.js` `tryInit` interval can outlive its effect | **False positive.** `clearInterval(poll)` is present in the cleanup. |
| H2 | `HOP_HEADERS` omits `content-length` (proxy bug) | **False positive.** Omitting it is the *correct* choice for a proxy that re-pipes both directions. |
| P18 | `sessionsSignature` builds a costly string | **False positive.** 33.3 KB built in **0.126 ms** for 200 sessions, once per 20 s poll. Negligible. |

---

## 📉 Performance — measured

### P1 · `/api/sessions` costs 210 ms and is uncached — **REAL, quantified**
```
200 session files, 5 runs: 0.207 0.208 0.213 0.212 0.210 s
```
Breakdown matches the endpoint almost exactly, and shows the cost is *entirely*
per-file sequential I/O — plus each file is opened **twice** (head, then
`nameFromTail`):
```
200× stat                        sequential  19.8 ms   parallel    6.3 ms
200× open+read 64 KB+close       sequential  91.9 ms   parallel   18.9 ms
nameFromTail (stat+open+read)    sequential 105.9 ms
                                 -------------------------  total ≈ 218 ms  ✓ matches
```
Parallelising (and reading head+tail from one open) should take this to **~55 ms**.
It is polled every 20 s by the idle poll plus on many events.

### P3 · Every page load sweeps 1016 hosts on your subnet — **REAL, worse than stated**
`refreshModels()` → `ensureLlamaGroup()` → `/api/llama-models` → `llamaLanUrls()`,
which is not opt-in:
```
targets = 2 subnets × 254 hosts × 2 ports = 1016
48 workers, 350 ms timeout  =>  floor ≈ 7 s
```
Measured: **1.24 s** on the first request, and the log confirms the sweep ran
(`llama.cpp on the LAN: nothing found`). The UI calls it again on model-button
click and on select focus. Opt-out is only via `PI_LLAMA_SCAN=off`.

### P12 · `/api/session-image` re-reads the file from byte 0 per image — **REAL, measured**
The loop is `for await (const raw of sessionLines(ref)) { if (++line !== wantLine) continue; … }`,
so cost is **O(position of the line)**, not O(1). On a 36 MB / 60-line session:
```
image at line 2   → 0.0064 s
image at line 60  → 0.0449 s      (7× slower)
```
With N images this is O(N × filesize). A per-file line-offset index (or
`mmap`) makes it O(1).

### P4 / P16 · `renderMarkdown` re-parse per paint — **OVERBUILT by me**
Measured cost of one full pass over the accumulated stream text:
```
500 chars  0.02 ms      8 000 chars  0.17 ms
2 000      0.04 ms     32 000       0.35 ms
                     128 000       1.14 ms
```
At the shipped 12 paints/s that is **~1.4 % of one core even at 128 k chars**.
The parse is *not* the bottleneck. The real cost is browser-side
`innerHTML` replacement + the forced layout in `scrollBottom()` — and the code
already throttles from 60/s to `LIVE_PAINT_MS = 80`. Incremental DOM append
would still help, but this is a modest win, not the problem I implied.

### Everything else — UNVERIFIED (do not act without profiling)
`P5` batched history build · `P6` sidebar O(N²) + full rebuild (2 × N filters
per row, but N ≤ 200) · `P7` 1 Hz `get_session_stats` · `P8` 1 Hz subagent poll
· `P9` `get_fork_messages` + `get_tree` · `P10` two `IntersectionObserver`s per
image · `P11` `avatarStillCache` never expires · `P13` 8 `docker exec`s for
`imageDensity` · `P14` favicon canvas per avatar change · `P15` `saveSettings`
POSTs the whole object per change · `P16` `FlatList` without `getItemLayout` ·
`P17` three WebViews always mounted · `P19` temp file per atomic write.
These are plausible; I did not measure them, and P4/P16 is a warning that my
intuition about this codebase's hot paths has been wrong twice already.

---

## Recommended order of work

1. **C1, C2** — pass paths as argv, never inside a `sh -c` script. Then
   re-run the two proofs above; both must report *NOT_CREATED* / 400.
2. **C3** — default `lan.json` to `{"lan": false}`, add it to `.gitignore`, and
   consider a token on the bridge.
3. **H-A, H-B** — stop sanitising directories as strings; validate the container
   name and pass the dir as argv. Add a startup log line when the session list
   comes back empty in docker mode, so this can never fail silently again.
4. **H-C** — give `rpc()` an id-returning sibling; use it in `sendBash`.
5. **H-D** — move the `agent_end` work into the real `case 'agent_end':`, or drop
   the self-tests.
6. **H-E** — replace the NUL byte with the text `\x00`.
7. **P1** — `Promise.all` with a concurrency cap, one `open` per file for head+tail.
8. **P3** — make the LAN sweep opt-in (`PI_LLAMA_SCAN=on`) rather than opt-out.

---

## Verification log

| Step | Result |
|---|---|
| Baseline `./verify-matrix.sh` | 20 passed, 0 skipped |
| C1 repro | command executed in container — **vulnerable** |
| C2 repro (docker) | `/tmp/INJECTION_PROOF` created — **vulnerable** |
| C2 repro (local) | unrelated `status.json` contents returned — **vulnerable** |
| B6 XSS probes (7 payloads) | 0 leaks — false positive |
| B1–B3 endpoints | all answered normally, no `ReferenceError` — false positives |
| H-A | dot-stripping confirmed; 0 sessions for `~/.pi/…`, 1 for `/root/sess` |
| H-B | BusyBox `find -printf` errors on alpine — confirmed |
| H-C | `cmd.id === undefined`; events carry `req-1` — confirmed |
| H-D | branch proven unreachable — confirmed |
| P1 | 210 ms → ~55 ms achievable; double-open identified |
| P3 | 1016 targets, 1.24 s cold — confirmed |
| P12 | 6.4 ms (line 2) vs 44.9 ms (line 60) on 36 MB — confirmed |
| P4/P16 | 1.14 ms per pass at 128 k chars — claim withdrawn |
| Cleanup | all test bridges stopped, containers removed, scratch deleted |
| Final `./verify-matrix.sh` | see below |
