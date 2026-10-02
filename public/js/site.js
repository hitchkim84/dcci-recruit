// 메인·공고 상세·개인정보처리방침 화면
(function () {
  'use strict';
  var RC = window.RC, esc = RC.esc, $ = RC.$;

  function fieldsText(p) {
    var f = (p.fields || []).filter(function (x) { return x && x.name; });
    if (!f.length) return '';
    return f.map(function (x) { return x.name + (x.headcount ? ' (' + x.headcount + ')' : ''); }).join(', ');
  }

  function card(p) {
    var fields = fieldsText(p);
    var applyBtn = p.state === 'open'
      ? '<a class="btn primary" href="/apply.html?id=' + esc(p.id) + '">지원하기</a>'
      : '<span class="btn disabled" aria-disabled="true">' + (p.state === 'upcoming' ? '접수 예정' : '마감') + '</span>';
    return '<article class="card">' +
      '<div>' + RC.badge(p.state) + '</div>' +
      '<h3><a href="/posting.html?id=' + esc(p.id) + '">' + esc(p.title) + '</a></h3>' +
      '<dl class="meta">' +
      (fields ? '<dt>모집 분야</dt><dd>' + esc(fields) + '</dd>' : '') +
      (p.employment_type ? '<dt>고용형태</dt><dd>' + esc(p.employment_type) + '</dd>' : '') +
      '<dt>접수기간</dt><dd>' + esc(RC.period(p)) + '</dd>' +
      '</dl>' +
      '<div class="btn-row"><a class="btn" href="/posting.html?id=' + esc(p.id) + '">공고 보기</a>' + applyBtn + '</div>' +
      '</article>';
  }

  function renderIndex() {
    RC.api('/api/public?r=postings').then(function (r) {
      var openEl = $('#open-list'), closedEl = $('#closed-list');
      if (r.result !== 'success') {
        openEl.innerHTML = '<div class="notice-box error">' + esc(r.msg || '공고를 불러오지 못했습니다.') + '</div>';
        closedEl.innerHTML = '';
        return;
      }
      var items = r.items || [];
      var active = items.filter(function (p) { return p.state === 'open' || p.state === 'upcoming'; })
        .sort(function (a, b) { return new Date(a.closes_at) - new Date(b.closes_at); });
      var closed = items.filter(function (p) { return p.state === 'closed'; });
      if (r.now) $('#now-text').textContent = '기준 시각 ' + RC.kst(r.now) + ' (한국 시간)';
      openEl.innerHTML = active.length
        ? '<div class="cards">' + active.map(card).join('') + '</div>'
        : '<div class="empty"><strong>현재 진행 중인 채용공고가 없습니다.</strong><br>채용공고는 준비되는 대로 이곳에 게시됩니다.</div>';
      closedEl.innerHTML = closed.length
        ? '<div class="table-wrap"><table><thead><tr><th>공고명</th><th>모집 분야</th><th>접수기간</th><th>상태</th></tr></thead><tbody>' +
          closed.slice(0, 20).map(function (p) {
            return '<tr><td><a href="/posting.html?id=' + esc(p.id) + '">' + esc(p.title) + '</a></td><td>' + esc(fieldsText(p) || '-') + '</td><td>' + esc(RC.period(p)) + '</td><td>' + RC.badge('closed') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="empty">마감된 공고가 없습니다.</div>';
    });
    RC.board().then(function (b) {
      if (b.result !== 'success') {
        $('#notice-list').innerHTML = $('#faq-list').innerHTML = '<div class="notice-box error">불러오지 못했습니다.</div>';
        return;
      }
      $('#notice-list').innerHTML = b.notices.length ? b.notices.map(function (n) {
        return '<details class="fold"><summary><span>' + (n.pinned ? '<span class="badge">중요</span> ' : '') + esc(n.title) +
          '</span><span class="muted small">' + esc(RC.kstDate(n.created_at)) + '</span></summary><div class="fold-body">' + esc(n.body) + '</div></details>';
      }).join('') : '<div class="empty">등록된 공지사항이 없습니다.</div>';
      $('#faq-list').innerHTML = b.faqs.length ? b.faqs.map(function (f) {
        return '<details class="fold"><summary><span>Q. ' + esc(f.question) + '</span></summary><div class="fold-body">' + esc(f.answer) + '</div></details>';
      }).join('') : '<div class="empty">등록된 질문이 없습니다.</div>';
      // 기관의 실제 전형 절차는 담당자가 설정에 입력한 경우에만 보여준다
      if (b.settings && b.settings.process_steps) {
        $('#process-extra').innerHTML = '<div class="notice-box"><strong>전형 절차 안내</strong><div class="pre">' + esc(b.settings.process_steps) + '</div></div>';
      }
    });
  }

  // 담당자가 입력한 항목만 보여준다(빈 항목은 표시하지 않음 — 조건을 임의로 만들지 않기 위해)
  function renderPosting() {
    var root = $('#posting');
    var id = RC.param('id');
    if (!RC.isUuid(id)) { root.innerHTML = '<div class="wrap section"><div class="empty">공고를 찾을 수 없습니다. <a href="/">목록으로</a></div></div>'; return; }
    RC.api('/api/public?r=posting&id=' + encodeURIComponent(id)).then(function (r) {
      if (r.result !== 'success') { root.innerHTML = '<div class="wrap section"><div class="empty">' + esc(r.msg || '공고를 찾을 수 없습니다.') + ' <a href="/">목록으로</a></div></div>'; return; }
      var p = r.item;
      document.title = p.title + ' | 대구상공회의소 채용';
      var rows = [];
      var fields = (p.fields || []).filter(function (x) { return x && x.name; });
      if (p.employment_type) rows.push(['고용형태', esc(p.employment_type)]);
      rows.push(['접수기간', esc(RC.period(p)) + ' <span class="muted small">(한국 시간)</span>']);
      var fieldHtml = fields.length ? '<h2>모집 분야</h2><div class="table-wrap"><table><thead><tr><th>분야</th><th>인원</th><th>담당 업무</th></tr></thead><tbody>' +
        fields.map(function (f) { return '<tr><td>' + esc(f.name) + '</td><td>' + esc(f.headcount || '-') + '</td><td class="pre">' + esc(f.duties || '-') + '</td></tr>'; }).join('') +
        '</tbody></table></div><br>' : '';
      var sections = [['지원자격', p.qualifications], ['우대사항', p.preferences], ['근무조건', p.conditions], ['전형절차', p.process],
        ['제출서류', p.documents], ['기타 안내', p.etc], ['문의처', p.contact]];
      sections.forEach(function (s) { if (s[1] && String(s[1]).trim()) rows.push([s[0], esc(s[1])]); });
      var applyBtn = p.state === 'open' ? '<a class="btn primary" href="/apply.html?id=' + esc(p.id) + '">지원서 작성하기</a>'
        : '<span class="btn disabled" aria-disabled="true">' + (p.state === 'upcoming' ? '접수 예정' : '접수 마감') + '</span>';
      root.innerHTML =
        '<div class="detail-head"><div class="wrap">' + RC.badge(p.state) + '<h1>' + esc(p.title) + '</h1>' +
        '<p class="muted">접수기간 ' + esc(RC.period(p)) + '</p></div></div>' +
        '<div class="wrap section">' + fieldHtml +
        '<dl class="kv">' + rows.map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl>' +
        '<p class="muted small">접수 마감은 서버의 한국 시간 기준으로 처리됩니다. 마감 시각 이후에는 제출할 수 없으니 여유 있게 제출해주세요.</p>' +
        '</div>' +
        '<div class="apply-bar"><div class="wrap"><span>' + RC.badge(p.state) + ' 마감 ' + esc(RC.kst(p.closes_at)) + '</span><div class="btn-row"><a class="btn" href="/">목록</a>' + applyBtn + '</div></div></div>';
    });
  }

  function renderPrivacy() {
    RC.board().then(function (b) {
      var el = $('#privacy-body');
      var text = b.result === 'success' && b.settings ? b.settings.privacy_policy : '';
      el.innerHTML = text ? '<div class="pre">' + esc(text) + '</div>'
        : '<div class="notice-box warn"><span class="review-needed">검토 필요</span> 개인정보처리방침이 아직 등록되지 않았습니다. 담당자가 확정된 내용을 관리자 화면 [설정]에 입력하면 이곳에 표시됩니다.</div>';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if ($('#open-list')) renderIndex();
    if ($('#posting')) renderPosting();
    if ($('#privacy-body')) renderPrivacy();
  });
})();
