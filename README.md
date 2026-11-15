# Home Base

A personal dashboard for tasks, planning, training and small-business sales, built as a learning project with security as the main theme.

**Status:** early. The app currently shows a placeholder page.

## Stack

Next.js (App Router), TypeScript (strict), Tailwind CSS. Planned: PostgreSQL with Prisma, login with Auth.js.

## Security rules for this repo

1. **Never trust the browser.** Every value that arrives from the client is checked on the server.
2. **Check the session on the server.** Every page and every API route verifies the login before doing anything.
3. **Keep secrets and real data out of git.** Secrets live in `.env`, real data lives in `private/`. Both are git-ignored. The public repo and demo only ever use fake data.

## Run it locally

```bash
npm install
cp .env.example .env
npm run dev
```

Then open http://localhost:3000.
