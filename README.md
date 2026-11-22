# WedPlan Server

Express.js and MongoDB API for the WedPlan wedding planning platform.

## Features

- Better Auth session and JWT-based API authentication
- Server-side role and resource ownership authorization
- Service approval, active status, search, filtering, and sorting
- Customer and vendor booking workflows
- Blocked-user enforcement
- Admin user, service, and transaction management
- Stripe Checkout and verified webhook subscription activation

## Tech Stack

- Node.js
- Express.js
- MongoDB
- JSON Web Tokens
- Stripe
- Better Auth

## Local Setup

```bash
npm install
cp .env.example .env
npm start
```

The API runs at `http://localhost:5000`.

## Health and Shutdown

- `GET /` returns basic API status.
- `GET /health` is available for deployment platform health checks.
- The server closes HTTP and MongoDB connections gracefully on `SIGTERM` and `SIGINT`.

## Environment Variables

See `.env.example`. Never commit `.env` or production secrets.

Required variables include `MONGODB_URI`, `MONGODB_DB_NAME`, `CLIENT_ORIGIN`, `JWT_SECRET`, `BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PREMIUM_PRICE_ID`.

`MONGODB_URI` / `MONGODB_DB_NAME` must point at the **same** database as the client's Better Auth config, and `BETTER_AUTH_SECRET` must match the client's secret — `POST /auth/token` reads Better Auth sessions directly from that database. `CLIENT_ORIGIN` must include the deployed client origin; Vercel client domains are allowed automatically.

## Stripe Webhook

Register `POST /webhook/stripe` in Stripe and subscribe to `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`.

Live API: Add the production URL here.

Server repository: Add the production repository URL here.
