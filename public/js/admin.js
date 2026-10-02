// 관리자 화면. CSP로 인라인 스크립트가 막혀 있으므로 모든 동작을 이 파일에서 연결한다.
// 로그인 정보는 이 탭(sessionStorage)에만 두고, 30분 동안 조작이 없으면 자동 로그아웃한다.
// 화면의 버튼 숨김은 편의일 뿐이고, 실제 권한은 서버(netlify/functions/admin.js)와 DB 함수가 막는다.
(function () {
  'use strict';
  var RC = window.RC, R = window.RCRules, esc = RC.esc, $ = RC.$, $$ = RC.$$;
  var IDLE_MS = 30 * 60 * 1000;
  var sb = null, me = null, postings = [], staffCache = null, board = null, idleTimer = null;
  var current = { tab: '', postingId: '', apps: [], q: '', stage: '' };

  // ------------------------------------------------------------ 공통
  function client() {
    return RC.config().then(function (cfg) {
      if (!sb) {
        sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: { storage: window.sessionStorage, storageKey: 'rc-admin', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
        });
      }
      return sb;
    });
  }
  function token() {
    return client().then(function (c) { return c.auth.getSession(); }).then(function (r) { return r.data.session ? r.data.session.access_token : ''; });
  }
  function api(body, raw) {
    return token().then(function (t) {
      if (!t) { logout('로그인 시간이 지났습니다. 다시 로그인해주세요.'); return { result: 'error', msg: '로그인이 필요합니다.' }; }
      return RC.api('/api/admin', { token: t, body: body, raw: raw });
    }).then(function (r) {
      if (!raw && r.status === 401) logout('로그인 시간이 지났습니다. 다시 로그인해주세요.');
      return r;
    });
  }
  function logout(msg) {
    clearTimeout(idleTimer);
    client().then(function (c) { return c.auth.signOut(); }).finally(function () {
      if (msg) sessionStorage.setItem('rc-admin-msg', msg);
      location.reload();
    });
  }
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { logout('30분 동안 사용하지 않아 자동 로그아웃되었습니다.'); }, IDLE_MS);
  }
  ['click', 'keydown', 'input'].forEach(function (ev) { document.addEventListener(ev, function () { if (me) resetIdle(); }, { passive: true }); });

  function toKstInput(iso) {
    if (!iso) return '';
    var d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
    return d.toISOString().slice(0, 16);
  }
  function errorBox(msg) { return '<div class="notice-box error">' + esc(msg) + '</div>'; }
  function modal(html) {
    var root = $('#modal-root');
    root.innerHTML = '<div class="modal-back" id="modal-back"><div class="modal" role="dialog" aria-modal="true">' +
      '<button type="button" class="btn small close no-print" id="modal-close">닫기</button>' + html + '</div></div>';
    $('#modal-close').addEventListener('click', closeModal);
    $('#modal-back').addEventListener('click', function (e) { if (e.target.id === 'modal-back') closeModal(); });
    return root;
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }
  function stageOptions(selected, withAll) {
    return (withAll ? '<option value="">전체 단계</option>' : '') + Object.keys(R.STAGES).map(function (k) {
      return '<option value="' + k + '"' + (k === selected ? ' selected' : '') + '>' + esc(R.STAGES[k]) + '</option>';
    }).join('');
  }
  var STATUS_LABEL = { draft: '초안(비공개)', published: '게시', closed: '마감', archived: '보관' };

  // ------------------------------------------------------------ 로그인
  function drawLogin() {
    var msg = sessionStorage.getItem('rc-admin-msg');
    sessionStorage.removeItem('rc-admin-msg');
    $('#login-root').innerHTML = '<div class="auth-box"><h1>관리자 로그인</h1>' +
      (msg ? '<div class="notice-box warn">' + esc(msg) + '</div>' : '') +
      '<form id="login-form" novalidate>' +
      '<div class="field"><label for="login-id">아이디 또는 이메일</label><input id="login-id" type="text" autocomplete="username" required maxlength="100"></div>' +
      '<div class="field"><label for="login-pw">비밀번호</label><input id="login-pw" type="password" autocomplete="current-password" required maxlength="72"></div>' +
      '<div id="login-captcha"></div><div id="login-msg" role="alert"></div>' +
      '<button class="btn primary" type="submit" id="login-btn">로그인</button></form>' +
      '<p class="hint">슈퍼관리자는 이메일 + 비밀번호 + 인증 앱 OTP, 일반 담당자는 아이디 + 비밀번호로 로그인합니다.</p></div>';
    var cap = null;
    RC.captcha($('#login-captcha'), 'admin_login').then(function (s) { cap = s; }).catch(function (e) { $('#login-msg').innerHTML = errorBox(e.message); });
    $('#login-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var id = $('#login-id').value.trim().toLowerCase();
      var pw = $('#login-pw').value;
      if (!id || !pw) { $('#login-msg').innerHTML = errorBox('아이디와 비밀번호를 입력해주세요.'); return; }
      if (cap && cap.enabled && !cap.token) { $('#login-msg').innerHTML = errorBox('로봇이 아님을 확인해주세요.'); return; }
      var btn = $('#login-btn'); btn.disabled = true;
      Promise.all([client(), RC.config()]).then(function (x) {
        var c = x[0], cfg = x[1];
        var email = id.indexOf('@') >= 0 ? id : id + '@' + cfg.staffEmailDomain;
        var opts = cap && cap.token ? { captchaToken: cap.token } : undefined;
        return c.auth.signInWithPassword({ email: email, password: pw, options: opts });
      }).then(function (r) {
        btn.disabled = false;
        if (r.error || !r.data.session) {
          if (cap) cap.reset();
          $('#login-msg').innerHTML = errorBox(/rate|many/i.test((r.error || {}).message || '') ? '시도가 너무 많습니다. 잠시 후 다시 시도해주세요.' : '아이디 또는 비밀번호가 맞지 않습니다.');
          return;
        }
        var role = (r.data.session.user.app_metadata || {}).role;
        if (role === 'admin') return drawMfa();
        if (role === 'staff') return start();
        logout('관리자 권한이 없는 계정입니다.');
      });
    });
  }

  // 슈퍼관리자 2단계 인증: 등록된 OTP가 있으면 코드 입력, 없으면 QR 등록
  function drawMfa() {
    client().then(function (c) {
      return c.auth.mfa.listFactors().then(function (r) {
        var totp = ((r.data && r.data.totp) || []).filter(function (f) { return f.status === 'verified'; })[0];
        if (totp) return drawOtp(c, totp.id, null);
        return c.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'dcci-recruit-' + Date.now() }).then(function (en) {
          if (en.error) { $('#login-root').innerHTML = errorBox('OTP 등록을 시작하지 못했습니다: ' + en.error.message); return; }
          drawOtp(c, en.data.id, en.data.totp);
        });
      });
    });
  }
  function drawOtp(c, factorId, enroll) {
    $('#login-root').innerHTML = '<div class="auth-box"><h1>2단계 인증</h1>' +
      (enroll ? '<p>처음 한 번 인증 앱(Google Authenticator 등)으로 아래 QR을 찍어 등록하세요.</p><img class="qr" alt="OTP 등록 QR 코드" src="' + esc(enroll.qr_code) + '">' +
        '<p class="small muted">QR을 찍을 수 없으면 비밀키 입력: <code>' + esc(enroll.secret) + '</code></p>' : '<p>인증 앱에 표시된 6자리 숫자를 입력하세요.</p>') +
      '<form id="otp-form" novalidate><div class="field"><label for="otp-code">OTP 6자리</label><input id="otp-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div>' +
      '<div id="otp-msg" role="alert"></div><div class="btn-row"><button class="btn primary" type="submit">확인</button><button class="btn" type="button" id="otp-cancel">취소</button></div></form></div>';
    $('#otp-code').focus();
    $('#otp-cancel').addEventListener('click', function () { logout(); });
    $('#otp-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var code = $('#otp-code').value.trim();
      if (!/^\d{6}$/.test(code)) { $('#otp-msg').innerHTML = errorBox('6자리 숫자를 입력하세요.'); return; }
      c.auth.mfa.challengeAndVerify({ factorId: factorId, code: code }).then(function (r) {
        if (r.error) { $('#otp-msg').innerHTML = errorBox('OTP가 맞지 않습니다. 앱의 현재 숫자를 입력하세요.'); return; }
        start();
      });
    });
  }

  // ------------------------------------------------------------ 시작·탭
  function start() {
    api({ action: 'me' }).then(function (r) {
      if (r.result !== 'success') { logout(r.msg); return; }
      me = r;
      resetIdle();
      $('#login-root').innerHTML = '';
      $('#app-root').classList.remove('hidden');
      $('#admin-user').innerHTML = '<span>' + esc(me.email) + ' · <strong>' + (me.super ? '슈퍼관리자' : '일반 담당자') + '</strong></span> <button class="btn small" type="button" id="logout-btn">로그아웃</button>';
      $('#logout-btn').addEventListener('click', function () { logout(); });
      var tabs = me.super ? [['postings', '채용공고'], ['apps', '지원자'], ['board', '공지·FAQ'], ['staff', '담당자 계정'], ['settings', '설정'], ['logs', '기록·파기']] : [['apps', '지원자']];
      $('#tabs').innerHTML = tabs.map(function (t) { return '<button type="button" role="tab" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('');
      $('#tabs').addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (b) openTab(b.getAttribute('data-tab')); });
      openTab(tabs[0][0]);
    });
  }
  function openTab(tab) {
    current.tab = tab;
    $$('#tabs [data-tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === tab)); });
    var body = $('#tab-body');
    body.innerHTML = '<p class="muted">불러오는 중…</p>';
    ({ postings: tabPostings, apps: tabApps, board: tabBoard, staff: tabStaff, settings: tabSettings, logs: tabLogs })[tab](body);
  }
  function loadPostings() {
    return api({ action: 'postings' }).then(function (r) { postings = r.result === 'success' ? r.items : []; return r; });
  }
  function loadStaff() {
    return api({ action: 'staff_list' }).then(function (r) { staffCache = r.result === 'success' ? r.items : []; return staffCache; });
  }

  // ------------------------------------------------------------ 채용공고
  function tabPostings(body) {
    loadPostings().then(function (r) {
      if (r.result !== 'success') { body.innerHTML = errorBox(r.msg); return; }
      body.innerHTML = '<div class="section-head"><h2>채용공고</h2><button class="btn primary" type="button" id="new-posting">+ 새 공고 등록</button></div>' +
        (postings.length ? '<div class="table-wrap"><table><thead><tr><th>번호</th><th>공고명</th><th>상태</th><th>접수기간</th><th>제출/작성중</th><th>보관기한</th><th>관리</th></tr></thead><tbody>' +
          postings.map(function (p) {
            return '<tr><td>' + esc(p.seq_no) + '</td><td>' + esc(p.title) + '</td><td>' + esc(STATUS_LABEL[p.status]) + '<br>' + RC.badge(p.state) + '</td>' +
              '<td class="small">' + esc(RC.period(p)) + '</td><td>' + esc(p.submitted) + ' / ' + esc(p.drafts) + '</td>' +
              '<td>' + (p.retention_until ? esc(p.retention_until) : '<span class="review-needed">미정</span>') + '</td><td>' +
              '<button class="btn small" data-edit="' + esc(p.id) + '">수정</button>' +
              (p.status !== 'published' ? '<button class="btn small" data-status="published" data-id="' + esc(p.id) + '">게시</button>' : '') +
              (p.status === 'published' ? '<button class="btn small" data-status="closed" data-id="' + esc(p.id) + '">마감</button>' : '') +
              (p.status !== 'archived' ? '<button class="btn small" data-status="archived" data-id="' + esc(p.id) + '">보관</button>' : '') +
              (p.status !== 'draft' ? '<button class="btn small" data-status="draft" data-id="' + esc(p.id) + '">비공개</button>' : '') +
              '<button class="btn small" data-apps="' + esc(p.id) + '">지원자</button>' +
              '<a class="btn small" href="/posting.html?id=' + esc(p.id) + '" target="_blank" rel="noopener">보기</a>' +
              '<button class="btn small danger" data-del="' + esc(p.id) + '">삭제</button></td></tr>';
          }).join('') + '</tbody></table></div>' : '<div class="empty">등록된 공고가 없습니다. [새 공고 등록]으로 시작하세요.</div>') +
        '<p class="hint">게시: 홈페이지에 공개 · 마감: 접수 기간과 관계없이 즉시 접수 중단 · 보관: 홈페이지에서 숨김(지원서는 유지) · 삭제: 지원서가 없는 공고만</p>';
      $('#new-posting').addEventListener('click', function () { editPosting(null); });
      body.querySelector('table') && body.querySelector('table').addEventListener('click', function (e) {
        var t = e.target.closest('button');
        if (!t) return;
        if (t.dataset.edit) editPosting(t.dataset.edit);
        if (t.dataset.apps) { current.postingId = t.dataset.apps; openTab('apps'); }
        if (t.dataset.status) setStatus(t.dataset.id, t.dataset.status);
        if (t.dataset.del) {
          if (!confirm('이 공고를 삭제할까요? (지원서가 있는 공고는 삭제되지 않습니다)')) return;
          api({ action: 'delete_posting', id: t.dataset.del }).then(function (r) { if (r.result !== 'success') alert(r.msg); openTab('postings'); });
        }
      });
    });
  }
  function setStatus(id, status) {
    var p = postings.filter(function (x) { return x.id === id; })[0];
    var go = function () { api({ action: 'set_status', id: id, status: status }).then(function (r) { if (r.result !== 'success') alert(r.msg); openTab('postings'); }); };
    if (status !== 'published') {
      if (confirm('"' + p.title + '" 공고를 [' + STATUS_LABEL[status] + '] 상태로 바꿀까요?')) go();
      return;
    }
    api({ action: 'posting', id: id }).then(function (r) {
      if (r.result !== 'success') { alert(r.msg); return; }
      var warn = [];
      if (!String(r.item.consent_text || '').trim()) warn.push('- 개인정보 동의문이 비어 있어 지원자가 제출할 수 없습니다.');
      if (/검토 필요/.test(r.item.consent_text || '')) warn.push('- 동의문에 [검토 필요] 표시가 남아 있습니다.');
      if (!r.item.retention_until) warn.push('- 보관기한이 비어 있어 지원서가 자동 파기되지 않습니다.');
      if (confirm('공고를 홈페이지에 게시할까요?' + (warn.length ? '\n\n확인 필요:\n' + warn.join('\n') : ''))) go();
    });
  }

  var DEFAULT_CONSENT = '[검토 필요 — 담당자가 내용을 확정한 뒤 이 줄을 지우세요]\n' +
    '1. 수집·이용 목적: 채용 전형 진행(본인 확인, 지원자격 확인, 전형 진행 및 결과 안내)\n' +
    '2. 수집 항목: 성명, 휴대폰 번호, 이메일, 이 공고에서 받는 항목(생년월일·주소·병역사항, 학력, 경력, 자격사항, 자기소개, 첨부서류)\n' +
    '3. 보유·이용 기간: [검토 필요: 기간 입력] 후 지체 없이 파기\n' +
    '4. 동의를 거부할 권리가 있으며, 동의하지 않으면 지원서를 제출할 수 없습니다.';

  function textArea(id, label, value, hint) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><textarea id="' + id + '" rows="4">' + esc(value || '') + '</textarea>' + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>';
  }
  function fieldRow(f) {
    return '<div class="row-sub" data-row="field"><input type="text" placeholder="분야명" maxlength="100" data-k="name" value="' + esc(f.name || '') + '">' +
      '<input type="text" placeholder="인원(예: 0명)" maxlength="30" data-k="headcount" value="' + esc(f.headcount || '') + '">' +
      '<textarea rows="2" placeholder="담당 업무" maxlength="3000" data-k="duties">' + esc(f.duties || '') + '</textarea>' +
      '<button type="button" class="btn small danger" data-rm>삭제</button></div>';
  }
  function essayRow(q) {
    return '<div class="row-essay" data-row="essay"><input type="text" placeholder="문항" maxlength="500" data-k="question" value="' + esc(q.question || '') + '">' +
      '<input type="number" min="100" max="5000" step="100" data-k="max_len" value="' + esc(q.max_len || 1000) + '" aria-label="최대 글자 수">' +
      '<label class="check"><input type="checkbox" data-k="required"' + (q.required ? ' checked' : '') + '>필수</label>' +
      '<button type="button" class="btn small danger" data-rm>삭제</button></div>';
  }
  function docRow(d) {
    return '<div class="row-doc" data-row="doc" data-key="' + esc(d.key || '') + '"><input type="text" placeholder="서류 이름(예: 이력서)" maxlength="50" data-k="label" value="' + esc(d.label || '') + '">' +
      '<label class="check"><input type="checkbox" data-k="required"' + (d.required ? ' checked' : '') + '>필수</label>' +
      '<button type="button" class="btn small danger" data-rm>삭제</button></div>';
  }
  function chk(id, label, on) { return '<label class="check"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '> ' + label + '</label>'; }

  function editPosting(id) {
    var load = id ? api({ action: 'posting', id: id }) : Promise.resolve({ result: 'success', item: null });
    Promise.all([load, loadStaff(), api({ action: 'board' })]).then(function (x) {
      var r = x[0], staff = x[1], settings = (x[2].settings || {});
      if (r.result !== 'success') { alert(r.msg); return; }
      var p = r.item || { fields: [{}], form_config: { basic: {}, education: { use: true }, career: { use: true }, certs: { use: true }, essays: [], attachments: [], max_file_mb: 10 } };
      var fc = p.form_config || {};
      var b = fc.basic || {};
      var assigned = p.staff || [];
      var body = $('#tab-body');
      body.innerHTML = '<h2>' + (id ? '공고 수정' : '새 공고 등록') + '</h2>' +
        (id && p.state !== 'draft' ? '<div class="notice-box warn">이미 게시된 공고입니다. 지원서 항목을 바꾸면 이미 작성된 지원서와 맞지 않을 수 있습니다.</div>' : '') +
        '<form id="posting-form" novalidate>' +
        '<section class="form-section"><h2>기본 정보</h2>' +
        '<div class="field"><label for="p-title">공고 제목<span class="req">*</span></label><input id="p-title" type="text" maxlength="200" value="' + esc(p.title || '') + '"></div>' +
        '<div class="grid2"><div class="field"><label for="p-type">고용형태</label><input id="p-type" type="text" maxlength="100" value="' + esc(p.employment_type || '') + '" placeholder="담당자가 확정한 내용만 입력"></div><div></div>' +
        '<div class="field"><label for="p-opens">접수 시작(한국 시간)<span class="req">*</span></label><input id="p-opens" type="datetime-local" value="' + esc(toKstInput(p.opens_at)) + '"></div>' +
        '<div class="field"><label for="p-closes">접수 마감(한국 시간)<span class="req">*</span></label><input id="p-closes" type="datetime-local" value="' + esc(toKstInput(p.closes_at)) + '"></div></div>' +
        '<div class="label">모집 분야·인원·담당 업무</div><div id="p-fields">' + (p.fields && p.fields.length ? p.fields : [{}]).map(fieldRow).join('') + '</div>' +
        '<button type="button" class="btn small" id="add-field">+ 분야 추가</button></section>' +
        '<section class="form-section"><h2>공고 내용</h2><p class="hint">입력한 항목만 홈페이지에 표시됩니다. 확정되지 않은 조건·제도는 쓰지 마세요.</p>' +
        textArea('p-qual', '지원자격', p.qualifications) + textArea('p-pref', '우대사항', p.preferences) + textArea('p-cond', '근무조건', p.conditions) +
        textArea('p-proc', '전형절차', p.process) + textArea('p-docs', '제출서류 안내', p.documents) + textArea('p-contact', '문의처', p.contact) + textArea('p-etc', '기타 안내', p.etc) + '</section>' +
        '<section class="form-section"><h2>지원서 항목</h2>' +
        '<p class="hint">성명·휴대폰·이메일은 항상 받습니다. 주민등록번호·사진·가족관계 등은 받지 않습니다.</p>' +
        '<div class="cfg-grid">' + chk('c-birth', '생년월일 받기', b.birth) + chk('c-address', '주소 받기', b.address) + chk('c-military', '병역사항 받기', b.military) + '</div><br>' +
        '<div class="cfg-grid">' +
        ['education', 'career', 'certs'].map(function (s) {
          var lab = { education: '학력', career: '경력', certs: '자격사항' }[s];
          var c = fc[s] || {};
          return '<div>' + chk('c-' + s + '-use', lab + ' 받기', c.use) + chk('c-' + s + '-req', lab + ' 필수', c.required) + '</div>';
        }).join('') + '</div>' +
        '<h3>자기소개 문항</h3><div id="p-essays">' + (fc.essays || []).map(essayRow).join('') + '</div><button type="button" class="btn small" id="add-essay">+ 문항 추가</button>' +
        '<h3>첨부서류</h3><div id="p-docs-list">' + (fc.attachments || []).map(docRow).join('') + '</div><button type="button" class="btn small" id="add-doc">+ 서류 추가</button>' +
        '<div class="field"><label for="c-maxmb">파일당 최대 크기(MB, 1~10)</label><input id="c-maxmb" type="number" min="1" max="10" value="' + esc(fc.max_file_mb || 10) + '"></div></section>' +
        '<section class="form-section"><h2>접수 규칙·개인정보</h2>' +
        chk('p-allow-edit', '마감 전 제출한 지원서 수정 허용', p.allow_edit) + chk('p-allow-cancel', '마감 전 제출 취소 허용', p.allow_cancel) +
        '<div class="field"><label for="p-consent">개인정보 수집·이용 동의문<span class="req">*</span></label><textarea id="p-consent" rows="8">' + esc(p.consent_text || '') + '</textarea>' +
        '<span class="hint">비어 있으면 지원자가 제출할 수 없습니다. <button type="button" class="btn small" id="fill-consent">기본 문안 넣기</button> (<span class="review-needed">검토 필요</span> 문안 — 확정 후 사용)</span></div>' +
        '<div class="field"><label for="p-retention">지원서 보관기한(이 날짜가 지나면 지원서·첨부파일 자동 파기)</label><input id="p-retention" type="date" value="' + esc(p.retention_until || '') + '">' +
        '<span class="hint"><span class="review-needed">검토 필요</span> 실제 업무 기준으로 확정한 날짜를 입력하세요. 비워 두면 자동 파기하지 않습니다.</span></div>' +
        textArea('p-result', '결과 공개 시 지원자에게 보일 안내(선택)', p.result_notice, '예: 다음 전형 일정 안내. 결과를 공개한 지원자에게만 보입니다.') + '</section>' +
        '<section class="form-section"><h2>담당자 지정</h2><p class="hint">지정된 일반 담당자만 이 공고의 지원서를 조회·다운로드할 수 있습니다.</p>' +
        (staff.length ? '<div class="cfg-grid">' + staff.map(function (s) { return '<label class="check"><input type="checkbox" data-staff="' + esc(s.id) + '"' + (assigned.indexOf(s.id) >= 0 ? ' checked' : '') + '> ' + esc(s.login_id) + '</label>'; }).join('') + '</div>'
          : '<p class="muted">일반 담당자 계정이 없습니다. [담당자 계정] 탭에서 만들 수 있습니다.</p>') + '</section>' +
        '<div id="p-msg" role="alert"></div>' +
        '<div class="action-bar"><div class="wrap"><button type="button" class="btn" id="p-cancel">목록으로</button><button type="submit" class="btn primary" id="p-save">저장</button></div></div>' +
        '</form>';
      var form = $('#posting-form');
      form.addEventListener('click', function (e) {
        var rm = e.target.closest('[data-rm]');
        if (rm) rm.parentElement.remove();
      });
      $('#add-field').addEventListener('click', function () { $('#p-fields').insertAdjacentHTML('beforeend', fieldRow({})); });
      $('#add-essay').addEventListener('click', function () { $('#p-essays').insertAdjacentHTML('beforeend', essayRow({ max_len: 1000, required: true })); });
      $('#add-doc').addEventListener('click', function () { $('#p-docs-list').insertAdjacentHTML('beforeend', docRow({ required: false })); });
      $('#fill-consent').addEventListener('click', function () {
        if ($('#p-consent').value.trim() && !confirm('입력된 동의문을 기본 문안으로 바꿀까요?')) return;
        $('#p-consent').value = settings.consent_default || DEFAULT_CONSENT;
      });
      $('#p-cancel').addEventListener('click', function () { openTab('postings'); });
      form.addEventListener('submit', function (ev) { ev.preventDefault(); savePosting(id, form); });
    });
  }

  function savePosting(id, form) {
    var used = {};
    var docs = $$('[data-row="doc"]', form).map(function (row) {
      return { key: row.getAttribute('data-key'), label: row.querySelector('[data-k=label]').value.trim(), required: row.querySelector('[data-k=required]').checked };
    }).filter(function (d) { return d.label; });
    docs.forEach(function (d) { if (d.key) used[d.key] = true; });
    var n = 1;
    docs.forEach(function (d) { if (!d.key) { while (used['doc' + n]) n++; d.key = 'doc' + n; used[d.key] = true; } });
    var data = {
      title: $('#p-title').value, employment_type: $('#p-type').value, opens_at: $('#p-opens').value, closes_at: $('#p-closes').value,
      fields: $$('[data-row="field"]', form).map(function (row) {
        return { name: row.querySelector('[data-k=name]').value, headcount: row.querySelector('[data-k=headcount]').value, duties: row.querySelector('[data-k=duties]').value };
      }).filter(function (f) { return f.name.trim(); }),
      qualifications: $('#p-qual').value, preferences: $('#p-pref').value, conditions: $('#p-cond').value, process: $('#p-proc').value,
      documents: $('#p-docs').value, contact: $('#p-contact').value, etc: $('#p-etc').value,
      form_config: {
        basic: { birth: $('#c-birth').checked, address: $('#c-address').checked, military: $('#c-military').checked },
        education: { use: $('#c-education-use').checked, required: $('#c-education-req').checked },
        career: { use: $('#c-career-use').checked, required: $('#c-career-req').checked },
        certs: { use: $('#c-certs-use').checked, required: $('#c-certs-req').checked },
        essays: $$('[data-row="essay"]', form).map(function (row) {
          return { question: row.querySelector('[data-k=question]').value, max_len: parseInt(row.querySelector('[data-k=max_len]').value, 10) || 1000, required: row.querySelector('[data-k=required]').checked };
        }).filter(function (q) { return q.question.trim(); }),
        attachments: docs, max_file_mb: parseInt($('#c-maxmb').value, 10) || 10
      },
      allow_edit: $('#p-allow-edit').checked, allow_cancel: $('#p-allow-cancel').checked,
      consent_text: $('#p-consent').value, retention_until: $('#p-retention').value, result_notice: $('#p-result').value
    };
    if (!data.title.trim()) { $('#p-msg').innerHTML = errorBox('공고 제목을 입력해주세요.'); return; }
    if (!data.opens_at || !data.closes_at) { $('#p-msg').innerHTML = errorBox('접수 시작·마감 일시를 입력해주세요.'); return; }
    var btn = $('#p-save'); btn.disabled = true;
    api({ action: 'save_posting', id: id, data: data }).then(function (r) {
      if (r.result !== 'success') { btn.disabled = false; $('#p-msg').innerHTML = errorBox(r.msg); return; }
      var ids = $$('[data-staff]', form).filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-staff'); });
      var staffBoxes = $$('[data-staff]', form).length;
      return (staffBoxes ? api({ action: 'set_posting_staff', posting_id: r.id, user_ids: ids }) : Promise.resolve({ result: 'success' })).then(function (s) {
        btn.disabled = false;
        if (s.result !== 'success') { $('#p-msg').innerHTML = errorBox('공고는 저장했지만 담당자 지정에 실패했습니다: ' + s.msg); return; }
        RC.toast('저장했습니다.' + (id ? '' : ' 새 공고는 [게시]를 눌러야 홈페이지에 보입니다.'));
        openTab('postings');
      });
    });
  }

  // ------------------------------------------------------------ 지원자
  function tabApps(body) {
    loadPostings().then(function (r) {
      if (r.result !== 'success') { body.innerHTML = errorBox(r.msg); return; }
      if (!postings.length) { body.innerHTML = '<div class="empty">' + (me.super ? '등록된 공고가 없습니다.' : '지정된 공고가 없습니다. 슈퍼관리자에게 공고 지정을 요청하세요.') + '</div>'; return; }
      if (!postings.some(function (p) { return p.id === current.postingId; })) current.postingId = postings[0].id;
      body.innerHTML = '<div class="toolbar">' +
        '<div class="field"><label for="a-posting">공고</label><select id="a-posting">' + postings.map(function (p) {
          return '<option value="' + esc(p.id) + '"' + (p.id === current.postingId ? ' selected' : '') + '>[' + esc(p.seq_no) + '] ' + esc(p.title) + ' (' + esc(p.submitted) + '명)</option>';
        }).join('') + '</select></div>' +
        '<div class="field"><label for="a-q">검색(이름·접수번호·이메일·전화)</label><input id="a-q" type="text" maxlength="100" value="' + esc(current.q) + '"></div>' +
        '<div class="field"><label for="a-stage">전형 단계</label><select id="a-stage">' + stageOptions(current.stage, true) + '</select></div>' +
        '<button class="btn primary" type="button" id="a-search">조회</button><button class="btn" type="button" id="a-csv">CSV 다운로드</button></div>' +
        (me.super ? '<div class="bulk"><span>선택한 지원자:</span><select id="b-stage" aria-label="변경할 단계">' + stageOptions('', false) + '</select>' +
          '<button class="btn small" type="button" id="b-set">단계 변경</button><button class="btn small" type="button" id="b-pub">결과 공개</button>' +
          '<button class="btn small" type="button" id="b-unpub">공개 취소</button><button class="btn small danger" type="button" id="b-del">선택 삭제</button></div>' : '') +
        '<div id="a-list"></div><p class="hint">조회·상세 보기·다운로드·첨부 열람은 관리자 기록에 남습니다. 내려받은 파일은 업무 후 지워주세요.</p>';
      var search = function () { current.postingId = $('#a-posting').value; current.q = $('#a-q').value.trim(); current.stage = $('#a-stage').value; loadApps(); };
      $('#a-search').addEventListener('click', search);
      $('#a-posting').addEventListener('change', search);
      $('#a-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') search(); });
      $('#a-csv').addEventListener('click', downloadCsv);
      if (me.super) {
        $('#b-set').addEventListener('click', function () { bulk('set_stage'); });
        $('#b-pub').addEventListener('click', function () { bulk('publish', true); });
        $('#b-unpub').addEventListener('click', function () { bulk('publish', false); });
        $('#b-del').addEventListener('click', function () { bulk('delete'); });
      }
      loadApps();
    });
  }
  function loadApps() {
    var el = $('#a-list');
    el.innerHTML = '<p class="muted">불러오는 중…</p>';
    api({ action: 'applications', posting_id: current.postingId, q: current.q, stage: current.stage }).then(function (r) {
      if (r.result !== 'success') { el.innerHTML = errorBox(r.msg); return; }
      current.apps = r.items;
      if (!r.items.length) { el.innerHTML = '<div class="empty">제출된 지원서가 없습니다.</div>'; return; }
      el.innerHTML = '<p class="small">' + r.items.length + '명</p><div class="table-wrap"><table><thead><tr>' +
        (me.super ? '<th><input type="checkbox" id="chk-all" aria-label="전체 선택"></th>' : '') +
        '<th>접수번호</th><th>성명</th><th>지원분야</th><th>휴대폰</th><th>이메일</th><th>제출일시</th><th>전형 단계</th><th>결과 공개</th><th>첨부</th><th></th></tr></thead><tbody>' +
        r.items.map(function (a) {
          return '<tr>' + (me.super ? '<td><input type="checkbox" data-chk="' + esc(a.id) + '" aria-label="선택"></td>' : '') +
            '<td>' + esc(a.receipt_no) + '</td><td>' + esc(a.name) + '</td><td>' + esc(a.field || '-') + '</td><td>' + esc(a.phone) + '</td><td>' + esc(a.email) + '</td>' +
            '<td class="small">' + esc(RC.kst(a.submitted_at)) + '</td><td>' + esc(R.STAGES[a.stage] || '-') + '</td>' +
            '<td class="small">' + (a.published_at ? esc(R.STAGES[a.published_stage]) + '<br>' + esc(RC.kst(a.published_at)) : '<span class="muted">비공개</span>') + '</td>' +
            '<td>' + esc(a.files) + '</td><td><button class="btn small" data-detail="' + esc(a.id) + '">상세</button></td></tr>';
        }).join('') + '</tbody></table></div>';
      if ($('#chk-all')) $('#chk-all').addEventListener('change', function () { var on = this.checked; $$('[data-chk]').forEach(function (c) { c.checked = on; }); });
      el.querySelector('table').addEventListener('click', function (e) { var b = e.target.closest('[data-detail]'); if (b) showDetail(b.getAttribute('data-detail')); });
    });
  }
  function selected() { return $$('[data-chk]').filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-chk'); }); }
  function bulk(kind, flag) {
    var ids = selected();
    if (!ids.length) { alert('지원자를 선택하세요.'); return; }
    var req, msg;
    if (kind === 'set_stage') { var st = $('#b-stage').value; req = { action: 'set_stage', ids: ids, stage: st }; msg = ids.length + '명의 전형 단계를 [' + R.STAGES[st] + ']로 바꿀까요?\n(지원자에게는 [결과 공개]를 해야 보입니다)'; }
    if (kind === 'publish') { req = { action: 'publish', ids: ids, publish: flag }; msg = flag ? ids.length + '명에게 현재 전형 단계를 결과로 공개할까요?\n지원자가 지원내역 확인에서 볼 수 있게 됩니다.' : ids.length + '명의 결과 공개를 취소할까요?'; }
    if (kind === 'delete') {
      if (ids.length > 100) { alert('한 번에 100건까지 삭제할 수 있습니다.'); return; }
      req = { action: 'delete_applications', ids: ids };
      msg = ids.length + '건의 지원서와 첨부파일을 삭제할까요?\n\n삭제하면 되돌릴 수 없습니다.';
    }
    if (!confirm(msg)) return;
    if (kind === 'delete' && prompt('삭제하려면 "삭제"라고 입력하세요.') !== '삭제') return;
    api(req).then(function (r) {
      if (r.result !== 'success') { alert(r.msg); return; }
      RC.toast(kind === 'delete' ? r.deleted + '건 삭제했습니다.' + (r.files_failed ? ' (파일 ' + r.files_failed + '개는 다음 자동 실행 때 다시 삭제)' : '') : r.updated + '건 처리했습니다.');
      loadApps();
    });
  }
  function downloadCsv() {
    var p = postings.filter(function (x) { return x.id === current.postingId; })[0];
    if (!confirm('지원자 개인정보가 담긴 파일을 내려받습니다. 다운로드는 기록되며, 업무 후 파일을 지워주세요.')) return;
    api({ action: 'export_csv', posting_id: current.postingId, stage: current.stage }, true).then(function (res) {
      if (!res || !res.ok) {
        return (res ? res.json() : Promise.resolve({})).then(function (j) { alert(j.msg || '다운로드하지 못했습니다.'); });
      }
      return res.blob().then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '지원자_' + (p ? p.seq_no : '') + '_' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      });
    });
  }
  function itemsTable(title, cols, items) {
    if (!items || !items.length) return '';
    return '<h3>' + title + '</h3><div class="table-wrap"><table><thead><tr>' + cols.map(function (c) { return '<th>' + c[1] + '</th>'; }).join('') + '</tr></thead><tbody>' +
      items.map(function (it) { return '<tr>' + cols.map(function (c) { return '<td class="pre">' + esc(it[c[0]] || '') + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  function showDetail(id) {
    api({ action: 'application', id: id }).then(function (r) {
      if (r.result !== 'success') { alert(r.msg); return; }
      var a = r.item, d = a.data || {}, b = d.basic || {}, fc = a.posting.form_config || {};
      var rows = [['접수번호', a.receipt_no], ['성명', b.name], ['휴대폰', b.phone], ['이메일', a.email]];
      if (b.birth !== undefined) rows.push(['생년월일', b.birth]);
      if (b.address !== undefined) rows.push(['주소', b.address]);
      if (b.military !== undefined) rows.push(['병역사항', b.military]);
      if (d.field) rows.push(['지원분야', d.field]);
      rows.push(['제출일시', RC.kst(a.submitted_at)], ['최종 수정', RC.kst(a.updated_at)], ['개인정보 동의', RC.kst(a.consent_at)]);
      var docs = fc.attachments || [];
      var html = '<div class="print-area preview"><h2>입사지원서 — ' + esc(a.posting.title) + '</h2><dl>' + rows.map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1] || '-') + '</dd>'; }).join('') + '</dl>' +
        itemsTable('학력', [['school', '학교'], ['major', '전공'], ['degree', '학위·과정'], ['from', '입학'], ['to', '졸업'], ['state', '구분']], d.education) +
        itemsTable('경력', [['org', '기관·회사'], ['dept', '부서'], ['title', '직위·직무'], ['from', '시작'], ['to', '종료'], ['duties', '담당 업무']], d.career) +
        itemsTable('자격사항', [['name', '자격·시험'], ['issuer', '발급기관'], ['date', '취득일']], d.certs) +
        (fc.essays || []).map(function (q, i) { return '<h3>' + (i + 1) + '. ' + esc(q.question) + '</h3><div class="consent-text">' + esc((d.essays || [])[i] || '') + '</div>'; }).join('') +
        '<h3>첨부서류</h3>' + (a.attachments.length ? '<ul class="file-list">' + a.attachments.map(function (f) {
          var label = (docs.filter(function (x) { return x.key === f.doc_key; })[0] || {}).label || f.doc_key;
          return '<li><span>[' + esc(label) + '] ' + esc(f.name) + ' <span class="muted small">' + RC.fileSize(f.size) + '</span></span><button class="btn small no-print" data-file="' + esc(f.id) + '">열기</button></li>';
        }).join('') + '</ul>' : '<p class="muted">없음</p>') +
        '<h3 class="no-print">처리 기록</h3><ul class="small no-print">' + a.events.map(function (e) { return '<li>' + esc(RC.kst(e.at)) + ' ' + esc(eventLabel(e.event)) + '</li>'; }).join('') + '</ul></div>' +
        '<div class="no-print">' +
        (me.super ? '<section class="form-section"><h3>전형 관리</h3><div class="grid2"><div class="field"><label for="d-stage">전형 단계</label><select id="d-stage">' + stageOptions(a.stage, false) + '</select></div>' +
          '<div><p class="small">공개된 결과: ' + (a.published_at ? esc(R.STAGES[a.published_stage]) + ' (' + esc(RC.kst(a.published_at)) + ')' : '없음') + '</p></div></div>' +
          '<div class="field"><label for="d-memo">내부 메모(지원자에게 보이지 않음)</label><textarea id="d-memo" maxlength="2000">' + esc(a.memo || '') + '</textarea></div>' +
          '<div class="btn-row"><button class="btn primary" type="button" id="d-save">저장</button><button class="btn" type="button" id="d-pub">현재 단계로 결과 공개</button></div></section>' : '') +
        '<div class="btn-row"><button class="btn" type="button" id="d-print">인쇄 / PDF 저장</button></div></div>';
      modal(html);
      $('#modal-back').addEventListener('click', function (e) {
        var f = e.target.closest('[data-file]');
        if (!f) return;
        var w = window.open('', '_blank');
        api({ action: 'file_url', attachment_id: f.getAttribute('data-file') }).then(function (x) {
          if (x.result !== 'success') { if (w) w.close(); alert(x.msg); return; }
          if (w) { w.opener = null; w.location.href = x.url; } else location.href = x.url;
        });
      });
      $('#d-print').addEventListener('click', function () { window.print(); });
      if (me.super) {
        $('#d-save').addEventListener('click', function () {
          api({ action: 'set_stage', ids: [a.id], stage: $('#d-stage').value, memo: $('#d-memo').value }).then(function (x) {
            if (x.result !== 'success') { alert(x.msg); return; }
            RC.toast('저장했습니다.'); loadApps();
          });
        });
        $('#d-pub').addEventListener('click', function () {
          if (!confirm('저장된 현재 전형 단계를 지원자에게 공개할까요? (단계를 바꿨다면 먼저 [저장])')) return;
          api({ action: 'publish', ids: [a.id], publish: true }).then(function (x) {
            if (x.result !== 'success') { alert(x.msg); return; }
            RC.toast('공개했습니다.'); closeModal(); loadApps();
          });
        });
      }
    });
  }

  function eventLabel(ev) {
    var parts = String(ev).split(':');
    var map = { submitted: '최종 제출', resubmitted: '수정 내용 제출', cancelled: '제출 취소(취소된 접수번호 ' + (parts[1] || '') + ')', file_added: '첨부 추가(' + (parts[1] || '') + ')', file_removed: '첨부 삭제(' + (parts[1] || '') + ')' };
    return map[parts[0]] || ev;
  }

  // ------------------------------------------------------------ 공지·FAQ
  function tabBoard(body) {
    api({ action: 'board' }).then(function (r) {
      if (r.result !== 'success') { body.innerHTML = errorBox(r.msg); return; }
      board = r;
      body.innerHTML = '<div id="board-wrap"><div class="section-head"><h2>공지사항</h2><button class="btn primary" type="button" id="new-notice">+ 공지 작성</button></div>' +
        (r.notices.length ? '<div class="table-wrap"><table><thead><tr><th>제목</th><th>공개</th><th>상단 고정</th><th>작성일</th><th></th></tr></thead><tbody>' +
          r.notices.map(function (n) {
            return '<tr><td>' + esc(n.title) + '</td><td>' + (n.published ? '공개' : '비공개') + '</td><td>' + (n.pinned ? '예' : '') + '</td><td class="small">' + esc(RC.kst(n.created_at)) + '</td>' +
              '<td><button class="btn small" data-en="' + esc(n.id) + '">수정</button><button class="btn small danger" data-dn="' + esc(n.id) + '">삭제</button></td></tr>';
          }).join('') + '</tbody></table></div>' : '<div class="empty">공지사항이 없습니다.</div>') +
        '<div class="section-head mt-32"><h2>자주 묻는 질문</h2><button class="btn primary" type="button" id="new-faq">+ 질문 작성</button></div>' +
        (r.faqs.length ? '<div class="table-wrap"><table><thead><tr><th>순서</th><th>질문</th><th>공개</th><th></th></tr></thead><tbody>' +
          r.faqs.map(function (f) {
            return '<tr><td>' + esc(f.sort) + '</td><td>' + esc(f.question) + '</td><td>' + (f.published ? '공개' : '비공개') + '</td>' +
              '<td><button class="btn small" data-ef="' + esc(f.id) + '">수정</button><button class="btn small danger" data-df="' + esc(f.id) + '">삭제</button></td></tr>';
          }).join('') + '</tbody></table></div>' : '<div class="empty">등록된 질문이 없습니다.</div>') + '</div>';
      $('#new-notice').addEventListener('click', function () { editNotice(null); });
      $('#new-faq').addEventListener('click', function () { editFaq(null); });
      $('#board-wrap').addEventListener('click', function (e) {
        var t = e.target.closest('button');
        if (!t) return;
        if (t.dataset.en) editNotice(board.notices.filter(function (n) { return n.id === t.dataset.en; })[0]);
        if (t.dataset.ef) editFaq(board.faqs.filter(function (n) { return n.id === t.dataset.ef; })[0]);
        if (t.dataset.dn || t.dataset.df) {
          if (!confirm('삭제할까요?')) return;
          api({ action: 'delete_board_item', kind: t.dataset.dn ? 'notice' : 'faq', id: t.dataset.dn || t.dataset.df }).then(function (x) { if (x.result !== 'success') alert(x.msg); openTab('board'); });
        }
      });
    });
  }
  function editNotice(n) {
    n = n || {};
    modal('<h2>' + (n.id ? '공지 수정' : '공지 작성') + '</h2><div class="field"><label for="n-title">제목</label><input id="n-title" type="text" maxlength="200" value="' + esc(n.title || '') + '"></div>' +
      '<div class="field"><label for="n-body">내용</label><textarea id="n-body" rows="10" maxlength="20000">' + esc(n.body || '') + '</textarea></div>' +
      chk('n-pub', '홈페이지에 공개', n.published) + chk('n-pin', '상단 고정', n.pinned) + '<div id="n-msg"></div><div class="btn-row"><button class="btn primary" type="button" id="n-save">저장</button></div>');
    $('#n-save').addEventListener('click', function () {
      api({ action: 'save_notice', id: n.id || null, title: $('#n-title').value, body: $('#n-body').value, published: $('#n-pub').checked, pinned: $('#n-pin').checked }).then(function (r) {
        if (r.result !== 'success') { $('#n-msg').innerHTML = errorBox(r.msg); return; }
        closeModal(); openTab('board');
      });
    });
  }
  function editFaq(f) {
    f = f || {};
    modal('<h2>' + (f.id ? '질문 수정' : '질문 작성') + '</h2><div class="field"><label for="f-q">질문</label><input id="f-q" type="text" maxlength="300" value="' + esc(f.question || '') + '"></div>' +
      '<div class="field"><label for="f-a">답변</label><textarea id="f-a" rows="8" maxlength="5000">' + esc(f.answer || '') + '</textarea></div>' +
      '<div class="field"><label for="f-sort">표시 순서(작은 숫자가 위)</label><input id="f-sort" type="number" value="' + esc(f.sort || 0) + '"></div>' +
      chk('f-pub', '홈페이지에 공개', f.published) + '<div id="f-msg"></div><div class="btn-row"><button class="btn primary" type="button" id="f-save">저장</button></div>');
    $('#f-save').addEventListener('click', function () {
      api({ action: 'save_faq', id: f.id || null, question: $('#f-q').value, answer: $('#f-a').value, sort: $('#f-sort').value, published: $('#f-pub').checked }).then(function (r) {
        if (r.result !== 'success') { $('#f-msg').innerHTML = errorBox(r.msg); return; }
        closeModal(); openTab('board');
      });
    });
  }

  // ------------------------------------------------------------ 담당자 계정
  function tabStaff(body) {
    Promise.all([loadStaff(), loadPostings()]).then(function (x) {
      var staff = x[0];
      var title = function (id) { var p = postings.filter(function (q) { return q.id === id; })[0]; return p ? '[' + p.seq_no + '] ' + p.title : id; };
      body.innerHTML = '<h2>일반 담당자 계정</h2>' +
        '<p class="hint">일반 담당자는 OTP 없이 아이디·비밀번호로 로그인하며, 지정된 공고의 지원서 조회·다운로드만 할 수 있습니다. 공용 계정은 만들지 말고 직원마다 따로 만드세요. 퇴사·이동 시 바로 삭제하세요.</p>' +
        (staff.length ? '<div class="table-wrap"><table><thead><tr><th>아이디</th><th>지정 공고</th><th>만든 날</th><th>마지막 로그인</th><th></th></tr></thead><tbody>' +
          staff.map(function (s) {
            return '<tr><td>' + esc(s.login_id) + '</td><td class="small">' + (s.postings.length ? s.postings.map(function (p) { return esc(title(p)); }).join('<br>') : '<span class="muted">없음</span>') + '</td>' +
              '<td class="small">' + esc(RC.kst(s.created_at)) + '</td><td class="small">' + esc(RC.kst(s.last_sign_in_at) || '-') + '</td>' +
              '<td><button class="btn small" data-pw="' + esc(s.id) + '">비밀번호 변경</button><button class="btn small danger" data-del="' + esc(s.id) + '" data-name="' + esc(s.login_id) + '">삭제</button></td></tr>';
          }).join('') + '</tbody></table></div>' : '<div class="empty">일반 담당자 계정이 없습니다.</div>') +
        '<section class="form-section mt-20"><h3>새 계정 만들기</h3><div class="grid2">' +
        '<div class="field"><label for="s-id">아이디(영문 소문자·숫자·.-_ 3~30자)</label><input id="s-id" type="text" maxlength="30" autocomplete="off"></div><div></div>' +
        '<div class="field"><label for="s-pw">비밀번호(12자 이상)</label><input id="s-pw" type="password" maxlength="72" autocomplete="new-password"></div>' +
        '<div class="field"><label for="s-pw2">비밀번호 확인</label><input id="s-pw2" type="password" maxlength="72" autocomplete="new-password"></div></div>' +
        '<div id="s-msg"></div><button class="btn primary" type="button" id="s-create">만들기</button>' +
        '<p class="hint">만든 뒤 [채용공고] → [수정] → 담당자 지정에서 공고를 지정하세요. 비밀번호는 직원에게 직접 전달하고 다른 곳에서 쓰지 않게 안내하세요.</p></section>';
      $('#s-create').addEventListener('click', function () {
        var pw = $('#s-pw').value;
        if (pw !== $('#s-pw2').value) { $('#s-msg').innerHTML = errorBox('비밀번호 확인이 일치하지 않습니다.'); return; }
        api({ action: 'staff_create', login_id: $('#s-id').value, password: pw }).then(function (r) {
          if (r.result !== 'success') { $('#s-msg').innerHTML = errorBox(r.msg); return; }
          RC.toast('계정을 만들었습니다.'); openTab('staff');
        });
      });
      var table = body.querySelector('table');
      if (table) table.addEventListener('click', function (e) {
        var t = e.target.closest('button');
        if (!t) return;
        if (t.dataset.pw) {
          var pw = prompt('새 비밀번호(12자 이상)를 입력하세요.');
          if (!pw) return;
          api({ action: 'staff_password', id: t.dataset.pw, password: pw }).then(function (r) { alert(r.result === 'success' ? '변경했습니다.' : r.msg); });
        }
        if (t.dataset.del) {
          if (!confirm('[' + t.dataset.name + '] 계정을 삭제할까요? 즉시 로그인할 수 없게 됩니다.')) return;
          api({ action: 'staff_delete', id: t.dataset.del }).then(function (r) { if (r.result !== 'success') alert(r.msg); openTab('staff'); });
        }
      });
    });
  }

  // ------------------------------------------------------------ 설정
  function tabSettings(body) {
    api({ action: 'board' }).then(function (r) {
      if (r.result !== 'success') { body.innerHTML = errorBox(r.msg); return; }
      var s = r.settings || {};
      var inp = function (id, label, hint) { return '<div class="field"><label for="st-' + id + '">' + label + '</label><input id="st-' + id + '" type="text" maxlength="200" value="' + esc(s[id] || '') + '">' + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>'; };
      var ta = function (id, label, hint, rows) { return '<div class="field"><label for="st-' + id + '">' + label + '</label><textarea id="st-' + id + '" rows="' + (rows || 6) + '">' + esc(s[id] || '') + '</textarea>' + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>'; };
      body.innerHTML = '<h2>사이트 설정</h2><p class="hint">비워 둔 항목은 홈페이지에 표시하지 않습니다. 기관의 실제 정보만 입력하세요.</p>' +
        '<section class="form-section"><h3>문의처(바닥글)</h3><div class="grid2">' + inp('contact_phone', '채용 문의 전화') + inp('contact_email', '채용 문의 이메일') + inp('contact_hours', '문의 가능 시간') + inp('address', '주소') + '</div></section>' +
        '<section class="form-section"><h3>안내 문구</h3>' +
        ta('process_steps', '전형 절차 안내(메인 화면)', '기관의 실제 전형 절차가 확정되면 입력하세요.') +
        ta('privacy_policy', '개인정보처리방침', '<span class="review-needed">검토 필요</span> 법무·개인정보 담당 검토를 거친 확정본을 입력하세요.', 12) +
        ta('consent_default', '공고 등록 시 넣을 기본 동의문', '<span class="review-needed">검토 필요</span> 비우면 화면에 내장된 검토용 문안을 씁니다.', 8) + '</section>' +
        '<section class="form-section"><h3>관리자 기록 보관</h3>' + inp('log_retention_days', '관리자 활동 기록 보관 일수(365 이상)', '<span class="review-needed">검토 필요</span> 비우면 기록을 삭제하지 않습니다. 업무 기준이 확정되면 입력하세요(예: 730 = 2년).') + '</section>' +
        '<div id="st-msg"></div><button class="btn primary" type="button" id="st-save">저장</button>';
      $('#st-save').addEventListener('click', function () {
        var data = {};
        ['contact_phone', 'contact_email', 'contact_hours', 'address', 'process_steps', 'privacy_policy', 'consent_default', 'log_retention_days'].forEach(function (k) { data[k] = $('#st-' + k).value.trim(); });
        api({ action: 'save_settings', data: data }).then(function (x) {
          if (x.result !== 'success') { $('#st-msg').innerHTML = errorBox(x.msg); return; }
          RC.toast('저장했습니다. 홈페이지 반영까지 최대 1분 걸릴 수 있습니다.');
        });
      });
    });
  }

  // ------------------------------------------------------------ 기록·파기
  var ACTION_LABEL = {
    view_list: '명단 조회', view_detail: '지원서 상세 조회', download_csv: 'CSV 다운로드', download_file: '첨부 열람', set_stage: '전형 단계 변경',
    publish_result: '결과 공개', unpublish_result: '결과 공개 취소', delete_applications: '지원서 삭제', posting_create: '공고 등록', posting_update: '공고 수정',
    posting_status: '공고 상태 변경', posting_delete: '공고 삭제', posting_staff: '담당자 지정', notice_save: '공지 저장', notice_delete: '공지 삭제',
    faq_save: 'FAQ 저장', faq_delete: 'FAQ 삭제', settings_save: '설정 변경', staff_create: '담당자 계정 생성', staff_delete: '담당자 계정 삭제',
    staff_password: '담당자 비밀번호 변경', purge_manual: '파기 수동 실행'
  };
  function tabLogs(body) {
    api({ action: 'logs', limit: 300 }).then(function (r) {
      if (r.result !== 'success') { body.innerHTML = errorBox(r.msg); return; }
      body.innerHTML = '<h2>자동 파기</h2><p class="hint">매일 03:10(한국 시간)에 보관기한이 지난 공고의 지원서·첨부파일을 함께 지웁니다. 보관기한이 비어 있는 공고는 지우지 않습니다.</p>' +
        '<p>삭제 대기 파일: <strong>' + esc(r.pending_files) + '개</strong> ' + (r.pending_files ? '<span class="badge danger">확인 필요</span>' : '') +
        ' <button class="btn small" type="button" id="purge-now">지금 실행</button></p>' +
        (r.purge.length ? '<div class="table-wrap"><table><thead><tr><th>실행 시각</th><th>방식</th><th>지원서 삭제</th><th>파일 삭제</th><th>파일 실패</th><th>남은 파일</th><th>기록 삭제</th><th>결과</th><th>비고</th></tr></thead><tbody>' +
          r.purge.map(function (p) {
            return '<tr><td class="small">' + esc(RC.kst(p.run_at)) + '</td><td>' + esc(p.trigger_type === 'manual' ? '수동' : '자동') + '</td><td>' + esc(p.applications_deleted) + '</td><td>' + esc(p.files_deleted) +
              '</td><td>' + esc(p.files_failed) + '</td><td>' + esc(p.files_remaining) + '</td><td>' + esc(p.logs_deleted) + '</td><td>' + (p.ok ? '정상' : '<span class="badge danger">확인 필요</span>') + '</td><td class="small">' + esc(p.detail || '') + '</td></tr>';
          }).join('') + '</tbody></table></div>' : '<div class="empty">아직 실행 기록이 없습니다.</div>') +
        '<h2 class="mt-32">관리자 활동 기록 (최근 300건)</h2>' +
        (r.access.length ? '<div class="table-wrap"><table><thead><tr><th>시각</th><th>계정</th><th>등급</th><th>활동</th><th>대상</th><th>내용</th></tr></thead><tbody>' +
          r.access.map(function (l) {
            return '<tr><td class="small">' + esc(RC.kst(l.created_at)) + '</td><td class="small">' + esc(l.user_email) + '</td><td>' + esc(l.user_role === 'admin' ? '슈퍼' : l.user_role === 'staff' ? '담당자' : l.user_role) + '</td>' +
              '<td>' + esc(ACTION_LABEL[l.action] || l.action) + '</td><td class="small">' + esc(l.target || '') + '</td><td class="small">' + esc(l.detail || '') + '</td></tr>';
          }).join('') + '</tbody></table></div>' : '<div class="empty">기록이 없습니다.</div>');
      $('#purge-now').addEventListener('click', function () {
        if (!confirm('보관기한이 지난 지원서·첨부파일을 지금 파기할까요? 되돌릴 수 없습니다.')) return;
        var btn = this; btn.disabled = true;
        api({ action: 'purge_now' }).then(function (x) {
          btn.disabled = false;
          if (x.result !== 'success') { alert(x.msg); return; }
          alert('완료: 지원서 ' + x.applications + '건, 파일 ' + x.files_deleted + '개 삭제' + (x.files_failed ? ', 실패 ' + x.files_failed + '개' : ''));
          openTab('logs');
        });
      });
    });
  }

  // ------------------------------------------------------------ 시작
  document.addEventListener('DOMContentLoaded', function () {
    client().then(function (c) {
      return c.auth.getSession().then(function (r) {
        var s = r.data.session;
        if (!s) return drawLogin();
        var role = (s.user.app_metadata || {}).role;
        if (role === 'staff') return start();
        if (role === 'admin') {
          return c.auth.mfa.getAuthenticatorAssuranceLevel().then(function (l) { if (l.data && l.data.currentLevel === 'aal2') start(); else drawMfa(); });
        }
        logout();
      });
    }).catch(function (e) { $('#login-root').innerHTML = errorBox('설정을 불러오지 못했습니다. ' + e.message); });
  });
})();
