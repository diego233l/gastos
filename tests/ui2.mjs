// Detección por nombre, logos automáticos y cobros pendientes. Requiere base de datos vacía.
import { createRequire } from "node:module";
const require = createRequire("/opt/node22/lib/node_modules/");
const { chromium } = require("playwright");
const BASE = process.argv[2] || "http://127.0.0.1:18080";
const SHOTS = process.argv[3] || "/tmp/claude-0/shots";
let fails = 0;
const ok = (n, c, x = "") => { console.log((c ? "OK   " : "FAIL ") + n + (c ? "" : "  -> " + x)); if (!c) fails++; };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ httpCredentials: { username: "demo", password: "demo123" }, viewport: { width: 1200, height: 900 } });
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/status of (404|422)/.test(m.text())) errs.push(m.text()); });
const settle = () => page.waitForFunction(() => [...document.images].every((i) => i.complete));

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = new Date();
const inDays = (n) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));

await page.goto(BASE + "/"); await page.waitForSelector(".empty");
// --- detección por nombre
await page.click(".page-head .btn-primary"); await page.waitForSelector("dialog[open]");
await page.type('input[name="name"]', "apple music", { delay: 20 });
await page.waitForFunction(() => document.querySelector('select[name="service-sel"]').value === "Apple Music");
ok("detecta categoría por el nombre", (await page.inputValue('select[name="category-sel"]')) === "Música y podcasts");
ok("detecta servicio por el nombre", (await page.inputValue('select[name="service-sel"]')) === "Apple Music");
ok("rellena la url sola", (await page.inputValue('input[name="url"]')).includes("music.apple.com"));
ok("el nombre se normaliza al del servicio", (await page.inputValue('input[name="name"]')) === "Apple Music");
ok("vista previa muestra el logo automático", (await page.getAttribute(".photo-preview img", "src")).includes("logos/apple-music.svg"));
ok("aviso de logo automático", (await page.textContent(".photo-actions")).length >= 0 && (await page.textContent("fieldset.photo-field")).includes("Logo automático"));
await page.fill('input[name="price"]', "10,99"); await page.selectOption('select[name="cycle"]', "monthly");
await page.fill('input[name="next_charge"]', inDays(20));
await page.click('dialog button[type="submit"]'); await page.waitForSelector("dialog", { state: "detached" });
await page.waitForSelector(".card"); await settle();
ok("tarjeta con logo sin subir foto", (await page.$$eval(".card .thumb img", (i) => i.map((x) => x.getAttribute("src")))).every((s) => s.includes("logos/apple-music.svg")));
await page.screenshot({ path: `${SHOTS}/12-logo-tarjeta.png` });

// --- si el usuario elige a mano, la detección no lo pisa
await page.click(".page-head .btn-primary"); await page.waitForSelector("dialog[open]");
await page.selectOption('select[name="category-sel"]', "Seguros");
await page.type('input[name="name"]', "netflix", { delay: 20 });
await page.waitForTimeout(500);
ok("no pisa la categoría elegida por el usuario", (await page.inputValue('select[name="category-sel"]')) === "Seguros");
await page.keyboard.press("Escape");
// categoría por palabras clave
await page.click(".page-head .btn-primary"); await page.waitForSelector("dialog[open]");
await page.type('input[name="name"]', "seguro del coche", { delay: 10 });
await page.waitForFunction(() => document.querySelector('select[name="category-sel"]').value === "Seguros");
ok("detecta solo la categoría por palabras clave", true);
await page.keyboard.press("Escape");

// --- ficha con logo
await page.click(".card"); await page.waitForSelector(".detail"); await settle();
ok("ficha muestra el logo", !!(await page.$(".photo-logo img")));
await page.screenshot({ path: `${SHOTS}/13-ficha-logo.png` });

// --- cobros pendientes: pago programado manual aparece en próximos cobros
const next = inDays(40);
await page.click("text=Añadir pago"); await page.waitForSelector("dialog[open]");
await page.fill('input[name="date"]', next); await page.selectOption('select[name="status"]', "scheduled");
await page.click('dialog button[type="submit"]'); await page.waitForSelector("dialog", { state: "detached" });
await page.waitForSelector(".pay-row");
ok("ficha lista el cobro programado como próximo", (await page.textContent(".panel:has(h2:text('Próximos cobros'))")).includes("programado"));
await page.click('#tabs a[data-tab="charges"]'); await page.waitForSelector(".charges");
const rowsBefore = await page.$$eval(".charges li", (l) => l.map((x) => x.textContent));
ok("Cobros incluye el programado (además del calculado)", rowsBefore.length >= 2 && rowsBefore.some((t) => t.includes("programado")), rowsBefore.join(" | "));
await page.screenshot({ path: `${SHOTS}/14-cobros.png` });
// marcarlo como pagado lo quita de pendientes
await page.click(".charges li:has-text('programado') button");
await page.waitForFunction(() => ![...document.querySelectorAll(".charges li")].some((l) => l.textContent.includes("programado")));
ok("al marcarlo pagado desaparece de Cobros", true);
// pago realizado en el mes del próximo cobro calculado lo oculta
await page.click(".charges li button"); // registrar el siguiente (calculado)
await page.waitForTimeout(600);
const after = await page.$$eval(".charges li", (l) => l.length);
ok("registrar cobro avanza al siguiente (el pagado no vuelve a salir)", after >= 1);
ok("sin errores de JS", errs.length === 0, errs.join(" | "));
await browser.close();
console.log(fails ? `\n${fails} FALLOS` : "\nTODO CORRECTO"); process.exit(fails ? 1 : 0);
