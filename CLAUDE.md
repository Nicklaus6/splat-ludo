# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `pnpm start` — run the server (port 3000, or `PORT` env var). Requires PostgreSQL — configure via `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` env vars (defaults: `127.0.0.1:5432`, user `splat_user`, db `splat_ludo`). Schema is applied idempotently at startup (`db.migrate()` runs `schema.sql`).
- No build, lint, or test tooling exists. Deps: `ws`, `pg`. Use `pnpm` (not npm/yarn).

## Deployment

`./deploy.sh` (or `pnpm run deploy` — NOT `pnpm deploy`, that's a pnpm builtin): refuses if local HEAD ≠ origin/main, then ssh → `git pull --ff-only` + `systemctl restart splat-ludo` + health checks. SSH key defaults to `~/SHDebian.pem` (override via `SPLAT_SSH_KEY`).

Production is `https://splat.jessie6.com`, served from `/opt/splat-ludo` (a git clone of this repo) on `1.15.12.238` (`ssh -i ~/SHDebian.pem root@1.15.12.238`), run by the `splat-ludo` systemd unit on port 3010 behind a reverse proxy. PostgreSQL runs there in Docker (`lobe-postgres`, port 5432); credentials live in `/etc/systemd/system/splat-ludo.service.d/env.conf` — never commit them.

Restart drops all WebSockets mid-game (state lives only in client memory, 5-min reconnect window), so avoid deploying while a game is likely in progress.

For local dev against the production db: `PGHOST=1.15.12.238 PGPASSWORD=<from env.conf> pnpm start` — clean up any test accounts you register (`DELETE FROM users WHERE email=...`).

## Architecture

A mini game portal ("Jessie 的游戏厅") hosting self-contained browser games — currently Splat Ludo (online multiplayer) and 口袋蛋仔 (single-player pet). One Node process serves everything: static pages, auth (email/password + session cookies), per-game APIs, and the Ludo WebSocket relay. Core surfaces:

- **`server.js`** (~400 lines): HTTP routes (auth API + static pages) + WebSocket relay. Contains **no game rules** — it manages a single room (lobby phase, 4 seats, waiting queue, host = lowest occupied seat) and relays `roll`/`move` messages from seated players to everyone with `from: seat` attached.
- **`auth.js`**: scrypt password hashing + 30-day cookie sessions (`splat_session`, HttpOnly). **`db.js`** + **`schema.sql`**: pg pool + idempotent startup migration (`users`, `sessions`, and a `rooms` placeholder table for future multi-room).
- **`public/index.html`**: portal homepage — a card grid listing all games. **`public/{login,register}.html`**: static auth pages. Each game is one self-contained HTML file under `public/games/<name>/`, listed as a card on the portal; new games follow the same pattern. Every game must have an in-game 玩法说明 overlay (see Ludo's 📖 规则 / tamagotchi's 📖 饲养手册).
- **Portal styling convention**: the portal shell and auth pages are game-neutral (dark near-black theme, amber accent, "Jessie 的游戏厅" branding) — per-game art direction lives ONLY inside that game's card (add a `.card.<name>` override, see `.card.ludo`) and the game's own page. Don't leak one game's visual identity into shared surfaces.
- **README.md** is user-facing (Chinese, Ludo-focused) — update it when player-visible behavior changes.

### Auth gating

`/` (portal) and everything under `/games/` redirect to `/login` without a valid session; `/login`/`/register` redirect to `/` when already logged in. `/games/<name>` (no trailing slash) 302s to `/games/<name>/` so relative asset paths resolve. API: `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`. WebSocket connections without a valid session cookie get `{t:'authRequired'}` and close code 4401 — the client redirects to `/login`. Player name defaults to the account's `display_name`.

## Game: Splat Ludo (`public/games/ludo/index.html`)

~1500 lines, the entire game in one file — SVG board rendering, animations, Web Audio sound synthesis, Ludo rules, CPU AI, and networking. Zero frontend dependencies.

### Deterministic lockstep sync (the key design constraint)

Clients stay in sync via a deterministic state machine, not server-authoritative state. The server broadcasts only *inputs* ("seat X rolled a 4", "seat X moved piece i"); every client independently applies identical rules (`applyRoll`, `applyMove`, `nextTurn`) so all screens converge. Consequences when editing:

- Any game-rule change must be deterministic given the same message sequence — no client-local randomness or timing affecting game state.
- Dice rolls originate on the acting client and are broadcast; CPU decisions are computed **only by the host client** (`aiPick`) then broadcast like normal moves. Disconnected/empty seats are played as CPU by the host.
- Animations are chained through a promise queue (`enqueue`) so network messages apply in order without racing.

### Server protocol (JSON over WebSocket)

Client→server: `join` (name, optional preferred `seat` 0-3), `pickSeat` (change color mid-lobby), `start`/`restart` (host only), `roll`/`move` (relayed), `snapshot` (mid-game state upload for a reconnecting peer).
Server→client: `welcome` (includes `user`), `seated` (final `seat` + optional `preferred` if it fell back; `reconnected:true` when restored from pending), `lobby` (snapshot, `seats[i].pending` flags disconnected-but-held seats; pushed immediately on connect), `start`, `roll`/`move` (with `from` and `seq`), `left` (with `pending` if the seat is held for reconnect), `reconnected`, `reconnectExpired`, `snapshotReq` (server asks a peer to build a snapshot for the reconnecting client), `snapshot` (relayed state to the reconnecting client), `authRequired`.

Seat = color: seat index (0-3) is the player's fixed identity **and** color slot (COLORS/SQUADS/START are indexed by seat). Players pick their seat in the lobby (先到先得) via `join`/`pickSeat`; server is authoritative and silently reassigns on conflict.

### Reconnect (5-minute window)

Reconnect identity is the account: the server sets `clientId = 'user-' + user.id` and ignores any client-supplied value. On disconnect *during play*, server reserves the seat in `pending` for `RECONNECT_WINDOW_MS` (5 min); the host client CPU-plays that seat in the meantime (`pendingSeats` set + `seatIsBotLike`). On reconnect, server matches by `clientId` → restores seat and asks another seated peer for a `snapshot` (pieces/turf/cur/dice/…) — the returning client applies it, then flushes any relay messages buffered while waiting (dedup by `seq`). Lobby-phase disconnects release the seat immediately (no pending). If every client drops mid-game, room state is **kept** until all pending windows expire — don't "clean up" on `clients.size === 0` during play.

### Game state

`pieces` (4 players × 4 pieces, `progress` -1=home, 0–50 shared track, 51–55 home column, 56 = finished at goal), `trackIdx()` maps track progress to the shared 52-cell loop, `SAFE` star cells (includes each home's start cell — start cells are safe **only for their owner**, `isSafeFor`), turf-painting overlay tracks cells each player has inked (`paintTurf`/`updateTurfBars`).

### Game rules (beyond vanilla Ludo)

- **One-shot ink shield**: a piece on a track cell whose `turf[idx]` matches its owner blocks one capture attempt — the shield then **breaks** (cell turf cleared to -1), leaving the piece unprotected next time.
- **Enemy-ink brake**: if a move ends on a cell where the pre-existing turf belongs to another player, the mover forfeits the extra roll for having rolled a 6 (extra rolls from captures / reaching goal still apply). `resolveLanding` reads `turf[idx]` BEFORE painting.
- **Capture surge**: after capturing, the mover surges `CAPTURE_SURGE` (3) extra cells forward (`captureSurge`), stopping early at the goal, an enemy blockade, or past progress 56. Landing at the surge destination is resolved again but with `allowSurge:false` — no chain surges.
- **Opening boost**: while all of a player's pieces are at home or finished (`allInYardOrGoal`), a rolled turn that produces no legal move re-rolls, up to 3 total attempts (`rollAttempts`).
- **Triple-6 void**: three consecutive 6s in a turn (`sixStreak`) → applyRoll skips to `nextTurn(false)` before any move.
- **Blockade**: 2+ same-color pieces on a track cell (progress 0–50) can't be captured and enemies can't land or pass through (`blockadeAt`, `pathBlocked` gates `movablePieces`).
- **Flight (✈)**: exactly-landing on your own flight cell (`progress===FLIGHT_FROM` = 20) teleports to `FLIGHT_TO` = 32 via `flyAnim`; capture at cell 20 resolves before flight; a same-color enemy blockade at cell 32 aborts the flight.

## Game: 口袋蛋仔 (`public/games/tamagotchi/index.html`)

Single-player Tamagotchi-style virtual pet. Canvas pixel LCD + hand-drawn pixel icons + Web Audio beeps; interaction replicates the original device (A=move cursor / B=confirm / C=cancel, keyboard works too).

- **Simulation is fully client-side**, ticked per-minute in `applyElapsed` so offline time counts — the pet ages, poops, sickens, and can die while the tab is closed (catch-up capped at 3 weeks). Death is real: sick >36h untreated, or hunger/happiness at zero accumulating 48h.
- **Save**: `GET/POST /api/games/tamagotchi/pet` (`pets` table, one JSONB row per user, upsert). Saved on every action + 60s interval + `sendBeacon` on tab hide. Loading merges the saved blob into `newEgg()` defaults — **adding fields to the pet state never breaks old saves**; keep it that way.
- **3D shell**: the only game with an external dep — three.js via CDN import map (jsdelivr, pinned version). `initEgg3D`: LatheGeometry egg + MeshPhysicalMaterial clearcoat + RoomEnvironment reflections; shell pattern painted into a CanvasTexture. DOM screen/buttons overlay the WebGL canvas. 3D init failure is non-fatal — the game must stay playable without it.
- **Skin system**: all shell visuals (gradient, spots, buttons, LCD palette) live in the `SKINS` config; `applySkin()` drives both CSS variables and the WebGL texture repaint. Adding a new colorway/generation = one `SKINS` entry. Choice persists in `pet.skin` and survives pet death/rebirth.

## Language

UI text, log messages, and README are Simplified Chinese — keep new user-facing strings in Chinese.
