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

## Phase 2 status
Implemented: responsive role-based dashboard, gym creation, user creation, plans, member directory, membership API, reception check-in, attendance and renewal lists, owner overview.

Not yet implemented: QR check-in, fee receipts, payment processing, workout/diet editing, WhatsApp integration, inactive-member reports, automated reminders, true online self-registration, tests and production hardening.

## Deployment safety
Do not expose this build publicly or use real customer data yet. The browser stores session tokens in sessionStorage; commercial release requires stronger browser session protections, HTTPS, database backups, migrations, audit logging, rate limiting, access-control testing and payment validation. Existing Docker databases do not automatically rerun schema initialization scripts.

## Design
Black/lime responsive UI. No paid dependencies required for local operation.
