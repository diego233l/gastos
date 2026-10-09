#!/bin/bash
# Levanta nginx + fcgiwrap REALES con una copia de nginx/gastos.conf adaptada a rutas locales.
#   tests/nginx_env.sh start|stop     (puerto 18080, usuario demo / clave demo123)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T=/tmp/gastos-nginx-test
case "$1" in
start)
  rm -rf "$T"; mkdir -p "$T/data" "$T/logs"
  chmod 777 "$T/data"
  echo "demo:$(openssl passwd -apr1 demo123)" > "$T/htpasswd"
  sed -e "s#/opt/apps/gastos#$ROOT#g" -e "s#/var/lib/gastos#$T/data#g" \
      -e "s#/run/fcgiwrap.socket#$T/fcgi.sock#" -e "s#listen 8081#listen 18080#" \
      -e "s#include fastcgi_params#include /etc/nginx/fastcgi_params#" -e "s#/etc/nginx/gastos.htpasswd#$T/htpasswd#" "$ROOT/nginx/gastos.conf" > "$T/site.conf"
  cat > "$T/nginx.conf" <<CONF
pid $T/nginx.pid;
error_log $T/logs/error.log info;
events {}
http {
  include /etc/nginx/mime.types;
  access_log $T/logs/access.log;
  client_body_temp_path $T/body; fastcgi_temp_path $T/fcgi; proxy_temp_path $T/proxy; uwsgi_temp_path $T/uwsgi; scgi_temp_path $T/scgi;
  include $T/site.conf;
}
CONF
  fcgiwrap -s unix:$T/fcgi.sock >"$T/logs/fcgiwrap.log" 2>&1 &
  echo $! > "$T/fcgiwrap.pid"
  sleep 1; chmod 777 "$T/fcgi.sock"
  nginx -c "$T/nginx.conf" -e "$T/logs/error.log"
  echo "nginx en http://127.0.0.1:18080  (demo / demo123)  datos: $T/data" ;;
stop)
  [ -f $T/nginx.pid ] && kill "$(cat $T/nginx.pid)" 2>/dev/null || true
  [ -f $T/fcgiwrap.pid ] && kill "$(cat $T/fcgiwrap.pid)" 2>/dev/null || true ;;
esac
