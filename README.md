# Kuya E Tapsilogan - Point of Sale

A complete, tablet-friendly POS for a tapsilogan: cashier order taking, kitchen queue, and admin
sales/menu/staff management. Built with Node.js, Supabase (database + photo storage) and Tailwind CSS.
Runs on the Render free tier.

- No emojis. Large text and large touch targets for senior staff.
- Live updates with no page refresh (Server-Sent Events pushed from the server).
- Every peso amount is computed on the server from the database price, never from the browser.
- The browser never talks to Supabase directly. All database access happens on the server with the
  `service_role` key, so the database is not exposed to the internet.

---

## 1. What each role can do

| Role | Screens |
| --- | --- |
| **Cashier** | New Order, Pending Payments, Orders |
| **Kitchen** | Kitchen board only |
| **Admin** | Everything: Sales Dashboard, New Order, Pending Payments, Orders, Kitchen, Menu, Users, Audit Logs, Sales Reports, Settings |

**Cashier - New Order**

- Tap menu items to add them, adjust quantities, add notes, choose Dine In or Take Out.
- Customer name is auto-filled as `Customer 1`, `Customer 2`, ... The cashier can type a real name
  instead, or press **Auto** to go back to the generated one.
- Receive payment: **Pay Now** (Cash with automatic change, or Online with optional reference) or
  **Pay Later** (saved as unpaid).
- After saving, a big confirmation shows the order number and the change to give, with a
  **Print Receipt** button.

**Cashier - Pending Payments**

- Every unpaid order, oldest first, with the total to collect.
- **Mark as Paid** at any time, even after the food was served.

**Kitchen**

- Orders arrive instantly. Oldest order first, marked **NEXT UP**.
- Shows PAID / UNPAID, Dine In / Take Out, items with big quantities, notes, and waiting time.
- **Start Cooking** moves an order to "Now Cooking"; **Done & Served** finishes it.
- A "Served today" list keeps the board clean.

**Admin**

- **Sales Dashboard**: today/yesterday/last 7 days/this month/custom range, gross, collected,
  uncollected, average order, 7-day bar chart, payment split, order types, top items, recent orders.
- **Menu**: add/edit/delete items, photo upload, price, category, description, available/unavailable
  switch (unavailable items cannot be ordered).
- **Users**: create staff, change role, reset password, enable/disable, delete.
- **Audit Logs**: every sign-in, failed sign-in, order, payment, menu and user change, filterable.
- **Sales Reports**: printable A4 report and CSV export.
- **Settings**: restaurant name, address, phone and receipt footer (used on receipts and reports).

---

## 2. Quick start (local)

Requirements: **Node.js 20 or newer**, a Supabase account (free), and this folder.

```bash
npm install
npm run build:css
```

Create a file named `.env` in the project root (copy `.env.example`) and fill it in after finishing
the Supabase setup below:

```ini
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SESSION_SECRET=a-long-random-string
TIMEZONE=Asia/Manila
```

Generate a strong `SESSION_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Start the app:

```bash
npm start
```

Open <http://localhost:3000>. On the first run (before Supabase is configured) the app shows a
setup screen instead of crashing - that is expected.

For development with automatic restarts and CSS watching:

```bash
npm run dev        # terminal 1
npm run watch:css  # terminal 2
```

---

## 3. Supabase setup (one time)

1. Create a project at <https://supabase.com>. Wait until it finishes provisioning.
2. Open **SQL Editor > New query**, paste the entire contents of `supabase/setup.sql`, and click
   **Run**. This creates:
   - `users`, `sessions`, `settings`, `menu_items`, `orders`, `order_items`, `audit_logs`
   - the `create_pos_order` function (atomic order creation with server-side prices)
   - indexes, updated-at triggers, Row Level Security with no public policies
   - the `menu-images` storage bucket (public read, server-side uploads only)
   - the realtime publication for live updates
3. Open **Project Settings > API** and copy:
   - **Project URL** -> `SUPABASE_URL`
   - **service_role** secret -> `SUPABASE_SERVICE_ROLE_KEY` (never put this in the browser)
4. Restart the app. The setup screen is replaced by **Create the first administrator account**.

The first account is always an Admin and can only be created while the `users` table is empty.
After that the same endpoint is permanently disabled.

> The `menu-images` bucket is created by the SQL file. If it is ever deleted, the server recreates it
> automatically on the next photo upload.

---

## 4. Deploy on Render (free tier)

### Option A - Blueprint (recommended)

1. Push this folder to a GitHub repository.
2. In Render: **New > Blueprint**, pick the repository. Render reads `render.yaml`.
3. Fill in the two secret values it asks for:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. `SESSION_SECRET` is generated automatically. `TIMEZONE` is preset to `Asia/Manila`.
5. Deploy. The health check is `/healthz`.

### Option B - Manual web service

- Runtime: **Node**
- Build command: `npm install && npm run build:css`
- Start command: `npm start`
- Health check path: `/healthz`
- Environment variables: `NODE_ENV=production`, `SESSION_SECRET`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, and optionally `TIMEZONE`, `SUPABASE_BUCKET`, `SESSION_HOURS`, `PORT`.

The app refuses to start in production without `SESSION_SECRET` (development falls back to a
warning-only random secret).

### Free tier notes

- The service sleeps after ~15 minutes of inactivity. The first visit afterwards can take up to a
  minute; the app shows a "Starting the POS..." screen while it wakes up.
- Supabase free projects pause after about a week with no activity. Open the Supabase dashboard to
  resume, or keep the POS in daily use.
- Free Supabase storage is 1 GB. Menu photos are compressed by the server and capped at 5 MB each.

---

## 5. Daily use

### Tablets

- Open the site in Chrome, then **Add to Home screen** for a full-screen app-like window.
- Landscape works best for the cashier screen; portrait works for the kitchen board.
- Keep the tablet plugged in. The screen can be locked by the OS settings; the POS itself has no
  timeout, but the login session expires after `SESSION_HOURS` (default 12 hours).

### Receipts

- **Print Receipt** opens the browser print dialog with an 80mm receipt layout. Choose a thermal
  receipt printer (58mm/80mm) and enable background graphics if the logo is missing.
- For a receipt printer that needs a driver dialog, print once and set it as the default printer.

### Sales reports

- **Print Report** produces an A4 report with summary, daily breakdown, top items, staff
  performance and the order list.
- **Export CSV** downloads the order list for spreadsheets. It opens correctly in Excel (UTF-8 BOM).

### Money

- Prices are entered in pesos in the menu form and stored as exact decimals in the database.
- Change is calculated from the cash received; the API validates that cash is not below the total.

---

## 6. Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SUPABASE_URL` | yes | - | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | - | Server-side key. Keep secret. |
| `SESSION_SECRET` | production | dev fallback | Signs session tokens |
| `PORT` | no | `3000` | HTTP port (Render sets it) |
| `TIMEZONE` | no | `Asia/Manila` | All dates, reports and the clock |
| `SUPABASE_BUCKET` | no | `menu-images` | Storage bucket for menu photos |
| `SESSION_HOURS` | no | `12` | How long a signed-in session lasts |
| `NODE_ENV` | no | `development` | `production` enables secure cookies and strict checks |

---

## 7. Security summary

- Passwords: bcrypt (cost 11), never stored or logged in plain text.
- Sessions: random 32-byte token in an `httpOnly`, `SameSite=Lax` cookie (Secure in production).
  Only an HMAC-SHA256 hash of the token is stored in the `sessions` table.
- Brute force: per-IP rate limiting on login, plus per-account lockout after 6 failures for 15 minutes.
- CSRF: every non-GET API call must send `X-Requested-With: kuyae-pos`, and the origin is checked.
- Headers: Helmet with a strict Content-Security-Policy (no inline scripts).
- Database: Row Level Security is enabled with no policies, so the anon key cannot read anything.
  Only the server's `service_role` key can access data.
- Audit trail: sign-ins, failed sign-ins, orders, payments, cancellations, menu and user changes.
- Order integrity: prices and totals are read from the database inside a Postgres function; a
  tampered browser cannot change what is charged.
- Deactivated users are signed out immediately and cannot sign in again.

---

## 8. Project structure

```
supabase/setup.sql        Database schema, RPC, RLS, bucket, realtime
src/server.js             Express app, security headers, static files
src/config.js             Environment configuration
src/supabase.js           Server-side Supabase client
src/realtime.js           Supabase realtime -> SSE fan-out
src/routes/               auth, menu, orders, users, audit, reports, settings, events
src/lib/                  helpers, timezone, serialization, audit, login guard
src/middleware/auth.js    Session authentication and role checks
public/index.html         App shell
public/js/app.js          Boot, router, role navigation
public/js/views/          One module per screen
public/js/components.js   Badges, payment modal, order details, receipts, reports
public/js/ui.js           Formatting, toasts, modals, loaders
src/styles/input.css      Tailwind source + component classes
public/css/tailwind.css   Compiled CSS (generated by npm run build:css)
```

---

## 9. Troubleshooting

**"Setup required" screen after deploying**
The environment variables are missing or wrong. Check `SUPABASE_URL` (must start with `https://`) and
`SUPABASE_SERVICE_ROLE_KEY` (the long `service_role` secret, not the anon key), then redeploy.

**"Database tables are missing" message**
`supabase/setup.sql` was not run, or was run in a different project. Run it in the SQL Editor of the
project whose URL you configured.

**The app says it is not configured but the variables are set**
Render only applies variables after a restart. Trigger a manual deploy or restart the service.

**No live updates (pill says "Reconnecting")**
The server falls back to polling automatically, so screens still update within a few seconds.
If it never turns "Live", check the service logs for Supabase realtime errors and confirm
`supabase/setup.sql` completed (it adds the tables to the realtime publication).

**Menu photos do not upload**
Confirm the `menu-images` bucket exists (the SQL file creates it) and that the file is JPG, PNG or
WebP under 5 MB. The server needs the `service_role` key to write to storage.

**Receipt prints without the logo**
Enable "Background graphics" in the browser print dialog, or give the printer a moment to load the
image before printing.

**Locked out**
Wait 15 minutes, or have another admin reset the password under **Users > Edit**. If no admin can
sign in, reset the password directly in Supabase (bcrypt hash) or clear the `users` table and reload
the app to create the first admin again - only do this on a fresh install.

**Reports show the wrong day**
Set `TIMEZONE` (default `Asia/Manila`) and redeploy. All day boundaries, receipt times and report
dates use it.

---

## 10. Backups

Use the Supabase dashboard (**Database > Backups**) or `pg_dump` with the connection string from
**Project Settings > Database**. Menu photos live in **Storage > menu-images** and can be downloaded
from the dashboard. Export a CSV sales report regularly as a simple off-site copy.
