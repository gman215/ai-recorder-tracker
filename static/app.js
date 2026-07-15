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
  $("#tab-timeline").classList.toggle("active", name === "timeline");
  $("#view-equipment").classList.toggle("hidden", name !== "equipment");
  $("#view-timeline").classList.toggle("hidden", name !== "timeline");
  // The timeline needs more horizontal room than the equipment table to
  // keep day columns legible, so it gets a wider content area.
  document.querySelector("main").classList.toggle("wide", name === "timeline");
  if (name === "timeline") refreshTimeline();
}

$("#tab-equipment").addEventListener("click", () => showTab("equipment"));
$("#tab-timeline").addEventListener("click", () => showTab("timeline"));

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
function openReserveDialog(id, name) {
  reserveTargetId = id;
  $("#reserve-item-name").textContent = name;
  $("#reserve-form").reset();
  $("#reserve-start").value = localVal(new Date());
  $("#reserve-holder").value = localStorage.getItem("rt-holder") || "";
  $("#reserve-dialog").showModal();
}

// Duration presets fill "Until" relative to the chosen "From" time.
$("#reserve-presets").addEventListener("click", (e) => {
  const preset = e.target.dataset?.preset;
  if (!preset) return;
  const base = new Date($("#reserve-start").value || Date.now());
  let end;
  if (preset === "eod") {
    end = new Date(base);
    end.setHours(18, 0, 0, 0);
    if (end <= base) end.setDate(end.getDate() + 1); // already past 6 PM
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

// ---------- timeline ----------

const TL_DAYS = 28;

function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // back to Monday
  return x;
}

let tlStart = startOfWeek(new Date());
let tlData = null; // { equipment: [...], byItem: Map(id -> intervals) }

$("#tl-prev").addEventListener("click", () => { shiftTimeline(-7); });
$("#tl-next").addEventListener("click", () => { shiftTimeline(7); });
$("#tl-today").addEventListener("click", () => {
  tlStart = startOfWeek(new Date());
  renderTimeline();
});

function shiftTimeline(days) {
  tlStart = new Date(tlStart.getTime() + days * DAY_MS);
  renderTimeline();
}

async function refreshTimeline() {
  try {
    const [equipment, cal] = await Promise.all([
      api("/api/equipment"),
      api("/api/calendar"),
    ]);
    const byItem = new Map();
    for (const iv of cal.intervals) {
      if (!byItem.has(iv.equipment_id)) byItem.set(iv.equipment_id, []);
      byItem.get(iv.equipment_id).push(iv);
    }
    tlData = { equipment, byItem };
    renderTimeline();
  } catch (err) {
    toast(err.message, true);
  }
}

// Resolve an interval to concrete start/end dates for display.
// Returns null if it shouldn't be drawn.
function barSpan(iv, winEnd) {
  const now = new Date();
  const start = new Date(iv.start);
  let end, ongoing = false;
  if (iv.type === "checked_out") {
    if (iv.end) {
      end = new Date(iv.end);
      if (iv.open && end < now) end = now; // overdue: still out, keep blocking
    } else if (iv.open) {
      end = now; // out with no expected return: ongoing up to now
      ongoing = true;
    } else {
      end = start;
    }
  } else if (iv.type === "unavailable" && iv.end === null) {
    end = winEnd; // still unavailable: fills the visible future
    ongoing = true;
  } else {
    end = new Date(iv.end);
  }
  if (end <= start) end = new Date(start.getTime() + 3600000); // min 1h so it's visible
  return { start, end, ongoing };
}

function renderTimeline() {
  if (!tlData) return;
  const winEnd = new Date(tlStart.getTime() + TL_DAYS * DAY_MS);
  const now = new Date();
  $("#tl-range").textContent = `${fmtDate(tlStart)} – ${fmtDate(new Date(winEnd.getTime() - DAY_MS))}`;

  const grid = $("#timeline");
  const hasItems = tlData.equipment.length > 0;
  $("#timeline-empty").classList.toggle("hidden", hasItems);
  grid.classList.toggle("hidden", !hasItems);
  if (!hasItems) { grid.innerHTML = ""; return; }

  const todayKey = new Date().toDateString();
  let html = `<div class="tl-head tl-corner"></div>`;
  for (let i = 0; i < TL_DAYS; i++) {
    const d = new Date(tlStart.getTime() + i * DAY_MS);
    const cls = [
      "tl-head",
      d.getDay() === 0 || d.getDay() === 6 ? "wknd" : "",
      d.toDateString() === todayKey ? "today" : "",
    ].filter(Boolean).join(" ");
    html += `<div class="${cls}">${"MTWTFSS"[(d.getDay() + 6) % 7]}<br>${d.getDate()}</div>`;
  }

  const pct = (date) => ((date - tlStart) / (TL_DAYS * DAY_MS)) * 100;

  // weekend + today shading and the now-line, shared per track
  let decor = "";
  for (let i = 0; i < TL_DAYS; i++) {
    const d = new Date(tlStart.getTime() + i * DAY_MS);
    if (d.toDateString() === todayKey) {
      decor += `<div class="tl-shade today" style="left:${(i / TL_DAYS) * 100}%;width:${100 / TL_DAYS}%"></div>`;
    } else if (d.getDay() === 0 || d.getDay() === 6) {
      decor += `<div class="tl-shade" style="left:${(i / TL_DAYS) * 100}%;width:${100 / TL_DAYS}%"></div>`;
    }
  }
  if (now >= tlStart && now < winEnd) {
    decor += `<div class="tl-now" style="left:${pct(now)}%"></div>`;
  }

  tlData.equipment.forEach((eq, idx) => {
    const st = effStatus(eq);
    html += `<div class="tl-name"><i class="dot st-${st}" title="${STATUS_LABELS[st]}"></i>${escapeHtml(eq.name)}</div>`;
    let bars = "";
    for (const iv of tlData.byItem.get(eq.id) || []) {
      const span = barSpan(iv, winEnd);
      if (!span || span.end <= tlStart || span.start >= winEnd) continue;
      const left = Math.max(0, pct(span.start));
      const width = Math.min(100, pct(span.end)) - left;
      const past = !iv.open && span.end < now && iv.type !== "reserved";
      const label = iv.type === "unavailable" ? (iv.note || "unavailable") : (iv.holder || "");
      // A bar under ~half a day wide can't fit readable text — render it as
      // a fixed-size pin (holder's initial) instead of a truncated word.
      const compact = (span.end - span.start) / DAY_MS < 0.4;
      const clsParts = ["tl-bar", iv.type];
      if (past) clsParts.push("done");
      if (compact) clsParts.push("compact"); else if (span.ongoing) clsParts.push("ongoing");
      const style = compact ? `left:${left}%` : `left:${left}%;width:${width}%`;
      const content = compact ? escapeHtml((label || "?").trim().charAt(0).toUpperCase()) : escapeHtml(label);
      bars += `<div class="${clsParts.join(" ")}" style="${style}"
        data-iv="${escapeHtml(JSON.stringify(iv))}"
        title="${escapeHtml(eq.name)} · ${escapeHtml(label)}">${content}</div>`;
    }
    html += `<div class="tl-track">${decor}${bars}</div>`;
  });

  grid.innerHTML = html;

  grid.querySelectorAll(".tl-bar").forEach((bar) => {
    bar.addEventListener("click", () => renderTlDetails(JSON.parse(bar.dataset.iv)));
  });
  $("#tl-details").classList.add("hidden");
}

function renderTlDetails(iv) {
  const el = $("#tl-details");
  el.classList.remove("hidden");
  const typeLabel = { checked_out: "Checked out", reserved: "Reserved", unavailable: "Unavailable" }[iv.type];
  const lines = [];
  if (iv.holder) lines.push(`${iv.type === "reserved" ? "Reserved by" : "With"} <strong>${escapeHtml(iv.holder)}</strong>`);
  let range = fmtDateTime(iv.start);
  if (iv.end) {
    range += ` → ${fmtDateTime(iv.end)}`;
    if (iv.type === "checked_out" && iv.open) {
      range += new Date(iv.end) < new Date()
        ? ` <strong class="late">(${relSpan(iv.end)} overdue)</strong>`
        : ` (due in ${relSpan(iv.end)})`;
    }
  } else if (iv.open) {
    range += iv.type === "unavailable" ? " → ongoing" : " → no expected return";
  }
  lines.push(range);
  if (iv.note) lines.push(`<span class="dim">${escapeHtml(iv.note)}</span>`);
  el.innerHTML = `<h3>${escapeHtml(iv.equipment_name)} — ${typeLabel}</h3>
    ${lines.map((l) => `<p>${l}</p>`).join("")}`;
}

// ---------- init ----------

refreshEquipment();
