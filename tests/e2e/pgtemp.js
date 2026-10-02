// 임시 PostgreSQL 실행(로컬 검증용, 운영 DB와 무관). tests/db/pg_temp.sh와 같은 방식.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findBin(name) {
  for (const d of ['/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/lib/postgresql/14/bin']) {
    if (fs.existsSync(path.join(d, name))) return path.join(d, name);
  }
  return name;
}

function startPg(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpg-'));
  const root = process.getuid && process.getuid() === 0;
  const run = (bin, args) => root ? execFileSync('runuser', ['-u', 'postgres', '--', findBin(bin), ...args], { stdio: 'pipe' }) : execFileSync(findBin(bin), args, { stdio: 'pipe' });
  if (root) { execFileSync('chown', ['postgres', dir]); fs.chmodSync(dir, 0o755); }
  run('initdb', ['-D', path.join(dir, 'data'), '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C.UTF-8']);
  run('pg_ctl', ['-D', path.join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, '-l', path.join(dir, 'log'), '-w', 'start']);
  const stop = () => {
    try { run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']); } catch (e) { /* 이미 종료 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, port, stop, conn: { host: '127.0.0.1', port, user: 'postgres', database: 'postgres' } };
}

module.exports = { startPg };
