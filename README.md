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

New Compose databases apply it automatically. Railway applies it through `init-db.mjs` before deploying. Existing Compose databases can apply membership cancellation with `docker compose exec -T db psql -v ON_ERROR_STOP=1 -U trainerx -d trainerx < migrations/006-membership-cancellation.sql`.

### WhatsApp reminders

To use the Meta WhatsApp Business Cloud API, configure these application environment variables in the host:

- `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` for the business sender
- `WHATSAPP_API_VERSION` for the supported Graph API version in use, in `vNN.N` format
- `WHATSAPP_EXPIRY_TEMPLATE` and `WHATSAPP_OVERDUE_TEMPLATE` for approved template names
- `WHATSAPP_FEE_DUE_TEMPLATE` for an approved upcoming payment reminder template
- `WHATSAPP_TEMPLATE_LANGUAGE` for the approved locale, defaulting to `en`

The expiry and overdue templates each take two body parameters. Supply the gym name first and the expiry date or overdue amount second. The upcoming fee template takes three parameters in order: gym name, billing period end date, and outstanding amount with currency. Upcoming reminders can be sent from three days before the due date through the due date. Enable reminders under **Dashboard → Gym account** and record each member's opt-in and international phone number in the member profile. The sender is shared by the installation. Use a sender approved to represent all participating gyms. The job checks for alerts every minute and attempts each membership and due period once. Delivery attempts are recorded to avoid duplicates across restarts and replicas. A failed or interrupted attempt is visible in the 30-day count and is not retried automatically.

## Encrypted Google Sheets backups

TrainerX can write a full PostgreSQL snapshot to a dedicated Google Sheets workbook once per UTC day. The server tries shortly after startup and retries failed jobs every 30 minutes. Seven rotating tabs retain up to seven daily snapshots. The workbook contains encrypted archive chunks and snapshot dates.

Enable the Google Sheets API in a Google Cloud project, create a service account, and give it Editor access to a private workbook dedicated to this backup. Set the following variables on the TrainerX backend. Use sealed Railway variables for the service account key and encryption key.

| Variable | Value |
| --- | --- |
| `GOOGLE_BACKUP_SHEET_ID` | Spreadsheet ID from the workbook URL |
| `GOOGLE_BACKUP_SERVICE_ACCOUNT` | Service account JSON containing `client_email` and `private_key` |
| `GOOGLE_BACKUP_KEY` | Independent 32-byte encryption key encoded in base64. Generate one with `openssl rand -base64 32`. |

Store a separate secure copy of the encryption key to make disaster recovery possible. Replacing it makes snapshots encrypted with the old key unreadable without that old key. When the sheet ID is unset, scheduled backups are disabled. A compressed database archive over 20 MiB exceeds this Sheets integration’s limit and produces a backend error.

To run or recover a snapshot with the configured environment, use these commands. Omit the date to recover the newest completed snapshot.

```sh
node sheets-backup.mjs run
node sheets-backup.mjs restore ./trainerx-recovery.dump 2026-11-25
pg_restore --list ./trainerx-recovery.dump
pg_restore --exit-on-error --no-owner --no-acl --dbname=trainerx_recovery ./trainerx-recovery.dump
```

Run the last command with PostgreSQL 18 tools against a fresh PostgreSQL 18 or newer recovery database. The backup includes PostgreSQL data and schema. Keep the deployment variables and repository available separately to recreate the application environment.
