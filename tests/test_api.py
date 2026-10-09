#!/usr/bin/env python3
"""Pruebas de la API contra nginx+fcgiwrap (tests/nginx_env.sh start) o el servidor dev.
   python3 tests/test_api.py [http://127.0.0.1:18080] [usuario:clave]"""
import base64, json, struct, sys, urllib.request, urllib.error, zlib

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18080"
AUTH = sys.argv[2] if len(sys.argv) > 2 else "demo:demo123"
fails = 0


def call(method, path, body=None, headers=None, raw=None, csrf=True):
    h = {"Authorization": "Basic " + base64.b64encode(AUTH.encode()).decode()}
    if csrf and method != "GET":
        h["X-Requested-With"] = "gastos"
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def jcall(*a, **k):
    st, body, hd = call(*a, **k)
    try:
        return st, json.loads(body), hd
    except ValueError:
        return st, body, hd


def check(name, cond, extra=""):
    global fails
    print(("OK   " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))
    if not cond:
        fails += 1


def png(w, h):
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * w for _ in range(h))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


good = {"name": "Netflix", "service": "Netflix", "plan": "Estándar", "category": "Streaming de vídeo",
        "price": "13,99", "cycle": "monthly", "next_charge": "2026-01-31", "people": 1}

st, d, _ = jcall("GET", "/api/health"); check("health", st == 200 and d["ok"], d)
st, d, _ = jcall("GET", "/api/catalog"); check("catálogo", st == 200 and len(d["categories"]) > 5 and not d["problems"], d if st != 200 else d["problems"])
svcs = {x["name"]: x for c in d["categories"] for x in c["services"]}
check("catálogo: Revolut con logo y Apple Music con logo", svcs["Revolut"]["logo"] == "logos/revolut.svg" and svcs["Apple Music"]["logo"] == "logos/apple-music.svg", svcs.get("Revolut"))
st, d, _ = jcall("POST", "/api/subscriptions", good, csrf=False); check("CSRF: POST sin cabecera -> 403", st == 403, (st, d))
st, d, _ = jcall("POST", "/api/subscriptions", {}); check("validación: vacío -> 422 con mensaje", st == 422 and "obligatorio" in d["error"], d)
for label, patch in [("precio negativo", {"price": -1}), ("precio con 3 decimales", {"price": "1.234"}), ("precio texto", {"price": "abc"}),
                     ("fecha imposible", {"next_charge": "2026-02-30"}), ("fecha formato", {"next_charge": "31/01/2026"}),
                     ("periodicidad rara", {"cycle": "daily"}), ("nombre largo", {"name": "x" * 81}), ("personas 0", {"people": 0}),
                     ("url javascript:", {"url": "javascript:alert(1)"}), ("color malo", {"color": "red"}),
                     ("control chars", {"notes": "a\x00b"}), ("estado raro", {"status": "zombie"}), ("aviso 999", {"remind_days": 999}),
                     ("activa sin fecha", {"next_charge": None})]:
    st, d, _ = jcall("POST", "/api/subscriptions", dict(good, **patch)); check("rechaza " + label, st == 422 and d.get("error"), (st, d))
st, d, _ = jcall("POST", "/api/subscriptions", raw=b"{no json", headers={"Content-Type": "application/json"}); check("JSON roto -> 400", st == 400, (st, d))
st, d, _ = jcall("POST", "/api/subscriptions", raw=b"[1]", headers={"Content-Type": "application/json"}); check("JSON no objeto -> 400", st == 400, (st, d))
st, d, _ = jcall("POST", "/api/subscriptions", raw=b"x" * 200000, headers={"Content-Type": "application/json"}); check("cuerpo 200 KB JSON -> 413", st == 413, (st, d))
st, d, _ = jcall("POST", "/api/subscriptions", raw=b"x" * 2_000_000, headers={"Content-Type": "application/json"}); check("cuerpo 2 MB (nginx) -> 413", st == 413, (st,))

st, sub, _ = jcall("POST", "/api/subscriptions", good); check("crear -> 201", st == 201 and sub["id"] and sub["price"] == 13.99, (st, sub))
sid = sub["id"]
st, d, _ = jcall("GET", "/api/subscriptions/%d" % sid); check("leer ficha", st == 200 and d["subscription"]["name"] == "Netflix", d)
st, d, _ = jcall("PUT", "/api/subscriptions/%d" % sid, {"price": 15.5, "notes": "hola"}); check("editar parcial", st == 200 and d["price"] == 15.5 and d["name"] == "Netflix", d)
st, d, _ = jcall("PUT", "/api/subscriptions/%d" % sid, {"price": 13.99}); check("restaurar precio", st == 200)
for expect in ["2026-02-28", "2026-03-31", "2026-04-30"]:   # el día ancla (31) se conserva
    st, d, _ = jcall("POST", "/api/subscriptions/%d/pay" % sid); check("registrar cobro -> " + expect, st == 200 and d["next_charge"] == expect, d)
st, d, _ = jcall("GET", "/api/subscriptions/%d" % sid); check("3 pagos realizados", len([p for p in d["payments"] if p["status"] == "done"]) == 3, d)
pid = d["payments"][0]["id"]
st, p, _ = jcall("POST", "/api/subscriptions/%d/payments" % sid, {"date": "2026-06-01", "amount": "5,00", "status": "scheduled", "notes": "extra"}); check("añadir pago programado", st == 201 and p["status"] == "scheduled", p)
st, d, _ = jcall("PUT", "/api/payments/%d" % p["id"], {"status": "done"}); check("marcar realizado", st == 200 and d["status"] == "done", d)
st, d, _ = jcall("PUT", "/api/payments/%d" % p["id"], {"date": "2026-13-01"}); check("pago fecha mala -> 422", st == 422, d)
st, d, _ = jcall("DELETE", "/api/payments/%d" % p["id"]); check("borrar pago", st == 200, d)
st, d, _ = jcall("DELETE", "/api/payments/%d" % p["id"]); check("borrar pago inexistente -> 404", st == 404, d)
st, d, _ = jcall("PUT", "/api/subscriptions/%d" % sid, {"status": "paused"}); check("pausar", st == 200 and d["status"] == "paused", d)
st, d, _ = jcall("POST", "/api/subscriptions/%d/pay" % sid); check("cobrar pausada -> 409", st == 409, d)
st, d, _ = jcall("PUT", "/api/subscriptions/%d" % sid, {"status": "active"})

st, d, _ = jcall("PUT", "/api/subscriptions/%d/photo" % sid, raw=b"hola mundo", headers={"Content-Type": "image/jpeg"}); check("foto: texto disfrazado -> 415", st == 415, (st, d))
st, d, _ = jcall("PUT", "/api/subscriptions/%d/photo" % sid, raw=png(10, 10), headers={"Content-Type": "image/png"}); check("foto: PNG 10x10 muy pequeña -> 422", st == 422, (st, d))
st, d, _ = jcall("PUT", "/api/subscriptions/%d/photo" % sid, raw=png(40, 20), headers={"Content-Type": "image/gif"}); check("foto: content-type gif -> 415", st == 415, (st, d))
st, d, _ = jcall("PUT", "/api/subscriptions/%d/photo" % sid, raw=png(40, 20), headers={"Content-Type": "image/png"}); check("foto: PNG válido", st == 200 and d["photo_w"] == 40 and d["photo_h"] == 20, (st, d))
st, body, hd = call("GET", "/api/subscriptions/%d/photo" % sid); check("foto: GET devuelve PNG", st == 200 and body[:4] == b"\x89PNG" and hd["Content-Type"] == "image/png", (st, hd))
st, body, hd = call("GET", "/api/subscriptions/%d/photo" % sid, headers={"If-None-Match": hd["ETag"]}); check("foto: ETag -> 304", st == 304, st)
st, d, _ = jcall("PUT", "/api/subscriptions/%d/photo" % sid, raw=b"\x89PNG\r\n\x1a\n" + b"0" * 800_000, headers={"Content-Type": "image/png"}); check("foto: >700 KB -> 413", st == 413, (st, d))
st, d, _ = jcall("DELETE", "/api/subscriptions/%d/photo" % sid); check("foto: borrar", st == 200 and not d["has_photo"], d)

st, d, _ = jcall("GET", "/api/subscriptions/99999"); check("ficha inexistente -> 404 JSON", st == 404 and "error" in d, (st, d))
st, d, _ = jcall("GET", "/api/subscriptions/abc"); check("id no numérico -> 404", st == 404, (st, d))
st, d, _ = jcall("GET", "/api/..%2f..%2fetc/passwd"); check("path traversal API -> sin fuga", st in (400, 404), (st, d))
st, body, _ = call("GET", "/../../etc/passwd"); check("path traversal estático", st in (400, 404) and b"root:" not in body, st)
st, body, _ = call("GET", "/.git/config"); check("dotfiles denegados", st in (403, 404), st)
st, d, _ = jcall("PATCH", "/api/subscriptions/%d" % sid, {}); check("método no permitido -> 405", st == 405, (st, d))
st, d, _ = jcall("PUT", "/api/settings", {"remind_days": 14, "monthly_budget": "50,5"}); check("ajustes", st == 200 and d["remind_days"] == 14 and d["monthly_budget"] == 50.5, d)
st, d, _ = jcall("PUT", "/api/settings", {"remind_days": 500}); check("ajustes inválidos -> 422", st == 422, d)
st, d, _ = jcall("PUT", "/api/settings", {"monthly_budget": None, "remind_days": 7})
st, body, hd = call("GET", "/api/export"); ex = json.loads(body); check("exportar JSON", st == 200 and ex["app"] == "gastos" and len(ex["subscriptions"]) >= 1 and "attachment" in hd["Content-Disposition"], st)
st, d, _ = jcall("DELETE", "/api/subscriptions/%d" % sid); check("borrar suscripción", st == 200, d)
st, d, _ = jcall("GET", "/api/payments"); check("pagos huérfanos eliminados en cascada", st == 200 and not [p for p in d["payments"] if p["subscription_id"] == sid], d)
print("\n%s" % ("TODO CORRECTO" if not fails else "%d FALLOS" % fails))
sys.exit(1 if fails else 0)
