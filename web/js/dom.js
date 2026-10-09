// Utilidades DOM. Nunca se usa innerHTML: todo el texto entra por textContent.
const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS = {
  plus: "M12 5v14M5 12h14",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  back: "M19 12H5M12 19l-7-7 7-7",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  check: "M20 6 9 17l-5-5",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  play: "M5 3l14 9-14 9Z",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3",
  x: "M18 6 6 18M6 6l12 12",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  image: "M3 5h18v14H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 19",
};

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name] || "");
  svg.appendChild(path);
  return svg;
}

// Aplana y descarta null/undefined/false (evita el texto "null" en la página).
export function clean(list) {
  return list.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, val] of Object.entries(props || {})) {
    if (val === null || val === undefined || val === false) continue;
    if (key === "class") el.className = val;
    else if (key === "style") {
      for (const [k, v] of Object.entries(val)) el.style.setProperty(k, String(v));
    } else if (key === "dataset") Object.assign(el.dataset, val);
    else if (key.startsWith("on") && typeof val === "function") el.addEventListener(key.slice(2), val);
    else if (key === "text") el.textContent = String(val);
    else if (val === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(val));
  }
  for (const child of clean(children)) {
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function render(root, ...nodes) {
  root.replaceChildren(...clean(nodes).map((n) => (n instanceof Node ? n : document.createTextNode(String(n)))));
}

let toastTimer = 0;
export function toast(message, kind = "ok") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === "error" ? 6000 : 3000);
}
