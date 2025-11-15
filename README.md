# Phallic Fury (Telegram Game Bot)

A Telegram group game where members can grow their "length", challenge others to sword fights, and track stats. Built with Node.js, node-telegram-bot-api, and Postgres. Deployable to Heroku.

## Features

- `/grow` once per day (UTC reset at midnight): random delta from -5cm to +10cm.
- `/attack <bet_cm>`: posts a challenge with an "En Guard" button. First to accept fights the challenger; winner takes the bet from the loser.
- `/stats`: shows your length and win/loss percentage.
- `/PhallusOfTheDay`: selects a random member as "Dick of the day" and shows them until midnight UTC.
- Stats are isolated per Telegram group.

## Requirements

- Node.js 18+
- Telegram Bot Token
- Postgres database (Heroku Postgres supported)

## Environment Variables

- `TELEGRAM_BOT_TOKEN` (required)
- `DATABASE_URL` (required in production; local Postgres supported)
- `WEBHOOK_DOMAIN` (required for Heroku/webhook deployments, e.g. `https://your-app.herokuapp.com`)
- `PORT` (Heroku provides this automatically)

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

## Deploy to Heroku (Webhook)

1. Create the Heroku app and add Postgres:
   ```bash
   heroku create your-app-name
   heroku addons:create heroku-postgresql:mini
   ```
2. Configure environment variables:
   ```bash
   heroku config:set TELEGRAM_BOT_TOKEN=your-token
   heroku config:set WEBHOOK_DOMAIN=https://your-app-name.herokuapp.com
   ```
   Heroku will set `DATABASE_URL` automatically.
3. Deploy:
   ```bash
   git push heroku main
   ```
4. Scale a web dyno:
   ```bash
   heroku ps:scale web=1
   ```
5. Add the bot to your Telegram group(s) and start playing!

## Notes

- The bot uses webhook mode (Express) when `WEBHOOK_DOMAIN` and `PORT` are present; otherwise, it falls back to long polling for local development.
- Length cannot go below 0cm.
- Fights select a random winner 50/50.


