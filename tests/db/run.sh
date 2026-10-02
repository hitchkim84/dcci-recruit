#!/usr/bin/env bash
# 실제 PostgreSQL 임시 DB에서 접근 차단·권한·마감·중복 제출·파기를 확인하는 테스트.
# 운영 DB가 아니라 이 스크립트가 만드는 임시 DB에서만 실행된다(끝나면 삭제).
# 필요: PostgreSQL 14 이상(initdb, pg_ctl, psql), npm install(pg 패키지). 실행: bash tests/db/run.sh
# 주의: Supabase를 흉내 낸 것(tests/db/supabase_stub.sql)이라 Supabase Auth·Storage 자체는 확인하지 못한다.
set -euo pipefail
cd "$(dirname "$0")/../.."
source tests/db/pg_temp.sh
trap pg_temp_stop EXIT
"${PSQL[@]}" -f tests/db/supabase_stub.sql -o /dev/null
# 두 번씩 실행해 '여러 번 실행해도 안전'한지도 확인한다
for f in sql/0*.sql sql/0*.sql; do "${PSQL[@]}" -f "$f" -o /dev/null; done
PGHOST=127.0.0.1 PGPORT="$PGPORT_T" PGUSER=postgres PGDATABASE=postgres node --test tests/db/db.test.js
"${PSQL[@]}" -f sql/check_security.sql
