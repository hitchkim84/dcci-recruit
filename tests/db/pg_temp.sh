#!/usr/bin/env bash
# 임시 PostgreSQL을 띄운다(운영 DB와 무관, 끝나면 삭제). source 해서 쓴다.
#   source tests/db/pg_temp.sh  →  PSQL 배열, PGTMP, PGPORT_T, pg_temp_stop 사용 가능
# root로 실행하면 postgres 사용자로 서버를 띄운다(PostgreSQL은 root 실행을 막음).
PGBIN="${PGBIN:-$(dirname "$(command -v initdb 2>/dev/null || echo /usr/lib/postgresql/16/bin/initdb)")}"
PGTMP="$(mktemp -d)"
PGPORT_T="${PGPORT_TEST:-55432}"
AS=()
if [ "$(id -u)" = "0" ]; then chown postgres "$PGTMP"; chmod 755 "$PGTMP"; AS=(runuser -u postgres --); fi
"${AS[@]}" "$PGBIN/initdb" -D "$PGTMP/data" -U postgres -A trust -E UTF8 --locale=C.UTF-8 >/dev/null
"${AS[@]}" "$PGBIN/pg_ctl" -D "$PGTMP/data" -o "-p $PGPORT_T -k $PGTMP -c listen_addresses=127.0.0.1 -c max_connections=100" -l "$PGTMP/log" -w start >/dev/null
pg_temp_stop() { "${AS[@]}" "$PGBIN/pg_ctl" -D "$PGTMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$PGTMP"; }
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -h "$PGTMP" -p "$PGPORT_T" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)
