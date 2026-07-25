# Bull Royale (Telegram Game Bot)

A Telegram group game where members grow their horns, challenge others to horn clashes, and track stats. Built with Node.js, node-telegram-bot-api, and Postgres. Deployable to Heroku.

## Features

- `/grow` every **8 hours**: random horn delta (mostly gains, occasional shrinkage). Sizes use **2 decimal places** (e.g. `12.18cm`).
- **Snap risk**: if horns are over **100cm**, there is a **5%** chance they snap to a stump of at most **5.00cm** (checked after grow and after clashes).
- `/attack <bet_cm>`: posts a Horn Clash challenge. First to accept fights; winner takes the bet. Bets support decimals (e.g. `/attack 12.18`).
- `/stats`: horn length and win/loss.
- `/bulloftheday`: random "Bull of the Day" until midnight UTC.
- `/top`, `/average`: leaderboard and averages.
- Stats are isolated per Telegram group.

## Requirements

- Node.js 18+
- Telegram Bot Token
- Postgres database (Heroku Postgres supported)

## Environment Variables

- `TELEGRAM_BOT_TOKEN` (required)
- `DATABASE_URL` (required in production; local Postgres supported)
- `PORT` (Heroku provides this automatically)
- `ALERT_DESTINATION` (optional; where new-group alerts are sent)

> Note: You can create a local `.env` file with these variables for local development.

## Install

```bash
npm install
```

## Run Locally (long polling)

```bash
npm start
```

Ensure `DATABASE_URL` points to your local Postgres (or a remote DB you control).

## Deploy to Heroku

1. Create the Heroku app and add Postgres:
   ```bash
   heroku create your-app-name
   heroku addons:create heroku-postgresql:mini
   ```
2. Configure environment variables:
   ```bash
   heroku config:set TELEGRAM_BOT_TOKEN=your-token
   ```
   Heroku will set `DATABASE_URL` automatically.
3. Deploy and scale:
   ```bash
   git push heroku main
   heroku ps:scale worker=1
   ```
4. Add the bot to your Telegram group(s) and start playing!

## Notes

- Horn length cannot go below 0cm.
- Fights select a random winner 50/50.
- Free `/grow` cooldown is 8 hours (not once per day).
