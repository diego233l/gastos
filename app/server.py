#!/usr/bin/env python3
"""Servidor de desarrollo local: sirve web/ y reutiliza api.dispatch().

    python3 app/server.py [puerto]        (por defecto 8080, solo 127.0.0.1)
Los datos se guardan en ./.devdata (o en GASTOS_DATA_DIR si lo defines).
"""
import os
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.environ.setdefault("GASTOS_DATA_DIR", os.path.join(ROOT, ".devdata"))
sys.path.insert(0, HERE)

import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

import api  # noqa: E402

WEB = os.path.join(ROOT, "web")
SECURITY = {
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; "
                               "img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; "
                               "base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
}
mimetypes.add_type("text/javascript", ".js")


class Handler(BaseHTTPRequestHandler):
    server_version = "GastosDev/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[dev] " + (fmt % args) + "\n")

    def send(self, status, headers, body):
        self.send_response(status)
        for k, v in dict(SECURITY, **headers).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD" and status not in (204, 304):
            self.wfile.write(body)

    def handle_any(self):
        parts = urlsplit(self.path)
        path = unquote(parts.path)
        if path.startswith("/api/") or path == "/api":
            headers = {k.lower(): v for k, v in self.headers.items()}
            resp = api.dispatch(self.command, path, parts.query, headers, self.rfile)
            return self.send(resp.status, resp.headers, resp.body)
        if self.command not in ("GET", "HEAD"):
            return self.send(405, {"Content-Type": "text/plain; charset=utf-8"}, b"Metodo no permitido")
        self.static(path)

    def static(self, path):
        if "\x00" in path:
            return self.send(400, {"Content-Type": "text/plain"}, b"Ruta no valida")
        rel = path.lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(WEB, rel))
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if os.path.commonpath([full, os.path.realpath(WEB)]) != os.path.realpath(WEB) or not os.path.isfile(full):
            return self.send(404, {"Content-Type": "text/plain; charset=utf-8"}, b"No encontrado")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript") or ctype.endswith("json"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as fh:
            body = fh.read()
        self.send(200, {"Content-Type": ctype, "Cache-Control": "no-cache"}, body)

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = handle_any


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("Gastos (desarrollo) en http://127.0.0.1:%d  ·  datos en %s" % (port, api.DATA_DIR))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
