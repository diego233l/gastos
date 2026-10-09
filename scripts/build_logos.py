#!/usr/bin/env python3
"""Genera web/logos/<servicio>.svg (icono de marca sobre fondo de su color) desde el paquete
npm `simple-icons` (licencia CC0; las marcas pertenecen a sus titulares).

    npm pack simple-icons && mkdir si && tar xzf simple-icons-*.tgz -C si
    python3 scripts/build_logos.py si/package

Solo hace falta ejecutarlo cuando cambie el catálogo; los SVG generados se versionan en el repo."""
import json
import os
import re
import sys
import unicodedata

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "app"))
import api  # noqa: E402

# Servicio del catálogo -> slug de simple-icons (cuando el nombre no coincide o es el mismo grupo)
ALIAS = {
    "YouTube Premium": "youtube", "PlayStation Plus": "playstation", "EA Play": "ea",
    "GeForce NOW": "nvidia", "Gemini": "googlegemini", "Kobo Plus": "rakutenkobo",
    "Apple Fitness+": "apple", "Fitbit Premium": "fitbit", "Uber One": "uber",
    "Glovo Prime": "glovo", "Zalando Plus": "zalando", "X (Twitter)": "x",
    "Meta Verified": "meta", "Santander Consumer Finance": "santander", "PayPal (Pagar en 3 plazos)": "paypal", "Apple One": "apple", "Google Workspace": "googleworkspace",
    "Microsoft Teams": "microsoftteams", "AppleCare+": "apple", "Apple Developer Program": "apple",
    "Revolut Business": "revolut", "Apple News+": "applenews", "Ryanair Prime": "ryanair",
    "Twitch Turbo": "twitch", "YouTube Membresías": "youtube", "Adobe Lightroom": "adobelightroom",
    "Adobe After Effects": "adobeaftereffects", "Adobe Express": "adobe", "Adobe Stock": "adobe",
    "Wolfram Alpha": "wolframalpha", "Akamai Linode": "linode", "Coinbase One": "coinbase",
    "WHOOP": "whoop", "Cloudflare": "cloudflare", "Bolt.new": "bolt", "Amazon Kids+": "amazon",
    "Suscríbete y ahorra (Amazon)": "amazon", "Prime Student": "amazonprime", "Microsoft 365 Copilot": "microsoftcopilot",
    "Peacock": "peacock", "Paramount+": "paramountplus", "Hulu": "hulu", "F1 TV": "f1",
    "NFL+": "nfl", "NBA League Pass": "nba", "Mistral Le Chat": "mistralai", "Character.AI": "characterdotai",
    "Leonardo.Ai": "leonardodotai", "Windsurf": "windsurf", "Real Madrid (socio)": "realmadrid",
    "FC Barcelona (soci)": "fcbarcelona", "Atlético de Madrid (abonado)": "atleticodemadrid",
    "Sevilla FC (abonado)": "sevillafc", "Valencia CF (abonado)": "valenciacf", "Athletic Club (socio)": "athleticclub",
    "Real Sociedad (socio)": "realsociedad", "Real Betis (abonado)": "realbetisbalompie", "Villarreal CF (abonado)": "villarrealcf", "Movistar Plus+": "movistar", "Crunchyroll": "crunchyroll",
}

# Coincidencias por título que serían un logo equivocado (p. ej. «R» es el lenguaje R)
EXCLUDE = {"R", "T-Mobile"}


def norm(text):
    t = unicodedata.normalize("NFKD", text.lower()).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "", t)


def luminance(hexcolor):
    r, g, b = (int(hexcolor[i:i + 2], 16) / 255 for i in (0, 2, 4))
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in (r, g, b)]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


# Bancos y prestamistas sin icono en simple-icons: se genera un logotipo-texto con el nombre
# sobre el color de la marca (es una aproximación, no el logotipo oficial).
WORDMARK_CATEGORY = "Préstamos e hipotecas"
SKIP_WORDS = {"banco", "banca", "caja", "servicios", "financiera"}


def wordmark(name, color):
    words = name.split(" (")[0].split()
    label = next((w for w in words if w.lower() not in SKIP_WORDS), words[0])
    size = max(9, min(22, int(52 / (0.58 * max(len(label), 1)))))
    fg = "#111111" if luminance(color.lstrip("#")) > 0.55 else "#ffffff"
    label = label.replace("&", "&amp;").replace("<", "&lt;")
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="256" height="256">'
            '<rect width="64" height="64" rx="14" fill="%s"/>'
            '<text x="32" y="%d" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-weight="700" '
            'font-size="%d" fill="%s">%s</text></svg>\n' % (color, 32 + size // 3, size, fg, label))


def main(pkg):
    data = json.load(open(os.path.join(pkg, "data", "simple-icons.json"), encoding="utf-8"))
    by_slug = {e["slug"]: e for e in data}
    by_title = {}
    for e in data:
        by_title.setdefault(norm(e["title"]), e)
        for a in (e.get("aliases") or {}).get("aka", []):
            by_title.setdefault(norm(a), e)
    out_dir = os.path.join(ROOT, "web", "logos")
    os.makedirs(out_dir, exist_ok=True)
    for old in os.listdir(out_dir):
        if old.endswith(".svg"):
            os.remove(os.path.join(out_dir, old))
    with open(os.path.join(ROOT, "catalog", "catalog.txt"), encoding="utf-8") as fh:
        cats = api.parse_catalog(fh.read())["categories"]
    made, missing, wordmarks = [], [], []
    for cat in cats:
        for svc in cat["services"]:
            if svc["name"] in EXCLUDE:
                missing.append(svc["name"])
                continue
            entry = by_slug.get(ALIAS.get(svc["name"], "")) or by_title.get(norm(svc["name"]))
            if not entry and cat["name"] == WORDMARK_CATEGORY and svc["color"]:
                slug = api.logo_slug(svc["name"])
                open(os.path.join(out_dir, slug + ".svg"), "w", encoding="utf-8").write(wordmark(svc["name"], svc["color"]))
                made.append(slug)
                wordmarks.append(svc["name"])
                continue
            if not entry:
                missing.append(svc["name"])
                continue
            svg = open(os.path.join(pkg, "icons", entry["slug"] + ".svg"), encoding="utf-8").read()
            m = re.search(r'<path d="([^"]+)"', svg)
            if not m:
                missing.append(svc["name"])
                continue
            bg = entry["hex"].upper()
            fg = "#111111" if luminance(bg) > 0.55 else "#ffffff"
            tile = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="256" height="256">'
                    '<rect width="64" height="64" rx="14" fill="#%s"/>'
                    '<g transform="translate(14 14) scale(1.4167)"><path fill="%s" d="%s"/></g></svg>\n' % (bg, fg, m.group(1)))
            slug = api.logo_slug(svc["name"])
            if slug not in made:
                open(os.path.join(out_dir, slug + ".svg"), "w", encoding="utf-8").write(tile)
                made.append(slug)
    with open(os.path.join(out_dir, "LICENSE.txt"), "w", encoding="utf-8") as fh:
        fh.write("Iconos de simple-icons (https://simpleicons.org), licencia CC0 1.0.\n"
                 "Las marcas y logotipos pertenecen a sus respectivos titulares.\n")
    print("%d de ellos son logotipos-texto (sin icono oficial): %s" % (len(wordmarks), ", ".join(wordmarks)))
    print("%d logos generados · %d servicios sin logo (usarán un monograma con su color)" % (len(made), len(missing)))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "si/package")
