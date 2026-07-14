"""Recorder Tracker — checkout tracking for shared AI recorders.

Run with: uvicorn main:app --reload
"""
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

DB_PATH = Path(__file__).parent / "recorder.db"

app = FastAPI(title="Recorder Tracker")


# ---------- database ----------

def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def db():
    """One connection per request; commit on success, rollback on any error.

    Every handler does all its reads and writes inside a single `with db()`
    block, so the equipment status update and the event log insert always
    land in the same transaction.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS equipment (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'available'
                    CHECK (status IN ('available', 'checked_out', 'unavailable')),
                holder TEXT,
                checked_out_at TEXT,
                expected_return_at TEXT,
                note TEXT
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
                action TEXT NOT NULL
                    CHECK (action IN ('check_out', 'check_in', 'mark_unavailable', 'mark_available')),
                holder TEXT,
                note TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_equipment ON events(equipment_id, id);
            """
        )


init_db()


def get_item(conn, equipment_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM equipment WHERE id = ?", (equipment_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Equipment not found")
    return row


def log_event(conn, equipment_id: int, action: str, holder: Optional[str], note: Optional[str]):
    conn.execute(
        "INSERT INTO events (equipment_id, action, holder, note, created_at) VALUES (?, ?, ?, ?, ?)",
        (equipment_id, action, holder, note, utcnow()),
    )


def parse_iso(value: str, field: str) -> str:
    try:
        datetime.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"{field} must be an ISO 8601 datetime")
    return value


# ---------- request bodies ----------

class EquipmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class CheckOutIn(BaseModel):
    holder: str = Field(min_length=1, max_length=200)
    expected_return_at: Optional[str] = None
    note: Optional[str] = Field(default=None, max_length=1000)


class CheckInIn(BaseModel):
    note: Optional[str] = Field(default=None, max_length=1000)


class UnavailableIn(BaseModel):
    note: str = Field(min_length=1, max_length=1000)


class AvailableIn(BaseModel):
    note: Optional[str] = Field(default=None, max_length=1000)


# ---------- equipment endpoints ----------

@app.get("/api/equipment")
def list_equipment():
    with db() as conn:
        rows = conn.execute("SELECT * FROM equipment ORDER BY name COLLATE NOCASE").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/equipment", status_code=201)
def add_equipment(body: EquipmentIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Name cannot be blank")
    with db() as conn:
        cur = conn.execute("INSERT INTO equipment (name) VALUES (?)", (name,))
        row = conn.execute("SELECT * FROM equipment WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


@app.delete("/api/equipment/{equipment_id}")
def delete_equipment(equipment_id: int):
    with db() as conn:
        item = get_item(conn, equipment_id)
        if item["status"] == "checked_out":
            raise HTTPException(
                status_code=409,
                detail=f"\"{item['name']}\" is checked out by {item['holder']} — check it in before deleting.",
            )
        conn.execute("DELETE FROM equipment WHERE id = ?", (equipment_id,))
    return {"ok": True}


@app.post("/api/equipment/{equipment_id}/checkout")
def check_out(equipment_id: int, body: CheckOutIn):
    holder = body.holder.strip()
    if not holder:
        raise HTTPException(status_code=422, detail="Holder name cannot be blank")
    expected = parse_iso(body.expected_return_at, "expected_return_at") if body.expected_return_at else None
    with db() as conn:
        item = get_item(conn, equipment_id)
        if item["status"] == "checked_out":
            raise HTTPException(
                status_code=409,
                detail=f"\"{item['name']}\" is already checked out by {item['holder']}.",
            )
        if item["status"] == "unavailable":
            raise HTTPException(
                status_code=409,
                detail=f"\"{item['name']}\" is marked unavailable ({item['note'] or 'no reason given'}). Mark it available first.",
            )
        now = utcnow()
        conn.execute(
            "UPDATE equipment SET status='checked_out', holder=?, checked_out_at=?, expected_return_at=?, note=? WHERE id=?",
            (holder, now, expected, body.note, equipment_id),
        )
        log_event(conn, equipment_id, "check_out", holder, body.note)
        row = conn.execute("SELECT * FROM equipment WHERE id = ?", (equipment_id,)).fetchone()
    return dict(row)


@app.post("/api/equipment/{equipment_id}/checkin")
def check_in(equipment_id: int, body: CheckInIn):
    with db() as conn:
        item = get_item(conn, equipment_id)
        if item["status"] != "checked_out":
            raise HTTPException(
                status_code=409,
                detail=f"\"{item['name']}\" is not checked out (current status: {item['status'].replace('_', ' ')}).",
            )
        conn.execute(
            "UPDATE equipment SET status='available', holder=NULL, checked_out_at=NULL, expected_return_at=NULL, note=NULL WHERE id=?",
            (equipment_id,),
        )
        log_event(conn, equipment_id, "check_in", item["holder"], body.note)
        row = conn.execute("SELECT * FROM equipment WHERE id = ?", (equipment_id,)).fetchone()
    return dict(row)


@app.post("/api/equipment/{equipment_id}/unavailable")
def mark_unavailable(equipment_id: int, body: UnavailableIn):
    note = body.note.strip()
    if not note:
        raise HTTPException(status_code=422, detail="A reason note is required to mark equipment unavailable")
    with db() as conn:
        item = get_item(conn, equipment_id)
        if item["status"] == "checked_out":
            raise HTTPException(
                status_code=409,
                detail=f"\"{item['name']}\" is checked out by {item['holder']} — check it in first.",
            )
        if item["status"] == "unavailable":
            raise HTTPException(status_code=409, detail=f"\"{item['name']}\" is already marked unavailable.")
        conn.execute(
            "UPDATE equipment SET status='unavailable', holder=NULL, checked_out_at=NULL, expected_return_at=NULL, note=? WHERE id=?",
            (note, equipment_id),
        )
        log_event(conn, equipment_id, "mark_unavailable", None, note)
        row = conn.execute("SELECT * FROM equipment WHERE id = ?", (equipment_id,)).fetchone()
    return dict(row)


@app.post("/api/equipment/{equipment_id}/available")
def mark_available(equipment_id: int, body: AvailableIn):
    with db() as conn:
        item = get_item(conn, equipment_id)
        if item["status"] != "unavailable":
            raise HTTPException(
                status_code=409,
                detail=f"\"{item['name']}\" is not marked unavailable (current status: {item['status'].replace('_', ' ')}).",
            )
        conn.execute(
            "UPDATE equipment SET status='available', note=NULL WHERE id=?",
            (equipment_id,),
        )
        log_event(conn, equipment_id, "mark_available", None, body.note)
        row = conn.execute("SELECT * FROM equipment WHERE id = ?", (equipment_id,)).fetchone()
    return dict(row)


@app.get("/api/equipment/{equipment_id}/events")
def item_events(equipment_id: int, limit: int = 25):
    limit = max(1, min(limit, 100))
    with db() as conn:
        get_item(conn, equipment_id)
        rows = conn.execute(
            "SELECT * FROM events WHERE equipment_id = ? ORDER BY id DESC LIMIT ?",
            (equipment_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


# ---------- calendar ----------

@app.get("/api/calendar")
def calendar_data(equipment_id: Optional[int] = None):
    """Busy intervals derived from the event log.

    Each interval is {equipment_id, equipment_name, type, start, end, holder, note, open}:
      - type 'checked_out', end set: item is/was out from start until end
        (actual check-in for closed pairs, expected return for the open one)
      - type 'checked_out', end null, open: checked out with no expected
        return — should show on its start day only, not block days forever
      - type 'unavailable', end null, open: still unavailable — ongoing
    """
    with db() as conn:
        eq_rows = conn.execute("SELECT * FROM equipment ORDER BY name COLLATE NOCASE").fetchall()
        if equipment_id is not None:
            get_item(conn, equipment_id)
            ev_rows = conn.execute(
                "SELECT * FROM events WHERE equipment_id = ? ORDER BY id", (equipment_id,)
            ).fetchall()
        else:
            ev_rows = conn.execute("SELECT * FROM events ORDER BY id").fetchall()

    eq_by_id = {r["id"]: r for r in eq_rows}
    intervals = []
    open_checkout: dict[int, sqlite3.Row] = {}
    open_unavailable: dict[int, sqlite3.Row] = {}

    def interval(eid, type_, start, end, holder, note, open_):
        return {
            "equipment_id": eid,
            "equipment_name": eq_by_id[eid]["name"],
            "type": type_,
            "start": start,
            "end": end,
            "holder": holder,
            "note": note,
            "open": open_,
        }

    for ev in ev_rows:
        eid = ev["equipment_id"]
        if eid not in eq_by_id:
            continue
        action = ev["action"]
        if action == "check_out":
            open_checkout[eid] = ev
        elif action == "check_in":
            started = open_checkout.pop(eid, None)
            if started is not None:
                intervals.append(interval(
                    eid, "checked_out", started["created_at"], ev["created_at"],
                    started["holder"], started["note"], False,
                ))
        elif action == "mark_unavailable":
            open_unavailable[eid] = ev
        elif action == "mark_available":
            started = open_unavailable.pop(eid, None)
            if started is not None:
                intervals.append(interval(
                    eid, "unavailable", started["created_at"], ev["created_at"],
                    None, started["note"], False,
                ))

    for eid, ev in open_checkout.items():
        eq = eq_by_id[eid]
        intervals.append(interval(
            eid, "checked_out",
            eq["checked_out_at"] or ev["created_at"],
            eq["expected_return_at"],  # may be null: show on checkout day only
            ev["holder"], ev["note"], True,
        ))
    for eid, ev in open_unavailable.items():
        intervals.append(interval(
            eid, "unavailable", ev["created_at"], None, None, ev["note"], True,
        ))

    return {
        "equipment": [{"id": r["id"], "name": r["name"]} for r in eq_rows],
        "intervals": intervals,
    }


# Static frontend — mounted last so /api/* routes win.
app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
