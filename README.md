# Telegram auto-poster bot

Send the bot anything — text, photos, videos, albums, files, links — and it queues it.
Once the target channel has been quiet for the configured delay, the bot publishes the
next item from the queue. A web dashboard shows the countdown, the queue, and every setting.

## Stack

Node + Express + TypeScript · grammY · Drizzle ORM + SQLite · React + Vite + Tailwind v4 ·
Vitest · Docker

## Quick start

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run dev
```

The API runs on `http://localhost:3000` and the dashboard on `http://localhost:5173`
(Vite proxies `/api` to the server). For a single-port production run:

```bash
npm run build
```

```bash
npm start
```

…then open `http://localhost:3000`.

## Setup checklist

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Paste the token into **Configuration → Bot token** in the dashboard and save. The bot
   restarts automatically.
3. Message the bot on Telegram. It replies with your numeric user ID — add it under
   **People** as an **admin** and save. From then on only listed users may talk to the bot.
4. Add the bot to your channel as an **administrator with “Post messages”**. The channel
   appears in the dashboard on its own. If the bot was already in the channel before it
   was configured, register it with the **Add** field (`@channelname` or `-100…`).
5. Set the delay and time zone, then start sending posts to the bot.

`BOT_TOKEN`, `ADMIN_IDS`, `MANAGER_IDS` and `TZ_NAME` in `.env` are optional shortcuts —
they seed the database the first time it is created, and are ignored afterwards. The
dashboard is the source of truth.

## People and roles

Any number of people may use the bot, in one of two roles. Manage them under **People** in
the dashboard: add a numeric Telegram user ID, change a role, or remove someone. Anyone not
on the list is ignored silently.

| | Admin | Manager |
| --- | --- | --- |
| Send posts to the queue | ✅ | ✅ |
| `/queue`, `/till`, `/summary`, `/help` | ✅ | ✅ |
| `/delay`, `/post`, `/pause`, `/resume`, `/clear` | ✅ | — |
| Dashboard | ✅ | — |

Managers are for people who should only feed the queue: they can add content and see when
it goes out, but cannot change the delay, publish early, pause posting, or empty the queue. The dashboard
itself has no per-user login — it is gated by `DASHBOARD_PASSWORD` and is admin territory,
so don't hand the password to a manager.

The last admin cannot be removed or demoted; promote someone else first. That is the only
thing standing between you and a bot nobody can configure.

## Bot commands

| Command | What it does | Role |
| --- | --- | --- |
| `/delay N` | Set the delay between posts to N minutes | admin |
| `/queue` | How many posts are waiting | any |
| `/post` | Publish the next queued item immediately | admin |
| `/till` | Time until the next automatic post | any |
| `/pause` | Stop automatic posting; the queue keeps filling | admin |
| `/resume` | Start automatic posting again | admin |
| `/clear` | Empty the queue | admin |
| `/summary` | Queue size, next post time, and total runway (queue × delay) | any |
| `/help` | Command list for your role | any |

Any non-command message is queued, and the bot replies with the new queue size. Use
`/till` or `/summary` for the schedule.

## Pausing

`/pause` (or **Pause posting** in the dashboard header) stops the automatic schedule.
Posts still queue up while paused, the countdown just stops — the dashboard and `/till`
say so. Publishing by hand still works: `/post` and **Post next now** are deliberate
actions and override the pause. `/resume` puts the schedule back; since the delay is
measured from the last message in the channel, a queue that was already overdue goes out
on the next check.

## Reactions on your messages

The bot reacts to the message you sent it, so the chat itself doubles as a status list:

| Reaction | Meaning |
| --- | --- |
| ⚡ | First in the queue — this is the next post to go out |
| 👍 | Published to the channel |
| (a reply) | Posting failed; the reply has the error, and the post stays first in the queue for the next attempt |

Telegram only lets bots use a fixed set of reaction emoji, which is why "next up" is ⚡
rather than ❗. Swap it for any other allowed one in `NEXT_UP_EMOJI`
(`src/server/services/poster.ts`).

## How the delay works

The countdown is measured from **the last message seen in the channel**, not from the
bot's last post. The bot records the timestamp of every `channel_post` update, so a post
you make by hand also pushes the schedule back. A scheduler tick runs every minute; when
`now − lastChannelMessage ≥ delay` and the queue is non-empty, the head of the queue is
published.

If the channel has no recorded activity yet, the first queued item goes out on the next
tick.

## Live dashboard

The dashboard never needs a refresh. It holds one server-sent-events stream open on
`GET /api/events`, and the server pushes a full snapshot — bot state, settings, people,
channels, queue, counters — whenever anything changes: a post queued from Telegram, a
scheduler run, an edit made in another browser tab. Idle streams cost one small frame
every 25 s.

Changes made outside the app (a direct write to the database, say) are picked up by a
revalidation pass every 5 s, so the stream never goes stale. `GET /api/status` still
returns the same snapshot for anything that cannot hold a stream open, and the dashboard
falls back to it while reconnecting — a dropped connection shows **reconnecting…** in the
header and retries with backoff.

The stream is read with `fetch` rather than `EventSource` so that `DASHBOARD_PASSWORD`
travels in a header instead of the query string.

## Notes and limitations

- **Nothing is re-uploaded.** A queued item is a reference to the original message in your
  chat with the bot; publishing uses `copyMessage` / `copyMessages`. Deleting your original
  message before it is published will make that item fail to post.
- **Albums** are grouped back together: messages sharing a `media_group_id` are collected
  for 1.5 s and stored as one queue item.
- **Channel discovery** relies on Telegram updates — there is no API to list a bot's chats.
  A channel shows up when the bot is added/promoted or when the first channel post arrives;
  otherwise add it manually in the dashboard.
- **Target channel**: if the bot administers exactly one channel it is used automatically.
  With several, pick one in **Configuration → Target channel**.
- **Long polling** is used, so no public URL or webhook setup is needed. Run one instance
  only — two processes polling the same token will fight over updates.

## Security

The dashboard stores the bot token, so do not expose it. Set `DASHBOARD_PASSWORD` in
`.env` to require a shared secret on every `/api` call; the server logs a warning at boot
when it is unset. Bind the port to localhost or put it behind a reverse proxy with TLS if
it needs to be reachable remotely.

## Self-hosting with Docker

```bash
docker compose up --build -d
```

The dashboard is then on `http://localhost:3000`, and everything the bot knows —
settings, people, channels, queue and post history — lives in one SQLite file under
`./data`, so a redeploy keeps the queue. Migrations run at boot, before the server
accepts traffic; a failed migration fails the start rather than serving against an old
schema.

Every knob has a default, so a bare `docker compose up` works. Override any of them in
`.env` (or the host environment) instead of editing the compose file:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Host port published for the dashboard |
| `DATA_DIR` | `./data` | Host directory holding the SQLite database |
| `DASHBOARD_PASSWORD` | *(empty)* | Shared secret for every `/api` call — set it if the dashboard is reachable from anywhere but localhost |
| `BOT_TOKEN`, `ADMIN_IDS`, `MANAGER_IDS`, `TZ_NAME` | *(empty)* | Bootstrap values, used only when the database is first created |
| `TZ` | `UTC` | Container clock |
| `IMAGE` | `tg-auto-poster-bot` | Image name to build/run |

Two things worth knowing:

- The container runs as a **non-root user**, so the host directory behind `DATA_DIR`
  must be writable by it (`chown 1000:1000 ./data` covers the usual case).
- `.env` is dockerignored on purpose — compose supplies the environment at runtime, so
  no secret is ever baked into the image.

Published images are `<dockerhub-user>/tg-auto-poster-bot:<version>` and `:latest`; to run
one without building, replace `build: .` with `image:` in `docker-compose.yml`.

## Releases

The `version` field in `package.json` is the release trigger — nothing ships until it
changes on `main`.

```bash
npm run release:patch
```

Commit the bump and push to `main`. The `Release` workflow wakes only when
`package.json` is touched, compares the version against the previous commit, and on a
real change runs the typecheck and the tests, pushes the tag `vX.Y.Z`, and publishes the
image to Docker Hub as both `:X.Y.Z` and `:latest`. An unchanged version means nothing
runs, so ordinary dependency edits are free. Use `release:minor` for features and
`release:major` for breaking changes; a bump on its own is enough to rebuild, no code
change needed.

The tag is created by CI, never locally, so local and remote tags cannot diverge. The
workflow needs two repository secrets under **Settings → Secrets and variables →
Actions**: `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub access token, not
the account password).

## Tests

```bash
npm test
```

Vitest, no watch mode in CI (`npm run test:watch` for local work). The server tests run
against a real SQLite database: each test file gets its own throwaway file in the
system temp directory, migrated once and emptied between tests, so nothing is stubbed
except the Telegram API and the clock. The HTTP tests boot the real Express router on
an ephemeral port.

## Project layout

```
src/server
  api/          Express routes, dashboard auth, snapshot + SSE stream
  bot/          grammY bot: lifecycle, handlers, album buffer, scheduler
  db/           Drizzle schema and connection
  services/     settings, users/roles, queue, channels, posting logic
  test/         scratch-database helpers for the test suite
src/web         React dashboard (Vite root)
drizzle/        generated SQL migrations, applied at boot
```

Tests sit next to the code they cover, as `*.test.ts`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Server (watch) + Vite dev server |
| `npm run build` | Compile the server and bundle the dashboard |
| `npm start` | Run the compiled server, serving the built dashboard |
| `npm run typecheck` | Type-check server, tests and web |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Re-run tests as files change |
| `npm run db:generate` | Regenerate migrations after editing the schema |
| `npm run release:patch` \| `:minor` \| `:major` | Bump the version to cut a release |
