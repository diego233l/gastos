#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""API de Gastos · suscripciones.

Un único script, solo biblioteca estándar + SQLite. nginx lo ejecuta por CGI
(fcgiwrap) en cada petición, así que `git pull` basta para actualizar.
`python3 app/server.py` reutiliza `dispatch()` para el desarrollo local.
"""
import sys

sys.dont_write_bytecode = True  # www-data no puede escribir en el repositorio

import base64
import calendar
import datetime
import hashlib
import json
import os
import re
import sqlite3
import struct
import traceback
from decimal import Decimal, InvalidOperation

VERSION = "1.0.0"
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("GASTOS_DATA_DIR", "/var/lib/gastos")
CATALOG_PATH = os.path.join(BASE_DIR, "catalog", "catalog.txt")
CSRF_HEADER_VALUE = "gastos"

MAX_JSON_BODY = 100_000
MAX_PHOTO_BODY = 700_000
MAX_SUBSCRIPTIONS = 2000
MAX_PAYMENTS_PER_SUB = 5000

CYCLES = {  # código -> meses por ciclo (semanal se trata aparte)
    "weekly": None, "monthly": 1, "bimonthly": 2,
    "quarterly": 3, "semiannual": 6, "annual": 12,
}
CYCLE_WORDS = {
    "semanal": "weekly", "mensual": "monthly", "bimestral": "bimonthly",
    "trimestral": "quarterly", "semestral": "semiannual", "anual": "annual",
}
STATUSES = ("active", "paused", "cancelled")
PAY_STATUSES = ("scheduled", "done")

# --------------------------------------------------------------------------
# Errores y respuestas
# --------------------------------------------------------------------------


class ApiError(Exception):
    def __init__(self, status, message, errors=None):
        Exception.__init__(self, message)
        self.status = status
        self.message = message
        self.errors = errors or {}


STATUS_TEXT = {
    200: "OK", 201: "Created", 204: "No Content", 304: "Not Modified",
    400: "Bad Request", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large",
    415: "Unsupported Media Type", 422: "Unprocessable Entity",
    500: "Internal Server Error", 503: "Service Unavailable",
}


class Response(object):
    def __init__(self, status=200, body=b"", headers=None, ctype="application/json; charset=utf-8"):
        self.status = status
        self.body = body
        self.headers = {"Content-Type": ctype, "Cache-Control": "no-store",
                        "X-Content-Type-Options": "nosniff"}
        if headers:
            self.headers.update(headers)


def json_response(obj, status=200, headers=None):
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return Response(status, body, headers)


def error_response(status, message, errors=None):
    payload = {"error": message}
    if errors:
        payload["errors"] = errors
    return json_response(payload, status)


# --------------------------------------------------------------------------
# Base de datos y migraciones
# --------------------------------------------------------------------------

MIGRATIONS = [
    # 1 · esquema inicial
    """
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      service TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      cycle TEXT NOT NULL,
      next_charge TEXT,
      anchor_day INTEGER,
      start_date TEXT,
      trial_end TEXT,
      payment_method TEXT NOT NULL DEFAULT '',
      people INTEGER NOT NULL DEFAULT 1 CHECK (people >= 1),
      status TEXT NOT NULL DEFAULT 'active',
      url TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_subs_status ON subscriptions(status);
    CREATE INDEX idx_subs_next ON subscriptions(next_charge);
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      status TEXT NOT NULL CHECK (status IN ('scheduled','done')),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_pay_sub ON payments(subscription_id, date);
    CREATE TABLE photos (
      subscription_id INTEGER PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      data BLOB NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """,
    # 2 · aviso propio por suscripción (NULL = usar el ajuste global)
    "ALTER TABLE subscriptions ADD COLUMN remind_days INTEGER;",
]


def now_iso():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def log_error(text):
    """Guarda el último fallo en la carpeta de datos (mejor esfuerzo)."""
    try:
        path = os.path.join(DATA_DIR, "error.log")
        if os.path.exists(path) and os.path.getsize(path) > 200_000:
            os.remove(path)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("[%s]\n%s\n" % (now_iso(), text))
    except Exception:
        pass
    sys.stderr.write(text + "\n")


def connect():
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        conn = sqlite3.connect(os.path.join(DATA_DIR, "gastos.db"), timeout=15,
                               isolation_level=None)
    except (OSError, sqlite3.Error) as exc:
        raise ApiError(500, "No se puede abrir la base de datos en %s (%s). "
                            "Comprueba que la carpeta es de www-data." % (DATA_DIR, exc))
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        migrate(conn)
    except sqlite3.Error as exc:
        conn.close()
        raise ApiError(500, "Error de base de datos: %s" % exc)
    return conn


def migrate(conn):
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    if current >= len(MIGRATIONS):
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        # otra petición pudo migrar mientras esperábamos el bloqueo
        current = conn.execute("PRAGMA user_version").fetchone()[0]
        for i in range(current, len(MIGRATIONS)):
            for stmt in split_sql(MIGRATIONS[i]):
                conn.execute(stmt)
            conn.execute("PRAGMA user_version = %d" % (i + 1))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def split_sql(script):
    # sqlite3.complete_statement evita partir por ';' dentro de literales
    out, buf = [], ""
    for line in script.splitlines(True):
        buf += line
        if sqlite3.complete_statement(buf):
            if buf.strip():
                out.append(buf.strip())
            buf = ""
    if buf.strip():
        out.append(buf.strip())
    return out


class Tx(object):
    """with Tx(conn): ...  -> transacción inmediata con commit/rollback."""

    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        self.conn.execute("ROLLBACK" if exc_type else "COMMIT")
        return False


# --------------------------------------------------------------------------
# Validación
# --------------------------------------------------------------------------

CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
MIN_DATE = datetime.date(2000, 1, 1)
MAX_DATE = datetime.date(2100, 12, 31)

LABELS = {
    "name": "El nombre", "service": "El servicio", "plan": "El plan",
    "category": "La categoría", "price": "El precio", "cycle": "La periodicidad",
    "next_charge": "El próximo cobro", "start_date": "La fecha de alta",
    "trial_end": "El fin de la prueba", "payment_method": "El método de pago",
    "people": "El número de personas", "status": "El estado", "url": "La web",
    "color": "El color", "notes": "Las notas", "remind_days": "El aviso",
    "date": "La fecha", "amount": "El importe", "remind_days_default": "El aviso general",
    "monthly_budget": "El presupuesto",
}


class Validator(object):
    def __init__(self, data):
        self.data = data
        self.errors = {}
        self.out = {}

    def fail(self, key, msg):
        if key not in self.errors:
            self.errors[key] = "%s %s" % (LABELS.get(key, key), msg)

    def text(self, key, maxlen, required=False, default=""):
        val = self.data.get(key, default)
        if val is None:
            val = ""
        if not isinstance(val, str):
            self.fail(key, "debe ser texto.")
            return
        val = val.strip()
        if CTRL_RE.search(val):
            self.fail(key, "contiene caracteres no permitidos.")
            return
        if required and not val:
            self.fail(key, "es obligatorio.")
        elif len(val) > maxlen:
            self.fail(key, "no puede superar los %d caracteres." % maxlen)
        self.out[key] = val

    def enum(self, key, options, required=True, default=None):
        val = self.data.get(key, default)
        if val in (None, "") and not required:
            self.out[key] = default
            return
        if val not in options:
            self.fail(key, "no es válido.")
            return
        self.out[key] = val

    def date(self, key, required=False):
        val = self.data.get(key)
        if val in (None, ""):
            if required:
                self.fail(key, "es obligatoria." if key in ("date", "start_date") else "es obligatorio.")
            self.out[key] = None
            return
        d = parse_date(val)
        if d is None:
            self.fail(key, "no es una fecha válida (usa AAAA-MM-DD entre 2000 y 2100).")
            return
        self.out[key] = d.isoformat()

    def money(self, key, out_key=None, maximum=99999.99):
        val = self.data.get(key)
        cents = parse_money(val, maximum)
        if cents is None:
            self.fail(key, "debe ser un importe válido entre 0 y %s con hasta 2 decimales." % ("{:,.2f}".format(maximum)))
            return
        self.out[out_key or key + "_cents"] = cents

    def integer(self, key, lo, hi, required=True, default=None):
        val = self.data.get(key, default)
        if val in (None, ""):
            if required:
                self.fail(key, "es obligatorio.")
            self.out[key] = None
            return
        if isinstance(val, bool) or not isinstance(val, (int, float, str)):
            self.fail(key, "debe ser un número entero.")
            return
        try:
            num = Decimal(str(val))
            if num != num.to_integral_value():
                raise InvalidOperation
            num = int(num)
        except (InvalidOperation, ValueError):
            self.fail(key, "debe ser un número entero.")
            return
        if not lo <= num <= hi:
            self.fail(key, "debe estar entre %d y %d." % (lo, hi))
            return
        self.out[key] = num

    def url(self, key):
        val = self.data.get(key) or ""
        if not isinstance(val, str):
            self.fail(key, "debe ser texto.")
            return
        val = val.strip()
        if val and (len(val) > 300 or not re.match(r"^https?://[^\s<>\"']+$", val, re.I)):
            self.fail(key, "debe empezar por http:// o https:// (máx. 300 caracteres, sin espacios).")
            return
        self.out[key] = val

    def color(self, key):
        val = self.data.get(key) or ""
        if not isinstance(val, str) or (val and not COLOR_RE.match(val.strip())):
            self.fail(key, "debe tener el formato #rrggbb.")
            return
        self.out[key] = val.strip().lower()


def parse_date(val):
    if not isinstance(val, str) or not DATE_RE.match(val):
        return None
    try:
        d = datetime.date.fromisoformat(val)
    except ValueError:
        return None
    return d if MIN_DATE <= d <= MAX_DATE else None


def parse_money(val, maximum=99999.99):
    if val is None or isinstance(val, bool) or not isinstance(val, (int, float, str)):
        return None
    try:
        s = str(val).strip().replace(",", ".")
        if not s:
            return None
        num = Decimal(s)
    except InvalidOperation:
        return None
    if not num.is_finite() or num < 0 or num > Decimal(str(maximum)):
        return None
    cents = num * 100
    if cents != cents.to_integral_value():
        return None
    return int(cents)


def validate_subscription(data):
    v = Validator(data)
    v.text("name", 80, required=True)
    v.text("service", 60)
    v.text("plan", 80)
    v.text("category", 40, required=True)
    v.money("price", "price_cents")
    v.enum("cycle", CYCLES.keys())
    v.enum("status", STATUSES, default="active")
    v.date("next_charge")
    v.date("start_date")
    v.date("trial_end")
    v.text("payment_method", 60)
    v.integer("people", 1, 50, default=1)
    v.url("url")
    v.color("color")
    v.text("notes", 1000)
    v.integer("remind_days", 0, 90, required=False)
    out = v.out
    if "status" in out and out["status"] == "active" and not out.get("next_charge") \
            and "next_charge" not in v.errors:
        v.fail("next_charge", "es obligatorio en una suscripción activa.")
    if out.get("start_date") and out.get("next_charge") and "next_charge" not in v.errors \
            and out["next_charge"] < out["start_date"]:
        v.fail("next_charge", "no puede ser anterior a la fecha de alta.")
    if out.get("trial_end") and out.get("start_date") and out["trial_end"] < out["start_date"]:
        v.fail("trial_end", "no puede ser anterior a la fecha de alta.")
    if v.errors:
        raise ApiError(422, next(iter(v.errors.values())), v.errors)
    return out


def validate_payment(data):
    v = Validator(data)
    v.date("date", required=True)
    v.money("amount", "amount_cents")
    v.enum("status", PAY_STATUSES, default="done")
    v.text("notes", 500)
    if v.errors:
        raise ApiError(422, next(iter(v.errors.values())), v.errors)
    return v.out


# --------------------------------------------------------------------------
# Fechas
# --------------------------------------------------------------------------


def add_months(d, months, anchor_day=None):
    idx = d.year * 12 + (d.month - 1) + months
    year, month = divmod(idx, 12)
    month += 1
    day = anchor_day or d.day
    day = min(day, calendar.monthrange(year, month)[1])
    return datetime.date(year, month, day)


def advance_charge(d, cycle, anchor_day):
    if cycle == "weekly":
        return d + datetime.timedelta(days=7)
    result = add_months(d, CYCLES[cycle], anchor_day)
    return min(result, MAX_DATE)


# --------------------------------------------------------------------------
# Serialización
# --------------------------------------------------------------------------

SUB_SELECT = """
SELECT s.*, p.width AS photo_w, p.height AS photo_h, p.updated_at AS photo_v
FROM subscriptions s LEFT JOIN photos p ON p.subscription_id = s.id
"""


def sub_to_dict(row):
    return {
        "id": row["id"], "name": row["name"], "service": row["service"],
        "plan": row["plan"], "category": row["category"],
        "price": row["price_cents"] / 100.0, "cycle": row["cycle"],
        "next_charge": row["next_charge"], "start_date": row["start_date"],
        "trial_end": row["trial_end"], "payment_method": row["payment_method"],
        "people": row["people"], "status": row["status"], "url": row["url"],
        "color": row["color"], "notes": row["notes"],
        "remind_days": row["remind_days"],
        "has_photo": row["photo_v"] is not None,
        "photo_w": row["photo_w"], "photo_h": row["photo_h"], "photo_v": row["photo_v"],
        "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def pay_to_dict(row):
    return {
        "id": row["id"], "subscription_id": row["subscription_id"],
        "date": row["date"], "amount": row["amount_cents"] / 100.0,
        "status": row["status"], "notes": row["notes"],
    }


def get_sub_row(conn, sub_id):
    row = conn.execute(SUB_SELECT + " WHERE s.id = ?", (sub_id,)).fetchone()
    if row is None:
        raise ApiError(404, "La suscripción no existe (puede que ya la hayas borrado).")
    return row


# --------------------------------------------------------------------------
# Catálogo
# --------------------------------------------------------------------------


def parse_catalog(text, strict=False):
    """Interpreta catalog.txt. En modo estricto lanza ValueError ante duplicados."""
    categories, cat, svc = [], None, None
    seen_cat, seen_svc, seen_plan = set(), set(), set()
    problems = []

    def bad(n, msg):
        problems.append("línea %d: %s" % (n, msg))

    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        if line.startswith("=="):
            name = line[2:].strip()
            if not name:
                bad(n, "categoría sin nombre")
                continue
            if name.lower() in seen_cat:
                bad(n, "categoría duplicada «%s»" % name)
                cat = next(c for c in categories if c["name"].lower() == name.lower())
            else:
                seen_cat.add(name.lower())
                cat = {"name": name, "services": []}
                categories.append(cat)
            svc = None
        elif line.startswith("#"):
            if cat is None:
                bad(n, "servicio fuera de una categoría")
                continue
            parts = [p.strip() for p in line[1:].split("|")]
            name = parts[0]
            if not name:
                bad(n, "servicio sin nombre")
                continue
            url = parts[1] if len(parts) > 1 else ""
            color = parts[2] if len(parts) > 2 else ""
            if url and not re.match(r"^https?://\S+$", url):
                bad(n, "URL no válida «%s»" % url)
                url = ""
            if color and not COLOR_RE.match(color):
                bad(n, "color no válido «%s»" % color)
                color = ""
            key = (cat["name"].lower(), name.lower())
            if key in seen_svc:
                bad(n, "servicio duplicado «%s» en «%s»" % (name, cat["name"]))
                svc = next(s for s in cat["services"] if s["name"].lower() == name.lower())
                continue
            seen_svc.add(key)
            svc = {"name": name, "url": url, "color": color, "plans": []}
            cat["services"].append(svc)
        elif line.startswith("-"):
            if svc is None:
                bad(n, "plan fuera de un servicio")
                continue
            parts = [p.strip() for p in line[1:].split("|")]
            name = parts[0]
            if not name:
                bad(n, "plan sin nombre")
                continue
            price, cycle = None, None
            if len(parts) > 1 and parts[1]:
                cents = parse_money(parts[1])
                if cents is None:
                    bad(n, "precio no válido «%s»" % parts[1])
                else:
                    price = cents / 100.0
            if len(parts) > 2 and parts[2]:
                cycle = CYCLE_WORDS.get(parts[2].lower())
                if cycle is None:
                    bad(n, "ciclo no válido «%s»" % parts[2])
            key = (cat["name"].lower(), svc["name"].lower(), name.lower())
            if key in seen_plan:
                bad(n, "plan duplicado «%s» en «%s»" % (name, svc["name"]))
                continue
            seen_plan.add(key)
            svc["plans"].append({"name": name, "price": price, "cycle": cycle})
        else:
            bad(n, "línea no reconocida: %r" % line[:40])
    if strict and problems:
        raise ValueError("\n".join(problems))
    return {"categories": categories, "problems": problems}


def load_catalog():
    try:
        with open(CATALOG_PATH, encoding="utf-8") as fh:
            return parse_catalog(fh.read())
    except OSError as exc:
        raise ApiError(500, "No se pudo leer el catálogo (%s)." % exc)


# --------------------------------------------------------------------------
# Imágenes (validación por los primeros bytes)
# --------------------------------------------------------------------------


def sniff_image(data):
    """Devuelve (mime, ancho, alto) o None si no es un JPEG/PNG válido."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) > 24 and data[12:16] == b"IHDR":
        w, h = struct.unpack(">II", data[16:24])
        return "image/png", w, h
    if data[:3] == b"\xff\xd8\xff":
        i, n = 2, len(data)
        while i + 9 < n:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7 or marker == 0xFF:
                i += 1 if marker == 0xFF else 2
                continue
            seglen = struct.unpack(">H", data[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return "image/jpeg", w, h
            i += 2 + seglen
    return None


# --------------------------------------------------------------------------
# Controladores
# --------------------------------------------------------------------------


def get_settings(conn):
    rows = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}
    budget = rows.get("monthly_budget_cents")
    return {
        "remind_days": int(rows.get("remind_days", 7)),
        "monthly_budget": (int(budget) / 100.0) if budget not in (None, "") else None,
    }


def h_health(ctx):
    conn = connect()
    try:
        ver = conn.execute("PRAGMA user_version").fetchone()[0]
        n = conn.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0]
    finally:
        conn.close()
    return json_response({"ok": True, "version": VERSION, "schema": ver, "subscriptions": n})


def h_catalog(ctx):
    return json_response(load_catalog())


def h_settings_get(ctx):
    conn = connect()
    try:
        return json_response(get_settings(conn))
    finally:
        conn.close()


def h_settings_put(ctx):
    data = ctx.json_body()
    conn = connect()
    try:
        cur = get_settings(conn)
        merged = {
            "remind_days": data.get("remind_days", cur["remind_days"]),
            "monthly_budget": data.get("monthly_budget", cur["monthly_budget"]),
        }
        v = Validator(merged)
        v.integer("remind_days", 0, 60)
        for k in list(v.errors):
            v.errors["remind_days_default"] = v.errors.pop(k).replace(LABELS["remind_days"], LABELS["remind_days_default"], 1)
        budget_cents = None
        if merged["monthly_budget"] not in (None, ""):
            budget_cents = parse_money(merged["monthly_budget"], 1_000_000)
            if budget_cents is None:
                v.errors["monthly_budget"] = "El presupuesto debe ser un importe válido (máx. 1.000.000)."
        if v.errors:
            raise ApiError(422, next(iter(v.errors.values())), v.errors)
        with Tx(conn):
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('remind_days', ?)",
                         (str(v.out["remind_days"]),))
            if budget_cents is None:
                conn.execute("DELETE FROM settings WHERE key = 'monthly_budget_cents'")
            else:
                conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('monthly_budget_cents', ?)",
                             (str(budget_cents),))
        return json_response(get_settings(conn))
    finally:
        conn.close()


def h_subs_list(ctx):
    conn = connect()
    try:
        rows = conn.execute(SUB_SELECT + " ORDER BY s.name COLLATE NOCASE, s.id").fetchall()
        return json_response({"subscriptions": [sub_to_dict(r) for r in rows],
                              "settings": get_settings(conn)})
    finally:
        conn.close()


def anchor_for(fields):
    nc = fields.get("next_charge")
    return int(nc[8:10]) if nc else None


def h_subs_create(ctx):
    fields = validate_subscription(ctx.json_body())
    conn = connect()
    try:
        with Tx(conn):
            count = conn.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0]
            if count >= MAX_SUBSCRIPTIONS:
                raise ApiError(409, "Has alcanzado el máximo de %d suscripciones." % MAX_SUBSCRIPTIONS)
            ts = now_iso()
            cur = conn.execute(
                """INSERT INTO subscriptions(name, service, plan, category, price_cents, cycle,
                   next_charge, anchor_day, start_date, trial_end, payment_method, people, status,
                   url, color, notes, remind_days, created_at, updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (fields["name"], fields["service"], fields["plan"], fields["category"],
                 fields["price_cents"], fields["cycle"], fields["next_charge"], anchor_for(fields),
                 fields["start_date"], fields["trial_end"], fields["payment_method"],
                 fields["people"], fields["status"], fields["url"], fields["color"],
                 fields["notes"], fields["remind_days"], ts, ts))
            new_id = cur.lastrowid
        return json_response(sub_to_dict(get_sub_row(conn, new_id)), 201)
    finally:
        conn.close()


def h_sub_get(ctx, sub_id):
    conn = connect()
    try:
        sub = sub_to_dict(get_sub_row(conn, sub_id))
        pays = conn.execute("SELECT * FROM payments WHERE subscription_id = ? "
                            "ORDER BY date DESC, id DESC", (sub_id,)).fetchall()
        return json_response({"subscription": sub, "payments": [pay_to_dict(p) for p in pays],
                              "settings": get_settings(conn)})
    finally:
        conn.close()


def h_sub_update(ctx, sub_id):
    patch = ctx.json_body()
    conn = connect()
    try:
        with Tx(conn):
            row = get_sub_row(conn, sub_id)
            merged = sub_to_dict(row)
            for key in ("name", "service", "plan", "category", "price", "cycle", "next_charge",
                        "start_date", "trial_end", "payment_method", "people", "status", "url",
                        "color", "notes", "remind_days"):
                if key in patch:
                    merged[key] = patch[key]
            fields = validate_subscription(merged)
            anchor = row["anchor_day"]
            if fields["next_charge"] != row["next_charge"]:
                anchor = anchor_for(fields)
            conn.execute(
                """UPDATE subscriptions SET name=?, service=?, plan=?, category=?, price_cents=?,
                   cycle=?, next_charge=?, anchor_day=?, start_date=?, trial_end=?, payment_method=?,
                   people=?, status=?, url=?, color=?, notes=?, remind_days=?, updated_at=?
                   WHERE id=?""",
                (fields["name"], fields["service"], fields["plan"], fields["category"],
                 fields["price_cents"], fields["cycle"], fields["next_charge"], anchor,
                 fields["start_date"], fields["trial_end"], fields["payment_method"],
                 fields["people"], fields["status"], fields["url"], fields["color"],
                 fields["notes"], fields["remind_days"], now_iso(), sub_id))
        return json_response(sub_to_dict(get_sub_row(conn, sub_id)))
    finally:
        conn.close()


def h_sub_delete(ctx, sub_id):
    conn = connect()
    try:
        with Tx(conn):
            get_sub_row(conn, sub_id)
            conn.execute("DELETE FROM subscriptions WHERE id = ?", (sub_id,))
        return json_response({"ok": True})
    finally:
        conn.close()


def h_sub_pay(ctx, sub_id):
    """Registra el cobro pendiente como realizado y avanza el próximo cobro."""
    body = ctx.json_body(optional=True)
    conn = connect()
    try:
        with Tx(conn):
            row = get_sub_row(conn, sub_id)
            if row["status"] != "active" or not row["next_charge"]:
                raise ApiError(409, "Solo se puede registrar un cobro en una suscripción activa con próximo cobro.")
            charge = datetime.date.fromisoformat(row["next_charge"])
            data = {"date": body.get("date", row["next_charge"]),
                    "amount": body.get("amount", row["price_cents"] / 100.0),
                    "status": "done", "notes": body.get("notes", "")}
            fields = validate_payment(data)
            existing = conn.execute(
                "SELECT id FROM payments WHERE subscription_id=? AND date=? AND status='scheduled'",
                (sub_id, row["next_charge"])).fetchone()
            if existing:
                conn.execute("UPDATE payments SET status='done', amount_cents=?, date=?, notes=? WHERE id=?",
                             (fields["amount_cents"], fields["date"], fields["notes"], existing["id"]))
            else:
                insert_payment(conn, sub_id, fields)
            nxt = advance_charge(charge, row["cycle"], row["anchor_day"])
            conn.execute("UPDATE subscriptions SET next_charge=?, updated_at=? WHERE id=?",
                         (nxt.isoformat(), now_iso(), sub_id))
        return json_response(sub_to_dict(get_sub_row(conn, sub_id)))
    finally:
        conn.close()


def insert_payment(conn, sub_id, fields):
    n = conn.execute("SELECT COUNT(*) FROM payments WHERE subscription_id = ?", (sub_id,)).fetchone()[0]
    if n >= MAX_PAYMENTS_PER_SUB:
        raise ApiError(409, "Esta suscripción ya tiene el máximo de %d pagos." % MAX_PAYMENTS_PER_SUB)
    cur = conn.execute(
        "INSERT INTO payments(subscription_id, date, amount_cents, status, notes, created_at) "
        "VALUES(?,?,?,?,?,?)",
        (sub_id, fields["date"], fields["amount_cents"], fields["status"], fields["notes"], now_iso()))
    return cur.lastrowid


def h_pay_create(ctx, sub_id):
    fields = validate_payment(ctx.json_body())
    conn = connect()
    try:
        with Tx(conn):
            get_sub_row(conn, sub_id)
            pid = insert_payment(conn, sub_id, fields)
        return json_response(pay_to_dict(conn.execute("SELECT * FROM payments WHERE id=?", (pid,)).fetchone()), 201)
    finally:
        conn.close()


def get_pay_row(conn, pay_id):
    row = conn.execute("SELECT * FROM payments WHERE id = ?", (pay_id,)).fetchone()
    if row is None:
        raise ApiError(404, "El pago no existe (puede que ya lo hayas borrado).")
    return row


def h_pay_update(ctx, pay_id):
    patch = ctx.json_body()
    conn = connect()
    try:
        with Tx(conn):
            row = get_pay_row(conn, pay_id)
            merged = pay_to_dict(row)
            merged.update({k: patch[k] for k in ("date", "amount", "status", "notes") if k in patch})
            fields = validate_payment(merged)
            conn.execute("UPDATE payments SET date=?, amount_cents=?, status=?, notes=? WHERE id=?",
                         (fields["date"], fields["amount_cents"], fields["status"], fields["notes"], pay_id))
        return json_response(pay_to_dict(get_pay_row(conn, pay_id)))
    finally:
        conn.close()


def h_pay_delete(ctx, pay_id):
    conn = connect()
    try:
        with Tx(conn):
            get_pay_row(conn, pay_id)
            conn.execute("DELETE FROM payments WHERE id = ?", (pay_id,))
        return json_response({"ok": True})
    finally:
        conn.close()


def h_pays_list(ctx):
    """Todos los pagos (para estadísticas y la vista de cobros)."""
    conn = connect()
    try:
        rows = conn.execute("SELECT * FROM payments ORDER BY date DESC, id DESC LIMIT 20000").fetchall()
        return json_response({"payments": [pay_to_dict(r) for r in rows]})
    finally:
        conn.close()


def h_photo_get(ctx, sub_id):
    conn = connect()
    try:
        row = conn.execute("SELECT mime, data, updated_at FROM photos WHERE subscription_id = ?",
                           (sub_id,)).fetchone()
    finally:
        conn.close()
    if row is None:
        raise ApiError(404, "Esta suscripción no tiene foto.")
    etag = '"%s"' % hashlib.sha1((row["updated_at"] + str(sub_id)).encode()).hexdigest()[:20]
    headers = {"ETag": etag, "Cache-Control": "private, max-age=86400"}
    if ctx.headers.get("if-none-match") == etag:
        return Response(304, b"", headers, ctype=row["mime"])
    return Response(200, bytes(row["data"]), headers, ctype=row["mime"])


def h_photo_put(ctx, sub_id):
    ctype = (ctx.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype not in ("image/jpeg", "image/png"):
        raise ApiError(415, "Formato de imagen no admitido: usa JPEG o PNG.")
    data = ctx.raw_body(MAX_PHOTO_BODY, "La foto es demasiado grande (máx. 700 KB; se reduce sola en el navegador).")
    info = sniff_image(data)
    if info is None:
        raise ApiError(415, "El archivo no es una imagen JPEG o PNG válida.")
    mime, w, h = info
    if not (16 <= w <= 6000 and 16 <= h <= 6000):
        raise ApiError(422, "Las dimensiones de la imagen no son válidas (entre 16 y 6000 px).")
    conn = connect()
    try:
        with Tx(conn):
            get_sub_row(conn, sub_id)
            conn.execute("INSERT OR REPLACE INTO photos(subscription_id, mime, data, width, height, updated_at) "
                         "VALUES(?,?,?,?,?,?)", (sub_id, mime, data, w, h, now_iso()))
        return json_response(sub_to_dict(get_sub_row(conn, sub_id)))
    finally:
        conn.close()


def h_photo_delete(ctx, sub_id):
    conn = connect()
    try:
        with Tx(conn):
            get_sub_row(conn, sub_id)
            conn.execute("DELETE FROM photos WHERE subscription_id = ?", (sub_id,))
        return json_response(sub_to_dict(get_sub_row(conn, sub_id)))
    finally:
        conn.close()


def h_export(ctx):
    with_photos = ctx.query.get("photos", "1") != "0"
    conn = connect()
    try:
        subs = [sub_to_dict(r) for r in conn.execute(SUB_SELECT + " ORDER BY s.id")]
        pays = [pay_to_dict(r) for r in conn.execute("SELECT * FROM payments ORDER BY id")]
        photos = []
        if with_photos:
            for r in conn.execute("SELECT subscription_id, mime, data, width, height FROM photos"):
                photos.append({"subscription_id": r["subscription_id"], "mime": r["mime"],
                               "width": r["width"], "height": r["height"],
                               "data_base64": base64.b64encode(bytes(r["data"])).decode("ascii")})
        payload = {"app": "gastos", "version": VERSION, "exported_at": now_iso(),
                   "schema": conn.execute("PRAGMA user_version").fetchone()[0],
                   "settings": get_settings(conn), "subscriptions": subs,
                   "payments": pays, "photos": photos}
    finally:
        conn.close()
    name = "gastos-%s.json" % datetime.date.today().strftime("%Y%m%d")
    return json_response(payload, headers={
        "Content-Disposition": 'attachment; filename="%s"' % name})


# --------------------------------------------------------------------------
# Enrutado
# --------------------------------------------------------------------------

ROUTES = [
    ("GET", r"/health", h_health),
    ("GET", r"/catalog", h_catalog),
    ("GET", r"/settings", h_settings_get),
    ("PUT", r"/settings", h_settings_put),
    ("GET", r"/export", h_export),
    ("GET", r"/subscriptions", h_subs_list),
    ("POST", r"/subscriptions", h_subs_create),
    ("GET", r"/subscriptions/(\d{1,9})", h_sub_get),
    ("PUT", r"/subscriptions/(\d{1,9})", h_sub_update),
    ("DELETE", r"/subscriptions/(\d{1,9})", h_sub_delete),
    ("POST", r"/subscriptions/(\d{1,9})/pay", h_sub_pay),
    ("POST", r"/subscriptions/(\d{1,9})/payments", h_pay_create),
    ("GET", r"/subscriptions/(\d{1,9})/photo", h_photo_get),
    ("PUT", r"/subscriptions/(\d{1,9})/photo", h_photo_put),
    ("DELETE", r"/subscriptions/(\d{1,9})/photo", h_photo_delete),
    ("GET", r"/payments", h_pays_list),
    ("PUT", r"/payments/(\d{1,9})", h_pay_update),
    ("DELETE", r"/payments/(\d{1,9})", h_pay_delete),
]
COMPILED = [(m, re.compile("^" + p + "$"), f) for m, p, f in ROUTES]


class Context(object):
    def __init__(self, headers, query, rfile):
        self.headers = headers
        self.query = query
        self.rfile = rfile

    def length(self):
        raw = self.headers.get("content-length", "") or "0"
        if not raw.isdigit():
            raise ApiError(400, "Cabecera Content-Length no válida.")
        return int(raw)

    def raw_body(self, limit, too_big_msg):
        n = self.length()
        if n > limit:
            self.drain(n)
            raise ApiError(413, too_big_msg)
        data = self.rfile.read(n) if n else b""
        if len(data) != n:
            raise ApiError(400, "El cuerpo de la petición está incompleto.")
        return data

    def drain(self, n):
        # Consumir el cuerpo evita que fcgiwrap devuelva un error mudo al responder antes de leerlo
        left = min(n, 4_000_000)
        while left > 0:
            chunk = self.rfile.read(min(65536, left))
            if not chunk:
                break
            left -= len(chunk)

    def json_body(self, optional=False):
        data = self.raw_body(MAX_JSON_BODY, "La petición es demasiado grande.")
        if not data.strip():
            if optional:
                return {}
            raise ApiError(400, "Falta el cuerpo JSON de la petición.")
        ctype = (self.headers.get("content-type") or "").lower()
        if "json" not in ctype:
            raise ApiError(415, "El cuerpo debe enviarse como application/json.")
        try:
            obj = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "El JSON recibido no es válido.")
        if not isinstance(obj, dict):
            raise ApiError(400, "Se esperaba un objeto JSON.")
        return obj


def parse_query(qs):
    from urllib.parse import parse_qs
    return {k: v[0] for k, v in parse_qs(qs or "", keep_blank_values=True).items()}


def dispatch(method, path, query_string, headers, rfile):
    """Punto de entrada común a CGI y al servidor de desarrollo."""
    try:
        method = method.upper()
        if method == "HEAD":
            method = "GET"
        path = path or "/"
        if path.startswith("/api"):
            path = path[4:] or "/"
        if len(path) > 200 or "\x00" in path or ".." in path.split("/"):
            raise ApiError(400, "Ruta no válida.")
        path = path.rstrip("/") or "/"
        matches = [(m, rx.match(path), f) for m, rx, f in COMPILED]
        found = [(m, mo, f) for m, mo, f in matches if mo]
        if not found:
            raise ApiError(404, "Ruta de la API no encontrada.")
        chosen = next(((mo, f) for m, mo, f in found if m == method), None)
        if chosen is None:
            raise ApiError(405, "Método %s no permitido en esta ruta." % method)
        if method not in ("GET",) and headers.get("x-requested-with") != CSRF_HEADER_VALUE:
            raise ApiError(403, "Petición rechazada: falta la cabecera de seguridad X-Requested-With.")
        mo, handler = chosen
        ctx = Context(headers, parse_query(query_string), rfile)
        args = [int(g) for g in mo.groups()]
        return handler(ctx, *args)
    except ApiError as exc:
        return error_response(exc.status, exc.message, exc.errors)
    except sqlite3.OperationalError as exc:
        log_error(traceback.format_exc())
        msg = "La base de datos está ocupada, inténtalo de nuevo." if "locked" in str(exc) \
            else "Error de base de datos: %s" % exc
        return error_response(503 if "locked" in str(exc) else 500, msg)
    except Exception as exc:  # cualquier fallo de código -> JSON claro, nunca un 502 mudo
        log_error(traceback.format_exc())
        return error_response(500, "Error interno de la API (%s: %s). Revisa %s/error.log."
                              % (type(exc).__name__, exc, DATA_DIR))


# --------------------------------------------------------------------------
# CGI
# --------------------------------------------------------------------------


def cgi_main():
    env = os.environ
    headers = {}
    for key, val in env.items():
        if key.startswith("HTTP_"):
            headers[key[5:].replace("_", "-").lower()] = val
    headers["content-type"] = env.get("CONTENT_TYPE", "")
    headers["content-length"] = env.get("CONTENT_LENGTH", "")
    path = env.get("PATH_INFO") or env.get("DOCUMENT_URI") or "/"
    resp = dispatch(env.get("REQUEST_METHOD", "GET"), path, env.get("QUERY_STRING", ""),
                    headers, sys.stdin.buffer)
    out = sys.stdout.buffer
    head = ["Status: %d %s" % (resp.status, STATUS_TEXT.get(resp.status, "OK"))]
    head += ["%s: %s" % (k, v) for k, v in resp.headers.items()]
    body = b"" if env.get("REQUEST_METHOD") == "HEAD" or resp.status in (204, 304) else resp.body
    head.append("Content-Length: %d" % len(body))
    out.write(("\r\n".join(head) + "\r\n\r\n").encode("utf-8"))
    out.write(body)
    out.flush()


if __name__ == "__main__":
    try:
        cgi_main()
    except Exception:  # último recurso
        text = traceback.format_exc()
        sys.stderr.write(text)
        msg = json.dumps({"error": "Fallo crítico de la API: %s" % text.strip().splitlines()[-1]}, ensure_ascii=False)
        sys.stdout.write("Status: 500 Internal Server Error\r\nContent-Type: application/json; charset=utf-8\r\n\r\n" + msg)
