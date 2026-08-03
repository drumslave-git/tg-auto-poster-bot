# Telegram auto-poster bot

Send the bot anything — text, photos, videos, albums, files — and it queues it. Send a
link and it downloads the media behind it and queues that instead. Once the target
channel has been quiet for the configured delay, the bot publishes the next item from the
queue. A web dashboard shows the countdown, the queue, and every setting.

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
5. Set the delay and time zone, then start sending posts to the bot. Posting hours and a
   standing footer are optional and can be added at any point.

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

The same list is published to Telegram as the bot's ☰ menu, so the commands are one
tap away and autocomplete as you type. Each person sees only what their role can use:
an admin's menu carries all nine, a manager's carries the four they may run. Strangers
see just `/start` and `/help`. The menu is set when the bot starts and again whenever
you add, promote or remove someone in the dashboard — someone added before they ever
opened the bot gets theirs the first time they write.

## Links become media

Send a link and the link is not what gets queued — the media behind it is. The bot hands
the URL to [yt-dlp](https://github.com/yt-dlp/yt-dlp), replies to your message with the
downloaded file, and queues **that reply**. Your link message stays out of the queue
entirely.

The reply carries a caption with the title and a `🔗 Source:` link back to where it came
from, and that caption travels to the channel with the post.

**Write something alongside the link and your words become the caption instead of the
scraped title** — the link itself is lifted out, and your line breaks are kept:

```
https://example.com/clip
Best goal of the season 🔥
```

queues the video captioned `Best goal of the season 🔥` above the source line. A link
written behind words (Telegram's "hidden" links) keeps the whole sentence, since the URL
was never part of what you typed.

Two switches in **Configuration** change what happens around this:

- **Add the title and a source link to downloaded posts** — on by default. Turn it off and
  the title and the `🔗 Source` line are both dropped; whatever you wrote with the link is
  then the entire caption, and a link sent bare produces a post with no caption at all.
- **Queue the message as it is when a download fails** — off by default. Turn it on and a
  link the downloader cannot handle no longer costs you the post: your original message is
  queued verbatim, link and all. The bot still replies with why the download failed.

- **50 MB ceiling.** That is all Telegram lets a bot upload, so it is also the download
  limit. yt-dlp skips anything it knows is too big before spending bandwidth on it, and
  the finished file is measured again — sites that report no size cannot sneak past.
- **What you get**: a single video (never a whole playlist), preferring ≤1080p h264 in an
  mp4 so Telegram plays it inline. Audio, images and GIFs are sent as their own kinds;
  anything else goes as a file.
- **Public `http(s)` links only.** Any other scheme is refused, and so is any host that
  resolves to a loopback, private, link-local or otherwise non-routable address. Without
  that, anyone allowed to send the bot a link could have it read your dashboard API, your
  cloud provider's metadata service, or any box on the LAN, and post the answer to the
  channel. Treat it as a guard, not a boundary: it cannot follow a redirect into a private
  range, so restrict the container's egress if you need that guaranteed.
- **If the download fails**, the bot replies to your link with yt-dlp's reason — private
  video, unsupported site, over the limit, no media there — and **nothing is queued**,
  unless the fallback switch above is on. Downloads run one at a time, so several links in
  a row are handled in order.
- Only text-only messages count. A photo or video whose *caption* holds a link is already
  a post and is queued untouched.

### The tools behind it

`yt-dlp` and `ffmpeg` are taken from `PATH` — there is nothing to configure. The Docker
image ships both; for a local `npm run dev` install them yourself (`brew install yt-dlp
ffmpeg`, `winget install yt-dlp.yt-dlp Gyan.FFmpeg`, or your distro's packages). Without
yt-dlp a link gets a "not installed" reply instead of a post, and the dashboard says so.

**Media tools** in the dashboard shows the installed version of each, when they were last
read, and when the next check is due. Extractors break whenever a site changes, so the
app runs `yt-dlp -U` at boot and once a day after that; **Update now** does it on demand.
The panel reports what happened — updated, already current, or why not.

Two things worth knowing about that:

- The image installs yt-dlp as the official standalone release in `/app/bin`, owned by the
  app user, because that is the only kind of install its updater will touch. A yt-dlp that
  came from apt, apk, brew or pip reports `unsupported` in the dashboard and has to be
  updated the same way it was installed — which is the normal state of affairs for a local
  dev machine.
- **ffmpeg has no self-update** — no build of it does — so the dashboard only reports its
  version, and it moves forward when you pull a newer image. That costs nothing in
  practice: ffmpeg just muxes the streams yt-dlp hands it, and that does not drift the way
  extractors do.

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

### Posting hours

By default the delay is the only thing standing between two posts, day or night. Set
**Post from** and **Post until** in the dashboard to confine posting to part of the day —
`13:00` to `17:00`, say. Both are read on the clock of the configured **time zone**, and
the end is exclusive: a 17:00 end means the last post of the day can go out at 16:59.

- A countdown that runs out inside the window publishes as usual.
- One that runs out after closing time waits for the window to open again.
- A window the bot slept through is a window it missed: the backlog waits for the next
  opening rather than spilling out at midnight all at once.
- A start later than the end wraps past midnight — `22:00` to `02:00` is a four-hour
  window over two dates.
- Leave both empty to post around the clock. **Queue empties** and `/summary` follow the
  window, so the projection stays honest once posting is down to a few hours a day.

### A standing footer

**Footer** in the dashboard is appended to every post that goes to the channel — the
"Subscribe to my awesome channel!" line most channels carry. It is stored once and applied
at publishing time, so editing it changes what everything still queued will say.

How it is attached depends on what the post is:

| Post | How the footer travels |
| --- | --- |
| Photo, video, GIF, audio, document, voice | Appended to the caption as the post is copied |
| Text | Appended to the text (the post is re-sent, since a copy cannot be reworded) |
| Album, sticker, poll, location | Follows as a message of its own — none of these has a caption to extend |

A caption holds 1024 characters in total, so if the two together are too long the **post**
is shortened and the footer is kept whole. Posts queued before the footer existed keep
their original caption and get the footer as a separate message; there is no record of
their text to append to.

## Watermarks

Upload a PNG in **Watermark** on the dashboard, switch it on, and every image and video
that reaches the queue is stamped with it first.

The watermark is applied **as the post arrives**, not as it goes out. Send a photo, and the
bot sends the stamped copy back to you and queues *that* — so what sits in the queue is
already what the channel will get. Doing it this way keeps publishing a plain
`copyMessage`, keeps a download-plus-re-encode off the scheduler's critical path, and means
a failure is reported to you while you are still in the chat instead of stalling the queue
head. It also makes a [downloaded link](#links-become-media) nearly free to stamp: that
file is already on disk.

Four settings shape it, all percentages:

| Setting | What it means |
| --- | --- |
| **Horizontal** / **Vertical** | Where it sits, as a share of the room it has to move in: `0` is flush left/top, `50` is centred, `100` is flush right/bottom. The travel is `picture − watermark`, so no value can push it over an edge — `100 / 100` is the bottom-right corner with the whole logo still on the picture. |
| **Opacity** | 1–100, multiplied into the PNG's own alpha, so transparent margins stay transparent. |
| **Size** | The watermark's width as a share of the picture's width. One setting then looks the same on a phone photo and on a 1080p video. Anything still too tall to fit is shrunk until it fits. |

The preview beside the sliders runs the same arithmetic the server does, so where the logo
sits in that 16:9 frame is where ffmpeg will put it.

What gets stamped: **photos, videos and GIFs**. A picture sent as a *file* stays a file, and
video notes, stickers, audio and text are left alone — stamping those would mean re-sending
them as something other than what you sent.

### When it cannot be done

A bot may only download 20 MB from Telegram, so media larger than that cannot be reached to
be stamped at all. (This does not apply to downloaded links, whose file never leaves the
host.) **Refuse anything that cannot be watermarked** decides what happens then:

- **Off** (default) — the post is queued unstamped and the bot tells you why.
- **On** — nothing is queued, so nothing reaches the channel without a watermark.

The same choice covers a mixed album (a photo next to a document, which is left alone whole
rather than half-stamped), a missing or broken ffmpeg, and a re-encode that still comes out
over the 50 MB a bot may upload.

### Keeping the result uploadable

Stamping re-encodes the video, and constant-quality encoding has no idea how large its
output will be — a clip that arrived just under the 50 MB limit can easily come back over
it, at which point it cannot be sent anywhere. So the encoder is given a bitrate ceiling
worked out from the clip's own duration, targeting 45 MB and leaving the rest as headroom.
Quality still leads on material that is cheap to encode; the cap only bites on the material
that would otherwise not fit.

There is a floor to this. Past roughly thirteen minutes the budget would mean a bitrate not
worth watching, so it stops shrinking — a video that long is refused as too large rather
than posted as a smear. Short-form video, which is what this feature is for, is nowhere
near that.

Stamping needs `ffmpeg` and `ffprobe` on `PATH` — both ship in the Docker image, and the
dashboard's **Media tools** card shows whether ffmpeg answered.

Nothing is ever posted half-stamped. A watermarked file is only sent on once ffmpeg has
exited cleanly *and* the result has been measured back, because an encode that is cut short
still leaves the bytes it had already written — an mp4 with no `moov` atom, which Telegram
accepts and then plays as a black rectangle for however long the caption claims.

### Memory

Watermarking re-encodes video rather than just re-muxing it, which is the heaviest thing
this app does. `docker-compose.yml` allows **768M** with that in mind; the encode is capped
at four threads, because x264 otherwise sizes its thread pool from the host's core count —
which a container's CPU limit does not change — and spends memory on threads it will never
get to run. Encodes are serialised, so only one runs at a time however busy the chat is.
A 30-second 1080p clip takes well under a minute.

If you see **"ffmpeg was killed before it finished"** in the chat, that is the kernel's OOM
killer: give the container more memory.

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

- **No media is re-uploaded at publishing time.** A queued item is a reference to the
  original message in your chat with the bot; publishing uses `copyMessage` /
  `copyMessages`. Deleting your original message before it is published will make that item
  fail to post. (A text post carrying a footer is the one exception — its words are re-sent,
  because a copy cannot be reworded. Nothing is uploaded either way.) With
  [watermarking](#watermarks) on, the queue points at the stamped copy the bot sent back to
  you rather than at your original, so that is the message to leave in place.
- **Albums** are grouped back together: messages sharing a `media_group_id` are collected
  for 1.5 s and stored as one queue item.
- **Downloaded media** follows the same rule: the queue item points at the bot's own reply
  in your chat, so deleting that reply before it is published breaks the post. A download
  is capped at 50 MB and at 5 minutes.
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

Two things follow from turning links into posts, both worth understanding before you add
anyone as a manager:

- **The bot fetches URLs on your host's behalf.** Only people on the user list can send it
  a link at all, but that request leaves from inside your network, so http(s) is enforced
  and non-routable hosts are refused (see [Links become media](#links-become-media)). The
  refusal is a guard against the obvious targets, not a substitute for restricted egress.
- **yt-dlp updates itself from GitHub**, unpinned, and runs as the app user — which is the
  point, since extractors rot fast, but it does mean a compromised yt-dlp release would be
  a compromised bot within a day. Pin a version in the `Dockerfile` and drop
  `startToolMaintenance()` if you would rather trade freshness for a fixed dependency.

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
| `MEMORY_LIMIT` | `512M` | Hard ceiling for the container, media tools included |
| `CPU_LIMIT` | `2` | CPU cores the container may use |
| `NODE_OPTIONS` | `--max-old-space-size=192` | Caps V8's heap inside that ceiling |

### Why it used to reserve so much memory

Left alone, V8 sizes its heap from **the host's** memory, not the container's — which is
why an idle bot on a 16 GB machine can look like it is holding on to a gigabyte or two.
Almost none of that is in use; it is headroom Node has reserved and never needed. This
app's own working set is a few MB.

`NODE_OPTIONS=--max-old-space-size=192` tells it the truth up front, and
`deploy.resources.limits` puts a hard ceiling on the container. The limit covers the
**whole** container — the server plus the yt-dlp and ffmpeg it spawns, which is where the
real memory goes: downloading and merging a 50 MB video is the peak. 512 MB covers that
comfortably.

Lower it only after watching it hold under a real download. There is no graceful failure
here — the kernel OOM-kills the container, and with `restart: unless-stopped` it comes
back and tries the same post again, so a limit set too low looks like a mysterious
restart loop rather than an error.

Two things worth knowing:

- The container runs as a **non-root user**, so the host directory behind `DATA_DIR`
  must be writable by it (`chown 1000:1000 ./data` covers the usual case).
- yt-dlp updates itself **inside the container**, so a new release survives only until the
  container is recreated — after which the image's copy is updated again on the next boot.
  It is a cache, not state; nothing needs to be persisted for it.
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
  bot/          grammY bot: lifecycle, handlers, command menu, album buffer, yt-dlp, watermarking, scheduler
  db/           Drizzle schema and connection
  media/        ffmpeg watermarking: geometry, filter graph, the stored PNG
  services/     settings, users/roles, queue, channels, posting, media tools
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
