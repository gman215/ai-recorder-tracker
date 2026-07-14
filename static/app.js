"use strict";

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);

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

function fmtDateTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Local calendar-date key ("YYYY-MM-DD") for a UTC timestamp.
function dayKey(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// ---------- tabs ----------

function showTab(name) {
  $("#tab-equipment").classList.toggle("active", name === "equipment");
  $("#tab-calendar").classList.toggle("active", name === "calendar");
  $("#view-equipment").classList.toggle("hidden", name !== "equipment");
  $("#view-calendar").classList.toggle("hidden", name !== "calendar");
  if (name === "calendar") refreshCalendar();
}

$("#tab-equipment").addEventListener("click", () => showTab("equipment"));
$("#tab-calendar").addEventListener("click", () => showTab("calendar"));

// ---------- equipment view ----------

const ACTION_LABELS = {
  check_out: "Checked out",
  check_in: "Checked in",
  mark_unavailable: "Marked unavailable",
  mark_available: "Marked available",
  reserve: "Reserved",
  cancel_reservation: "Reservation cancelled",
};

let reservationsByItem = new Map();

async function refreshEquipment() {
  try {
    const [items, reservations] = await Promise.all([
      api("/api/equipment"),
      api("/api/reservations"),
    ]);
    reservationsByItem = new Map();
    for (const r of reservations) {
      if (!reservationsByItem.has(r.equipment_id)) reservationsByItem.set(r.equipment_id, []);
      reservationsByItem.get(r.equipment_id).push(r);
    }
    renderEquipment(items);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderEquipment(items) {
  const list = $("#equipment-list");
  $("#equipment-empty").classList.toggle("hidden", items.length > 0);
  list.innerHTML = items.map(cardHtml).join("");

  list.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleAction(
      btn.dataset.action,
      Number(btn.dataset.id),
      btn.dataset.name,
    ));
  });
  list.querySelectorAll("[data-cancel-res]").forEach((btn) => {
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
}

function cardHtml(item) {
  const badgeText = { available: "Available", checked_out: "Checked out", unavailable: "Unavailable" }[item.status];
  let meta = "";
  if (item.status === "checked_out") {
    meta += `<p class="meta">With <strong>${escapeHtml(item.holder)}</strong> since ${fmtDateTime(item.checked_out_at)}</p>`;
    if (item.expected_return_at) {
      const overdue = new Date(item.expected_return_at) < new Date();
      meta += `<p class="meta${overdue ? " overdue" : ""}">${overdue ? "Overdue — expected" : "Expected"} back ${fmtDateTime(item.expected_return_at)}</p>`;
    }
    if (item.note) meta += `<p class="meta">Note: ${escapeHtml(item.note)}</p>`;
  } else if (item.status === "unavailable") {
    meta += `<p class="meta">Reason: ${escapeHtml(item.note || "—")}</p>`;
  }

  for (const r of reservationsByItem.get(item.id) || []) {
    meta += `<p class="meta reservation">📅 Reserved by <strong>${escapeHtml(r.holder)}</strong>
      ${fmtDateTime(r.start_at)} → ${fmtDateTime(r.end_at)}${r.note ? ` · ${escapeHtml(r.note)}` : ""}
      <button class="btn subtle danger res-cancel" data-cancel-res="${r.id}" data-holder="${escapeHtml(r.holder)}" title="Cancel reservation">✕</button></p>`;
  }

  const actions = {
    available: `
      <button class="btn primary" data-action="checkout" data-id="${item.id}" data-name="${escapeHtml(item.name)}">Check out</button>
      <button class="btn" data-action="unavailable" data-id="${item.id}" data-name="${escapeHtml(item.name)}">Mark unavailable</button>`,
    checked_out: `
      <button class="btn primary" data-action="checkin" data-id="${item.id}" data-name="${escapeHtml(item.name)}">Check in</button>`,
    unavailable: `
      <button class="btn primary" data-action="available" data-id="${item.id}" data-name="${escapeHtml(item.name)}">Mark available</button>`,
  }[item.status] + `
      <button class="btn" data-action="reserve" data-id="${item.id}" data-name="${escapeHtml(item.name)}">Reserve</button>`;

  return `
    <div class="card">
      <h3>${escapeHtml(item.name)} <span class="badge ${item.status}">${badgeText}</span></h3>
      ${meta}
      <div class="card-actions">
        ${actions}
        <button class="btn subtle" data-action="history" data-id="${item.id}" data-name="${escapeHtml(item.name)}">History</button>
        <button class="btn subtle danger" data-action="delete" data-id="${item.id}" data-name="${escapeHtml(item.name)}">Delete</button>
      </div>
    </div>`;
}

async function handleAction(action, id, name) {
  try {
    if (action === "checkout") {
      openCheckoutDialog(id, name);
    } else if (action === "reserve") {
      openReserveDialog(id, name);
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

let checkoutTargetId = null;
function openCheckoutDialog(id, name) {
  checkoutTargetId = id;
  $("#checkout-item-name").textContent = name;
  $("#checkout-form").reset();
  $("#checkout-dialog").showModal();
}

$("#checkout-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const holder = $("#checkout-holder").value.trim();
  const ret = $("#checkout-return").value; // local datetime string or ""
  const note = $("#checkout-note").value.trim();
  try {
    await api(`/api/equipment/${checkoutTargetId}/checkout`, {
      method: "POST",
      body: JSON.stringify({
        holder,
        expected_return_at: ret ? new Date(ret).toISOString() : null,
        note: note || null,
      }),
    });
    $("#checkout-dialog").close();
    toast("Checked out.");
    await refreshEquipment();
  } catch (err) {
    toast(err.message, true);
  }
});

let reserveTargetId = null;
function openReserveDialog(id, name) {
  reserveTargetId = id;
  $("#reserve-item-name").textContent = name;
  $("#reserve-form").reset();
  $("#reserve-dialog").showModal();
}

$("#reserve-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const start = $("#reserve-start").value;
  const end = $("#reserve-end").value;
  const note = $("#reserve-note").value.trim();
  try {
    await api(`/api/equipment/${reserveTargetId}/reservations`, {
      method: "POST",
      body: JSON.stringify({
        holder: $("#reserve-holder").value.trim(),
        start_at: new Date(start).toISOString(),
        end_at: new Date(end).toISOString(),
        note: note || null,
      }),
    });
    $("#reserve-dialog").close();
    toast("Reserved.");
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

// ---------- calendar view ----------

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
    const busyCount = new Set(entries.map((e) => e.equipment_id)).size;

    let status = "";
    if (denominator > 0) {
      if (busyCount === 0) status = "status-available";
      else if (busyCount >= denominator) status = "status-full";
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
      renderDayDetails(busy.get(selectedDayKey) || []);
    });
  });

  if (selectedDayKey) renderDayDetails(busy.get(selectedDayKey) || []);
  else $("#day-details").classList.add("hidden");
}

function renderDayDetails(entries) {
  const el = $("#day-details");
  el.classList.remove("hidden");
  const dateLabel = new Date(selectedDayKey + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  if (!entries.length) {
    el.innerHTML = `<h3>${dateLabel}</h3><p class="all-free">All equipment available. 🎉</p>`;
    return;
  }

  const items = entries.map((iv) => {
    if (iv.type === "checked_out") {
      const range = iv.end
        ? `${fmtDateTime(iv.start)} → ${fmtDateTime(iv.end)}${iv.open ? " (expected)" : ""}`
        : `${fmtDateTime(iv.start)} (no expected return)`;
      return `<li><strong>${escapeHtml(iv.equipment_name)}</strong> — checked out by ${escapeHtml(iv.holder)}<br>
        <small>${range}${iv.note ? ` · ${escapeHtml(iv.note)}` : ""}</small></li>`;
    }
    if (iv.type === "reserved") {
      return `<li><strong>${escapeHtml(iv.equipment_name)}</strong> — reserved by ${escapeHtml(iv.holder)}<br>
        <small>${fmtDateTime(iv.start)} → ${fmtDateTime(iv.end)}${iv.note ? ` · ${escapeHtml(iv.note)}` : ""}</small></li>`;
    }
    const range = iv.end
      ? `${fmtDateTime(iv.start)} → ${fmtDateTime(iv.end)}`
      : `since ${fmtDateTime(iv.start)} (ongoing)`;
    return `<li><strong>${escapeHtml(iv.equipment_name)}</strong> — unavailable: ${escapeHtml(iv.note || "no reason given")}<br>
      <small>${range}</small></li>`;
  }).join("");

  el.innerHTML = `<h3>${dateLabel}</h3><ul>${items}</ul>`;
}

// ---------- init ----------

refreshEquipment();
