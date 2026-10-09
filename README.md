# Gastos · mis suscripciones

Aplicación web para controlar tus suscripciones mensuales (Apple Music, Netflix, el móvil, seguros…):
cuánto gastas, cuándo se cobra cada una, avisos de cobros próximos o vencidos, historial de pagos, estadísticas y copia de seguridad.

* **Sin instalador ni servicio propio.** nginx sirve la interfaz estática y ejecuta la API por CGI (`fcgiwrap`).
  La API es **un único script Python** (`app/api.py`, solo biblioteca estándar) con SQLite.
* **Actualizar = un comando:** `sudo git -C /opt/apps/gastos pull`. El código se lee del repositorio en cada petición: entra en producción al instante, sin reiniciar nada.
* **Convive con otras webs:** sitio nginx propio en su puerto (8080), carpeta propia (`/opt/apps/gastos`) y datos propios (`/var/lib/gastos`). No toca ningún otro sitio ni `nginx.conf`.

```
app/api.py              API (CGI): rutas, validación, migraciones SQLite
app/server.py           servidor de desarrollo local (reutiliza api.dispatch)
catalog/catalog.txt     catálogo de servicios y planes (listas en cascada)
web/                    interfaz (HTML + CSS + JS propios, sin librerías)
nginx/gastos.conf       sitio nginx (se enlaza con un symlink)
scripts/backup.py       copia diaria con la API de backup de SQLite
scripts/check_catalog.py  valida el catálogo (duplicados, ciclos, precios…)
tests/                  pruebas de API y de interfaz (Playwright)
```

## Instalación inicial (Ubuntu)

```bash
# 1. Paquetes
sudo apt update
sudo apt install -y nginx fcgiwrap git openssl

# 2. fcgiwrap (ejecuta la API por CGI)
sudo systemctl enable --now fcgiwrap.socket
ls -l /run/fcgiwrap.socket            # debe existir (propietario www-data)

# 3. Código
sudo mkdir -p /opt/apps
sudo git clone https://github.com/diego233l/gastos.git /opt/apps/gastos

# 4. Datos (fuera del repositorio, propiedad de www-data)
sudo mkdir -p /var/lib/gastos
sudo chown www-data:www-data /var/lib/gastos
sudo chmod 750 /var/lib/gastos

# 5. Contraseña (usuario "diego"; cambia TU_CONTRASEÑA)
printf 'diego:%s\n' "$(openssl passwd -apr1 'TU_CONTRASEÑA')" | sudo tee /etc/nginx/gastos.htpasswd >/dev/null
sudo chown root:www-data /etc/nginx/gastos.htpasswd
sudo chmod 640 /etc/nginx/gastos.htpasswd

# 6. Sitio nginx (symlink al archivo del repositorio) y recarga
sudo ln -s /opt/apps/gastos/nginx/gastos.conf /etc/nginx/sites-enabled/gastos.conf
sudo nginx -t && sudo systemctl reload nginx

# 7. Copia de seguridad diaria (03:30, conserva las últimas 14)
echo '30 3 * * * www-data /usr/bin/python3 /opt/apps/gastos/scripts/backup.py >> /var/lib/gastos/backup.log 2>&1' | sudo tee /etc/cron.d/gastos >/dev/null
sudo chmod 644 /etc/cron.d/gastos

# 8. Cortafuegos (solo si usas ufw)
sudo ufw allow 8081/tcp
```

Abre `http://IP-DE-LA-MAQUINA:8081` e introduce usuario y contraseña.

> **Mientras el código no esté fusionado en `main`**, clona la rama de desarrollo:
> `sudo git clone -b claude/upbeat-bardeen-07y2ha https://github.com/diego233l/gastos.git /opt/apps/gastos`.
> Cuando la fusiones: `sudo git -C /opt/apps/gastos checkout main`.

### Convivir con la otra web de la máquina

* Esta app **solo** escucha en el puerto **8081** (`listen 8081;`, para no chocar con la web de coches que ya usa el 8080, sin `default_server` y sin `[::]`), así que no interfiere con tu otro sitio.
  Comprueba antes que el puerto está libre: `sudo ss -ltnp | grep :8081` (si sale algo, elige otro puerto, p. ej. 8082, en el `listen` de `nginx/gastos.conf` y en `ufw`).
  Si lo cambias, guarda el cambio como commit local para que `git pull` siga funcionando:
  `sudo git -C /opt/apps/gastos config pull.rebase false && sudo git -C /opt/apps/gastos -c user.name=srv -c user.email=srv@localhost commit -am "Puerto local"`.
* `fcgiwrap.socket` es un recurso compartido: si la otra web ya lo usa, no pasa nada, ambos pueden usarlo a la vez.
* La contraseña (`auth_basic`) está dentro del bloque `server` de esta app: no afecta a la otra web.
* Para usar un dominio en lugar de un puerto, cambia `server_name _;` por tu dominio y `listen 8081;` por `listen 80;`.

## Actualizar

```bash
sudo git -C /opt/apps/gastos pull
```

Nada más: sin reiniciar, sin scripts de despliegue. Los cambios de esquema de la base de datos se aplican solos (lista `MIGRATIONS` + `PRAGMA user_version`) en la primera petición posterior.
Solo si cambia `nginx/gastos.conf`: `sudo nginx -t && sudo systemctl reload nginx`.

## Copias de seguridad

* **Automática:** `scripts/backup.py` usa la API de backup de SQLite (copia consistente en caliente + `integrity_check`) y deja `/var/lib/gastos/backups/gastos-AAAAMMDD-HHMMSS.db`, conservando las últimas 14. Prueba manual: `sudo -u www-data python3 /opt/apps/gastos/scripts/backup.py`.
* **Desde la interfaz:** *Ajustes → Exportar copia (JSON)* descarga suscripciones, pagos y fotos.
* **Restaurar:** `sudo cp /var/lib/gastos/backups/gastos-XXXX.db /var/lib/gastos/gastos.db && sudo chown www-data:www-data /var/lib/gastos/gastos.db` (borra antes `gastos.db-wal` y `gastos.db-shm` si existen).

## Si algo no funciona

| Síntoma | Causa probable | Solución |
|---|---|---|
| La página carga pero sale «La API no responde…» (503 JSON) | `fcgiwrap` parado, o el código está roto tras un `git pull` | `systemctl status fcgiwrap.socket`; `python3 -m py_compile /opt/apps/gastos/app/api.py`; vuelve atrás con `git -C /opt/apps/gastos log -3` y `git -C /opt/apps/gastos checkout <commit-anterior>` |
| `502 Bad Gateway` o `/run/fcgiwrap.socket` no existe | fcgiwrap no instalado/activo | `sudo apt install fcgiwrap && sudo systemctl enable --now fcgiwrap.socket` |
| `403 Forbidden` en `/api/...` (texto plano) | `api.py` sin permiso de ejecución | `sudo chmod +x /opt/apps/gastos/app/api.py` (y `git config core.fileMode true`) |
| «No se puede abrir la base de datos…» | La carpeta de datos no es de `www-data` | `sudo chown -R www-data:www-data /var/lib/gastos` |
| «La base de datos está ocupada» (503) | Otra escritura en curso (copia, otra pestaña) | Reintenta; si persiste, mira `/var/lib/gastos/error.log` |
| `nginx -t` falla: `bind() to 0.0.0.0:8081 failed` | Puerto en uso | Cambia el puerto en `listen` (ver arriba) |
| `nginx -t` falla con `[::]:8081` | Máquina sin IPv6 | Esta config **no** usa `[::]`; no lo añadas |
| `nginx -t` falla: no encuentra `gastos.htpasswd` | Falta el paso 5 | Crea el archivo con `openssl passwd -apr1` |
| Pide contraseña una y otra vez | Clave mal escrita o permisos | Regenera el htpasswd (paso 5); debe ser legible por `www-data` (`chmod 640`, grupo `www-data`) |
| `/` da 404 | Falta `index.html` o ruta del `root` mal | `ls /opt/apps/gastos/web/index.html`; el `root` debe ser `/opt/apps/gastos/web` |
| Tras actualizar sigo viendo la versión vieja | Caché del navegador | Recarga forzada (Ctrl+F5); nginx ya envía `Cache-Control: no-cache` |
| «La foto es demasiado grande» | Más de 700 KB tras reducirla | Prueba con otra imagen (se reduce sola a 900 px) |
| No se crean copias | cron no cargó el archivo | `ls -l /etc/cron.d/gastos` (root, 644, acaba en salto de línea); `sudo -u www-data python3 /opt/apps/gastos/scripts/backup.py`; mira `/var/lib/gastos/backup.log` |
| `git pull` dice «dubious ownership» | Repo de otro usuario | Ejecuta siempre con `sudo` o `git config --global --add safe.directory /opt/apps/gastos` |
| `git pull` pide usuario/contraseña | Repositorio privado | Ver nota siguiente |
| No llego desde otro equipo | Cortafuegos | `sudo ufw allow 8081/tcp`; comprueba también el cortafuegos del proveedor |

Registros útiles: `/var/log/nginx/error.log`, `/var/lib/gastos/error.log` (trazas de errores de la API), `journalctl -u fcgiwrap`.

### Repositorios privados

Si `diego233l/gastos` es privado, `git pull` necesita credenciales **en el servidor**. Lo más limpio es una *deploy key* de solo lectura:

```bash
sudo ssh-keygen -t ed25519 -f /root/.ssh/gastos_deploy -N ""
sudo cat /root/.ssh/gastos_deploy.pub     # añádela en GitHub → repo → Settings → Deploy keys (sin permiso de escritura)
sudo git -C /opt/apps/gastos remote set-url origin git@github.com:diego233l/gastos.git
sudo git -C /opt/apps/gastos config core.sshCommand "ssh -i /root/.ssh/gastos_deploy -o IdentitiesOnly=yes"
```

(Alternativa: un *fine-grained token* con permiso `Contents: read` en la URL `https://TOKEN@github.com/diego233l/gastos.git`.)

## Qué hace

* **Portada:** gasto mensual/anual (tu parte), próximo cobro, **avisos** (cobros vencidos con botón «Registrar cobro», cobros que se acercan, pruebas gratuitas a punto de terminar, presupuesto superado), buscador, filtros y orden, tarjetas con miniatura.
* **Ficha:** foto con su proporción exacta, costes, método de pago, historial de pagos (programado/realizado), próximos cobros previstos, pausar / cancelar / reactivar / eliminar.
* **Formulario:** listas en cascada **categoría → servicio → plan** con «Otro…» para escribir a mano; al elegir se rellenan precio, periodicidad, nombre, color y web **solo si están vacíos** (nunca pisa lo que hayas escrito).
* **Compartidas:** indica entre cuántas personas se reparte y la app calcula tu parte.
* **Cobros:** calendario de los próximos 30–365 días agrupado por mes. **Estadísticas:** por categoría, método de pago, previsión a 12 meses y pagado.
* **Fotos:** se reducen en el navegador (máx. 900 px, JPEG); el servidor valida el tipo por los primeros bytes.

### Seguridad

CSP estricta, `X-Content-Type-Options`, `X-Frame-Options`; cabecera `X-Requested-With` obligatoria en POST/PUT/DELETE (anti-CSRF); `auth_basic`; límites de cuerpo en nginx (1 MB) y en el script (100 KB JSON / 700 KB foto); validación de tipos, rangos, fechas y longitudes en servidor con mensajes en español; consultas SQL parametrizadas; el front nunca usa `innerHTML` (todo con `textContent`); sin rutas a ficheros (las fotos viven en SQLite, no hay *path traversal*); ficheros ocultos denegados.

### ⚠️ Sobre el catálogo

`catalog/catalog.txt` está **escrito de memoria**: puede tener huecos, y los **precios son orientativos** (solo se incluyen cuando estoy razonablemente seguro; muchos planes van sin precio a propósito). Solo contiene servicios y planes reales de ese dominio (sin acabados inventados). Edítalo cuando quieras (formato en la cabecera del archivo; comentarios con `//`) y valida con `python3 scripts/check_catalog.py`. Siempre puedes usar «Otro…».

## Desarrollo local

```bash
python3 app/server.py            # http://127.0.0.1:8080  ·  datos en ./.devdata  ·  sin contraseña
python3 app/server.py 9000       # otro puerto
python3 scripts/check_catalog.py # valida el catálogo
```

Pruebas contra nginx + fcgiwrap reales (en este repositorio se ejecutan con una copia de `nginx/gastos.conf` adaptada, puerto 18080):

```bash
tests/nginx_env.sh start
python3 tests/test_api.py        # ~60 comprobaciones de la API (validación, CSRF, fotos, límites…)
node tests/ui.mjs                # recorrido de la interfaz con Playwright + Chromium, genera capturas
tests/nginx_env.sh stop
```
