# Hosting on Cloudflare (Workers + D1)

The same secure portal, running on Cloudflare. The page is served from `public/`, the server code runs as a Worker at `/api`, and the data lives in a D1 database.

## Free plan or paid plan
The project is set for the **free** Workers plan: `wrangler.toml` has `SCRYPT_N = "2048"`, a lighter password check that fits the 10 ms limit. It is still safe against guessing because logins lock after 5 wrong tries. If you later move to Workers Paid (about US$5 a month), delete that line to get the strongest setting, then have users change their passwords.

## Steps (you do these; never send me passwords)
1. Create a free Cloudflare account and, in **Workers & Pages**, subscribe to **Workers Paid**.
2. Add your domain to Cloudflare (buy it there, or change your domain's nameservers to the two Cloudflare gives you).
3. On a computer with Node.js 20+, open this folder in a terminal and run:
   - `npm install`
   - `npx wrangler login` (a browser opens; approve)
   - `npx wrangler d1 create portal-db` then copy the `database_id` it prints into `wrangler.toml`
   - `npm run cf:migrate`
   - `npx wrangler secret put ADMIN_PASSWORD` (type the admin password when asked)
   - `npx wrangler secret put SESSION_SECRET` (type a long random text, 40+ characters)
   - optional for SMS: `npx wrangler secret put ARKESEL_API_KEY` (use the variable name the portal expects, see `.env.example`)
   - `npm run cf:deploy`
4. In Cloudflare: Workers & Pages > student-assessment-portal > Settings > Domains & Routes > Add custom domain > your domain.
5. Open your domain, sign in as admin with the password you set, and change it when asked.
6. Trial with test students and one test SMS, then delete the test data.

## Test on your own computer first
`npm run cf:dev` (needs a `.dev.vars` file with `ADMIN_PASSWORD=...` and `SESSION_SECRET=...`).

## Backups
Cloudflare D1 keeps point-in-time history (Time Travel). Restore with `npx wrangler d1 time-travel restore portal-db --timestamp=<time>`. The Phase 2 plan adds an in-app backup button.
