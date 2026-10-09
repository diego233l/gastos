// Formularios en <dialog>: suscripción (con listas en cascada y autorrelleno) y pago.
import { api } from "./api.js";
import { h, icon, toast, render } from "./dom.js";
import { openDialog } from "./dialogs.js";
import { shrinkImage } from "./photo.js";
import { CYCLES, STATUS, PAY_STATUS, hashColor, todayIso, detectFromText, logoFor, normText } from "./util.js";

const OTHER = "__otro__";
const PAYMENT_METHODS = [
  "Tarjeta de crédito", "Tarjeta de débito", "PayPal", "Domiciliación bancaria",
  "Apple (App Store)", "Google Play", "Bizum", "Transferencia", "Cargo en la factura del operador", "Efectivo",
];

function field(label, control, { hint, wide, id } = {}) {
  const wrap = h("label", { class: wide ? "field field-wide" : "field" },
    h("span", { class: "field-label", text: label }), control, hint ? h("span", { class: "field-hint", text: hint }) : null);
  if (id) wrap.id = id;
  return wrap;
}

// Select con opción «Otro…» que muestra un campo de texto. `required` se gestiona dinámicamente:
// un control oculto y obligatorio bloquearía el envío del formulario.
function combo({ name, required, placeholder, maxlength, otherLabel = "Otro…" }) {
  const select = h("select", { name: name + "-sel" });
  const text = h("input", { type: "text", name, maxlength, placeholder: "Escríbelo aquí", autocomplete: "off", class: "combo-text" });
  const listeners = [];
  let opts = [];
  const sync = () => {
    const other = select.value === OTHER;
    text.hidden = !other;
    text.disabled = !other;
    text.required = other && required;
    select.required = required;
  };
  const fire = () => listeners.forEach((fn) => fn(api2.value()));
  const api2 = {
    el: h("div", { class: "combo" }, select, text),
    select, text,
    setOptions(list, ph = placeholder) {
      opts = list.slice();
      select.replaceChildren(
        h("option", { value: "", text: ph }),
        ...opts.map((o) => h("option", { value: o, text: o })),
        h("option", { value: OTHER, text: otherLabel }));
      select.value = "";
      text.value = "";
      sync();
    },
    value() { return select.value === OTHER ? text.value.trim() : select.value; },
    isCatalog() { return select.value !== OTHER && select.value !== ""; },
    set(v) {
      const val = v || "";
      if (!val) select.value = "";
      else if (opts.includes(val)) select.value = val;
      else { select.value = OTHER; text.value = val; }
      if (select.value !== OTHER) text.value = "";
      sync();
    },
    onChange(fn) { listeners.push(fn); },
  };
  select.addEventListener("change", () => { if (select.value !== OTHER) text.value = ""; sync(); if (select.value === OTHER) text.focus(); fire(); });
  text.addEventListener("input", fire);
  api2.setOptions([], placeholder);
  return api2;
}

// Autorrelleno: solo escribe si está vacío o si lo escribió antes el autorrelleno (nunca pisa al usuario).
function autofill(input, value) {
  if (value === null || value === undefined || value === "") return;
  if (!input.value || input.dataset.auto === "1") {
    input.value = String(value);
    input.dataset.auto = "1";
  }
}
function trackUser(input) {
  input.addEventListener("input", () => { delete input.dataset.auto; });
}

export function openSubscriptionForm({ sub, catalog, onSaved }) {
  const editing = !!sub;
  const cats = catalog.categories;
  let loading = true;
  let applying = false;
  const photo = { blob: null, url: null, remove: false };

  const category = combo({ name: "category", required: true, placeholder: "Elige una categoría…", maxlength: 40 });
  const service = combo({ name: "service", required: false, placeholder: "— ninguno / personalizado —", maxlength: 60 });
  const plan = combo({ name: "plan", required: false, placeholder: "— sin plan concreto —", maxlength: 80 });
  const method = combo({ name: "payment_method", required: false, placeholder: "— sin indicar —", maxlength: 60 });
  category.setOptions(cats.map((c) => c.name));
  method.setOptions(PAYMENT_METHODS);

  const name = h("input", { type: "text", name: "name", required: true, maxlength: 80, autocomplete: "off", placeholder: "Ej.: Netflix" });
  const price = h("input", { type: "text", name: "price", required: true, inputmode: "decimal", autocomplete: "off", placeholder: "9,99" });
  const cycle = h("select", { name: "cycle", required: true },
    h("option", { value: "", text: "Elige…" }),
    ...Object.entries(CYCLES).map(([k, v]) => h("option", { value: k, text: v.label })));
  const status = h("select", { name: "status" }, ...Object.entries(STATUS).map(([k, v]) => h("option", { value: k, text: v })));
  const next = h("input", { type: "date", name: "next_charge", min: "2000-01-01", max: "2100-12-31" });
  const start = h("input", { type: "date", name: "start_date", min: "2000-01-01", max: "2100-12-31" });
  const trial = h("input", { type: "date", name: "trial_end", min: "2000-01-01", max: "2100-12-31" });
  const people = h("input", { type: "number", name: "people", min: 1, max: 50, step: 1, value: 1 });
  const url = h("input", { type: "url", name: "url", maxlength: 300, placeholder: "https://…" });
  const color = h("input", { type: "color", name: "color", value: "#4f46e5" });
  const remind = h("input", { type: "number", name: "remind_days", min: 0, max: 90, step: 1, placeholder: "General" });
  const notes = h("textarea", { name: "notes", rows: 3, maxlength: 1000, placeholder: "Notas, cómo cancelar, usuario compartido…" });
  [name, price, url, color].forEach(trackUser);
  [cycle].forEach((el) => el.addEventListener("change", () => { delete el.dataset.auto; }));

  const syncRequired = () => { next.required = status.value === "active"; };
  status.addEventListener("change", syncRequired);

  // --- cascada categoría → servicio → plan
  const catObj = () => cats.find((c) => c.name === category.value());
  const svcObj = () => {
    const c = catObj();
    return c ? c.services.find((s) => s.name === service.value()) : null;
  };
  let detected = false; // true mientras categoría/servicio los haya puesto la detección y no el usuario
  category.onChange(() => {
    if (!loading && !applying) detected = false;
    const c = catObj();
    service.setOptions(c ? c.services.map((s) => s.name) : []);
    plan.setOptions([]);
  });
  service.onChange(() => {
    if (!loading && !applying) detected = false;
    renderPreview();
    const s = svcObj();
    plan.setOptions(s ? s.plans.map((p) => p.name) : []);
    if (loading || !s) return;
    autofill(name, s.name);
    if (s.color) { if (!color.dataset.touched) { color.value = s.color; color.dataset.auto = "1"; } }
    autofill(url, s.url);
  });
  plan.onChange(() => {
    const s = svcObj();
    const p = s ? s.plans.find((x) => x.name === plan.value()) : null;
    if (loading || !p) return;
    if (p.price !== null) autofill(price, String(p.price.toFixed(2)).replace(".", ","));
    if (p.cycle && (!cycle.value || cycle.dataset.auto === "1")) { cycle.value = p.cycle; cycle.dataset.auto = "1"; }
  });
  color.addEventListener("input", () => { color.dataset.touched = "1"; });

  // --- detección por el nombre: «apple music», «mi netflix premium», «seguro del coche»…
  let detectTimer = 0;
  const applyDetection = () => {
    if (loading) return;
    const catEmpty = !category.value() && !service.value();
    if (!catEmpty && !detected) return; // el usuario ya eligió: no se toca
    const hit = detectFromText(name.value, catalog);
    if (!hit) return;
    applying = true;
    try {
      category.set(hit.category);
      const c = catObj();
      service.setOptions(c ? c.services.map((x) => x.name) : []);
      service.set(hit.service);
      const sv = svcObj();
      plan.setOptions(sv ? sv.plans.map((x) => x.name) : []);
      if (hit.plan) plan.set(hit.plan);
      detected = true;
      // «apple music» -> «Apple Music» (solo si el nombre es exactamente el del servicio)
      if (hit.service && normText(name.value) === normText(hit.service) && name.value !== hit.service) name.value = hit.service;
      if (sv) {
        if (sv.color && !color.dataset.touched) { color.value = sv.color; color.dataset.auto = "1"; }
        autofill(url, sv.url);
        const p = sv.plans.find((x) => x.name === hit.plan);
        if (p && p.price !== null) autofill(price, p.price.toFixed(2).replace(".", ","));
        if (p && p.cycle && (!cycle.value || cycle.dataset.auto === "1")) { cycle.value = p.cycle; cycle.dataset.auto = "1"; }
      }
    } finally { applying = false; }
    renderPreview();
  };
  name.addEventListener("input", () => {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => { applyDetection(); renderPreview(); }, 250);
  });

  // --- foto
  const preview = h("div", { class: "photo-preview" });
  const fileInput = h("input", { type: "file", accept: "image/*", class: "visually-hidden", id: "photo-file" });
  const removeBtn = h("button", { type: "button", class: "btn btn-sm", text: "Quitar foto" });
  const pickBtn = h("label", { class: "btn btn-sm", for: "photo-file" }, icon("image", 16), " Elegir foto");
  const photoMsg = h("span", { class: "field-hint" });
  const photoNote = h("p", { class: "field-hint" });
  const renderPreview = () => {
    const own = photo.url || (!photo.remove && editing && sub.has_photo ? `api/subscriptions/${sub.id}/photo?v=${encodeURIComponent(sub.photo_v)}` : null);
    const logo = own ? "" : logoFor({ service: service.value(), name: name.value }, catalog);
    const src = own || logo;
    render(preview, src ? h("img", { src, alt: own ? "Vista previa de la foto" : "Logo automático" }) : h("span", { class: "photo-empty", text: "Sin foto" }));
    removeBtn.hidden = !own;
    photoNote.textContent = !own && logo ? "Logo automático del servicio. Si subes tu propia foto, se usará esa." : "";
  };
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    photoMsg.textContent = "Procesando…";
    try {
      const r = await shrinkImage(file);
      if (photo.url) URL.revokeObjectURL(photo.url);
      photo.blob = r.blob;
      photo.url = URL.createObjectURL(r.blob);
      photo.remove = false;
      photoMsg.textContent = `${r.width}×${r.height} px · ${Math.round(r.blob.size / 1024)} KB`;
    } catch (err) {
      photoMsg.textContent = "";
      toast(err.message, "error");
    }
    fileInput.value = "";
    renderPreview();
  });
  removeBtn.addEventListener("click", () => {
    if (photo.url) URL.revokeObjectURL(photo.url);
    photo.blob = null; photo.url = null; photo.remove = true;
    photoMsg.textContent = "";
    renderPreview();
  });

  const errorBox = h("div", { class: "form-error", role: "alert", hidden: true });
  const saveBtn = h("button", { type: "submit", class: "btn btn-primary", text: editing ? "Guardar cambios" : "Añadir suscripción" });
  const cancelBtn = h("button", { type: "button", class: "btn", text: "Cancelar" });

  const form = h("form", { class: "form", novalidate: false },
    h("fieldset", { class: "grid" },
      h("legend", { text: "¿Qué suscripción es?" }),
      field("Categoría", category.el), field("Servicio", service.el), field("Plan", plan.el),
      field("Nombre que verás en la lista", name, { id: "f-name" })),
    h("fieldset", { class: "grid" },
      h("legend", { text: "Cobro" }),
      field("Precio (€)", price, { hint: "Importe total de cada cobro" }),
      field("Periodicidad", cycle),
      field("Estado", status),
      field("Próximo cobro", next),
      field("Personas que lo comparten", people, { hint: "Tu parte = precio ÷ personas" }),
      field("Método de pago", method.el)),
    h("fieldset", { class: "grid" },
      h("legend", { text: "Fechas y avisos" }),
      field("Fecha de alta", start), field("Fin de la prueba gratuita", trial),
      field("Avisarme con (días)", remind, { hint: "Vacío = ajuste general" })),
    h("fieldset", { class: "grid" },
      h("legend", { text: "Detalles" }),
      field("Web / gestión de la cuenta", url), field("Color", color),
      field("Notas", notes, { wide: true })),
    h("fieldset", { class: "photo-field" },
      h("legend", { text: "Foto o logo" }),
      preview, photoNote,
      h("div", { class: "photo-actions" }, fileInput, pickBtn, removeBtn, photoMsg)),
    errorBox,
    h("div", { class: "dlg-actions" }, cancelBtn, saveBtn));

  const d = openDialog(editing ? "Editar suscripción" : "Nueva suscripción", form, { wide: true });
  cancelBtn.addEventListener("click", () => d.close("cancel"));

  // --- valores iniciales
  if (editing) {
    category.set(sub.category);
    const c = cats.find((x) => x.name === sub.category);
    service.setOptions(c ? c.services.map((s) => s.name) : []);
    service.set(sub.service);
    const s = c && c.services.find((x) => x.name === sub.service);
    plan.setOptions(s ? s.plans.map((p) => p.name) : []);
    plan.set(sub.plan);
    method.set(sub.payment_method);
    name.value = sub.name;
    price.value = String(sub.price.toFixed(2)).replace(".", ",");
    cycle.value = sub.cycle;
    status.value = sub.status;
    next.value = sub.next_charge || "";
    start.value = sub.start_date || "";
    trial.value = sub.trial_end || "";
    people.value = sub.people;
    url.value = sub.url;
    color.value = sub.color || hashColor(sub.name);
    color.dataset.touched = "1";
    remind.value = sub.remind_days ?? "";
    notes.value = sub.notes;
  } else {
    next.value = todayIso();
    color.dataset.auto = "1";
  }
  syncRequired();
  renderPreview();
  loading = false;
  if (!editing) category.select.focus();

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!form.reportValidity()) return;
    errorBox.hidden = true;
    saveBtn.disabled = true;
    const payload = {
      name: name.value, service: service.value(), plan: plan.value(), category: category.value(),
      price: price.value, cycle: cycle.value, status: status.value, next_charge: next.value || null,
      start_date: start.value || null, trial_end: trial.value || null, people: people.value,
      payment_method: method.value(), url: url.value, color: color.value, notes: notes.value,
      remind_days: remind.value === "" ? null : remind.value,
    };
    try {
      let saved = editing ? await api.put(`/subscriptions/${sub.id}`, payload) : await api.post("/subscriptions", payload);
      let photoError = null;
      try {
        if (photo.blob) saved = await api.putImage(`/subscriptions/${saved.id}/photo`, photo.blob);
        else if (photo.remove && editing && sub.has_photo) saved = await api.del(`/subscriptions/${saved.id}/photo`);
      } catch (err) { photoError = err.message; }
      if (photo.url) URL.revokeObjectURL(photo.url);
      d.close("saved");
      toast(photoError ? `Guardada, pero la foto falló: ${photoError}` : (editing ? "Cambios guardados." : "Suscripción añadida."), photoError ? "error" : "ok");
      onSaved(saved);
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      const first = Object.keys(err.errors || {})[0];
      const bad = first && form.elements[first];
      if (bad && bad.focus && !bad.hidden) bad.focus();
      errorBox.scrollIntoView({ block: "nearest" });
      saveBtn.disabled = false;
    }
  });
}

export function openPaymentForm({ subId, payment, defaultAmount, onSaved }) {
  const editing = !!payment;
  const date = h("input", { type: "date", name: "date", required: true, min: "2000-01-01", max: "2100-12-31", value: payment ? payment.date : todayIso() });
  const amount = h("input", { type: "text", name: "amount", required: true, inputmode: "decimal", autocomplete: "off",
    value: String((payment ? payment.amount : defaultAmount).toFixed(2)).replace(".", ",") });
  const status = h("select", { name: "status" }, ...Object.entries(PAY_STATUS).map(([k, v]) => h("option", { value: k, text: v })));
  status.value = payment ? payment.status : "done";
  const notes = h("textarea", { name: "notes", rows: 2, maxlength: 500, placeholder: "Opcional", text: payment ? payment.notes : "" });
  const errorBox = h("div", { class: "form-error", role: "alert", hidden: true });
  const cancelBtn = h("button", { type: "button", class: "btn", text: "Cancelar" });
  const saveBtn = h("button", { type: "submit", class: "btn btn-primary", text: "Guardar" });
  const form = h("form", { class: "form" },
    h("div", { class: "grid" }, field("Fecha", date), field("Importe (€)", amount), field("Estado", status), field("Notas", notes, { wide: true })),
    errorBox, h("div", { class: "dlg-actions" }, cancelBtn, saveBtn));
  const d = openDialog(editing ? "Editar pago" : "Añadir pago", form);
  cancelBtn.addEventListener("click", () => d.close("cancel"));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!form.reportValidity()) return;
    saveBtn.disabled = true;
    errorBox.hidden = true;
    const payload = { date: date.value, amount: amount.value, status: status.value, notes: notes.value };
    try {
      const saved = editing ? await api.put(`/payments/${payment.id}`, payload) : await api.post(`/subscriptions/${subId}/payments`, payload);
      d.close("saved");
      toast("Pago guardado.");
      onSaved(saved);
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      saveBtn.disabled = false;
    }
  });
}
