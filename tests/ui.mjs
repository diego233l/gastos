// Recorrido de la interfaz con Playwright (Chromium ya instalado). Uso: node tests/ui.mjs [url] [dir-capturas]
import { createRequire } from "node:module";
import zlib from "node:zlib";
const require = createRequire("/opt/node22/lib/node_modules/");
const { chromium } = require("playwright");
const BASE = process.argv[2] || "http://127.0.0.1:18080";
const SHOTS = process.argv[3] || "/tmp/claude-0/shots";
let fails = 0;
const ok = (name, cond, extra = "") => { console.log((cond ? "OK   " : "FAIL ") + name + (cond ? "" : "  -> " + extra)); if (!cond) fails++; };

// PNG sintético apaisado 300x100 (degradado) para probar la proporción
function makePng(w, h) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1); raw[o] = 0; raw[o + 1 + x * 3] = (x * 255 / w) | 0; raw[o + 2 + x * 3] = (y * 255 / h) | 0; raw[o + 3 + x * 3] = 160; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const auth = { username: "demo", password: "demo123" };
const jsErrors = [];
const ctx = await browser.newContext({ httpCredentials: auth, viewport: { width: 1200, height: 900 }, colorScheme: "light" });
const page = await ctx.newPage();
page.on("pageerror", (e) => jsErrors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/status of (404|422)/.test(m.text())) jsErrors.push(m.text()); });
const settle = (pg) => pg.waitForFunction(() => [...document.images].every((i) => i.complete));
const shot = async (n) => { await settle(page); await page.waitForTimeout(150); await page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }); };

// contraseña: sin credenciales -> 401
const anon = await browser.newContext(); const r401 = await anon.request.get(BASE + "/"); ok("sin contraseña -> 401", r401.status() === 401, r401.status()); await anon.close();

await page.goto(BASE + "/");
await page.waitForSelector(".empty");
ok("portada vacía con mensaje", (await page.textContent(".empty h2")).includes("Aún no tienes"));
await shot("01-vacio");

// ---- crear con catálogo y autorrelleno
await page.click(".page-head .btn-primary");
await page.waitForSelector("dialog[open]");
await page.selectOption('select[name="category-sel"]', "Streaming de vídeo");
const svcOpts = await page.$$eval('select[name="service-sel"] option', (o) => o.map((x) => x.textContent));
ok("servicios filtrados por categoría", svcOpts.includes("Netflix") && !svcOpts.includes("Spotify"), svcOpts.slice(0, 5));
await page.selectOption('select[name="service-sel"]', "Netflix");
ok("autorrelleno nombre", (await page.inputValue('input[name="name"]')) === "Netflix");
await page.selectOption('select[name="plan-sel"]', "Estándar");
ok("autorrelleno precio y ciclo", (await page.inputValue('input[name="price"]')) === "13,99" && (await page.inputValue('select[name="cycle"]')) === "monthly");
// el usuario escribe un nombre propio: no se pisa
await page.fill('input[name="name"]', "Mi Netflix");
await page.selectOption('select[name="plan-sel"]', "Premium");
ok("no pisa lo escrito por el usuario (nombre)", (await page.inputValue('input[name="name"]')) === "Mi Netflix");
ok("sí actualiza el precio autorrellenado", (await page.inputValue('input[name="price"]')) === "19,99");
// foto apaisada
await page.setInputFiles("#photo-file", { name: "logo.png", mimeType: "image/png", buffer: makePng(300, 100) });
await page.waitForSelector(".photo-preview img");
await page.fill('input[name="people"]', "2");
await page.selectOption('select[name="payment_method-sel"]', "PayPal");
const nextDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
await page.fill('input[name="next_charge"]', nextDate);
await shot("02-formulario");
await page.click('dialog button[type="submit"]');
await page.waitForSelector("dialog", { state: "detached" });
await page.waitForSelector(".card");
ok("tarjeta creada", (await page.textContent(".card-title")) === "Mi Netflix");
ok("aviso de cobro próximo", (await page.textContent(".alerts")).includes("Mi Netflix"));
ok("foto en tarjeta (fondo + frente)", (await page.$$(".card .thumb img")).length === 2);

// ---- "Otro…" y required dinámico: ocultos no bloquean
await page.click(".page-head .btn-primary");
await page.waitForSelector("dialog[open]");
await page.selectOption('select[name="category-sel"]', "Seguros");
await page.selectOption('select[name="service-sel"]', "__otro__");
await page.fill('input[name="service"]', "Seguro del patinete");
await page.fill('input[name="name"]', "Seguro patinete");
await page.fill('input[name="price"]', "7,5");
await page.selectOption('select[name="cycle"]', "annual");
await page.fill('input[name="next_charge"]', "2020-01-15"); // vencido
await page.click('dialog button[type="submit"]');
await page.waitForSelector("dialog", { state: "detached" });
await page.waitForFunction(() => document.querySelectorAll(".card").length === 2);
ok("alta con «Otro…» (campos ocultos no bloquean)", true);
ok("aviso de cobro vencido con botón", (await page.textContent(".alert-overdue")).includes("venció") && !!(await page.$(".alert-overdue button")));

// ---- errores de validación servidor
await page.click(".page-head .btn-primary");
await page.waitForSelector("dialog[open]");
await page.selectOption('select[name="category-sel"]', "Música y podcasts");
await page.fill('input[name="name"]', "Prueba");
await page.fill('input[name="price"]', "12.345");
await page.selectOption('select[name="cycle"]', "monthly");
await page.click('dialog button[type="submit"]');
await page.waitForSelector(".form-error:not([hidden])");
ok("error de servidor visible en español", (await page.textContent(".form-error")).includes("precio"), await page.textContent(".form-error"));
await shot("03-error-validacion");
await page.click("dialog .dlg-actions .btn:not(.btn-primary)");
await page.waitForSelector("dialog", { state: "detached" });
await page.click('.page-head .btn-primary'); await page.waitForSelector("dialog[open]");
await page.click('dialog button[type="submit"]');
ok("validación del navegador bloquea envío vacío", (await page.$$("dialog[open]")).length === 1);
await page.keyboard.press("Escape");

// ---- búsqueda y filtros
await page.fill(".search-input", "patinete");
ok("buscador filtra", (await page.$$(".card")).length === 1);
await page.fill(".search-input", "");
await shot("04-portada");

// ---- ficha: proporción de la foto, botón volver, scroll
await page.click('.card:has-text("Mi Netflix")');
await page.waitForSelector(".detail");
const box = await page.$eval(".photo-frame", (e) => { const r = e.getBoundingClientRect(); return r.width / r.height; });
ok("marco con proporción exacta de la foto (3:1)", Math.abs(box - 3) < 0.02, box);
await page.evaluate(() => window.scrollTo(0, 400));
await page.click("text=Volver al listado");
await page.waitForSelector(".grid-cards");
ok("volver al listado y scroll arriba", (await page.evaluate(() => window.scrollY)) === 0);
await page.click('.card:has-text("Mi Netflix")');
await page.waitForSelector(".detail");
await shot("05-ficha");

// registrar cobro + historial
await page.click("text=Registrar cobro");
await page.waitForSelector(".pay-row");
ok("cobro registrado en historial", (await page.$$(".pay-row")).length === 1);
// editar
await page.click(".actions >> text=Editar");
await page.waitForSelector("dialog[open]");
ok("edición precarga valores", (await page.inputValue('input[name="name"]')) === "Mi Netflix" && (await page.inputValue('select[name="plan-sel"]')) === "Premium");
ok("edición precarga foto", !!(await page.$(".photo-preview img")));
await page.fill('textarea[name="notes"]', "Cuenta compartida con <b>Ana</b>");
await page.click('dialog button[type="submit"]');
await page.waitForSelector("dialog", { state: "detached" });
await page.waitForSelector(".notes");
ok("notas con HTML se muestran como texto (sin inyección)", (await page.textContent(".notes")).includes("<b>Ana</b>") && !(await page.$(".notes b")));
// pausar
await page.click(".actions >> text=Pausar");
await page.waitForSelector(".actions >> text=Reanudar");
ok("pausar muestra Reanudar", true);
await page.click(".actions >> text=Reanudar"); await page.waitForSelector(".actions >> text=Pausar");

// ---- cobros / estadísticas / ajustes
await page.click('#tabs a[data-tab="charges"]'); await page.waitForSelector(".charges");
ok("vista cobros con filas", (await page.$$(".charges li")).length >= 2);
await shot("06-cobros");
await page.click('#tabs a[data-tab="stats"]'); await page.waitForSelector(".bars");
await shot("07-estadisticas");
await page.click('#tabs a[data-tab="settings"]'); await page.waitForSelector("text=Copia de seguridad");
await page.fill('input[name="monthly_budget"]', "5"); await page.click("text=Guardar ajustes");
await page.waitForSelector("#toast:not([hidden])");
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("text=Exportar copia")]);
ok("exportar copia descarga JSON", dl.suggestedFilename().endsWith(".json"), dl.suggestedFilename());
await shot("08-ajustes");
await page.click('#tabs a[data-tab="home"]'); await page.waitForSelector(".grid-cards");
ok("aviso de presupuesto superado", (await page.textContent(".alerts")).includes("presupuesto"));

// ---- eliminar con confirmación
await page.click('.card:has-text("Seguro patinete")'); await page.waitForSelector(".detail");
await page.click(".actions >> text=Eliminar"); await page.waitForSelector("dialog[open]");
await page.click('dialog .btn-danger'); await page.waitForSelector(".grid-cards");
ok("eliminada", (await page.$$(".card")).length === 1);
ok("ruta inexistente de ficha vuelve al listado", true);
await page.goto(BASE + "/#/s/9999"); await page.waitForSelector(".grid-cards");

// ---- móvil y modo oscuro
const m = await browser.newContext({ httpCredentials: auth, viewport: { width: 390, height: 800 }, colorScheme: "dark", deviceScaleFactor: 2 });
const mp = await m.newPage(); mp.on("pageerror", (e) => jsErrors.push(e.message));
await mp.goto(BASE + "/"); await mp.waitForSelector(".card");
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
ok("móvil sin scroll horizontal", !overflow);
await settle(mp); await mp.screenshot({ path: `${SHOTS}/09-movil-oscuro.png` });
await mp.click(".card"); await mp.waitForSelector(".detail");
ok("ficha móvil sin scroll horizontal", !(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
await settle(mp); await mp.screenshot({ path: `${SHOTS}/10-ficha-movil.png` });
await mp.click('.actions >> text=Editar'); await mp.waitForSelector("dialog[open]");
await mp.screenshot({ path: `${SHOTS}/11-form-movil.png` });

ok("sin errores de JavaScript/consola", jsErrors.length === 0, jsErrors.join(" | "));
await browser.close();
console.log(fails ? `\n${fails} FALLOS` : "\nTODO CORRECTO");
process.exit(fails ? 1 : 0);
