# TrainerX.io

Private, self-hostable gym management application under active development.

## Local installation
Install Docker Engine and Docker Compose. Create a local `.env` with two independent, strong random values:
```dotenv
DB_PASSWORD=replace-with-strong-random-secret
BOOTSTRAP_TOKEN=replace-with-another-strong-random-secret
```
Run `docker compose up --build`. Open `http://localhost:3000`.

Create the first superadmin once (replace placeholders):
```bash
curl -X POST http://localhost:3000/bootstrap -H 'Content-Type: application/json' -d '{"email":"admin@example.com","password":"replace-with-strong-password","token":"replace-with-bootstrap-token"}'
```
Log in via the browser. Superadmin creates gyms and owner accounts. Owner can create plans, members and staff. Reception can check in active members and view renewals.

## Existing database migration
For a database created before fee collection was added, run `docker compose exec -T db psql -U trainerx -d trainerx < migrations/002-fee-payments.sql` from the repository root after the database is running. Fresh database initialization already includes the payment schema. Back up existing data before migrating.

For existing databases, also run `docker compose exec -T db psql -U trainerx -d trainerx < migrations/003-training.sql` before restarting the app. The QR generator is installed automatically during the Docker build.\n\n## Phase 2 status
Implemented: responsive role-based dashboard, gym creation, user creation, plans, member directory, membership assignment and renewals, cash/bank/UPI payment recording ledger, reception check-in, attendance and renewal lists, owner overview.

Not yet implemented: QR check-in, downloadable fee receipts, payment gateway processing, workout/diet editing, WhatsApp integration, inactive-member reports, automated reminders, true online self-registration, tests and production hardening.

## Deployment safety
Do not expose this build publicly or use real customer data yet. The browser stores session tokens in sessionStorage; commercial release requires stronger browser session protections, HTTPS, database backups, migrations, audit logging, rate limiting, access-control testing and payment validation. Existing Docker databases do not automatically rerun schema initialization scripts.

## Design
Black/lime responsive UI. No paid dependencies required for local operation.
