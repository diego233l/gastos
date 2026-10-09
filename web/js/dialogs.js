import { h, icon, render } from "./dom.js";

// Crea un <dialog> modal, lo monta y lo retira al cerrarse. Devuelve {dialog, close, closed}.
export function openDialog(title, bodyNodes, { wide = false } = {}) {
  const dialog = h("dialog", { class: wide ? "dlg dlg-wide" : "dlg", "aria-labelledby": "dlg-title" });
  const closeBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Cerrar", onclick: () => dialog.close("cancel") }, icon("x"));
  render(dialog, h("div", { class: "dlg-head" }, h("h2", { id: "dlg-title", text: title }), closeBtn), bodyNodes);
  document.body.append(dialog);
  const closed = new Promise((resolve) => {
    dialog.addEventListener("close", () => { dialog.remove(); resolve(dialog.returnValue); });
  });
  dialog.showModal();
  return { dialog, close: (v) => dialog.close(v), closed };
}

export function confirmDialog(title, message, { okLabel = "Aceptar", danger = false } = {}) {
  return new Promise((resolve) => {
    const ok = h("button", { type: "button", class: danger ? "btn btn-danger" : "btn btn-primary", text: okLabel });
    const cancel = h("button", { type: "button", class: "btn", text: "Cancelar" });
    const d = openDialog(title, [
      h("p", { class: "dlg-text", text: message }),
      h("div", { class: "dlg-actions" }, cancel, ok),
    ]);
    ok.addEventListener("click", () => d.close("ok"));
    cancel.addEventListener("click", () => d.close("cancel"));
    d.closed.then((v) => resolve(v === "ok"));
    cancel.focus();
  });
}
