# RentEasy API

Express, TypeScript, Prisma and Postgres. Implements release 1 of the Business Requirements Document: accounts and roles, properties and units with photos, the approval workflow, public listings, tenancies, notifications and SMTP email.

## Run it

```
cp .env.example .env          # then fill in DATABASE_URL and JWT_SECRET
npm install
npm run db:deploy             # creates the tables
npm run seed                  # creates the first super admin from SEED_SUPER_ADMIN_* in .env
npm run dev                   # http://localhost:4000
npm run smoke                 # end-to-end test (needs the API running); creates and removes its own data
                              # run the API with AUTH_RATE_LIMIT=5000 first, or the lockout checks hit the rate limit
```

| Script | What it does |
| --- | --- |
| `npm run dev` | API with automatic restart |
| `npm run build` then `npm start` | Compiled production build |
| `npm run db:migrate` | New migration after you edit `prisma/schema.prisma` (interactive) |
| `npm run db:deploy` | Apply migrations without prompts (servers) |
| `npm run seed` | Create or repair the first super admin and default settings |
| `npm run smoke` | 150+ end-to-end checks of every flow below |

After a migration, restart the dev server so it loads the new Prisma client.

## Roles

`user`, `tenant`, `owner`, `admin`, `super_admin`. A person can hold several at once (for example user, owner and tenant) and the permissions add together. Everyone is a `user`; that role cannot be removed.

| Role | How it is obtained |
| --- | --- |
| user | Automatically at registration |
| owner | Automatically when an admin approves their first property |
| tenant | Automatically when a rent request is approved or an admin links them to a unit; removed when their last tenancy ends |
| admin, super_admin | Only a super admin creates these (`POST /api/users/staff`) |

Roles and account status are read from the database on every request, so a role change or suspension applies immediately.

## API

All routes are under `/api`. Errors look like `{ "error": "message", "details": ... }`. Lists return `{ items, page, pageSize, total, totalPages }`. Money is in the platform currency (PHP by default, changed in Settings > General) with two decimals.

### Auth
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | `email, password, fullName, phone?`. Sends a verification email |
| POST | `/auth/login` | 5 wrong passwords in 15 minutes lock the account for 15 minutes |
| POST | `/auth/logout` | |
| GET | `/auth/me` | Roles, profile, unread notification count |
| POST | `/auth/verify-email` | `{ token }`, single use, valid 24 hours |
| POST | `/auth/resend-verification` | Max 3 per hour |
| POST | `/auth/forgot-password` | Always answers the same; max 3 per hour |
| POST | `/auth/reset-password` | `{ token, password }`, single use, valid 1 hour; signs out all devices |
| POST | `/auth/change-password` | Signs out other devices |

### My profile
| Method | Path | Notes |
| --- | --- | --- |
| PATCH | `/users/me` | Name, phone, birth date, address, ID type and number, notification preferences |
| POST | `/users/me/avatar` | multipart field `avatar`, image up to 2 MB |
| POST | `/users/me/id-document` | multipart field `document`, PDF/JPG/PNG up to 10 MB, private |

### People (admins)
| Method | Path | Who |
| --- | --- | --- |
| GET | `/users?q=&role=&status=&page=` | admin, super admin |
| GET | `/users/:id` | admin, super admin (includes ID details) |
| PATCH | `/users/:id/status` | `Active`, `Suspended`, `Deactivated`. Admins cannot touch admins |
| POST / DELETE | `/users/:id/roles[/:role]` | Admin: tenant only. Super admin: tenant, owner, admin, super_admin |
| POST | `/users/staff` | Super admin creates an admin or super admin; they get a set-password email |

### Properties and units
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/properties` | Verified email required. Created as a draft. Can include a `unit` object (the first home), saved in the same request |
| GET | `/properties` | Owners see their own; staff see all. `?queue=pending` is the review queue |
| GET / PATCH | `/properties/:id` | Owner or staff |
| POST | `/properties/:id/photos` | field `photos`, 3 to 20 images, 5 MB each, resized to large and thumbnail WebP |
| POST | `/properties/:id/documents` | field `documents`, ownership papers, private |
| POST | `/properties/:id/submit` | Needs 3 photos, 1 document, owner identity on file. Notifies admins |
| POST | `/properties/:id/review` | Staff. `{ action: "approve" }` or `{ action: "reject", reason }` |
| PATCH | `/properties/:id/listing` | `Listed` or `Hidden` |
| DELETE | `/properties/:id` | Staff. Archives (soft delete) |
| POST / GET | `/properties/:id/units` | |
| GET / PATCH / DELETE | `/units/:id` | Delete only if the unit never had a tenant |
| PATCH | `/units/:id/status` | `Vacant` or `UnderMaintenance` (Occupied comes only from a tenancy) |
| POST | `/units/:id/photos` | field `photos`, up to 15 |
| PATCH / DELETE | `/files/:id[/cover]` | Set cover, delete a photo |
| GET | `/files/:id/download` | Private files, owner or staff only |

### Public site (no login)
`GET /public/config`, `GET /public/filters` (cities with home counts, rent range),  `GET /public/listings` (filters: `q, city, minRent, maxRent, bedrooms, bathrooms, propertyType, furnishing, amenities=gym,security, sort=newest|price_asc|price_desc, page, pageSize`), `GET /public/listings/:unitId`. Only vacant units of approved, listed properties appear. Images are served from `/uploads/...`.

### Renting
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/units/:unitId/rent-requests` | Verified user with identity on file |
| GET | `/rent-requests` | Admins see all; others see their own |
| POST | `/rent-requests/:id/cancel` | Requester, while pending |
| POST | `/rent-requests/:id/decision` | Staff. Approve creates the tenancy and adds the tenant role |
| POST | `/tenancies` | Staff links a tenant directly |
| GET | `/tenancies` | Tenant: own. Owner: own properties. Staff: all |
| POST | `/tenancies/:id/end` | Staff. Unit becomes Vacant again |

### Notifications and announcements
`GET /notifications`, `GET /notifications/unread-count` (poll every 30 s), `PATCH /notifications/:id/read`, `POST /notifications/read-all`, `DELETE /notifications/:id`. Staff send `POST /announcements` to `all`, `owners` or `tenants`.

### Super admin settings
`GET/PUT /settings/general` (currency), `GET/PUT /settings/email` (SMTP; password saved encrypted and never returned), `POST /settings/email/test`, `GET/PUT/DELETE /settings/email-templates/:key` (edit email wording), `GET /settings/mail-log`, `POST /settings/mail-log/:id/retry`. Staff read `GET /audit-logs`.

## Email

- Emails are written to an outbox table and sent by a background worker, so no request waits for the mail server.
- A failed send is retried after 1 minute, 10 minutes and 1 hour. After that it is marked Failed and `ADMIN_ALERT_EMAIL` is told.
- Security and account emails (verification, reset, password and role changes, suspensions, new-device sign-in) are always sent. Update emails respect the person's preference.
- `MAIL_MODE=console` prints emails in the terminal (development). Set `MAIL_MODE=smtp` in production and save the SMTP settings as super admin, or put them in `.env`.
- Add SPF, DKIM and DMARC records for the sending domain, or messages land in spam. Some hosts block outgoing SMTP on certain ports; confirm the port with the host.
- `MAIL_REDIRECT_TO` sends every email to one test inbox.

## Deploying on a Hostinger VPS

1. Install Node, Postgres and Nginx. Create the database and a database user.
2. Copy the project, then `npm ci`, set `.env` (`NODE_ENV=production`, `MAIL_MODE=smtp`, a long random `JWT_SECRET`, `CLIENT_ORIGIN` and `APP_URL` set to your domain).
3. `npm run db:deploy && npm run seed && npm run build`.
4. Run with PM2: `pm2 start dist/server.js --name propy-lease-hub-api`, then `pm2 save` and `pm2 startup`.
5. Nginx serves the built React app and proxies `/api` to port 4000 and serves `/uploads` directly, all under one domain with HTTPS from Let's Encrypt. Photos are uploaded up to 20 at a time, so allow large bodies (`client_max_body_size 100m;`).

The `deploy/` folder at the project root has all of this ready to use: an Nginx config, a PM2 file, a server setup script, a one-command deploy script and a step-by-step guide (`deploy/README.md`).
6. Daily backup (database and uploads, kept 30 days): add a cron line `30 2 * * * /path/to/server/scripts/backup.sh`. Test a restore with `pg_restore` before launch.

Use one API instance, or several: the mail worker claims jobs before sending, so nothing is sent twice.

## Project layout

```
prisma/            schema, migrations, seed
scripts/           smoke-test.ts, backup.sh
src/config         validated environment
src/lib            errors, audit, tokens, serializers, validation helpers
src/middleware     auth (checks the database), roles, uploads, rate limits, error handler
src/services       mailer and queue, templates, notifications, files and images, tenancy rules
src/modules        auth, users, properties, units, files, public, tenancies,
                   notifications, announcements, settings, audit
src/jobs           background worker (mail queue, cleanup)
```
