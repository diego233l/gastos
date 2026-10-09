#!/usr/bin/python3
"""Copia de seguridad diaria con la API de backup de SQLite (consistente y en caliente).

Lanzada por /etc/cron.d/gastos como www-data. Conserva las últimas 14 copias.
Uso manual:  sudo -u www-data python3 /opt/apps/gastos/scripts/backup.py
"""
import datetime
import glob
import os
import sqlite3
import sys

DATA_DIR = os.environ.get("GASTOS_DATA_DIR", "/var/lib/gastos")
KEEP = 14


def main():
    src_path = os.path.join(DATA_DIR, "gastos.db")
    if not os.path.exists(src_path):
        print("No hay base de datos en %s: nada que copiar." % src_path)
        return 0
    dest_dir = os.path.join(DATA_DIR, "backups")
    os.makedirs(dest_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(dest_dir, "gastos-%s.db" % stamp)
    tmp = dest + ".tmp"
    src = sqlite3.connect("file:%s?mode=ro" % src_path, uri=True, timeout=30)
    dst = sqlite3.connect(tmp)
    try:
        src.backup(dst)
        ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        dst.close()
        src.close()
    if ok != "ok":
        os.remove(tmp)
        print("La copia no pasó la comprobación de integridad: %s" % ok, file=sys.stderr)
        return 1
    os.replace(tmp, dest)
    files = sorted(glob.glob(os.path.join(dest_dir, "gastos-*.db")))
    for old in files[:-KEEP]:
        os.remove(old)
    print("Copia creada: %s (se conservan %d)" % (dest, min(len(files), KEEP)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
