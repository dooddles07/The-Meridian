# The Meridian — Community Living Portal (Portfolio Demo)

A full **resident + management + guardhouse** portal for a residential community:
facility bookings, guest passes with QR check-in, parcel tracking, defect reports,
feedback, move-in/out scheduling, deposits & payments, announcements with RSVP,
two-way messaging, and document resources.

> **Portfolio demo build.** This is a sanitised, self-contained copy of a production
> system, published to showcase the UI/UX and front-end architecture. **It runs
> entirely in the browser** — no login, no database, no CRM, and no external
> network calls. Every screen is populated with realistic seeded data, and every
> action (book a facility, register a guest, move a booking's status, pay a deposit,
> reply to a message…) works against an in-browser mock. Nothing you do can reach a
> real backend or trigger any real workflow.

---

## Try it

```bash
cd backend
npm install
npm start
```

Then open **http://localhost:3000** and pick a portal:

| Portal | URL | Opens as |
|---|---|---|
| Resident | `/portal.html` | Alex Tan · Unit 12-08 |
| Management | `/management.html` | Management console |
| Guardhouse | `/guardhouse-portal.html` | Guard station |

No credentials are needed — each portal auto-enters. (Try guest ref **`GST-…`** from
the resident's "My Guests" list in the Guardhouse lookup to see cross-portal check-in.)

You can also serve the `public/` folder with any static file server, or deploy it to
a static host (Netlify / Vercel / GitHub Pages) — the app needs no server-side runtime.

---

## How the demo works

The production front-end talks to a REST API. For this demo, that API is replaced by
a **client-side mock** so there are zero external dependencies:

- [`public/js/demo-backend.js`](public/js/demo-backend.js) overrides `window.fetch`,
  intercepts every `"/api/…"` request, and answers it from an in-browser store
  (`localStorage`) seeded with demo data.
- The three portals share the same browser store, so actions in one appear in the
  others (a resident's booking shows up in the management table; a guest registration
  is findable at the guardhouse; a management status change syncs back to the resident).
- Authentication is bypassed — a demo session is seeded on load so recruiters/visitors
  can explore freely.
- Deposit payments open a **simulated** checkout page
  ([`public/demo-pay.html`](public/demo-pay.html)); no card is charged.

Reset all demo data anytime from the browser console:

```js
window.__meridianDemoReset()
```

## Tech

- **Front-end:** vanilla JavaScript (no framework), modular CSS design system, responsive
  layouts, light/dark theme, SweetAlert2, client-side QR generation/scanning.
- **Back-end (reference only):** Node.js + Express, kept under [`backend/`](backend/) to
  show the original architecture (JWT auth, security headers/Helmet, input hardening,
  Mongoose models, a CRM service layer, and pipeline/workflow integration). **It is not
  wired up in this demo** — `server.js` only serves the static front-end and opens no
  connections. All real tenant identifiers, credentials, domains and integration IDs
  have been removed.

## What's inside

**Resident portal** — dashboard, facility booking (with availability + deposits),
my bookings, guest registration + passes, parcel notifications, defect reporting,
feedback/complaints/suggestions, move-in/out booking, payments & history, announcements
+ RSVP, messaging, and downloadable resources.

**Management console** — bookings board with stage moves, guest & parcel & defect &
feedback & move pipelines, resident directory, announcements (events / maintenance /
facility blocking) with RSVP tracking, payments, resident messaging inbox, and resource
management.

**Guardhouse station** — QR / reference lookup for guest passes and parcels, check-in /
check-out / departure actions, parcel status updates, and a shared daily activity log.

---

*This repository is an independent portfolio copy and is not connected to, nor does it
communicate with, the original production deployment.*
