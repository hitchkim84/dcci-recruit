// 지원내역 확인: 이메일 인증 후 본인 지원서만 공고별로 보여준다. 결과는 담당자가 공개한 것만 표시된다.
(function () {
  'use strict';
  var RC = window.RC, R = window.RCRules, esc = RC.esc, $ = RC.$;

  function render(root) {
    RC.applicantCall({ action: 'my_list' }).then(function (r) {
      if (r.status === 401) { RC.applicantLogout(); return; }
      if (r.result !== 'success') { root.innerHTML = '<div class="notice-box error">' + esc(r.msg) + '</div>'; return; }
      $('#my-user').innerHTML = '인증된 이메일: <strong>' + esc(r.email) + '</strong> <button type="button" class="btn small" id="logout-btn">인증 해제</button>';
      $('#logout-btn').addEventListener('click', RC.applicantLogout);
      if (!r.items.length) {
        root.innerHTML = '<div class="empty">이 이메일로 작성하거나 제출한 지원서가 없습니다.<br>다른 이메일로 지원했다면 인증 해제 후 그 이메일로 인증해주세요.<br><br><a class="btn" href="/#postings">채용공고 보기</a></div>';
        return;
      }
      root.innerHTML = '<div class="cards">' + r.items.map(function (it) {
        var submitted = it.status === 'submitted';
        var status = submitted ? '<span class="badge open">제출 완료</span>' : '<span class="badge upcoming">임시저장 (미제출)</span>';
        var result = '';
        if (submitted && it.result) {
          result = '<div class="notice-box ok"><strong>전형 결과: ' + esc(R.STAGES[it.result] || it.result) + '</strong>' +
            '<div class="small muted">공개일 ' + esc(RC.kst(it.result_published_at)) + '</div>' +
            (it.result_notice ? '<div class="pre small">' + esc(it.result_notice) + '</div>' : '') + '</div>';
        } else if (submitted) {
          result = '<p class="muted small">공개된 전형 결과가 없습니다.</p>';
        }
        var warn = !submitted ? (it.state === 'open'
          ? '<div class="notice-box warn small">아직 제출되지 않았습니다. 마감(' + esc(RC.kst(it.closes_at)) + ') 전에 [최종 제출]을 해야 접수됩니다.</div>'
          : '<div class="notice-box error small">접수가 마감되어 제출되지 않은 지원서입니다.</div>') : '';
        var actionLabel = submitted ? (it.can_edit ? '지원서 보기·수정' : '지원서 보기') : (it.state === 'open' ? '이어서 작성하기' : '내용 보기·삭제');
        return '<article class="card"><div>' + status + ' ' + RC.badge(it.state) + '</div>' +
          '<h3>' + esc(it.posting_title) + '</h3>' +
          '<dl class="meta">' +
          (submitted ? '<dt>접수번호</dt><dd><strong>' + esc(it.receipt_no) + '</strong></dd><dt>제출일시</dt><dd>' + esc(RC.kst(it.submitted_at)) + '</dd>'
            : '<dt>마지막 저장</dt><dd>' + esc(RC.kst(it.updated_at)) + '</dd>') +
          '<dt>접수 마감</dt><dd>' + esc(RC.kst(it.closes_at)) + '</dd></dl>' +
          warn + result +
          '<div class="btn-row"><a class="btn primary" href="/apply.html?id=' + esc(it.posting_id) + '">' + actionLabel + '</a></div></article>';
      }).join('') + '</div>';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var root = $('#my-root');
    RC.applicantAuth(root, '지원할 때 사용한 이메일로 인증하면 본인의 지원내역만 볼 수 있습니다.', function () { render(root); });
  });
})();
