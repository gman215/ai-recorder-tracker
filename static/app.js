"use strict";

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const DAY_MS = 86400000;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") detail = body.detail;
      else if (Array.isArray(body.detail) && body.detail[0]?.msg) detail = body.detail[0].msg;
    } catch (_) { /* keep default */ }
    throw new Error(detail);
  }
  return res.json();
}

let toastTimer;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtDateTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function fmtDate(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "2d" / "3h" / "10m" magnitude of the distance to `iso`
function relSpan(iso) {
  const abs = Math.abs(new Date(iso) - Date.now());
  if (abs >= DAY_MS) return Math.round(abs / DAY_MS) + "d";
  if (abs >= 3600000) return Math.round(abs / 3600000) + "h";
  return Math.max(1, Math.round(abs / 60000)) + "m";
}

function localVal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function isOverdue(item) {
  return item.status === "checked_out" && item.expected_return_at
    && new Date(item.expected_return_at) < new Date();
}

function effStatus(item) {
  return isOverdue(item) ? "overdue" : item.status;
}

// ---------- tabs ----------

function showTab(name) {
  $("#tab-equipment").classList.toggle("active", name === "equipment");
  $("#tab-calendar").classList.toggle("active", name === "calendar");
  $("#view-equipment").classList.toggle("hidden", name !== "equipment");
  $("#view-calendar").classList.toggle("hidden", name !== "calendar");
  if (name === "calendar") refreshCalendar(); else refreshEquipment();
}

$("#tab-equipment").addEventListener("click", () => showTab("equipment"));
$("#tab-calendar").addEventListener("click", () => showTab("calendar"));

// ---------- equipment table ----------

const ACTION_LABELS = {
  check_out: "Checked out",
  check_in: "Checked in",
  mark_unavailable: "Marked unavailable",
  mark_available: "Marked available",
  reserve: "Reserved",
  cancel_reservation: "Reservation cancelled",
};

const STATUS_LABELS = {
  available: "Available", checked_out: "Checked out",
  overdue: "Overdue", unavailable: "Unavailable",
};

const STATUS_RANK = { overdue: 0, checked_out: 1, unavailable: 2, available: 3 };

let equipmentList = [];
let reservationsByItem = new Map();
let statusFilter = "all";

async function refreshEquipment() {
  try {
    const [items, reservations] = await Promise.all([
      api("/api/equipment"),
      api("/api/reservations"),
    ]);
    equipmentList = items;
    reservationsByItem = new Map();
    for (const r of reservations) {
      if (!reservationsByItem.has(r.equipment_id)) reservationsByItem.set(r.equipment_id, []);
      reservationsByItem.get(r.equipment_id).push(r);
    }
    renderPills();
    renderTable();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderPills() {
  const counts = { all: equipmentList.length, available: 0, checked_out: 0, overdue: 0, unavailable: 0 };
  for (const it of equipmentList) {
    counts[it.status]++;
    if (isOverdue(it)) counts.overdue++;
  }
  const defs = [
    ["all", "All"], ["available", "Available"], ["checked_out", "Out"],
    ["overdue", "Overdue"], ["unavailable", "Unavailable"],
  ];
  $("#status-pills").innerHTML = defs.map(([key, label]) =>
    `<button class="pill${statusFilter === key ? " active" : ""}${key === "overdue" && counts.overdue ? " alert" : ""}"
      data-filter="${key}">${label} <span class="cnt">${counts[key]}</span></button>`
  ).join("");
  document.querySelectorAll("#status-pills .pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      statusFilter = btn.dataset.filter;
      renderPills();
      renderTable();
    });
  });
}

function rowMatches(item) {
  const st = effStatus(item);
  if (statusFilter === "checked_out" && item.status !== "checked_out") return false;
  if (statusFilter !== "all" && statusFilter !== "checked_out" && st !== statusFilter) return false;
  const q = $("#search").value.trim().toLowerCase();
  if (!q) return true;
  return item.name.toLowerCase().includes(q) || (item.holder || "").toLowerCase().includes(q);
}

function dueHtml(item) {
  if (item.status === "checked_out") {
    let s = `out for ${relSpan(item.checked_out_at)}`;
    if (item.expected_return_at) {
      s += isOverdue(item)
        ? ` · <strong class="late">${relSpan(item.expected_return_at)} overdue</strong>`
        : ` · due in ${relSpan(item.expected_return_at)}`;
    }
    if (item.note) s += ` <span class="dim" title="${escapeHtml(item.note)}">✎</span>`;
    return s;
  }
  if (item.status === "unavailable") return escapeHtml(item.note || "—");
  return "—";
}

function upcomingHtml(item) {
  const list = reservationsByItem.get(item.id) || [];
  return list.map((r) => `
    <span class="res-chip" title="${fmtDateTime(r.start_at)} → ${fmtDateTime(r.end_at)}${r.note ? " · " + escapeHtml(r.note) : ""}">
      📅 ${escapeHtml(r.holder)} · ${fmtDate(new Date(r.start_at))}–${fmtDate(new Date(r.end_at))}
      <button class="chip-x" data-cancel-res="${r.id}" data-holder="${escapeHtml(r.holder)}" title="Cancel reservation">✕</button>
    </span>`).join("");
}

function actionsHtml(item) {
  const n = escapeHtml(item.name);
  const primary = {
    available: `<button class="btn primary sm" data-action="reserve" data-id="${item.id}" data-name="${n}">Reserve</button>`,
    checked_out: `<button class="btn primary sm" data-action="checkin" data-id="${item.id}" data-name="${n}">Check in</button>`,
    unavailable: `<button class="btn primary sm" data-action="available" data-id="${item.id}" data-name="${n}">Mark available</button>`,
  }[item.status];
  const extra = [`<button data-action="rename" data-id="${item.id}" data-name="${n}">Rename</button>`];
  if (item.status !== "available") extra.push(`<button data-action="reserve" data-id="${item.id}" data-name="${n}">Reserve ahead</button>`);
  extra.push(`<button data-action="history" data-id="${item.id}" data-name="${n}">History</button>`);
  if (item.status === "available") extra.push(`<button data-action="unavailable" data-id="${item.id}" data-name="${n}">Mark unavailable</button>`);
  extra.push(`<button class="danger" data-action="delete" data-id="${item.id}" data-name="${n}">Delete</button>`);
  return `${primary}
    <div class="menu">
      <button class="btn sm menu-btn" data-menu title="More actions">⋯</button>
      <div class="menu-pop hidden">${extra.join("")}</div>
    </div>`;
}

function renderTable() {
  const rows = equipmentList.filter(rowMatches).sort((a, b) =>
    STATUS_RANK[effStatus(a)] - STATUS_RANK[effStatus(b)]
    || (a.expected_return_at || "9999").localeCompare(b.expected_return_at || "9999")
    || a.name.localeCompare(b.name)
  );
  $("#equipment-empty").classList.toggle("hidden", rows.length > 0);
  $("#equipment-table").classList.toggle("hidden", rows.length === 0);

  $("#equipment-rows").innerHTML = rows.map((item) => {
    const st = effStatus(item);
    return `<tr class="${st === "overdue" ? "row-overdue" : ""}">
      <td class="td-name">${escapeHtml(item.name)}</td>
      <td><span class="badge ${st}">${STATUS_LABELS[st]}</span></td>
      <td>${item.holder ? escapeHtml(item.holder) : '<span class="dim">—</span>'}</td>
      <td class="td-due">${dueHtml(item)}</td>
      <td class="td-upcoming">${upcomingHtml(item) || '<span class="dim">—</span>'}</td>
      <td class="td-actions">${actionsHtml(item)}</td>
    </tr>`;
  }).join("");

  bindTableHandlers();
}

function bindTableHandlers() {
  document.querySelectorAll("#equipment-rows [data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleAction(
      btn.dataset.action, Number(btn.dataset.id), btn.dataset.name,
    ));
  });
  document.querySelectorAll("#equipment-rows [data-cancel-res]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(`Cancel ${btn.dataset.holder}'s reservation?`)) return;
      try {
        await api(`/api/reservations/${btn.dataset.cancelRes}`, { method: "DELETE" });
        toast("Reservation cancelled.");
        await refreshEquipment();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  document.querySelectorAll("#equipment-rows [data-menu]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pop = btn.nextElementSibling;
      const wasHidden = pop.classList.contains("hidden");
      closeMenus();
      pop.classList.toggle("hidden", !wasHidden);
    });
  });
}

function closeMenus() {
  document.querySelectorAll(".menu-pop").forEach((p) => p.classList.add("hidden"));
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu")) closeMenus();
});

$("#search").addEventListener("input", renderTable);

async function handleAction(action, id, name) {
  closeMenus();
  try {
    if (action === "reserve") {
      openReserveDialog(id, name);
    } else if (action === "rename") {
      openRenameDialog(id, name);
    } else if (action === "checkin") {
      await api(`/api/equipment/${id}/checkin`, { method: "POST", body: JSON.stringify({}) });
      toast(`${name} checked in.`);
      await refreshEquipment();
    } else if (action === "unavailable") {
      openUnavailableDialog(id, name);
    } else if (action === "available") {
      await api(`/api/equipment/${id}/available`, { method: "POST", body: JSON.stringify({}) });
      toast(`${name} is available again.`);
      await refreshEquipment();
    } else if (action === "history") {
      await openHistoryDialog(id, name);
    } else if (action === "delete") {
      if (!confirm(`Delete "${name}" and its history? This can't be undone.`)) return;
      await api(`/api/equipment/${id}`, { method: "DELETE" });
      toast(`${name} deleted.`);
      await refreshEquipment();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#add-name");
  const name = input.value.trim();
  if (!name) return;
  try {
    await api("/api/equipment", { method: "POST", body: JSON.stringify({ name }) });
    input.value = "";
    toast(`${name} added.`);
    await refreshEquipment();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- dialogs ----------

document.querySelectorAll("dialog [data-close]").forEach((btn) => {
  btn.addEventListener("click", () => btn.closest("dialog").close());
});

let reserveTargetId = null;
// startAt/endAt let the day-hour-grid pre-fill a specific slot; equipment-table
// callers omit them and get the usual "From = now, Until = blank" default.
function openReserveDialog(id, name, startAt, endAt) {
  reserveTargetId = id;
  $("#reserve-item-name").textContent = name;
  $("#reserve-form").reset();
  $("#reserve-start").value = localVal(startAt || new Date());
  $("#reserve-end").value = endAt ? localVal(endAt) : "";
  $("#reserve-holder").value = localStorage.getItem("rt-holder") || "";
  $("#reserve-dialog").showModal();
}

// Duration presets fill "Until" relative to the chosen "From" time.
// "Nh" = N hours (e.g. "1h", "2h" for quick meeting-length bookings),
// "eod" = end of that day, a bare number = that many days.
$("#reserve-presets").addEventListener("click", (e) => {
  const preset = e.target.dataset?.preset;
  if (!preset) return;
  const base = new Date($("#reserve-start").value || Date.now());
  let end;
  if (preset === "eod") {
    end = new Date(base);
    end.setHours(18, 0, 0, 0);
    if (end <= base) end.setDate(end.getDate() + 1); // already past 6 PM
  } else if (preset.endsWith("h")) {
    end = new Date(base.getTime() + Number(preset.slice(0, -1)) * HOUR_MS);
  } else {
    end = new Date(base.getTime() + Number(preset) * DAY_MS);
  }
  $("#reserve-end").value = localVal(end);
});

// One flow for both: a start time at (or before) now checks the item out
// immediately; a future start creates a reservation.
$("#reserve-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const holder = $("#reserve-holder").value.trim();
  const start = new Date($("#reserve-start").value);
  const end = $("#reserve-end").value;
  const note = $("#reserve-note").value.trim();
  const startsNow = start.getTime() - Date.now() < 60000;
  try {
    if (startsNow) {
      await api(`/api/equipment/${reserveTargetId}/checkout`, {
        method: "POST",
        body: JSON.stringify({
          holder,
          expected_return_at: end ? new Date(end).toISOString() : null,
          note: note || null,
        }),
      });
      toast("Checked out.");
    } else {
      if (!end) {
        toast("Future bookings need an \"Until\" time.", true);
        return;
      }
      await api(`/api/equipment/${reserveTargetId}/reservations`, {
        method: "POST",
        body: JSON.stringify({
          holder,
          start_at: start.toISOString(),
          end_at: new Date(end).toISOString(),
          note: note || null,
        }),
      });
      toast("Reserved.");
    }
    localStorage.setItem("rt-holder", holder);
    $("#reserve-dialog").close();
    await refreshEquipment();
  } catch (err) {
    toast(err.message, true);
  }
});

let renameTargetId = null;
function openRenameDialog(id, name) {
  renameTargetId = id;
  $("#rename-name").value = name;
  $("#rename-dialog").showModal();
}

$("#rename-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#rename-name").value.trim();
  try {
    await api(`/api/equipment/${renameTargetId}`, { method: "PATCH", body: JSON.stringify({ name }) });
    $("#rename-dialog").close();
    toast("Renamed.");
    await refreshEquipment();
  } catch (err) {
    toast(err.message, true);
  }
});

let unavailableTargetId = null;
function openUnavailableDialog(id, name) {
  unavailableTargetId = id;
  $("#unavailable-item-name").textContent = name;
  $("#unavailable-form").reset();
  $("#unavailable-dialog").showModal();
}

$("#unavailable-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const note = $("#unavailable-note").value.trim();
  try {
    await api(`/api/equipment/${unavailableTargetId}/unavailable`, {
      method: "POST",
      body: JSON.stringify({ note }),
    });
    $("#unavailable-dialog").close();
    toast("Marked unavailable.");
    await refreshEquipment();
  } catch (err) {
    toast(err.message, true);
  }
});

async function openHistoryDialog(id, name) {
  const events = await api(`/api/equipment/${id}/events?limit=25`);
  $("#history-item-name").textContent = name;
  $("#history-list").innerHTML = events.length
    ? events.map((ev) => `
        <div class="history-entry">
          <div><strong>${ACTION_LABELS[ev.action] || ev.action}</strong>${ev.holder ? ` — ${escapeHtml(ev.holder)}` : ""}</div>
          <div class="when">${fmtDateTime(ev.created_at)}</div>
          ${ev.note ? `<div class="note">${escapeHtml(ev.note)}</div>` : ""}
        </div>`).join("")
    : '<p class="empty">No events yet.</p>';
  $("#history-dialog").showModal();
}

// ---------- calendar ----------

let calYear, calMonth; // calMonth is 0-based
let calData = null;    // last /api/calendar response
let selectedDayKey = null;

{
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
}

$("#cal-prev").addEventListener("click", () => shiftMonth(-1));
$("#cal-next").addEventListener("click", () => shiftMonth(1));
$("#cal-today").addEventListener("click", () => {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  selectedDayKey = null;
  renderCalendar();
});
$("#cal-filter").addEventListener("change", refreshCalendar);

function shiftMonth(delta) {
  const d = new Date(calYear, calMonth + delta, 1);
  calYear = d.getFullYear();
  calMonth = d.getMonth();
  selectedDayKey = null;
  renderCalendar();
}

async function refreshCalendar() {
  const filter = $("#cal-filter").value;
  try {
    calData = await api("/api/calendar" + (filter ? `?equipment_id=${filter}` : ""));
    updateFilterOptions(calData.equipment, filter);
    renderCalendar();
  } catch (err) {
    toast(err.message, true);
  }
}

function updateFilterOptions(equipment, current) {
  const sel = $("#cal-filter");
  sel.innerHTML = '<option value="">All equipment</option>' +
    equipment.map((e) => `<option value="${e.id}"${String(e.id) === current ? " selected" : ""}>${escapeHtml(e.name)}</option>`).join("");
}

// "YYYY-MM-DD" local-date key for a Date.
function dayKey(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// Expand intervals into a map of dayKey -> [{equipment_id, ...interval}] for
// the visible range. Returns entries deduped per equipment per day.
function busyByDay(firstVisible, lastVisible) {
  const map = new Map();
  if (!calData) return map;
  const today = new Date();

  for (const iv of calData.intervals) {
    let start = new Date(iv.start);
    let end;
    if (iv.type === "checked_out" && iv.end === null) {
      end = start; // no expected return: only the checkout day
    } else if (iv.end === null) {
      end = lastVisible; // ongoing unavailable: through end of visible range
    } else {
      end = new Date(iv.end);
      // Still checked out past the expected return: keep blocking through today.
      if (iv.open && iv.type === "checked_out" && end < today) end = today;
    }
    if (end < start) end = start;

    // Clamp to visible range, then walk days.
    const from = start < firstVisible ? new Date(firstVisible) : new Date(start);
    from.setHours(0, 0, 0, 0);
    const until = end > lastVisible ? lastVisible : end;
    for (let d = from; d <= until; d.setDate(d.getDate() + 1)) {
      const key = dayKey(d);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(iv);
    }
  }
  return map;
}

// How much of one specific calendar day (from dayStart 00:00 to dayEnd next
// midnight) an interval actually consumes for its item:
//   "full"    — still ongoing/unresolved (unknown end so treated
//               conservatively), or it covers this day from its very start
//               to its very end (a multi-day span's fully-enclosed days, or
//               an exact all-day booking).
//   "partial" — anything less than the whole day — a two-hour meeting
//               reservation, a checkout returned the same day, or even the
//               first/last day of a multi-day span if it doesn't start
//               right at midnight or end right at the next one (e.g. an
//               overnight checkout from 1pm to 11am the next morning only
//               partially touches each of those two days, not all of
//               either).
function intervalLevel(iv, dayStart, dayEnd) {
  if (iv.open) return "full";
  const start = new Date(iv.start);
  const end = new Date(iv.end);
  return (start <= dayStart && end >= dayEnd) ? "full" : "partial";
}

function renderCalendar() {
  if (!calData) return;
  const monthName = new Date(calYear, calMonth, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  $("#cal-title").textContent = monthName;

  const firstOfMonth = new Date(calYear, calMonth, 1);
  const firstVisible = new Date(firstOfMonth);
  firstVisible.setDate(1 - firstOfMonth.getDay()); // back up to Sunday
  const lastOfMonth = new Date(calYear, calMonth + 1, 0);
  const lastVisible = new Date(lastOfMonth);
  lastVisible.setDate(lastOfMonth.getDate() + (6 - lastOfMonth.getDay()));
  lastVisible.setHours(23, 59, 59, 999);

  const busy = busyByDay(firstVisible, lastVisible);
  const totalEquipment = calData.equipment.length;
  const filterActive = $("#cal-filter").value !== "";
  const denominator = filterActive ? 1 : totalEquipment;
  const todayKey = dayKey(new Date());

  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let html = dows.map((d) => `<div class="cal-dow">${d}</div>`).join("");

  for (let d = new Date(firstVisible); d <= lastVisible; d.setDate(d.getDate() + 1)) {
    const key = dayKey(d);
    const entries = busy.get(key) || [];
    const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);

    // One item can have several bookings the same day (e.g. two separate
    // meeting-length reservations) — take the worse of its levels that day.
    const levelByItem = new Map();
    for (const iv of entries) {
      const lvl = intervalLevel(iv, dayStart, dayEnd);
      if (levelByItem.get(iv.equipment_id) !== "full") levelByItem.set(iv.equipment_id, lvl);
    }
    const busyCount = levelByItem.size;
    const fullCount = [...levelByItem.values()].filter((lvl) => lvl === "full").length;

    let status = "";
    if (denominator > 0) {
      if (busyCount === 0) status = "status-available";
      else if (fullCount >= denominator) status = "status-full";
      else status = "status-partial";
    }
    const classes = [
      "cal-day", status,
      d.getMonth() !== calMonth ? "outside" : "",
      key === todayKey ? "today" : "",
      key === selectedDayKey ? "selected" : "",
    ].filter(Boolean).join(" ");

    html += `
      <div class="${classes}" data-day="${key}">
        <span class="cal-day-num">${d.getDate()}</span>
        ${busyCount ? `<span class="cal-day-count">${busyCount} busy</span>` : ""}
      </div>`;
  }

  const grid = $("#calendar-grid");
  grid.innerHTML = html;
  grid.querySelectorAll(".cal-day").forEach((cell) => {
    cell.addEventListener("click", () => {
      selectedDayKey = cell.dataset.day;
      renderCalendar();
      openDayDialog(selectedDayKey);
    });
  });
}

const HOUR_MS = 3600000;

// Click a day to see it broken into hours, one column per equipment item —
// busy hours show who has it, free future hours are clickable to book.
// Always fetches its own unfiltered data, independent of the month view's
// "Show" dropdown, so every item's real availability is visible here even
// when the grid behind it is filtered down to one piece of equipment.
async function openDayDialog(key) {
  const dayStart = new Date(key + "T00:00:00");
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const now = new Date();

  $("#day-dialog-title").textContent = dayStart.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  let data;
  try {
    data = await api("/api/calendar");
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const equipment = data.equipment;

  const table = $("#day-hours-grid");
  if (equipment.length === 0) {
    table.innerHTML = '<tr><td class="empty">No equipment yet — add items on the Equipment tab.</td></tr>';
    $("#day-dialog").showModal();
    return;
  }

  // Effective occupied ranges per item for this specific day — same
  // open-ended/overdue handling as the month grid, just clipped to 24h.
  const rangesByItem = new Map();
  for (const iv of data.intervals) {
    let start = new Date(iv.start);
    let end;
    if (iv.type === "checked_out" && iv.end === null) {
      end = new Date(start.getTime() + HOUR_MS); // marker: at least show the checkout hour
    } else if (iv.end === null) {
      end = dayEnd; // ongoing unavailable
    } else {
      end = new Date(iv.end);
      if (iv.open && iv.type === "checked_out" && end < now) end = now; // overdue: still out
    }
    if (end <= start) end = new Date(start.getTime() + HOUR_MS);
    const s = start < dayStart ? dayStart : start;
    const e = end > dayEnd ? dayEnd : end;
    if (e <= dayStart || s >= dayEnd) continue; // doesn't touch this day
    if (!rangesByItem.has(iv.equipment_id)) rangesByItem.set(iv.equipment_id, []);
    rangesByItem.get(iv.equipment_id).push({ start: s, end: e, iv });
  }

  let html = `<thead><tr><th></th>${equipment.map((e) => `<th>${escapeHtml(e.name)}</th>`).join("")}</tr></thead><tbody>`;
  for (let h = 0; h < 24; h++) {
    const hourStart = new Date(dayStart.getTime() + h * HOUR_MS);
    const hourEnd = new Date(hourStart.getTime() + HOUR_MS);
    const label = hourStart.toLocaleTimeString(undefined, { hour: "numeric" });
    html += `<tr><td class="day-hour-label">${label}</td>`;
    for (const eq of equipment) {
      const hit = (rangesByItem.get(eq.id) || []).find((r) => r.start < hourEnd && r.end > hourStart);
      if (hit) {
        const iv = hit.iv;
        const text = iv.type === "unavailable" ? (iv.note || "unavailable") : (iv.holder || "");
        html += `<td class="day-cell busy-${iv.type}" title="${escapeHtml(eq.name)} · ${escapeHtml(text)}">${escapeHtml(text)}</td>`;
      } else if (hourEnd <= now) {
        html += `<td class="day-cell disabled"></td>`;
      } else {
        html += `<td class="day-cell free" data-eq-id="${eq.id}" data-eq-name="${escapeHtml(eq.name)}" data-hour="${h}"
          title="Book ${escapeHtml(eq.name)} at ${label}">+</td>`;
      }
    }
    html += `</tr>`;
  }
  html += `</tbody>`;
  table.innerHTML = html;

  table.querySelectorAll(".day-cell.free").forEach((cell) => {
    cell.addEventListener("click", () => {
      const start = new Date(dayStart.getTime() + Number(cell.dataset.hour) * HOUR_MS);
      const end = new Date(start.getTime() + HOUR_MS);
      $("#day-dialog").close();
      openReserveDialog(Number(cell.dataset.eqId), cell.dataset.eqName, start, end);
    });
  });

  $("#day-dialog").showModal();
}

// ---------- init ----------

refreshEquipment();

// This is a shared, no-login tool — someone else can check an item in or
// book it while you're sitting on a tab. There's no realtime push, so poll
// whichever view is visible to pick up other people's changes automatically.
const POLL_MS = 15000;
setInterval(() => {
  if (!$("#view-calendar").classList.contains("hidden")) refreshCalendar();
  else if (!$("#view-equipment").classList.contains("hidden")) refreshEquipment();
}, POLL_MS);
