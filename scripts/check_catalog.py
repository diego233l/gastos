#!/usr/bin/env python3
"""Valida catalog/catalog.txt: duplicados, ciclos, precios, URLs y colores."""
import os
import sys

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "app"))
import api  # noqa: E402

with open(api.CATALOG_PATH, encoding="utf-8") as fh:
    result = api.parse_catalog(fh.read())

cats = result["categories"]
nsvc = sum(len(c["services"]) for c in cats)
nplans = sum(len(s["plans"]) for c in cats for s in c["services"])
priced = sum(1 for c in cats for s in c["services"] for p in s["plans"] if p["price"] is not None)
print("%d categorías · %d servicios · %d planes (%d con precio)" % (len(cats), nsvc, nplans, priced))

# Un mismo nombre de servicio en dos categorías suele ser un descuido
seen = {}
for c in cats:
    for s in c["services"]:
        seen.setdefault(s["name"].lower(), []).append(c["name"])
dups = {k: v for k, v in seen.items() if len(v) > 1}
for k, v in dups.items():
    result["problems"].append("servicio «%s» repetido en varias categorías: %s" % (k, ", ".join(v)))

if result["problems"]:
    print("\nPROBLEMAS:")
    for p in result["problems"]:
        print(" -", p)
    sys.exit(1)
print("Catálogo correcto.")
