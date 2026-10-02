// 입사지원서 작성 화면: 이메일 인증 → 작성·임시저장 → 미리보기 → 최종 제출 → 접수번호
// 접수 가능 여부·입력값·중복 제출은 서버와 DB가 최종 판단한다. 화면의 확인은 안내용이다.
(function () {
  'use strict';
  var RC = window.RC, R = window.RCRules, esc = RC.esc, $ = RC.$, $$ = RC.$$;
  var root, postingId, sb, email = '';
  var posting = null, app = null, mode = 'form', dirty = false, busy = false, autoTimer = null;

  var LABELS = {
    education: { title: '학력', add: '학력 추가', cols: [['school', '학교명', 'text'], ['major', '전공', 'text'], ['degree', '학위·과정', 'text'], ['from', '입학(년월)', 'month'], ['to', '졸업(년월)', 'month'], ['state', '졸업 구분(졸업·재학 등)', 'text']] },
    career: { title: '경력', add: '경력 추가', cols: [['org', '기관·회사명', 'text'], ['dept', '부서', 'text'], ['title', '직위·직무', 'text'], ['from', '시작(년월)', 'month'], ['to', '종료(년월, 재직 중이면 비움)', 'month'], ['duties', '담당 업무', 'textarea']] },
    certs: { title: '자격사항·어학', add: '자격 추가', cols: [['name', '자격·시험명', 'text'], ['issuer', '발급기관', 'text'], ['date', '취득일', 'date']] }
  };

  function cfg() { return (posting && posting.form_config) || {}; }
  function fields() { return ((posting && posting.fields) || []).filter(function (f) { return f && f.name; }); }
  function setMsg(html, kind) {
    var el = $('#form-msg');
    if (!el) return;
    el.innerHTML = html ? '<div class="notice-box ' + (kind || 'error') + '">' + html + '</div>' : '';
    if (html) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function call(body) {
    return RC.applicantCall(body).then(function (r) {
      if (r.status === 401) { RC.toast('인증 시간이 지났습니다. 다시 인증해주세요.'); setTimeout(function () { RC.applicantLogout(); }, 1200); }
      return r;
    });
  }

  // ---------------------------------------------------------------- 불러오기
  function load() {
    return call({ action: 'my_app', posting_id: postingId }).then(function (r) {
      if (r.result !== 'success') { root.innerHTML = '<div class="empty">' + esc(r.msg) + ' <a href="/">목록으로</a></div>'; return false; }
      posting = r.posting;
      app = r.application;
      email = r.email;
      $('#apply-title').textContent = posting.title;
      $('#apply-posting-meta').innerHTML = RC.badge(posting.state) + ' 접수기간 ' + esc(RC.period(posting)) + ' (한국 시간)';
      $('#apply-user').innerHTML = '인증된 이메일: <strong>' + esc(email) + '</strong> <button type="button" class="btn small" id="logout-btn">인증 해제</button>';
      $('#logout-btn').addEventListener('click', function () {
        if (dirty && !confirm('저장하지 않은 내용이 있습니다. 인증을 해제할까요?')) return;
        dirty = false;
        RC.applicantLogout();
      });
      return true;
    });
  }

  function route() {
    if (app && app.status === 'submitted') return renderStatus();
    if (posting.state !== 'open') {
      if (!app) {
        root.innerHTML = '<div class="empty">' + (posting.state === 'upcoming' ? '아직 접수 기간이 아닙니다. 접수 시작: ' + esc(RC.kst(posting.opens_at)) : '접수가 마감된 공고입니다.') + '<br><a href="/posting.html?id=' + esc(posting.id) + '">공고 보기</a></div>';
        return;
      }
      return renderClosedDraft();
    }
    renderForm(false);
  }

  // ---------------------------------------------------------------- 제출 상태
  function renderStatus(justSubmitted) {
    mode = 'status';
    var a = app;
    var html = '<div class="status-card ok" role="status">' +
      '<p><span class="badge open">제출 완료</span></p>' +
      '<p class="muted">접수번호</p><p class="receipt">' + esc(a.receipt_no) + '</p>' +
      '<p>제출일시 ' + esc(RC.kst(a.submitted_at)) + (a.updated_at && a.updated_at !== a.submitted_at ? ' · 최종 수정 ' + esc(RC.kst(a.updated_at)) : '') + '</p>' +
      (justSubmitted ? '<p><strong>지원서가 정상적으로 접수되었습니다.</strong> 접수번호를 기록해 두세요. 지원내역은 [지원내역 확인]에서 같은 이메일로 인증해 다시 볼 수 있습니다.</p>' : '') +
      '</div>' +
      '<div class="btn-row no-print">' +
      '<button class="btn" type="button" id="view-btn">제출한 지원서 보기</button>' +
      (a.can_edit ? '<button class="btn primary" type="button" id="edit-btn">수정하기</button>' : '') +
      (a.can_cancel ? '<button class="btn danger" type="button" id="cancel-btn">제출 취소</button>' : '') +
      '<a class="btn" href="/my.html">지원내역 확인</a></div>' +
      '<p class="muted small">' + (a.can_edit ? '이 공고는 마감 전까지 수정할 수 있습니다. ' : '이 공고는 제출 후 수정할 수 없습니다. ') +
      (posting.allow_cancel ? '마감 전까지 제출을 취소할 수 있습니다.' : '제출 취소는 허용되지 않습니다.') + '</p>' +
      '<div id="status-view"></div>';
    root.innerHTML = html;
    $('#view-btn').addEventListener('click', function () { $('#status-view').innerHTML = previewHtml(a.data, a.attachments); });
    if ($('#edit-btn')) $('#edit-btn').addEventListener('click', function () { renderForm(true); });
    if ($('#cancel-btn')) $('#cancel-btn').addEventListener('click', function () {
      if (!confirm('제출을 취소할까요?\n\n지원서는 임시저장 상태로 돌아가고 접수번호는 무효가 됩니다. 마감 전에 다시 제출하지 않으면 접수되지 않습니다.')) return;
      var btn = this; btn.disabled = true;
      call({ action: 'cancel', posting_id: postingId }).then(function (r) {
        btn.disabled = false;
        if (r.result !== 'success') { alert(r.msg); return; }
        RC.toast('제출이 취소되었습니다. 임시저장 상태입니다.');
        load().then(function (okLoad) { if (okLoad) route(); });
      });
    });
    window.scrollTo(0, 0);
  }

  function renderClosedDraft() {
    root.innerHTML = '<div class="notice-box warn"><strong>접수가 마감되어 제출할 수 없습니다.</strong> 이 지원서는 임시저장 상태로, 접수되지 않았습니다.</div>' +
      previewHtml(app.data, app.attachments) +
      '<div class="btn-row"><button class="btn danger" type="button" id="del-draft">임시저장 지원서 삭제</button></div>';
    $('#del-draft').addEventListener('click', deleteDraft);
  }

  function deleteDraft() {
    if (!confirm('임시저장한 지원서와 첨부파일을 삭제할까요? 되돌릴 수 없습니다.')) return;
    call({ action: 'delete_draft', posting_id: postingId }).then(function (r) {
      if (r.result !== 'success') { alert(r.msg); return; }
      dirty = false;
      RC.toast('삭제되었습니다.');
      setTimeout(function () { location.href = '/my.html'; }, 800);
    });
  }

  // ---------------------------------------------------------------- 작성 화면
  function input(id, label, type, value, opts) {
    opts = opts || {};
    var req = opts.required ? '<span class="req" aria-hidden="true">*</span>' : '';
    var attrs = ' id="' + id + '" name="' + id + '"' + (opts.required ? ' aria-required="true"' : '') + (opts.max ? ' maxlength="' + opts.max + '"' : '') +
      (opts.autocomplete ? ' autocomplete="' + opts.autocomplete + '"' : '') + (opts.inputmode ? ' inputmode="' + opts.inputmode + '"' : '') + (opts.readonly ? ' readonly' : '') +
      (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '');
    var control = type === 'textarea' ? '<textarea' + attrs + '>' + esc(value) + '</textarea>' : '<input type="' + type + '"' + attrs + ' value="' + esc(value) + '">';
    return '<div class="field"><label for="' + id + '">' + esc(label) + req + '</label>' + control + (opts.hint ? '<span class="hint">' + esc(opts.hint) + '</span>' : '') + '</div>';
  }

  function itemRow(sec, item, idx) {
    var def = LABELS[sec];
    var html = '<div class="item-row" data-sec="' + sec + '"><button type="button" class="btn small danger remove" data-remove>삭제</button><div class="grid3">';
    def.cols.forEach(function (c) {
      if (c[2] === 'textarea') return;
      html += input('f-' + sec + '-' + idx + '-' + c[0], c[1], c[2], item[c[0]] || '', { max: 100 });
    });
    html += '</div>';
    def.cols.forEach(function (c) {
      if (c[2] === 'textarea') html += input('f-' + sec + '-' + idx + '-' + c[0], c[1], 'textarea', item[c[0]] || '', { max: 1000 });
    });
    return html + '</div>';
  }

  var rowSeq = 0;
  function sectionHtml(sec) {
    var c = cfg()[sec] || {};
    if (!c.use) return '';
    var items = (app && app.data && app.data[sec]) || [];
    if (!items.length) items = [{}];
    return '<section class="form-section" id="sec-' + sec + '" tabindex="-1"><h2>' + LABELS[sec].title + (c.required ? '<span class="req">*</span>' : '') + '</h2>' +
      '<p class="hint">' + (c.required ? '1개 이상 입력해주세요. ' : '해당 사항이 없으면 비워 두세요. ') + '최대 ' + R.ITEM_MAX[sec] + '개</p>' +
      '<div data-items="' + sec + '">' + items.map(function (it) { return itemRow(sec, it, rowSeq++); }).join('') + '</div>' +
      '<button type="button" class="btn small" data-add="' + sec + '">+ ' + LABELS[sec].add + '</button></section>';
  }

  function docsHtml() {
    var docs = cfg().attachments || [];
    if (!docs.length) return '';
    var maxMb = cfg().max_file_mb || 10;
    return '<section class="form-section" id="sec-files"><h2>첨부서류</h2>' +
      '<p class="hint">PDF, JPG, PNG, HWP, HWPX, DOCX 파일만, 파일당 ' + maxMb + 'MB 이하. 서류마다 3개까지 올릴 수 있습니다. 주민등록번호가 보이는 서류는 해당 부분을 가리고 올려주세요.</p>' +
      docs.map(function (d) {
        return '<div class="doc-row" id="doc-' + esc(d.key) + '"><div class="label">' + esc(d.label) + (d.required ? '<span class="req">*</span>' : ' <span class="muted small">(선택)</span>') + '</div>' +
          '<ul class="file-list" data-files="' + esc(d.key) + '"></ul>' +
          '<label class="btn small" for="file-' + esc(d.key) + '">파일 선택</label>' +
          '<input class="sr-only" type="file" id="file-' + esc(d.key) + '" data-doc="' + esc(d.key) + '" accept=".pdf,.jpg,.jpeg,.png,.hwp,.hwpx,.docx">' +
          '<span class="small muted" data-progress="' + esc(d.key) + '"></span></div>';
      }).join('') + '</section>';
  }

  function renderFiles() {
    var list = (app && app.attachments) || [];
    $$('[data-files]').forEach(function (ul) {
      var key = ul.getAttribute('data-files');
      var mine = list.filter(function (f) { return f.doc_key === key; });
      ul.innerHTML = mine.map(function (f) {
        return '<li><span>' + esc(f.name || ('파일.' + f.ext)) + ' <span class="muted small">' + RC.fileSize(f.size) + '</span></span>' +
          '<span class="btn-row"><button type="button" class="btn small" data-view-file="' + esc(f.id) + '">보기</button>' +
          '<button type="button" class="btn small danger" data-remove-file="' + esc(f.id) + '">삭제</button></span></li>';
      }).join('') || '<li class="muted small">올린 파일이 없습니다.</li>';
    });
  }

  function renderForm(editMode) {
    mode = editMode ? 'edit' : 'form';
    var d = (app && app.data) || {};
    var b = d.basic || {};
    var bc = cfg().basic || {};
    var fs = fields();
    var essays = cfg().essays || [];
    var html = '';
    if (editMode) html += '<div class="notice-box warn"><strong>제출한 지원서 수정 중</strong> — 수정한 뒤 [미리보기]에서 [수정 내용 제출]을 눌러야 반영됩니다. (접수번호 ' + esc(app.receipt_no) + ' 유지)</div>';
    else if (app) html += '<div class="notice-box">임시저장된 지원서를 불러왔습니다. 마지막 저장 ' + esc(RC.kst(app.updated_at)) + ' · <strong>아직 제출되지 않았습니다.</strong></div>';
    html += '<p class="muted small"><span class="req">*</span> 표시는 필수 항목입니다. 사진, 가족관계, 신체조건 등 직무와 관계없는 개인정보는 적지 마세요.</p>';
    html += '<form id="app-form" novalidate>';
    html += '<section class="form-section"><h2>기본정보</h2><div class="grid2">' +
      input('f-name', '성명', 'text', b.name || '', { required: true, max: 50, autocomplete: 'name' }) +
      input('f-phone', '휴대폰', 'tel', b.phone || '', { required: true, max: 20, autocomplete: 'tel', inputmode: 'tel', placeholder: '010-0000-0000' }) +
      input('f-email', '이메일(인증됨)', 'email', email, { readonly: true, hint: '인증한 이메일로 연락합니다. 바꾸려면 인증 해제 후 다른 이메일로 인증하세요.' }) +
      (bc.birth ? input('f-birth', '생년월일', 'date', b.birth || '', { required: true }) : '') +
      (bc.military ? input('f-military', '병역사항', 'text', b.military || '', { max: 50, placeholder: '예: 군필, 미필, 면제, 해당없음' }) : '') +
      '</div>' + (bc.address ? input('f-address', '주소', 'text', b.address || '', { required: true, max: 200, autocomplete: 'street-address' }) : '') + '</section>';
    if (fs.length > 1) {
      html += '<section class="form-section"><h2>지원 분야<span class="req">*</span></h2><div class="field"><label for="f-field" class="sr-only">지원 분야</label><select id="f-field"><option value="">선택해주세요</option>' +
        fs.map(function (f) { return '<option' + (d.field === f.name ? ' selected' : '') + ' value="' + esc(f.name) + '">' + esc(f.name) + (f.headcount ? ' (' + esc(f.headcount) + ')' : '') + '</option>'; }).join('') +
        '</select></div></section>';
    } else if (fs.length === 1) {
      html += '<section class="form-section"><h2>지원 분야</h2><p>' + esc(fs[0].name) + '</p></section>';
    }
    html += sectionHtml('education') + sectionHtml('career') + sectionHtml('certs');
    if (essays.length) {
      html += '<section class="form-section" id="sec-essays"><h2>자기소개</h2>' + essays.map(function (q, i) {
        var v = (d.essays && d.essays[i]) || '';
        return '<div class="field"><label for="f-essay-' + i + '">' + (i + 1) + '. ' + esc(q.question) + (q.required ? '<span class="req">*</span>' : '') + '</label>' +
          '<textarea id="f-essay-' + i + '" data-max="' + q.max_len + '" rows="8">' + esc(v) + '</textarea>' +
          '<div class="counter" data-counter="f-essay-' + i + '"></div></div>';
      }).join('') + '</section>';
    }
    html += '</form>';
    html += docsHtml();
    html += '<div id="form-msg" role="alert" aria-live="assertive"></div>';
    html += '<div class="action-bar no-print"><div class="wrap"><span class="small muted" id="save-state"></span><div class="btn-row">' +
      (editMode ? '<button type="button" class="btn" id="cancel-edit">수정 그만두기</button>'
        : '<button type="button" class="btn" id="reset-btn">다시 작성</button><button type="button" class="btn" id="save-btn">임시저장</button>') +
      '<button type="button" class="btn primary" id="preview-btn">미리보기</button></div></div></div>';
    if (!editMode && app) html += '<p class="small"><button type="button" class="btn small danger" id="del-draft">임시저장 지원서 삭제</button></p>';
    root.innerHTML = html;
    renderFiles();
    bindForm(editMode);
    updateCounters();
    dirty = false;
  }

  function updateCounters() {
    $$('textarea[data-max]').forEach(function (t) {
      var c = $('[data-counter="' + t.id + '"]');
      var max = Number(t.getAttribute('data-max'));
      c.textContent = t.value.length.toLocaleString() + ' / ' + max.toLocaleString() + '자';
      c.classList.toggle('over', t.value.length > max);
    });
  }

  function bindForm(editMode) {
    var form = $('#app-form');
    form.addEventListener('input', function (e) {
      dirty = true;
      if (e.target.classList && e.target.classList.contains('invalid')) {
        e.target.classList.remove('invalid');
        e.target.removeAttribute('aria-invalid');
        var fe = e.target.parentElement.querySelector('.field-error');
        if (fe) fe.remove();
      }
      if (e.target.matches('textarea[data-max]')) updateCounters();
      $('#save-state').textContent = '저장하지 않은 변경사항이 있습니다.';
    });
    form.addEventListener('click', function (e) {
      var add = e.target.closest('[data-add]');
      if (add) {
        var sec = add.getAttribute('data-add');
        var box = $('[data-items="' + sec + '"]');
        if (box.children.length >= R.ITEM_MAX[sec]) { RC.toast('최대 ' + R.ITEM_MAX[sec] + '개까지 입력할 수 있습니다.'); return; }
        box.insertAdjacentHTML('beforeend', itemRow(sec, {}, rowSeq++));
        dirty = true;
        return;
      }
      var rm = e.target.closest('[data-remove]');
      if (rm) { rm.closest('.item-row').remove(); dirty = true; }
    });
    var files = $('#sec-files');
    if (files) {
      files.addEventListener('change', function (e) { if (e.target.matches('input[type=file]')) uploadFiles(e.target); });
      files.addEventListener('click', function (e) {
        var v = e.target.closest('[data-view-file]');
        if (v) return viewFile(v.getAttribute('data-view-file'));
        var r = e.target.closest('[data-remove-file]');
        if (r) removeFile(r.getAttribute('data-remove-file'));
      });
    }
    if ($('#save-btn')) $('#save-btn').addEventListener('click', function () { save(false); });
    if ($('#reset-btn')) $('#reset-btn').addEventListener('click', function () {
      if (!confirm('입력한 내용을 모두 지우고 처음부터 다시 작성할까요?\n(첨부파일은 지워지지 않습니다. [임시저장]을 눌러야 저장된 내용도 바뀝니다)')) return;
      app = app ? Object.assign({}, app, { data: {} }) : null;
      var keepFiles = app ? app.attachments : [];
      renderForm(false);
      if (app) { app.attachments = keepFiles; renderFiles(); }
      dirty = true;
    });
    if ($('#cancel-edit')) $('#cancel-edit').addEventListener('click', function () {
      if (dirty && !confirm('수정한 내용을 버리고 돌아갈까요?')) return;
      dirty = false;
      load().then(function (okLoad) { if (okLoad) route(); });
    });
    if ($('#del-draft')) $('#del-draft').addEventListener('click', deleteDraft);
    $('#preview-btn').addEventListener('click', showPreview);
    clearInterval(autoTimer);
    // 작성 중 3분마다 자동 임시저장(임시저장 상태일 때만)
    if (!editMode) autoTimer = setInterval(function () { if (dirty && mode === 'form' && !busy) save(true); }, 180000);
  }

  function collect() {
    var v = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : undefined; };
    var data = { basic: { name: v('f-name') || '', phone: v('f-phone') || '' } };
    if (v('f-birth') !== undefined) data.basic.birth = v('f-birth');
    if (v('f-address') !== undefined) data.basic.address = v('f-address');
    if (v('f-military') !== undefined) data.basic.military = v('f-military');
    var fs = fields();
    data.field = fs.length > 1 ? (v('f-field') || '') : (fs.length === 1 ? fs[0].name : '');
    ['education', 'career', 'certs'].forEach(function (sec) {
      var box = $('[data-items="' + sec + '"]');
      if (!box) return;
      data[sec] = $$('.item-row', box).map(function (row) {
        var item = {};
        LABELS[sec].cols.forEach(function (c) {
          var el = row.querySelector('[id$="-' + c[0] + '"]');
          item[c[0]] = el ? el.value.trim() : '';
        });
        return item;
      }).filter(function (item) { return Object.keys(item).some(function (k) { return item[k]; }); });
    });
    data.essays = (cfg().essays || []).map(function (_, i) { var el = document.getElementById('f-essay-' + i); return el ? el.value : ''; });
    return data;
  }

  function showError(err) {
    $$('.invalid').forEach(function (el) { el.classList.remove('invalid'); });
    $$('.field-error').forEach(function (el) { el.remove(); });
    var el = err.field ? document.getElementById(err.field) : null;
    setMsg(esc(err.msg));
    if (el) {
      // 모바일에서도 바로 보이도록 해당 입력칸 바로 아래에도 안내를 붙인다
      var anchor = el.matches('section') ? el.querySelector('h2') : el;
      anchor.insertAdjacentHTML('afterend', '<span class="field-error">' + esc(err.msg) + '</span>');
      if (el.matches('input,select,textarea')) { el.classList.add('invalid'); el.setAttribute('aria-invalid', 'true'); }
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function save(silent) {
    if (busy) return Promise.resolve();
    var data = collect();
    var err = R.validateApplication(posting, data, false);
    if (err) { if (!silent) showError(err); return Promise.resolve(); }
    busy = true;
    var btn = $('#save-btn');
    if (btn && !silent) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 저장 중'; }
    return call({ action: 'save', posting_id: postingId, data: data }).then(function (r) {
      busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '임시저장'; }
      if (r.result !== 'success') { if (!silent) setMsg(esc(r.msg)); return; }
      dirty = false;
      setMsg('');
      if (!app) app = { status: 'draft', data: data, attachments: [] };
      app.data = data;
      $('#save-state').textContent = (silent ? '자동 저장됨 ' : '임시저장됨 ') + RC.kst(r.saved_at) + ' (아직 제출 전)';
      if (!silent) RC.toast('임시저장되었습니다. 아직 제출되지 않았습니다.');
    });
  }

  // ---------------------------------------------------------------- 첨부
  function refreshFiles() {
    return call({ action: 'my_app', posting_id: postingId }).then(function (r) {
      if (r.result === 'success' && r.application) {
        if (!app) app = { status: 'draft', data: collect() };
        app.attachments = r.application.attachments;
        renderFiles();
      }
    });
  }

  function uploadFiles(inputEl) {
    var key = inputEl.getAttribute('data-doc');
    var file = inputEl.files && inputEl.files[0];
    inputEl.value = '';
    if (!file) return;
    var prog = $('[data-progress="' + key + '"]');
    var maxMb = cfg().max_file_mb || 10;
    var ext = R.extOf(file.name);
    if (R.ALLOWED_EXT.indexOf(ext) < 0) { alert('올릴 수 없는 파일 형식입니다. (PDF, JPG, PNG, HWP, HWPX, DOCX)'); return; }
    if (file.size > maxMb * 1048576) { alert('파일은 ' + maxMb + 'MB 이하만 올릴 수 있습니다.'); return; }
    if (file.size === 0) { alert('빈 파일은 올릴 수 없습니다.'); return; }
    prog.innerHTML = '<span class="spinner"></span> 올리는 중…';
    call({ action: 'upload_begin', posting_id: postingId, doc_key: key, filename: file.name, size: file.size }).then(function (r) {
      if (r.result !== 'success') throw new Error(r.msg);
      return RC.config().then(function (c) {
        return sb.storage.from(c.bucket).uploadToSignedUrl(r.path, r.token, file, { contentType: file.type || 'application/octet-stream' });
      }).then(function (u) {
        if (u.error) throw new Error('파일을 올리지 못했습니다. 다시 시도해주세요.');
        prog.innerHTML = '<span class="spinner"></span> 파일 확인 중…';
        return call({ action: 'upload_done', attachment_id: r.attachment_id });
      }).then(function (d) {
        if (d.result !== 'success') throw new Error(d.msg);
      });
    }).then(function () {
      prog.textContent = '';
      RC.toast('파일을 올렸습니다.');
      return refreshFiles();
    }).catch(function (e) {
      prog.textContent = '';
      alert(e.message || '파일을 올리지 못했습니다.');
      refreshFiles();
    });
  }

  function viewFile(id) {
    // 팝업 차단을 피하려고 먼저 창을 연 뒤 주소를 넣는다
    var w = window.open('', '_blank');
    call({ action: 'file_url', attachment_id: id }).then(function (r) {
      if (r.result !== 'success') { if (w) w.close(); alert(r.msg); return; }
      if (w) { w.opener = null; w.location.href = r.url; } else location.href = r.url;
    });
  }

  function removeFile(id) {
    if (!confirm('이 파일을 삭제할까요?')) return;
    call({ action: 'remove_file', attachment_id: id }).then(function (r) {
      if (r.result !== 'success') { alert(r.msg); return; }
      refreshFiles();
    });
  }

  // ---------------------------------------------------------------- 미리보기·제출
  function previewHtml(data, attachments) {
    data = data || {};
    var b = data.basic || {};
    var bc = cfg().basic || {};
    var rows = [['성명', b.name], ['휴대폰', b.phone], ['이메일', email]];
    if (bc.birth) rows.push(['생년월일', b.birth]);
    if (bc.address) rows.push(['주소', b.address]);
    if (bc.military) rows.push(['병역사항', b.military]);
    if (fields().length) rows.push(['지원 분야', data.field]);
    var html = '<div class="preview print-area"><h2>' + esc(posting.title) + '</h2><h3>기본정보</h3><dl>' +
      rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1] || '-') + '</dd>'; }).join('') + '</dl>';
    ['education', 'career', 'certs'].forEach(function (sec) {
      if (!(cfg()[sec] || {}).use) return;
      var items = data[sec] || [];
      html += '<h3>' + LABELS[sec].title + '</h3>';
      if (!items.length) { html += '<p class="muted">입력 없음</p>'; return; }
      html += '<div class="table-wrap"><table><thead><tr>' + LABELS[sec].cols.map(function (c) { return '<th>' + esc(c[1]) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        items.map(function (it) { return '<tr>' + LABELS[sec].cols.map(function (c) { return '<td class="pre">' + esc(it[c[0]] || '') + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
    });
    (cfg().essays || []).forEach(function (q, i) {
      html += '<h3>' + (i + 1) + '. ' + esc(q.question) + '</h3><div class="consent-text">' + esc((data.essays || [])[i] || '') + '</div>';
    });
    var docs = cfg().attachments || [];
    if (docs.length) {
      html += '<h3>첨부서류</h3><dl>' + docs.map(function (d) {
        var fl = (attachments || []).filter(function (f) { return f.doc_key === d.key; });
        return '<dt>' + esc(d.label) + '</dt><dd>' + (fl.length ? fl.map(function (f) { return esc(f.name) + ' (' + RC.fileSize(f.size) + ')'; }).join('\n') : '<span class="muted">없음</span>') + '</dd>';
      }).join('') + '</dl>';
    }
    return html + '</div>';
  }

  function showPreview() {
    var data = collect();
    var err = R.validateApplication(posting, data, true);
    if (err) return showError(err);
    var missing = (cfg().attachments || []).filter(function (d) {
      return d.required && !((app && app.attachments) || []).some(function (f) { return f.doc_key === d.key; });
    });
    if (missing.length) { setMsg('필수 첨부서류(' + esc(missing[0].label) + ')를 올려주세요.'); var el = $('#doc-' + missing[0].key); if (el) el.scrollIntoView({ block: 'center' }); return; }
    var editMode = mode === 'edit';
    mode = 'preview';
    var formHtml = root.innerHTML;
    var formState = data;
    var consent = String(posting.consent_text || '').trim();
    root.innerHTML = '<div class="notice-box warn no-print"><strong>최종 확인</strong> — 아래 내용을 확인한 뒤 제출해주세요. ' +
      (editMode ? '수정 내용 제출 후에도 접수번호는 그대로입니다.' : (posting.allow_edit ? '이 공고는 마감 전까지 수정할 수 있습니다.' : '이 공고는 <strong>제출 후 수정할 수 없습니다.</strong>')) + '</div>' +
      previewHtml(data, app && app.attachments) +
      '<section class="form-section no-print"><h2>개인정보 수집·이용 동의</h2>' +
      (consent ? '<div class="consent-text">' + esc(consent) + '</div>' : '<div class="notice-box error">이 공고에 동의문이 등록되지 않아 제출할 수 없습니다. 문의처로 연락해주세요.</div>') +
      '<label class="check"><input type="checkbox" id="consent"' + (consent ? '' : ' disabled') + '> 위 내용을 읽었으며 개인정보 수집·이용에 동의합니다. (동의하지 않으면 지원할 수 없습니다)</label></section>' +
      '<div id="form-msg" role="alert"></div>' +
      '<div class="action-bar no-print"><div class="wrap"><button type="button" class="btn" id="back-btn">수정하러 돌아가기</button><div class="btn-row">' +
      '<button type="button" class="btn" id="print-btn">인쇄</button>' +
      '<button type="button" class="btn primary" id="submit-btn"' + (consent ? '' : ' disabled') + '>' + (editMode ? '수정 내용 제출' : '최종 제출') + '</button></div></div></div>';
    window.scrollTo(0, 0);
    $('#print-btn').addEventListener('click', function () { window.print(); });
    $('#back-btn').addEventListener('click', function () {
      root.innerHTML = formHtml;
      mode = editMode ? 'edit' : 'form';
      restore(formState);
      renderFiles();
      bindForm(editMode);
      updateCounters();
    });
    $('#submit-btn').addEventListener('click', function () { submit(data, editMode); });
  }

  // innerHTML로 되돌리면 입력값이 처음 값으로 돌아가므로 다시 채운다
  function restore(data) {
    var set = function (id, v) { var el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
    var b = data.basic || {};
    set('f-name', b.name); set('f-phone', b.phone); set('f-birth', b.birth); set('f-address', b.address); set('f-military', b.military); set('f-field', data.field);
    ['education', 'career', 'certs'].forEach(function (sec) {
      var box = $('[data-items="' + sec + '"]');
      if (!box) return;
      var items = data[sec] && data[sec].length ? data[sec] : [{}];
      box.innerHTML = items.map(function (it) { return itemRow(sec, it, rowSeq++); }).join('');
    });
    (data.essays || []).forEach(function (v, i) { set('f-essay-' + i, v); });
  }

  function submit(data, editMode) {
    if (busy) return;
    if (!$('#consent').checked) { setMsg('개인정보 수집·이용에 동의해야 제출할 수 있습니다.'); return; }
    busy = true;
    var btn = $('#submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 제출 중… 창을 닫지 마세요';
    call({ action: 'submit', posting_id: postingId, data: data, consent: true }).then(function (r) {
      busy = false;
      if (r.result !== 'success') {
        btn.disabled = false;
        btn.textContent = editMode ? '수정 내용 제출' : '최종 제출';
        setMsg('<strong>제출되지 않았습니다.</strong> ' + esc(r.msg));
        return;
      }
      dirty = false;
      clearInterval(autoTimer);
      load().then(function (okLoad) { if (okLoad) renderStatus(true); });
    });
  }

  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  document.addEventListener('DOMContentLoaded', function () {
    root = $('#apply-root');
    postingId = RC.param('id');
    if (!RC.isUuid(postingId)) { root.innerHTML = '<div class="empty">공고를 찾을 수 없습니다. <a href="/">목록으로</a></div>'; return; }
    // 인증 전에도 공고 제목은 보여준다
    RC.api('/api/public?r=posting&id=' + encodeURIComponent(postingId)).then(function (r) {
      if (r.result === 'success') {
        $('#apply-title').textContent = r.item.title;
        $('#apply-posting-meta').innerHTML = RC.badge(r.item.state) + ' 접수기간 ' + esc(RC.period(r.item)) + ' (한국 시간)';
      }
    });
    RC.applicantAuth(root, '지원서 작성·임시저장·제출을 위해 이메일로 본인 확인을 합니다.', function (session, client) {
      sb = client;
      load().then(function (okLoad) { if (okLoad) route(); });
    });
  });
})();
