# Telegram auto-poster bot

Send the bot anything — text, photos, videos, albums, files, links — and it queues it.
Once the target channel has been quiet for the configured delay, the bot publishes the
next item from the queue. A web dashboard shows the countdown, the queue, and every setting.

## Stack

Node + Express + TypeScript · grammY · Drizzle ORM + SQLite · React + Vite + Tailwind v4

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
3. Message the bot on Telegram. It replies with your numeric user ID — paste it into
   **Admin user ID** and save. From then on only that user may talk to the bot.
4. Add the bot to your channel as an **administrator with “Post messages”**. The channel
   appears in the dashboard on its own. If the bot was already in the channel before it
   was configured, register it with the **Add** field (`@channelname` or `-100…`).
5. Set the delay and time zone, then start sending posts to the bot.

`BOT_TOKEN`, `ADMIN_ID` and `TZ_NAME` in `.env` are optional shortcuts — they seed the
database the first time it is created, and are ignored afterwards. The dashboard is the
source of truth.

## Bot commands (admin only)

| Command | What it does |
| --- | --- |
| `/delay N` | Set the delay between posts to N minutes |
| `/queue` | How many posts are waiting |
| `/post` | Publish the next queued item immediately |
| `/till` | Time until the next automatic post |
| `/clear` | Empty the queue |
| `/summary` | Queue size, next post time, and total runway (queue × delay) |
| `/help` | Command list |

Any non-command message is queued, and the bot replies with the new queue size and the
time until the next post.

## How the delay works

The countdown is measured from **the last message seen in the channel**, not from the
bot's last post. The bot records the timestamp of every `channel_post` update, so a post
you make by hand also pushes the schedule back. A scheduler tick runs every minute; when
`now − lastChannelMessage ≥ delay` and the queue is non-empty, the head of the queue is
published.

If the channel has no recorded activity yet, the first queued item goes out on the next
tick.

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

## Project layout

```
src/server
  api/          Express routes + dashboard auth
  bot/          grammY bot: lifecycle, handlers, album buffer, scheduler
  db/           Drizzle schema and connection
  services/     settings, queue, channels, posting logic
src/web         React dashboard (Vite root)
drizzle/        generated SQL migrations, applied at boot
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Server (watch) + Vite dev server |
| `npm run build` | Compile the server and bundle the dashboard |
| `npm start` | Run the compiled server, serving the built dashboard |
| `npm run typecheck` | Type-check server and web |
| `npm run db:generate` | Regenerate migrations after editing the schema |
