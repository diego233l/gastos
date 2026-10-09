// Fechas, dinero y cálculo de costes. Las fechas son AAAA-MM-DD en hora local.
export const CYCLES = {
  weekly: { label: "Semanal", short: "/sem", months: null },
  monthly: { label: "Mensual", short: "/mes", months: 1 },
  bimonthly: { label: "Bimestral", short: "/2 meses", months: 2 },
  quarterly: { label: "Trimestral", short: "/trim.", months: 3 },
  semiannual: { label: "Semestral", short: "/sem.", months: 6 },
  annual: { label: "Anual", short: "/año", months: 12 },
};
export const STATUS = { active: "Activa", paused: "En pausa", cancelled: "Cancelada" };
export const PAY_STATUS = { scheduled: "Programado", done: "Realizado" };

const eur = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
export const money = (n) => eur.format(n || 0);

const pad = (n) => String(n).padStart(2, "0");
export const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayIso = () => toIso(new Date());
export function fromIso(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function daysBetween(fromS, toS) {
  const a = fromIso(fromS), b = fromIso(toS);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
    Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}
export const daysUntil = (iso) => daysBetween(todayIso(), iso);

const dateFmt = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric" });
const monthFmt = new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric" });
const monthShortFmt = new Intl.DateTimeFormat("es-ES", { month: "short", year: "2-digit" });
export const fmtDate = (iso) => (iso ? dateFmt.format(fromIso(iso)) : "—");
export const fmtMonth = (iso) => monthFmt.format(fromIso(iso + "-01"));
export const fmtMonthShort = (iso) => monthShortFmt.format(fromIso(iso + "-01"));

export function relativeDays(days) {
  if (days === 0) return "hoy";
  if (days === 1) return "mañana";
  if (days === -1) return "ayer";
  return days > 0 ? `en ${days} días` : `hace ${-days} días`;
}

export function addMonths(d, months, anchor) {
  const total = d.getFullYear() * 12 + d.getMonth() + months;
  const y = Math.floor(total / 12), m = total % 12;
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(anchor || d.getDate(), last));
}

export function nextCharge(iso, cycle, anchor) {
  const d = fromIso(iso);
  if (cycle === "weekly") return toIso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7));
  return toIso(addMonths(d, CYCLES[cycle].months, anchor));
}

// Cobros previstos de una suscripción activa entre dos fechas (ambas incluidas).
export function occurrences(sub, fromS, toS) {
  const out = [];
  if (sub.status !== "active" || !sub.next_charge) return out;
  const anchor = Number(sub.next_charge.slice(8, 10));
  let cur = sub.next_charge;
  for (let i = 0; i < 600 && cur <= toS; i++) {
    if (cur >= fromS) out.push(cur);
    cur = nextCharge(cur, sub.cycle, anchor);
  }
  return out;
}

export const share = (sub) => sub.price / (sub.people || 1);
export function monthlyCost(sub) {
  const s = share(sub);
  const months = CYCLES[sub.cycle].months;
  return months ? s / months : (s * 52) / 12;
}
export const yearlyCost = (sub) => monthlyCost(sub) * 12;

export function hashColor(text) {
  let hsh = 0;
  for (const ch of text || "?") hsh = (hsh * 31 + ch.codePointAt(0)) >>> 0;
  const hue = hsh % 360;
  // HSL -> hex (colores medios, legibles con texto blanco)
  const s = 0.55, l = 0.45;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function initial(sub) {
  const t = (sub.name || "?").trim();
  return (t[0] || "?").toUpperCase();
}
