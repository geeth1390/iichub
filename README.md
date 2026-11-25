# IICHUB (iichub.com)

Find a machine, book it, get a quote, track the job. Private labs can list their own equipment, with photos and an operating procedure, for admins to approve. This is one Node.js app plus a PostgreSQL database:

| Address | Who uses it |
|---|---|
| `https://www.iichub.com/` | Innovators and equipment owners: search, book, sign up; owners list equipment at `/#/list` and track it at `/#/listings` |
| `https://www.iichub.com/manager` | Centre staff and managers: job queue, quotes, stock, maintenance |
| `https://www.iichub.com/admin` | Super admins, admins and centre managers: accounts, centres, machines, listings, audit log |

> This README replaces `IICHUB_Developer_Instruction_Book.docx`, which describes the older phone-OTP version.

## Roles

| Role | Can do |
|---|---|
| **Super admin** | Everything. Creates and removes admins and other super admins, reads the audit log. There must always be at least one active super admin. |
| **Admin** (`apis_admin`) | All centres, machines and private listings. Creates centre managers, staff and equipment owners. Cannot create or change admins or super admins. |
| **Centre manager** | Their own centre's queue, quotes, stock and maintenance. Creates and manages staff **for their own centre only**. |
| **Centre staff** | Their own centre's queue, quotes, stock and maintenance. |
| **Equipment owner** | Signs up on the site and lists private machines: location, device, photos and operating procedure. Listings stay hidden until an admin approves them and sets the platform fee. |
| **Innovator** | Signs up on the site, books machines, accepts quotes, cancels before work starts. |

Only innovators and equipment owners can sign themselves up. Every other account is created by someone above it and starts with a one-time temporary password that must be changed at first sign-in.

## Equipment listings (private labs)

1. The owner fills in 5 steps: **Location → Device → Photos → Procedure → Review**. A draft is saved after the Device step.
2. They can't submit without **at least one device photo**, how a job runs, safety rules and at least one material.
3. Admins review it in **Admin → Listings to review**, which shows the photos, address (with a Google Maps link), procedure and SOP PDF. They then **Approve** (and set the fee), **Ask for changes** (a note is required, and the owner sees it) or **Reject**. Live listings can be **suspended**.
4. **Editing a live listing sends it back for review**, and it's hidden until it's approved again.
5. **Privacy:** for private labs, the public sees the area, an approximate location (about 2 km) and the distance. The street address and phone appear only to people with a confirmed booking there, the owner, and staff and admins.
6. **Uploads:**
   - **Photos:** JPG, PNG or WebP, 5 MB and 8 photos at most. They're checked byte by byte, re-encoded (removing GPS and camera data), and stored in the database, so they're backed up with it. Oversized images ("decompression bombs") are refused.
   - **SOP PDFs:** 5 MB at most. Files with scripts or embedded files are refused, and they're always served as downloads.
   - **Unapproved listings:** their photos and documents are private.

## Security

- **Sign-in:** email and password. Passwords are hashed with scrypt and must be at least 10 characters (14 for the first super admin) and not common. After 8 wrong passwords the account locks for 15 minutes, and sign-in attempts are rate-limited per visitor.
- **Sessions:** last 12 hours and are checked against the database on every request. Disabling an account, changing its role or centre, or resetting or changing its password ends its sessions at once. "Sign out" in the manager and admin consoles signs that person out on every device.
- **Permissions:** checked twice, once in the API and again inside the database functions. Staff can only act on their own centre's jobs, machines and stock.
- **Browser protection:** a strict Content Security Policy (no inline scripts), no cross-site API access, HSTS, clickjacking protection and request size limits.
- **Audit log:** sign-ins (including failed ones), account changes, listing changes and approvals, quotes, stock and maintenance are all recorded. Only super admins can view it.
- **Under load:** limits (open bookings, photos, listings) and the password lockout hold even when hit by many requests at once. Two people can never get the same slot.
- **Secrets:** live only in environment variables. The app refuses to start without a strong `JWT_SECRET`, or with a non-https `SITE_URL` in production.

## Settings

See `.env.example`. Required: `DATABASE_URL`, `SITE_URL`, `JWT_SECRET`, plus `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` for the first start.

## Deploy on Dokploy (Hostinger VPS)

These are the same steps as for PhDCircle. IICHUB gets **its own project** in Dokploy, and nothing in the other projects is touched.

### 1. Push the code to GitHub
Create a **private** repository (for example `iichub`). Then, from inside this folder:
```
git init && git add . && git commit -m "IICHUB v2 – secure release" && git branch -M main && git remote add origin https://github.com/<you>/iichub.git && git push -u origin main
```
On GitHub, give Dokploy's GitHub App access to the new repo: **Settings → Applications → (Dokploy app) → Configure → Only select repositories → add `iichub`**.

### 2. Point the domain at the VPS
In the DNS panel where `iichub.com` is registered, add:

| Type | Host | Value |
|---|---|---|
| A | `@` | your VPS IP |
| A | `www` | your VPS IP |

Remove any parking-page records first.

### 3. Create the project and database in Dokploy
1. **Projects → Create Project**, named `IIChub`.
2. **Create Service → Database → PostgreSQL**, with:
   - Name `iichub-db`
   - Database `iichub`
   - User `iichub`
   - Password: long and random, letters and numbers only
3. Click **Deploy** and wait until it's green.
4. Copy the **Internal Connection URL**. Don't fill in "External Credentials", so the database stays private.

### 4. Create the app
1. **Create Service → Application**, named `web`.
2. Provider **GitHub**, repository `iichub`, branch `main`, Build Type **Dockerfile**. Click **Save**.
3. In the **Environment** tab, paste the following. Generate the secret with `openssl rand -hex 32` in Hostinger's browser terminal.
   ```
   NODE_ENV=production
   DATABASE_URL=<Internal Connection URL>
   DATABASE_SSL=disable
   SITE_URL=https://www.iichub.com
   JWT_SECRET=<64 random characters>
   SUPERADMIN_EMAIL=<your email>
   SUPERADMIN_NAME=<your name>
   SUPERADMIN_PASSWORD=<temporary, 14+ characters>
   SEED_DEMO=true
   EMAIL_FROM=IICHUB <noreply@iichub.com>
   ```
4. Click **Deploy** and open **Logs**. You should see `Applied 9 migration(s)`, `Loaded the sample catalogue`, `Created the first super admin`, then `IICHUB ready`.

### 5. Attach the domain
In the app's **Domains** tab, add `www.iichub.com` and then `iichub.com`, each with:
- Path `/`
- **Container port 3000**
- HTTPS on
- Certificate **Let's Encrypt**

Visitors to `iichub.com` are redirected to `www.iichub.com`.

### 6. First sign-in (do this straight away)
1. Open `https://www.iichub.com/admin` and sign in with the super admin email and temporary password. You'll be asked to choose your own password; use 14+ characters.
2. In Dokploy's **Environment** tab, **delete the `SUPERADMIN_PASSWORD` line**, save and redeploy.
3. Under **Accounts → New account**, create a second super admin for a trusted colleague, so you can never be locked out. Then create your admins, centre managers and staff. Each gets a temporary password to share privately.

### 7. Check it works
- `https://www.iichub.com/health` shows `{"ok":true,"db":"up"}`.
- Sign up as a test innovator on the home page and book a slot.
- Sign in at `/manager` as a staff member of that centre and price the job.

### 8. Before announcing publicly
- **Email:** sign up at resend.com and verify `iichub.com` (add its DNS records). Then add `RESEND_API_KEY` in Dokploy and redeploy. Until then, password-reset emails and job emails aren't sent, and admins reset passwords from the Accounts page.
- **Real data:** the sample catalogue uses real centre names with modelled rates, and a yellow "sample data" ribbon shows on every page. Replace or confirm each centre's machines and rates in **Admin → Centres / Machines**. Untick **Live** for centres that aren't on the platform. Then add `HIDE_SAMPLE_NOTICE=true`.
- **Backups:** on the `iichub-db` **Backups** tab, schedule daily backups to S3-type storage (Cloudflare R2 or Backblaze B2). Keep Hostinger's weekly VPS snapshots on as a second copy.
- **Auto Deploy:** turn it on in the app's **General** tab so every `git push` updates the site.

## If you're locked out of every super admin

In Hostinger's browser terminal, run the following. It prints a temporary password.
```
docker ps --format '{{.Names}}' | grep web
docker exec -it <that-name> node scripts/create-admin.js you@iichub.com "Your Name" super_admin
```

## Run it locally
```
npm install
cp .env.example .env     # fill in DATABASE_URL, JWT_SECRET, SITE_URL=http://localhost:3000, SUPERADMIN_*
npm start                # runs migrations, then the app on :3000
```

## How the database is managed
- `migrations/*.sql` are applied once each, in order, on every start. Applied files are recorded in `schema_migrations`. **Never edit an applied migration.** Add a new numbered file instead.
- `seeds/demo.sql` (with `SEED_DEMO=true`) loads only into an empty catalogue and never touches real data. It creates no login accounts.
- Centre hours, booking slots and "today" use Indian time (Asia/Kolkata).

## Testing (run before every release)

`tests/` holds the regression suites. Run them against a local copy with a fresh database, never against the live site: they create accounts and listings.

- `sec_test.py`: 88 security and permission checks.
- `listings_test.py`: 63 listing, upload and privacy checks (run it after `sec_test.py`).
- `ui_test.py` and `ui_bold_test.py`: browser journeys on desktop and phone.
- `pressure.js`: load, flood, booking-race, brute-force and upload-burst tests.

Results on a 2-CPU / 8 GB machine, the same size as the VPS:
- About **570 requests/second** of mixed browsing, with 99% of answers under 0.35 s.
- About **900 searches/second**.
- A single-address flood is throttled with zero errors.
- In a 40-way race for one slot, exactly 1 booking wins.
- Two bursts of sixteen 4.5 MB photo uploads complete in about 6 s each, with memory steady at about 440 MB.

## Not included yet
- **SMS:** OTP sign-in was removed. Job SMS messages are queued and marked "skipped" until an SMS provider (MSG91 or similar, with DLT registration) is added in `worker/notification-worker.js`.
- **File uploads for innovators' job drawings** (STL/DXF). The `job_file` table exists, but there's no upload endpoint yet; owners' photo and PDF uploads are done.
- **A real map** on the machine page and in the listing form (needs a maps provider key). For now, there's a Google Maps link and "use my current location".
- **Two-factor sign-in** (authenticator app) for admin accounts. This is recommended as the next security step.
- **Online payment.**

## Machine photos (admins)

Admin console → **Machines** → **Photos** on any machine (government centres included). Upload JPG/PNG/WebP up to 5 MB, choose what it shows, and add a credit line (e.g. "Photo: APIIC Visakhapatnam"). The credit appears under the photo on the machine page. Use photos of the actual machine taken at the centre, or images you have permission to use. Manufacturer product photos are usually copyrighted.

## Utilisation report

Admin console → **Utilisation** (admins see every centre; centre managers see their own). Pick a period and, for admins, a centre.

| Measure | How it is calculated |
|---|---|
| Available hours | Centre opening hours on its working days, from the machine's commissioning date, minus repairs (maintenance windows) and blocked slots |
| Booked hours | Customer booking slots: requested, confirmed, completed and no-show (cancelled bookings are shown separately) |
| Executed hours | Time a job was marked **Setup** or **Running** by centre staff, from the job's timestamped history |
| Utilisation | Executed ÷ available |
| Booked → executed | Executed ÷ booked. The gap is split into no-shows and jobs that finished early or started late |
| Actual ÷ quoted | Real setup + run time ÷ the time in the quote, for jobs that reached Ready in the period |
| Unbooked hours at listed rates | Unbooked hours × the machine's hourly rate: the most it could have earned, not money lost |

Only hours already passed are counted. Executed hours are only as accurate as staff updating job stages on time. **Download CSV** exports the per-machine table (cells starting with `=`, `+`, `-` or `@` are escaped so spreadsheets don't run them as formulas).

Flags per machine: under 20% used, over 85% booked, bookings not run (<70% executed), many no-shows (>15%), high downtime (>20% of open hours), quotes off (actual time more than 25% away from quoted, 3+ jobs).

**Sample history.** Installs with the sample catalogue (`SEED_DEMO=true`) get 60 days of sample bookings and jobs so the report has something to show. They belong to the disabled `sample-history@system.invalid` account. Remove them with `SELECT remove_sample_usage_history();` before going live with real centres.

Tests: `python3 tests/report_test.py` checks the arithmetic on a known scenario (29 checks).
