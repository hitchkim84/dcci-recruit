// 자동 파기: 보관기한이 지난 지원서·첨부파일, 하루 지난 미완료 업로드, (정해진 경우) 오래된 관리자 기록을 지운다.
// 1) DB 함수 purge_expired()가 행을 지우고 파일 경로를 삭제 대기 목록에 넣는다.
// 2) 여기서 Storage의 실제 파일을 지운다(실패분은 목록에 남아 다음 실행 때 다시 시도).
// 3) 결과를 purge_log에 남긴다(관리자 화면 '기록' 탭에서 확인).
const { serviceClient, removeFiles } = require('./core');

async function runPurge(triggerType) {
  const svc = serviceClient();
  if (!svc) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  let apps = 0, logs = 0, deleted = 0, failed = 0, okFlag = true, detail = '';
  try {
    const { data, error } = await svc.rpc('purge_expired');
    if (error) throw new Error('purge_expired: ' + error.message);
    apps = data.applications;
    logs = data.logs;
    detail = `미완료 업로드 ${data.stale_uploads}건 정리`;
    // 한 번에 최대 5,000개까지(함수 실행 시간 제한 대비). 남은 것은 다음 실행 때 지운다.
    for (let round = 0; round < 5; round++) {
      const { data: paths, error: e2 } = await svc.rpc('pending_files', { p_limit: 1000 });
      if (e2) throw new Error('pending_files: ' + e2.message);
      if (!paths || paths.length === 0) break;
      const r = await removeFiles(paths);
      deleted += r.deleted;
      failed += r.failed;
      if (r.deleted === 0) break;
    }
    if (failed > 0) okFlag = false;
  } catch (e) {
    okFlag = false;
    detail = (detail ? detail + ' / ' : '') + '오류: ' + e.message;
    console.error('purge failed:', e.message);
  }
  const { error: e3 } = await svc.rpc('record_purge', {
    p_trigger: triggerType, p_apps: apps, p_files_deleted: deleted, p_files_failed: failed, p_logs: logs, p_ok: okFlag, p_detail: detail
  });
  if (e3) console.error('record_purge failed:', e3.message);
  return { applications: apps, files_deleted: deleted, files_failed: failed, logs_deleted: logs, ok: okFlag, detail };
}

module.exports = { runPurge };
