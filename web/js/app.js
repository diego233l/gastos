import { api } from "./api.js";
import { h, icon, render, toast } from "./dom.js";
import { confirmDialog } from "./dialogs.js";
import { openSubscriptionForm, openPaymentForm } from "./form.js";
import {
  CYCLES, STATUS, PAY_STATUS, money, fmtDate, fmtMonth, fmtMonthShort, relativeDays,
  daysUntil, todayIso, toIso, fromIso, occurrences, share, monthlyCost, yearlyCost, hashColor, initial,
  pendingCharges, logoFor,
} from "./util.js";

const view = document.getElementById("view");
const state = {
  subs: [],
  settings: { remind_days: 7, monthly_budget: null },
  catalog: null,
  filters: { q: "", status: "active", category: "", sort: "name" },
};
let routeToken = 0;

// ---------------------------------------------------------------- utilidades
const photoSrc = (s) => `api/subscriptions/${s.id}/photo?v=${encodeURIComponent(s.photo_v)}`;
const colorOf = (s) => s.color || hashColor(s.name);
const remindFor = (s) => (s.remind_days ?? state.settings.remind_days);
const cycleText = (s) => `${money(s.price)} ${CYCLES[s.cycle].short}`;

async function loadSubs() {
  const data = await api.get("/subscriptions");
  state.subs = data.subscriptions;
  state.settings = data.settings;
}
async function ensureCatalog() {
  if (!state.catalog) state.catalog = await api.get("/catalog");
  return state.catalog;
}

function errorView(err, retry) {
  render(view, h("div", { class: "empty empty-error" },
    h("h2", { text: "No se pudo cargar" }),
    h("p", { text: err.message }),
    h("button", { class: "btn btn-primary", type: "button", onclick: retry, text: "Reintentar" })));
}

function badge(text, kind) {
  return h("span", { class: `badge badge-${kind}`, text });
}

function chargeChip(sub) {
  if (sub.status !== "active") return badge(STATUS[sub.status], sub.status);
  if (!sub.next_charge) return badge("Sin fecha", "paused");
  const d = daysUntil(sub.next_charge);
  const kind = d < 0 ? "overdue" : d <= remindFor(sub) ? "soon" : "ok";
  const label = d < 0 ? `Vencido ${relativeDays(d)}` : d === 0 ? "Se cobra hoy" : `Cobro ${relativeDays(d)}`;
  return badge(label, kind);
}

// Imagen de la suscripción: foto propia > logo del catálogo > monograma con su color.
const imageOf = (s) => (s.has_photo ? photoSrc(s) : logoFor(s, state.catalog));

function thumb(sub) {
  const src = imageOf(sub);
  if (src) {
    return h("div", { class: sub.has_photo ? "thumb" : "thumb thumb-logo" },
      h("img", { class: "thumb-bg", src, alt: "", "aria-hidden": "true", loading: "lazy" }),
      h("img", { class: "thumb-fg", src, alt: `${sub.has_photo ? "Foto" : "Logo"} de ${sub.name}`, loading: "lazy" }));
  }
  return h("div", { class: "thumb thumb-ph", style: { "--c": colorOf(sub) } }, h("span", { text: initial(sub) }));
}

function buildAlerts() {
  const out = [];
  for (const s of state.subs) {
    if (s.status !== "active") continue;
    if (s.next_charge) {
      const d = daysUntil(s.next_charge);
      if (d < 0) out.push({ kind: "overdue", sub: s, days: d, text: `El cobro de ${s.name} (${money(s.price)}) venció ${relativeDays(d)}.`, pay: true });
      else if (d <= remindFor(s)) out.push({ kind: "soon", sub: s, days: d, text: `${s.name}: ${money(s.price)} ${d === 0 ? "se cobra hoy" : "se cobra " + relativeDays(d)} (${fmtDate(s.next_charge)}).` });
    }
    if (s.trial_end) {
      const d = daysUntil(s.trial_end);
      if (d >= 0 && d <= Math.max(remindFor(s), 3)) out.push({ kind: "trial", sub: s, days: d, text: `La prueba gratuita de ${s.name} termina ${relativeDays(d)} (${fmtDate(s.trial_end)}). Cancela si no quieres pagar.` });
    }
  }
  const budget = state.settings.monthly_budget;
  if (budget) {
    const total = state.subs.filter((s) => s.status === "active").reduce((a, s) => a + monthlyCost(s), 0);
    if (total > budget) out.push({ kind: "budget", days: -9999, text: `Tu gasto mensual (${money(total)}) supera el presupuesto de ${money(budget)}.` });
  }
  const rank = { overdue: 0, trial: 1, soon: 2, budget: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.days - b.days);
}

async function registerPayment(sub) {
  try {
    await api.post(`/subscriptions/${sub.id}/pay`);
    toast(`Cobro de ${sub.name} registrado.`);
    await refresh();
  } catch (err) { toast(err.message, "error"); }
}

// ---------------------------------------------------------------- inicio
function statTile(label, value, sub) {
  return h("div", { class: "stat" }, h("span", { class: "stat-label", text: label }), h("strong", { class: "stat-value", text: value }), sub ? h("span", { class: "stat-sub", text: sub }) : null);
}

function filteredSubs() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  let list = state.subs.filter((s) => {
    if (f.status && s.status !== f.status) return false;
    if (f.category && s.category !== f.category) return false;
    if (q && ![s.name, s.service, s.plan, s.category, s.payment_method, s.notes].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });
  const by = {
    name: (a, b) => a.name.localeCompare(b.name, "es"),
    next: (a, b) => (a.next_charge || "9999").localeCompare(b.next_charge || "9999") || a.name.localeCompare(b.name, "es"),
    price: (a, b) => monthlyCost(b) - monthlyCost(a),
    category: (a, b) => a.category.localeCompare(b.category, "es") || a.name.localeCompare(b.name, "es"),
  };
  return list.sort(by[f.sort] || by.name);
}

function card(sub) {
  const mine = sub.people > 1 ? h("span", { class: "card-share", text: `Tu parte: ${money(share(sub))} ${CYCLES[sub.cycle].short}` }) : null;
  return h("a", { class: `card card-${sub.status}`, href: `#/s/${sub.id}` },
    thumb(sub),
    h("div", { class: "card-body" },
      h("h3", { class: "card-title", text: sub.name }),
      h("p", { class: "card-sub", text: [sub.plan, sub.category].filter(Boolean).join(" · ") }),
      h("p", { class: "card-price" }, h("strong", { text: money(sub.price) }), " ", h("span", { text: CYCLES[sub.cycle].short })),
      mine,
      h("div", { class: "card-foot" }, chargeChip(sub), sub.trial_end && daysUntil(sub.trial_end) >= 0 ? badge("Prueba", "trial") : null)));
}

async function viewHome(token) {
  await Promise.all([loadSubs(), ensureCatalog().catch(() => null)]);
  if (token !== routeToken) return;
  const active = state.subs.filter((s) => s.status === "active");
  const month = active.reduce((a, s) => a + monthlyCost(s), 0);
  const upcoming = active.filter((s) => s.next_charge).sort((a, b) => a.next_charge.localeCompare(b.next_charge))[0];
  const alertsHost = h("section", { class: "alerts", "aria-label": "Avisos" });
  const gridHost = h("section", { class: "grid-cards" });
  const countEl = h("p", { class: "count" });

  const renderAlerts = () => {
    const alerts = buildAlerts();
    render(alertsHost, alerts.map((a) => h("div", { class: `alert alert-${a.kind}`, role: "status" },
      icon("bell", 18),
      a.sub ? h("a", { class: "alert-text", href: `#/s/${a.sub.id}`, text: a.text }) : h("span", { class: "alert-text", text: a.text }),
      a.pay ? h("button", { type: "button", class: "btn btn-sm", onclick: () => registerPayment(a.sub) }, icon("check", 14), " Registrar cobro") : null)));
  };
  const renderGrid = () => {
    const list = filteredSubs();
    countEl.textContent = `${list.length} de ${state.subs.length} suscripciones`;
    if (!list.length) {
      render(gridHost, h("div", { class: "empty" },
        h("h2", { text: state.subs.length ? "Nada coincide con el filtro" : "Aún no tienes suscripciones" }),
        h("p", { text: state.subs.length ? "Prueba con otra búsqueda o cambia los filtros." : "Añade la primera: elige el servicio y se rellena casi todo solo." }),
        state.subs.length ? null : h("button", { class: "btn btn-primary", type: "button", onclick: openNew }, icon("plus"), " Nueva suscripción")));
      return;
    }
    render(gridHost, list.map(card));
  };

  const f = state.filters;
  const search = h("input", { type: "search", class: "search-input", placeholder: "Buscar por nombre, plan, categoría…", value: f.q, "aria-label": "Buscar", oninput: (e) => { f.q = e.target.value; renderGrid(); } });
  const cats = [...new Set(state.subs.map((s) => s.category))].sort((a, b) => a.localeCompare(b, "es"));
  const selStatus = h("select", { "aria-label": "Estado", onchange: (e) => { f.status = e.target.value; renderGrid(); } },
    h("option", { value: "", text: "Todas" }), ...Object.entries(STATUS).map(([k, v]) => h("option", { value: k, text: v })));
  selStatus.value = f.status;
  const selCat = h("select", { "aria-label": "Categoría", onchange: (e) => { f.category = e.target.value; renderGrid(); } },
    h("option", { value: "", text: "Todas las categorías" }), ...cats.map((c) => h("option", { value: c, text: c })));
  selCat.value = f.category;
  const selSort = h("select", { "aria-label": "Ordenar", onchange: (e) => { f.sort = e.target.value; renderGrid(); } },
    h("option", { value: "name", text: "Orden: nombre" }), h("option", { value: "next", text: "Orden: próximo cobro" }),
    h("option", { value: "price", text: "Orden: más caras" }), h("option", { value: "category", text: "Orden: categoría" }));
  selSort.value = f.sort;

  renderAlerts();
  renderGrid();
  render(view,
    h("div", { class: "page-head" }, h("h1", { text: "Mis suscripciones" }),
      h("button", { class: "btn btn-primary", type: "button", onclick: openNew }, icon("plus"), " Nueva suscripción")),
    h("section", { class: "stats" },
      statTile("Gasto al mes", money(month), "tu parte, solo activas"),
      statTile("Gasto al año", money(month * 12), "estimación"),
      statTile("Activas", String(active.length), `${state.subs.length - active.length} en pausa o canceladas`),
      statTile("Próximo cobro", upcoming ? fmtDate(upcoming.next_charge) : "—", upcoming ? `${upcoming.name} · ${relativeDays(daysUntil(upcoming.next_charge))}` : "nada programado")),
    alertsHost,
    h("div", { class: "toolbar" },
      h("div", { class: "search" }, icon("search", 18), search), selStatus, selCat, selSort),
    countEl, gridHost);
}

async function openNew() {
  try {
    openSubscriptionForm({ catalog: await ensureCatalog(), onSaved: (s) => { if (location.hash.startsWith("#/s/") || location.hash === "" || location.hash === "#/") refresh(); else location.hash = "#/"; } });
  } catch (err) { toast(err.message, "error"); }
}

// ---------------------------------------------------------------- ficha
function infoRow(label, value) {
  if (value === null || value === undefined || value === "") return null;
  return h("div", { class: "info-row" }, h("dt", { text: label }), h("dd", {}, value));
}

async function viewDetail(token, id) {
  const [data] = await Promise.all([api.get(`/subscriptions/${id}`), ensureCatalog().catch(() => null)]);
  if (token !== routeToken) return;
  const sub = data.subscription;
  state.settings = data.settings;
  const pays = data.payments;
  const doneTotal = pays.filter((p) => p.status === "done").reduce((a, p) => a + p.amount, 0);
  const future = pendingCharges(sub, pays, toIso(new Date(new Date().getFullYear() + 3, 0, 1))).slice(0, 6);
  const logo = sub.has_photo ? "" : logoFor(sub, state.catalog);

  const frame = sub.has_photo
    ? h("div", { class: "photo-frame", style: { "--ar": (sub.photo_w / sub.photo_h).toFixed(5) } },
      h("img", { src: photoSrc(sub), alt: `Foto de ${sub.name}`, width: sub.photo_w, height: sub.photo_h }))
    : logo ? h("div", { class: "photo-frame photo-logo", style: { "--ar": "1" } }, h("img", { src: logo, alt: `Logo de ${sub.name}`, width: 256, height: 256 }))
    : h("div", { class: "photo-frame photo-ph", style: { "--ar": "1.6", "--c": colorOf(sub) } }, h("span", { text: initial(sub) }));

  const reload = () => refresh();
  const patch = async (body, msg) => {
    try { await api.put(`/subscriptions/${id}`, body); toast(msg); reload(); } catch (err) { toast(err.message, "error"); }
  };
  const edit = async () => {
    try { openSubscriptionForm({ sub, catalog: await ensureCatalog(), onSaved: reload }); } catch (err) { toast(err.message, "error"); }
  };
  const del = async () => {
    if (!await confirmDialog("Eliminar suscripción", `Se borrará «${sub.name}» con su historial de pagos y su foto. No se puede deshacer.`, { okLabel: "Eliminar", danger: true })) return;
    try { await api.del(`/subscriptions/${id}`); toast("Suscripción eliminada."); location.hash = "#/"; } catch (err) { toast(err.message, "error"); }
  };
  const cancelSub = async () => {
    if (await confirmDialog("Marcar como cancelada", `«${sub.name}» dejará de contar en tus gastos y avisos. Recuerda darla de baja también en el servicio.`, { okLabel: "Marcar como cancelada" })) patch({ status: "cancelled" }, "Marcada como cancelada.");
  };

  const payRow = (p) => h("div", { class: "pay-row" },
    h("span", { class: "pay-date", text: fmtDate(p.date) }),
    h("strong", { class: "pay-amount", text: money(p.amount) }),
    badge(PAY_STATUS[p.status], p.status === "done" ? "ok" : "soon"),
    h("span", { class: "pay-notes", text: p.notes }),
    h("span", { class: "pay-actions" },
      p.status === "scheduled" ? h("button", { type: "button", class: "icon-btn", title: "Marcar como realizado", "aria-label": "Marcar como realizado", onclick: async () => { try { await api.put(`/payments/${p.id}`, { status: "done" }); reload(); } catch (e) { toast(e.message, "error"); } } }, icon("check")) : null,
      h("button", { type: "button", class: "icon-btn", title: "Editar pago", "aria-label": "Editar pago", onclick: () => openPaymentForm({ subId: id, payment: p, defaultAmount: sub.price, onSaved: reload }) }, icon("edit")),
      h("button", { type: "button", class: "icon-btn", title: "Borrar pago", "aria-label": "Borrar pago", onclick: async () => { if (await confirmDialog("Borrar pago", `¿Borrar el pago del ${fmtDate(p.date)}?`, { okLabel: "Borrar", danger: true })) { try { await api.del(`/payments/${p.id}`); reload(); } catch (e) { toast(e.message, "error"); } } } }, icon("trash"))));

  render(view,
    h("div", { class: "back-row" }, h("button", { type: "button", class: "btn", onclick: () => { location.hash = "#/"; } }, icon("back"), " Volver al listado")),
    h("article", { class: "detail" },
      h("div", { class: "detail-media" }, frame),
      h("div", { class: "detail-main" },
        h("div", { class: "detail-title" },
          h("h1", { text: sub.name }), chargeChip(sub)),
        h("p", { class: "detail-sub", text: [sub.service !== sub.name ? sub.service : "", sub.plan, sub.category].filter(Boolean).join(" · ") }),
        h("p", { class: "detail-price" }, h("strong", { text: money(sub.price) }), " ", h("span", { text: CYCLES[sub.cycle].label.toLowerCase() })),
        h("div", { class: "actions" },
          sub.status === "active" && sub.next_charge ? h("button", { type: "button", class: "btn btn-primary", onclick: () => registerPayment(sub) }, icon("check"), " Registrar cobro") : null,
          h("button", { type: "button", class: "btn", onclick: edit }, icon("edit"), " Editar"),
          sub.status === "active" ? h("button", { type: "button", class: "btn", onclick: () => patch({ status: "paused" }, "Suscripción en pausa.") }, icon("pause"), " Pausar") : null,
          sub.status === "paused" ? h("button", { type: "button", class: "btn", onclick: () => patch({ status: "active" }, "Suscripción reanudada.") }, icon("play"), " Reanudar") : null,
          sub.status === "cancelled" ? h("button", { type: "button", class: "btn", onclick: () => patch({ status: "active" }, "Suscripción reactivada.") }, icon("play"), " Reactivar") : null,
          sub.status !== "cancelled" ? h("button", { type: "button", class: "btn", onclick: cancelSub }, icon("x"), " Cancelar") : null,
          h("button", { type: "button", class: "btn btn-danger-outline", onclick: del }, icon("trash"), " Eliminar")),
        h("dl", { class: "info" },
          infoRow("Próximo cobro", sub.status === "active" && sub.next_charge ? `${fmtDate(sub.next_charge)} (${relativeDays(daysUntil(sub.next_charge))})` : (sub.next_charge ? fmtDate(sub.next_charge) : null)),
          infoRow("Coste mensual", money(monthlyCost(sub)) + (sub.people > 1 ? " (tu parte)" : "")),
          infoRow("Coste anual", money(yearlyCost(sub)) + (sub.people > 1 ? " (tu parte)" : "")),
          infoRow("Compartida entre", sub.people > 1 ? `${sub.people} personas · tu parte ${money(share(sub))} por cobro` : null),
          infoRow("Método de pago", sub.payment_method),
          infoRow("Fecha de alta", sub.start_date ? fmtDate(sub.start_date) : null),
          infoRow("Fin de la prueba", sub.trial_end ? `${fmtDate(sub.trial_end)}${daysUntil(sub.trial_end) >= 0 ? " (" + relativeDays(daysUntil(sub.trial_end)) + ")" : ""}` : null),
          infoRow("Aviso", sub.remind_days !== null ? `${sub.remind_days} días antes` : `${state.settings.remind_days} días antes (general)`),
          infoRow("Total pagado registrado", pays.some((p) => p.status === "done") ? money(doneTotal) : null),
          infoRow("Web", sub.url ? h("a", { href: sub.url, target: "_blank", rel: "noopener noreferrer nofollow" }, sub.url.replace(/^https?:\/\//, ""), " ", icon("external", 14)) : null),
          infoRow("Notas", sub.notes ? h("span", { class: "notes", text: sub.notes }) : null)))),
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", { text: "Historial de pagos" }),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => openPaymentForm({ subId: id, defaultAmount: sub.price, onSaved: reload }) }, icon("plus", 14), " Añadir pago")),
      pays.length ? h("div", { class: "pay-list" }, pays.map(payRow)) : h("p", { class: "muted", text: "Todavía no hay pagos registrados. Usa «Registrar cobro» cuando se cargue el recibo." })),
    future.length ? h("section", { class: "panel" },
      h("h2", { text: "Próximos cobros" }),
      h("p", { class: "muted", text: "Todo lo que aún no figura como pagado en el historial." }),
      h("ul", { class: "plain-list" }, future.map((c) => {
        const d = daysUntil(c.date);
        return h("li", { class: d < 0 ? "is-overdue" : "" },
          h("span", { text: fmtDate(c.date) }),
          h("span", { class: "muted", text: (d < 0 ? "vencido " : "") + relativeDays(d) + (c.paymentId ? " · programado" : "") }),
          h("strong", { text: money(c.amount) }));
      }))) : null);
}

// ---------------------------------------------------------------- cobros
async function viewCharges(token, horizon = 90) {
  const [, { payments }] = await Promise.all([Promise.all([loadSubs(), ensureCatalog().catch(() => null)]), api.get("/payments")]);
  if (token !== routeToken) return;
  const end = new Date(); end.setDate(end.getDate() + horizon);
  const endIso = toIso(end);
  const rows = [];
  for (const s of state.subs) for (const c of pendingCharges(s, payments, endIso)) rows.push({ date: c.date, sub: s, amount: c.amount, paymentId: c.paymentId });
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.sub.name.localeCompare(b.sub.name, "es"));
  const groups = new Map();
  for (const r of rows) {
    const key = r.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const markPaid = async (r) => {
    if (!r.paymentId) return registerPayment(r.sub);
    try { await api.put(`/payments/${r.paymentId}`, { status: "done" }); toast("Pago marcado como realizado."); await refresh(); } catch (err) { toast(err.message, "error"); }
  };
  const sel = h("select", { "aria-label": "Horizonte", onchange: (e) => viewCharges(++routeToken, Number(e.target.value)) },
    ...[30, 60, 90, 180, 365].map((d) => h("option", { value: d, text: `Próximos ${d} días` })));
  sel.value = String(horizon);
  const today = todayIso();
  render(view,
    h("div", { class: "page-head" }, h("h1", { text: "Próximos cobros" }), sel),
    rows.length ? [...groups.entries()].map(([month, list]) => h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", { class: "cap", text: fmtMonth(month) }),
        h("strong", { text: money(list.reduce((a, r) => a + r.amount, 0)) })),
      h("ul", { class: "plain-list charges" }, list.map((r) => {
        const d = daysUntil(r.date);
        const overdue = r.date < today;
        return h("li", { class: overdue ? "is-overdue" : "" },
          h("span", { class: "ch-date", text: fmtDate(r.date) }),
          h("a", { class: "ch-name", href: `#/s/${r.sub.id}`, text: r.sub.name }),
          h("span", { class: "muted ch-rel", text: (overdue ? `vencido ${relativeDays(d)}` : relativeDays(d)) + (r.paymentId ? " · programado" : "") }),
          h("strong", { class: "ch-amount", text: money(r.amount) }),
          r.paymentId || r.date === r.sub.next_charge ? h("button", { type: "button", class: "btn btn-sm", onclick: () => markPaid(r) }, icon("check", 14), r.paymentId ? " Pagado" : " Registrar") : h("span"));
      })))) : h("div", { class: "empty" }, h("h2", { text: "No hay cobros previstos" }), h("p", { text: "Aquí aparece todo lo que aún no figura como pagado en el historial." })));
}

// ---------------------------------------------------------------- estadísticas
function barList(items, formatter = money) {
  const max = Math.max(...items.map((i) => i.value), 0.0001);
  return h("ul", { class: "bars" }, items.map((i) => h("li", {},
    h("span", { class: "bar-label", text: i.label }),
    h("span", { class: "bar-track" }, h("span", { class: "bar-fill", style: { "--w": `${(i.value / max) * 100}%`, "--c": i.color || "var(--accent)" } })),
    h("strong", { class: "bar-value", text: formatter(i.value) }))));
}

async function viewStats(token) {
  await loadSubs();
  const { payments } = await api.get("/payments");
  if (token !== routeToken) return;
  const active = state.subs.filter((s) => s.status === "active");
  if (!active.length && !payments.length) {
    render(view, h("div", { class: "page-head" }, h("h1", { text: "Estadísticas" })), h("div", { class: "empty" }, h("h2", { text: "Sin datos todavía" }), h("p", { text: "Añade suscripciones para ver cuánto gastas y en qué." })));
    return;
  }
  const sum = (arr, fn) => arr.reduce((a, x) => a + fn(x), 0);
  const group = (arr, keyFn, valFn) => {
    const m = new Map();
    for (const x of arr) m.set(keyFn(x) || "Sin indicar", (m.get(keyFn(x) || "Sin indicar") || 0) + valFn(x));
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  };
  const byCat = group(active, (s) => s.category, monthlyCost);
  const byMethod = group(active, (s) => s.payment_method, monthlyCost);
  const top = [...active].sort((a, b) => monthlyCost(b) - monthlyCost(a)).slice(0, 8).map((s) => ({ label: s.name, value: monthlyCost(s), color: colorOf(s) }));

  const now = new Date();
  const months = [];
  for (let i = 0; i < 12; i++) months.push(toIso(new Date(now.getFullYear(), now.getMonth() + i, 1)).slice(0, 7));
  const forecast = months.map((m) => {
    const from = m + "-01", to = toIso(new Date(Number(m.slice(0, 4)), Number(m.slice(5)), 0));
    return { label: fmtMonthShort(m), value: sum(active, (s) => sum(pendingCharges(s, payments, to).filter((c) => c.date >= from), (c) => c.amount / (s.people || 1))) };
  });
  const subMap = new Map(state.subs.map((s) => [s.id, s]));
  const past = [];
  for (let i = 11; i >= 0; i--) past.push(toIso(new Date(now.getFullYear(), now.getMonth() - i, 1)).slice(0, 7));
  const paid = past.map((m) => ({ label: fmtMonthShort(m), value: sum(payments.filter((p) => p.status === "done" && p.date.startsWith(m)), (p) => p.amount / ((subMap.get(p.subscription_id) || { people: 1 }).people || 1)) }));
  const total = sum(active, monthlyCost);

  render(view,
    h("div", { class: "page-head" }, h("h1", { text: "Estadísticas" })),
    h("section", { class: "stats" },
      statTile("Al mes", money(total), "tu parte"), statTile("Al año", money(total * 12), "estimación"),
      statTile("Media por suscripción", money(active.length ? total / active.length : 0), "al mes"),
      statTile("Más cara", top[0] ? top[0].label : "—", top[0] ? money(top[0].value) + " al mes" : "")),
    h("div", { class: "cols" },
      h("section", { class: "panel" }, h("h2", { text: "Por categoría (al mes)" }), barList(byCat)),
      h("section", { class: "panel" }, h("h2", { text: "Las más caras (al mes)" }), barList(top))),
    h("div", { class: "cols" },
      h("section", { class: "panel" }, h("h2", { text: "Por método de pago (al mes)" }), barList(byMethod)),
      h("section", { class: "panel" }, h("h2", { text: "Previsión próximos 12 meses" }), barList(forecast))),
    h("section", { class: "panel" }, h("h2", { text: "Pagado en los últimos 12 meses (tu parte)" }),
      sum(paid, (x) => x.value) ? barList(paid) : h("p", { class: "muted", text: "Aún no hay pagos registrados como realizados." })));
}

// ---------------------------------------------------------------- ajustes
async function viewSettings(token) {
  const [settings, health, catalog] = await Promise.all([api.get("/settings"), api.get("/health"), ensureCatalog()]);
  if (token !== routeToken) return;
  state.settings = settings;
  const days = h("input", { type: "number", name: "remind_days", min: 0, max: 60, step: 1, required: true, value: settings.remind_days });
  const budget = h("input", { type: "text", name: "monthly_budget", inputmode: "decimal", placeholder: "Sin límite", value: settings.monthly_budget === null ? "" : String(settings.monthly_budget.toFixed(2)).replace(".", ",") });
  const err = h("div", { class: "form-error", role: "alert", hidden: true });
  const form = h("form", { class: "form" },
    h("div", { class: "grid" },
      h("label", { class: "field" }, h("span", { class: "field-label", text: "Avisarme con (días de antelación)" }), days),
      h("label", { class: "field" }, h("span", { class: "field-label", text: "Presupuesto mensual (€)" }), budget, h("span", { class: "field-hint", text: "Te aviso en la portada si lo superas" }))),
    err, h("div", { class: "dlg-actions" }, h("button", { class: "btn btn-primary", type: "submit", text: "Guardar ajustes" })));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    try {
      state.settings = await api.put("/settings", { remind_days: days.value, monthly_budget: budget.value.trim() === "" ? null : budget.value });
      toast("Ajustes guardados.");
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  const nSvc = catalog.categories.reduce((a, c) => a + c.services.length, 0);
  render(view,
    h("div", { class: "page-head" }, h("h1", { text: "Ajustes" })),
    h("section", { class: "panel" }, h("h2", { text: "Avisos y presupuesto" }), form),
    h("section", { class: "panel" }, h("h2", { text: "Copia de seguridad" }),
      h("p", { class: "muted", text: "Descarga todos tus datos (suscripciones, pagos y fotos) en un archivo JSON. El servidor además hace una copia diaria automática." }),
      h("a", { class: "btn", href: "api/export", download: "" }, icon("download"), " Exportar copia (JSON)")),
    h("section", { class: "panel" }, h("h2", { text: "Acerca de" }),
      h("p", { class: "muted", text: `Versión ${health.version} · esquema de base de datos ${health.schema} · ${health.subscriptions} suscripciones guardadas.` }),
      h("p", { class: "muted", text: `El catálogo incluye ${nSvc} servicios. Está escrito de memoria: puede tener huecos y los precios son orientativos; comprueba siempre el importe real y usa «Otro…» si no encuentras algo.` })));
}

// ---------------------------------------------------------------- router
async function refresh() { await route(false); }

async function route(resetScroll = true) {
  const token = ++routeToken;
  const hash = location.hash || "#/";
  const [, seg, arg] = hash.split("/");
  const tab = { "": "home", s: "home", cobros: "charges", stats: "stats", ajustes: "settings" }[seg ?? ""] || "home";
  document.querySelectorAll("#tabs a").forEach((a) => { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (resetScroll) window.scrollTo(0, 0);
  const y = window.scrollY;
  if (resetScroll) render(view, h("p", { class: "loading", text: "Cargando…" }));
  try {
    if (seg === "s" && /^\d+$/.test(arg || "")) await viewDetail(token, Number(arg));
    else if (seg === "cobros") await viewCharges(token);
    else if (seg === "stats") await viewStats(token);
    else if (seg === "ajustes") await viewSettings(token);
    else await viewHome(token);
    if (!resetScroll) window.scrollTo(0, y);
  } catch (err) {
    if (token !== routeToken) return;
    if (err.status === 404 && seg === "s") { toast(err.message, "error"); location.hash = "#/"; return; }
    errorView(err, () => route(false));
  }
}

window.addEventListener("hashchange", () => route(true));
route(true);
