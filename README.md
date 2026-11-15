<div align="center">

# Discord Quest Auto

**Finish Discord quests from your terminal.**
Video · Play · Activity · Achievement — no browser, no database, no proxy.

[![CI](https://github.com/KashikoKanda/discord-quest-auto/actions/workflows/ci.yml/badge.svg)](https://github.com/KashikoKanda/discord-quest-auto/actions/workflows/ci.yml)
[![Quests](https://github.com/KashikoKanda/discord-quest-auto/actions/workflows/quests.yml/badge.svg)](https://github.com/KashikoKanda/discord-quest-auto/actions/workflows/quests.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-informational)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-linux%20%7C%20macos%20%7C%20windows%20%7C%20termux-6f42c1)](#platforms)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Quick start](#quick-start) · [Platforms](#platforms) · [Commands](#commands) · [Bot](#discord-bot) · [How it works](#how-it-works) · [Troubleshooting](#troubleshooting)

</div>

---

## Why this exists

Discord hands out Orbs for watching a video, playing a game, or sitting inside an
activity. The official client does all of that quietly in the background. This tool
does the same thing, except it prints what it is doing in a terminal window and takes
one account token to start.

- **One process, one token.** No Docker, no database, no browser automation.
- **Real pacing.** Every request goes through a per-token queue: 1.5–3 s apart, `429`
  respected, `5xx` backed off exponentially, one quest at a time by default.
- **Stable identity.** User agent, locale, timezone, launch id and session id are
  generated once per token and reused, so Discord keeps seeing the same device.
- **Works where you are.** Linux, macOS, Windows `cmd`/PowerShell, Android Termux,
  or GitHub Actions if you would rather not keep a machine awake.

<a id="quick-start"></a>

## Quick start

```bash
git clone https://github.com/KashikoKanda/discord-quest-auto
cd discord-quest-auto
npm install
npm start
```

No `.env` yet? `npm start` asks for the token in the terminal, hides what you type, and
offers to save it to `.env` so you never paste it twice.

Prefer files? Copy the example and fill it in:

```bash
cp .env.example .env      # Windows cmd: copy .env.example .env
```

```ini
TOKEN=your_account_token
```

Then `npm start`. Quests run one after another, and the tool stops when nothing is left.

Already have the token in a variable? Pipe it in and skip the prompt:

```bash
echo "$TOKEN" | npm start
```

Habits worth keeping: `npm run list` before a run, `npm run claim` after one, and
`npx tsx bot.ts stop` when a background loop needs to go.

> The token is a **user** token, not a bot token. `npm start` prints an invite link if
> the account is not in the server that Discord requires for rewards.

<a id="platforms"></a>

## Platforms

### Linux and macOS

```bash
npm install && npm start
```

Long runs belong in tmux or screen:

```bash
tmux new -s quest 'npm run auto'
# leave: Ctrl-B then D      come back: tmux attach -t quest
```

### Windows (cmd and PowerShell)

```bat
npm install
copy .env.example .env
npm start
```

The token prompt, colours, `list`, `claim`, `auto`, `status` and `stop` all behave the
same in `cmd` and PowerShell. In PowerShell you can also pass the token inline:

```powershell
$env:TOKEN = 'your_account_token'; npm start
```

No colour in an old console or a redirected pipe? It turns itself off. Force it with
`--no-color` or `set NO_COLOR=1`.

### Android (Termux)

```bash
pkg update && pkg install nodejs-lts git
git clone https://github.com/KashikoKanda/discord-quest-auto
cd discord-quest-auto
npm install
npm start
```

Termux notes, in the order they usually matter:

| Situation                           | What to do                                                        |
| :---------------------------------- | :---------------------------------------------------------------- |
| Phone sleeps and the run dies       | `termux-wake-lock` before starting, `termux-wake-unlock` after    |
| Session closes when you switch apps | `pkg install tmux`, then `tmux new -s quest 'npm run auto'`       |
| `npm install` fails on esbuild      | `pkg install python make clang`, then `npm install` again         |
| Storage blocked                     | Keep the project in `~/discord-quest-auto`, not on shared storage |

Battery and network are the real limits on a phone. `npm start` finishes and exits,
which is the friendliest mode for Termux; `npm run auto` is for a plugged-in device.

### GitHub Actions

No machine to babysit, no secret to create first.

1. **Fork** this repository (or use it directly).
2. Open **Actions → Quests → Run workflow**.
3. Paste the token, leave the **multi** switch on, press **Run workflow**.

| Input      | What it does                                                                        |
| :--------- | :---------------------------------------------------------------------------------- |
| `token`    | Account token. Masked in the log before anything runs, never written to disk        |
| `multi`    | **On** (default) every quest that still needs work, **off** only the `quest_id` one |
| `quest_id` | Quest id, required when `multi` is off                                              |
| `gap`      | Minimum seconds between two quests, default `10`                                    |

The workflow keeps `.quest-store.json` in the Actions cache, so an account keeps one
device identity across runs, and uploads the log as an artifact. A run **completes
quests only**; claiming rewards stays on your machine (`npm run claim`).

Want to skip the prompt? Add a repository secret named `DISCORD_TOKEN`.

<a id="commands"></a>

## Commands

| Command                     | What it does                                           |
| :-------------------------- | :----------------------------------------------------- |
| `npm start`                 | Run every available quest, then exit                   |
| `npm run list`              | List quests with progress                              |
| `npm run hidden`            | Every quest in the public catalogue your account lacks |
| `npm run hidden -- --image` | Also renders them as a grid of cover art               |
| `npm run proxy`             | Show the proxy source, count and per-country split     |
| `npm run claim`             | Claim rewards for quests that already finished         |
| `npm run auto`              | Run as a background loop, rescanning every 5 minutes   |
| `npm run status`            | Show the background loop and live Discord progress     |
| `npx tsx bot.ts stop`       | Stop a running `run` or `auto`                         |

### Flags

```bash
npx tsx bot.ts run --quest=<id>     # a single quest
npx tsx bot.ts run --multi          # every quest at once instead of one by one
npx tsx bot.ts run --gap=20         # at least 20 s between two quests
npx tsx bot.ts run --log=run.log    # custom log file (default logs/quest-<date>.log)
npx tsx bot.ts hidden               # quests in the public catalogue your account cannot see
npx tsx bot.ts hidden --enroll=<id> # enrol one of them so it enters the normal run
npx tsx bot.ts hidden --country=VN  # compare against another region (default VN)
npx tsx bot.ts list --all           # include claimed quests
npx tsx bot.ts list --json          # machine readable
npx tsx bot.ts auto --force         # skip the required-server check
npx tsx bot.ts run --token=<token>  # override the token from .env
npx tsx bot.ts run --no-color       # plain output for logs
```

### Configuration

| Variable      | Default             | Meaning                                    |
| :------------ | :------------------ | :----------------------------------------- |
| `TOKEN`       | required            | Account token; the prompt fills it for you |
| `QUEST_STORE` | `.quest-store.json` | Where each token's fingerprint lives       |
| `QUEST_STATE` | `.quest-state.json` | pid file used by `status` and `stop`       |
| `NO_COLOR`    | unset               | Any value disables ANSI colours            |

Both JSON files are created on first run and are git-ignored.

<a id="discord-bot"></a>

## Discord bot

A small bot can hold the same engine behind slash commands, so an account can be run
from a phone without a terminal.

```bash
# put the bot token in .env
DISCORD_BOT_TOKEN=your_bot_token
npm run bot
```

On first start the bot publishes its commands globally and prints its own tag when the
gateway is ready.

| Command        | What it does                                                  |
| :------------- | :------------------------------------------------------------ |
| `/link`        | Opens a private form; paste the account token there           |
| `/quests`      | Quest list with type, state and progress bars                 |
| `/hidden`      | Hidden quests one card at a time: back, enrol, next |
| `/proxy`       | Proxy list health; `/proxy reload:true` refetches it          |
| `/run [quest]` | Complete quests, progress streams into the reply              |
| `/stop`        | Stop the current run                                          |
| `/claim`       | Claim rewards for finished quests                             |
| `/status`      | Engine state, progress and the latest log lines               |
| `/auto`        | Scan every 30 minutes on its own                              |
| `/unlink`      | Forget the linked account                                     |
| `/help`        | Command overview                                              |

Every reply is private to the person who ran the command. Tokens live in
`.quest-bot.json` (mode `600`, git-ignored) and are never echoed back; the bot never
logs them either.

### Token hygiene

Discord scans messages, gists and public repositories and revokes any token it finds
there. That is the usual reason a token stops working minutes after it was created.

- Paste the token into the private `/link` form or `.env`, never into a chat message,
  a screenshot, a commit or an issue.
- Logs are scrubbed: anything that looks like a token becomes `<đã che>` before it is
  written, and the startup line only shows an eight character fingerprint.
- When Discord rejects a token, the bot writes `.quest-bot-dead`, exits with code 78 and
  stops retrying; the watchdog waits instead of hammering the gateway. A new token
  clears the marker and everything resumes.

<a id="how-it-works"></a>

## How it works

```
bot.ts              worker.ts            api/client.ts             Discord
──────              ─────────            ─────────────             ───────
read .env    ──▶    open gateway    ──▶  GET  /quests/@me
                    list quests
                    quests/index.ts ──▶   POST /quests/@me/enroll
                    poll user_status
                    claim (manual)  ──▶   POST /quests/@me/{id}/claim
```

```
bot.ts                  command line: flags, token, log tail
src/
  api/
    client.ts           REST: fingerprint headers, build number, list/enroll/claim
    gateway.ts          socket gateway: identify, presence, heartbeat
  core/
    state.ts            per-token state: queue, logs, progress, abort controllers
    queue.ts            per-token API queue: spacing, 429 retry, 5xx backoff
    store.ts            fingerprint storage
    config.ts           .env, token id, pid file
    constants.ts        endpoints, required server, timings
    interface.ts        shared types
    logger.ts           terminal and file output
  quests/
    quest.ts            quest shape helpers + the Quest wrapper
    video.ts            WATCH_VIDEO, WATCH_VIDEO_ON_MOBILE
    play.ts             PLAY_ON_DESKTOP and the console variant
    activity.ts         PLAY_ACTIVITY
    achievement.ts      ACHIEVEMENT_IN_ACTIVITY
    index.ts            dispatcher: skip, enroll, hand off to the right handler
  worker.ts             run orchestration: batches, auto loop, public API
```

Adding a quest type means one file in `src/quests/` and one `case` in
`src/quests/index.ts`.

### Quest types

| Type                                                     | Module           | How it completes                                                                        |
| :------------------------------------------------------- | :--------------- | :-------------------------------------------------------------------------------------- |
| `WATCH_VIDEO`, `WATCH_VIDEO_ON_MOBILE`                   | `video.ts`       | Sends `video-progress` with an increasing timestamp until the seconds are met           |
| `PLAY_ON_DESKTOP`, `PLAY_ON_XBOX`, `PLAY_ON_PLAYSTATION` | `play.ts`        | Presence plus heartbeat with the application id until Discord reports it done           |
| `PLAY_ACTIVITY`                                          | `activity.ts`    | Activity heartbeat until the duration is reached                                        |
| `ACHIEVEMENT_IN_ACTIVITY`                                | `achievement.ts` | Ticket, activity instance, heartbeat on `*.discordsays.com` until the achievement fires |
| `STREAM_ON_DESKTOP`                                      | skipped          | Discord only counts a stream from a real desktop client                                 |

### Three rules that keep an account alive

- **One queue per token.** Requests are 1.5–3 s apart, `retry-after` is honoured and
  `5xx` backs off exponentially. Two requests never overlap.
- **Progress in real time.** A video quest sends one second of watch time per real
  second; play and activity quests heartbeat every 30 s like the real client.
- **One fixed fingerprint.** User agent, locale, timezone, launch id and session id are
  generated once per token and reused on every later run.

Quest by quest is the default. `--multi` runs them together, still through the same
queue, still with `gap` seconds between starts in the Actions workflow.

<a id="troubleshooting"></a>

## Troubleshooting

| Symptom                                          | Cause                                                            |
| :----------------------------------------------- | :--------------------------------------------------------------- |
| `Invalid or expired token`                       | Token was rotated or pasted wrong, grab a fresh one              |
| Token prompt keeps coming back                   | Nothing saved to `.env`; answer `y` to the save question         |
| Quest finished but no reward                     | Account is not in the server Discord requires                    |
| A quest is skipped as "not available on Node.js" | That is `STREAM_ON_DESKTOP`                                      |
| Video quest stalls halfway                       | Gateway session dropped, run again                               |
| `EACCES` creating `logs/`                        | Run from the project folder, or pass `--log=` somewhere writable |
| Odd symbols instead of colours                   | Old console; `--no-color` or `NO_COLOR=1`                        |

## Hidden quests

`npm run hidden` reads the public quest catalogue at discordquest.com, diffs it
against `/quests/@me` and lists every quest the linked account does not have yet,
with the region it is tied to. Nothing is filtered by region, so the list is the
full picture; Discord decides at enrolment time whether the account may join.

Regions matter when you enrol. Point `PROXY_LIST_URL` at a raw GitHub file and the
API request for a region-locked quest goes through a matching proxy:

```bash
PROXY_LIST_URL=https://raw.githubusercontent.com/<you>/<repo>/main/proxies.txt
```

Each line is one proxy, optionally tagged with a country:

```
host:port
host:port:user:pass#DE
user:pass@host:port#JP
socks5://user:pass@host:port#TH
```

Editing that file on GitHub is enough: the list is reloaded every ten minutes
(`PROXY_REFRESH_MIN`), cached on disk between restarts, and a quest without a
matching proxy falls back to a direct request so nothing is lost.

## Development

```bash
npm run typecheck     # tsc --noEmit
npm run format        # prettier --write
npm run ci            # typecheck + format check
```

CI runs exactly those two checks on every push and pull request.

## Disclaimer

Use your own token and your own account. Automating an account can violate Discord's
Terms of Service; the risk is yours. This project exists to save a few minutes of
watching a video, not to farm a marketplace.

## License

MIT
