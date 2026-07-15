# Recorder Tracker

A tiny self-hosted web app for tracking who has the team's AI recorders (or any shared equipment). No login, no build step, one process, SQLite on disk.

## Features

- **Equipment tab** — a searchable, filterable table: one row per item with status chip, holder, relative due dates ("due in 2d", "3d overdue"), and upcoming-reservation chips. Status pills with live counts (All / Available / Out / Overdue / Unavailable) double as filters; overdue items sort to the top. Row actions: one primary button per state plus an overflow menu (rename, reserve ahead, history, mark unavailable, delete).
- **Rename equipment** — fix a typo or relabel an item without deleting and re-adding it (which would also wipe its history).
- **Export CSV** — the full event log (or one item's, via `?equipment_id=`) as a downloadable CSV for reporting or an audit trail.
- **Reservations** — one unified **Reserve** flow: leave "From" as now and the item is checked out immediately; pick a future start to book ahead (future bookings need an end time). The dialog remembers your name and offers duration presets (+1 hr / +2 hr / end of day / +1 day / +3 days / +1 week). Overlapping reservations are rejected, a checkout that would run into someone else's reservation is rejected, and checking out during your own reservation fulfills (consumes) it.
- **Calendar tab** — month view of availability across all equipment (or filtered to one item). Days are color-coded: green = everything free, amber = partially booked, red = everything busy. Click a day to open an hour-by-hour view (one column per item, 24 hour rows) showing exactly who has what and when — click any free future hour to book that item right there, which opens the Reserve flow pre-filled with that date and hour.
- State transitions are enforced server-side (you can't check out something that's already out; marking unavailable requires a reason; a checked-out item must be checked in before deletion). Status changes and the event log are written in the same SQLite transaction, so they can never disagree.

## Setup & run

Requires Python 3.10+.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Then open http://127.0.0.1:8000/ — the database (`recorder.db`) is created automatically next to `main.py`.

To make it reachable by the rest of the team on your LAN:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

## Project layout

```
main.py             FastAPI backend + SQLite (schema auto-created on startup)
static/index.html   Both views (Equipment + Calendar) in one page
static/app.js       All frontend logic, plain JS, no dependencies
static/style.css    Styling
recorder.db         SQLite database (created at first run)
```

## API sketch

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/equipment` | List all equipment with current status |
| POST | `/api/equipment` | Add an item `{name}` |
| PATCH | `/api/equipment/{id}` | Rename an item `{name}` |
| DELETE | `/api/equipment/{id}` | Delete an item (refused while checked out) |
| POST | `/api/equipment/{id}/checkout` | `{holder, expected_return_at?, note?}` |
| POST | `/api/equipment/{id}/checkin` | `{note?}` |
| POST | `/api/equipment/{id}/unavailable` | `{note}` — reason required |
| POST | `/api/equipment/{id}/available` | `{note?}` |
| GET | `/api/equipment/{id}/events?limit=25` | Recent history for one item |
| GET | `/api/events/export?equipment_id=` | Full event log as a CSV download |
| GET | `/api/reservations?equipment_id=` | Upcoming reservations |
| POST | `/api/equipment/{id}/reservations` | `{holder, start_at, end_at, note?}` — book a future slot |
| DELETE | `/api/reservations/{id}` | Cancel a reservation |
| GET | `/api/calendar?equipment_id=` | Busy intervals derived from the event log + reservations |

Invalid transitions return `409` with a human-readable `detail` message that the UI surfaces as a toast.

Calendar semantics (from `/api/calendar` intervals): a checkout spans `checked_out_at → expected_return_at` (or the actual check-in time once returned). A checkout with **no** expected return shows only on its checkout day rather than blocking the calendar forever — but an item that's overdue keeps blocking through today. An unavailable item spans from when it was marked unavailable until it's marked available again (ongoing if it hasn't been). Reservations block their booked `start_at → end_at` range; back-to-back bookings (one ending exactly when the next starts) are allowed.

Day coloring accounts for how much of *that specific day* is actually consumed, not just whether an item was touched: a booking only paints a day "fully unavailable" if it's still ongoing/unresolved (no known return, or still marked unavailable) or if it covers that day from midnight to midnight. Anything less — a two-hour meeting reservation, a checkout returned the same day, or even the first/last day of a multi-day span if it doesn't start or end right at a day boundary (e.g. checked out 1pm, returned 11am the next morning touches two calendar dates but doesn't fully consume either one) — paints it "partially booked" instead, even with several such bookings stacked on the same day.

All timestamps are stored as UTC ISO 8601 and rendered in the viewer's local timezone by the browser. Set `RECORDER_DB=/path/to/file.db` to override where the database lives.

There's no realtime push (no websockets) — the frontend polls every 15 seconds so both tabs pick up changes made by other people (or another tab of your own) without a manual reload, and switching tabs always re-fetches immediately too.

## Where this could grow

- **QR codes** — print a QR label per recorder pointing at a `/checkout?id=N` deep link, so people can scan-and-check-out from their phone. The `id` is stable, so labels survive redeploys.
- **Auth** — holder is free text today, which is fine for a trusting team. Next step would be lightweight magic-link or OAuth (e.g. `authlib`) and deriving the holder from the session instead of a text field.
- **Postgres migration** — the SQL is deliberately plain. Swapping `sqlite3` for `asyncpg`/SQLAlchemy is mostly mechanical; the event log's append-only design ports directly. Do this before multiple uvicorn workers, since SQLite writes are single-process here.
- **Notifications** — a small scheduled job could ping a Slack webhook when an item goes overdue (`expected_return_at < now` and still checked out).
- **Resource timeline** — a month calendar answers "what's happening on day X," which is the more common question at a handful of items. If the fleet grows into the dozens, a Gantt-style row-per-item timeline (one existed in an earlier version of this app, in git history) answers "when is item Y next free" better — worth revisiting at that scale.
