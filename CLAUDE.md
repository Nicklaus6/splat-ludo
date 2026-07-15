# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `pnpm start` — run the server (port 3000, or `PORT` env var). Requires PostgreSQL — configure via `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` env vars.
- No build, lint, or test tooling exists. Deps: `ws`, `pg`. Use `pnpm` (not npm/yarn).

## Architecture

Splatoon-styled online multiplayer Ludo. Runs a single Node process serving both the game (WebSocket) and auth (email/password + session cookies). Core surfaces:

- **`server.js`** (~120 lines): HTTP static file server + WebSocket relay. Contains **no game rules** — it only manages a single room (lobby phase, 4 seats, waiting queue, host = lowest occupied seat) and relays `roll`/`move` messages from seated players to everyone with `from: seat` attached.
- **`public/index.html`** (~1000 lines): the entire game as one file — SVG board rendering, animations, Web Audio sound synthesis, Ludo rules, CPU AI, and networking. Zero frontend dependencies.

### Deterministic lockstep sync (the key design constraint)

Clients stay in sync via a deterministic state machine, not server-authoritative state. The server broadcasts only *inputs* ("seat X rolled a 4", "seat X moved piece i"); every client independently applies identical rules (`applyRoll`, `applyMove`, `nextTurn`) so all screens converge. Consequences when editing:

- Any game-rule change must be deterministic given the same message sequence — no client-local randomness or timing affecting game state.
- Dice rolls originate on the acting client and are broadcast; CPU decisions are computed **only by the host client** (`aiPick`) then broadcast like normal moves. Disconnected/empty seats are played as CPU by the host.
- Animations are chained through a promise queue (`enqueue`) so network messages apply in order without racing.

### Server protocol (JSON over WebSocket)

Client→server: `join` (name, optional preferred `seat` 0-3, `clientId` for reconnect), `pickSeat` (change color mid-lobby), `start`/`restart` (host only), `roll`/`move` (relayed), `snapshot` (mid-game state upload for a reconnecting peer).
Server→client: `welcome`, `seated` (final `seat` + optional `preferred` if it fell back; `reconnected:true` when restored from pending), `lobby` (snapshot, `seats[i].pending` flags disconnected-but-held seats), `start`, `roll`/`move` (with `from` and `seq`), `left` (with `pending` if the seat is held for reconnect), `reconnected`, `reconnectExpired`, `snapshotReq` (server asks a peer to build a snapshot for the reconnecting client), `snapshot` (relayed state to the reconnecting client).

Seat = color: seat index (0-3) is the player's fixed identity **and** color slot (COLORS/SQUADS/START are indexed by seat). Players pick their seat in the lobby (先到先得) via `join`/`pickSeat`; server is authoritative and silently reassigns on conflict.

### Reconnect (5-minute window)

Each browser has a stable `clientId` in localStorage. On disconnect *during play*, server reserves the seat in `pending` for `RECONNECT_WINDOW_MS` (5 min); the host client CPU-plays that seat in the meantime (`pendingSeats` set + `seatIsBotLike`). On reconnect, server matches by `clientId` → restores seat and asks another seated peer for a `snapshot` (pieces/turf/cur/dice/…) — the returning client applies it, then flushes any relay messages buffered while waiting (dedup by `seq`). Lobby-phase disconnects release the seat immediately (no pending).

### Game state in index.html

`pieces` (4 players × 4 pieces, `progress` -1=home, 0–50 shared track, 51–55 home column, 56 = finished at goal), `trackIdx()` maps track progress to the shared 52-cell loop, `SAFE` star cells (includes each home's start cell), turf-painting overlay tracks cells each player has inked (`paintTurf`/`updateTurfBars`).

### Game rules (beyond vanilla Ludo)

- **Own-ink shield**: a piece on a track cell whose `turf[idx]` matches its owner cannot be captured.
- **Enemy-ink brake**: if a move ends on a cell where the pre-existing turf belongs to another player, the mover forfeits the extra roll for having rolled a 6 (extra rolls from captures / reaching goal still apply). `resolveLanding` reads `turf[idx]` BEFORE painting.
- **Opening boost**: while all of a player's pieces are at home or finished (`allInYardOrGoal`), a rolled turn that produces no legal move re-rolls, up to 3 total attempts (`rollAttempts`).
- **Triple-6 void**: three consecutive 6s in a turn (`sixStreak`) → applyRoll skips to `nextTurn(false)` before any move.
- **Blockade**: 2+ same-color pieces on a track cell (progress 0–50) can't be captured and enemies can't land or pass through (`blockadeAt`, `pathBlocked` gates `movablePieces`).
- **Flight (✈)**: exactly-landing on your own flight cell (`progress===FLIGHT_FROM` = 20) teleports to `FLIGHT_TO` = 32 via `flyAnim`; capture at cell 20 resolves before flight; a same-color enemy blockade at cell 32 aborts the flight.

## Language

UI text, log messages, and README are Simplified Chinese — keep new user-facing strings in Chinese.
