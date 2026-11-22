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

For existing databases, also run `docker compose exec -T db psql -U trainerx -d trainerx < migrations/003-training.sql` before restarting the app. The QR generator is installed automatically during the Docker build.

Run `docker compose exec -T db psql -v ON_ERROR_STOP=1 -U trainerx -d trainerx < migrations/004-member-profiles.sql` for existing Compose databases that predate the member profile or billing month features. New Compose databases run this migration during initialization.

## Deployment safety
Do not expose this build publicly or use real customer data yet. The browser stores session tokens in sessionStorage; commercial release requires stronger browser session protections, HTTPS, database backups, migrations, audit logging, rate limiting, access-control testing and payment validation. Existing Docker databases do not automatically rerun schema initialization scripts.

## Design
Black/lime responsive UI. No paid dependencies required for local operation.

## Gym operations

Owners can review expiry and overdue alerts, record expenses, export financial statements, and manage reception and trainer access. Financial statements use recorded cash flow and can be downloaded as CSV. Payment receipts can be downloaded or printed. Membership insights compare the opening member cohort with the closing cohort for each month.

Member freezes pause all check-in methods for an inclusive date range. Billing and membership expiry follow the existing schedule. Superadmins can set a gym's subscription plan, paid-through date and access status. A blank paid-through date keeps the account open-ended. Subscription dates record externally managed billing.

For an existing Docker Compose database, apply the operations migration before starting the new app:

```sh
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U trainerx -d trainerx < migrations/005-gym-operations.sql
```

New Compose databases apply it automatically. Railway applies it through `init-db.mjs` before deploying.

### WhatsApp reminders

To use the Meta WhatsApp Business Cloud API, configure these application environment variables in the host:

- `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` for the business sender
- `WHATSAPP_API_VERSION` for the supported Graph API version in use, in `vNN.N` format
- `WHATSAPP_EXPIRY_TEMPLATE` and `WHATSAPP_OVERDUE_TEMPLATE` for approved template names
- `WHATSAPP_TEMPLATE_LANGUAGE` for the approved locale, defaulting to `en`

Each template takes two body text parameters. The first is the gym name and the second is the expiry date or overdue amount including currency. Enable reminders in the owner's Account screen and record each member's opt-in and international phone number in the member profile. The sender is shared by the installation. Use a sender approved to represent all participating gyms. The job checks for alerts every minute and attempts each membership and due period once. Delivery attempts are recorded to avoid duplicates across restarts and replicas. A failed or interrupted attempt is visible in the 30-day count and is not retried automatically.
