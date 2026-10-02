// 화면 공통 기능: API 호출, 화면 출력 이스케이프(XSS 방지), 한국 시간 표시, 지원자 이메일 인증
// CSP 때문에 HTML 안에 스크립트를 쓰지 않는다. 버튼 동작은 이 파일들에서 addEventListener로 연결한다.
(function () {
  'use strict';
  var RC = {};
  var configPromise = null;

  // 화면에 넣는 모든 글자는 이 함수로 감싼다
  RC.esc = function (v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  RC.$ = function (sel, root) { return (root || document).querySelector(sel); };
  RC.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  RC.param = function (name) { return new URLSearchParams(location.search).get(name) || ''; };
  RC.isUuid = function (v) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || ''); };

  var KST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  var KSTD = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  // 한국 시간으로 표시: 2026. 10. 10. 18:00
  RC.kst = function (iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? '' : KST.format(d); };
  RC.kstDate = function (iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? '' : KSTD.format(d); };
  RC.period = function (p) { return RC.kst(p.opens_at) + ' ~ ' + RC.kst(p.closes_at); };
  RC.STATE_LABEL = { open: '접수 중', upcoming: '접수 예정', closed: '마감', draft: '비공개' };
  RC.badge = function (state) { return '<span class="badge ' + RC.esc(state) + '">' + RC.esc(RC.STATE_LABEL[state] || state) + '</span>'; };
  RC.fileSize = function (n) { n = Number(n) || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB'; };

  RC.toast = function (msg, ms) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 2600);
  };

  // 서버 호출. 실패하면 { result:'error', msg } 형태로 돌려준다(화면에서 msg를 보여줌)
  RC.api = function (path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    return fetch(path, { method: opts.body ? 'POST' : 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' })
      .then(function (res) {
        if (opts.raw) return res;
        return res.json().catch(function () { return { result: 'error', msg: '서버 응답을 읽지 못했습니다.' }; })
          .then(function (j) { j.status = res.status; return j; });
      })
      .catch(function () { return { result: 'error', msg: '인터넷 연결을 확인한 뒤 다시 시도해주세요.' }; });
  };

  RC.config = function () {
    if (!configPromise) configPromise = RC.api('/api/public?r=config');
    return configPromise;
  };

  // 바닥글: 담당자가 입력한 문의처만 보여준다(없으면 '준비 중')
  RC.renderFooter = function (settings) {
    var el = RC.$('#footer-contact');
    if (!el) return;
    var s = settings || {};
    var lines = [];
    if (s.contact_phone) lines.push('채용 문의 ' + RC.esc(s.contact_phone));
    if (s.contact_email) lines.push(RC.esc(s.contact_email));
    if (s.contact_hours) lines.push(RC.esc(s.contact_hours));
    if (s.address) lines.push(RC.esc(s.address));
    el.innerHTML = lines.length ? lines.join(' · ') : '문의처 정보 준비 중';
  };
  var boardPromise = null;
  RC.board = function () {
    if (!boardPromise) boardPromise = RC.api('/api/public?r=board');
    return boardPromise;
  };

  // ---------------------------------------------------------------
  // 지원자 이메일 인증 (Supabase Auth 일회용 코드). 로그인 정보는 이 탭(sessionStorage)에만 둔다.
  // 로봇 확인(Turnstile)은 Supabase가 서버에서 검증한다(Supabase 대시보드에서 CAPTCHA 켜기).
  // ---------------------------------------------------------------
  var sbClient = null;
  RC.supabase = function () {
    return RC.config().then(function (cfg) {
      if (cfg.result !== 'success' || !cfg.supabaseUrl) throw new Error('설정을 불러오지 못했습니다.');
      if (!sbClient) {
        sbClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: { storage: window.sessionStorage, storageKey: 'rc-applicant', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
        });
      }
      return sbClient;
    });
  };

  var turnstileLoading = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (!turnstileLoading) {
      turnstileLoading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function () { reject(new Error('로봇 확인 도구를 불러오지 못했습니다.')); };
        document.head.appendChild(s);
      });
    }
    return turnstileLoading;
  }
  // 로봇 확인 위젯. 사이트 키가 없으면(개발 환경) 위젯 없이 진행한다. getToken()으로 토큰을 받는다.
  RC.captcha = function (container, action) {
    var state = { token: '', widget: null, enabled: false };
    return RC.config().then(function (cfg) {
      if (!cfg.turnstileSiteKey) return state;
      state.enabled = true;
      return loadTurnstile().then(function () {
        state.widget = window.turnstile.render(container, {
          sitekey: cfg.turnstileSiteKey, action: action, language: 'ko',
          callback: function (t) { state.token = t; }, 'expired-callback': function () { state.token = ''; }
        });
        return state;
      });
    }).then(function (st) {
      st.reset = function () { if (st.enabled && window.turnstile) { window.turnstile.reset(st.widget); st.token = ''; } };
      return st;
    });
  };

  // 인증 화면을 container에 그리고, 인증이 끝나면 onReady(session)을 부른다.
  RC.applicantAuth = function (container, intro, onReady) {
    RC.supabase().then(function (sb) {
      return sb.auth.getSession().then(function (r) {
        var session = r.data && r.data.session;
        var role = session && session.user && session.user.app_metadata && session.user.app_metadata.role;
        if (session && !role) return onReady(session, sb);
        if (session) sb.auth.signOut();
        drawEmailStep(container, intro, sb, onReady);
      });
    }).catch(function (e) {
      container.innerHTML = '<div class="notice-box error">' + RC.esc(e.message) + '</div>';
    });
  };

  function drawEmailStep(container, intro, sb, onReady) {
    container.innerHTML =
      '<div class="auth-box">' +
      '<h2>이메일 본인 확인</h2>' +
      '<p class="muted small">' + RC.esc(intro) + '</p>' +
      '<form id="auth-email-form" novalidate>' +
      '<div class="field"><label for="auth-email">이메일 주소</label>' +
      '<input id="auth-email" type="email" autocomplete="email" inputmode="email" required maxlength="100"></div>' +
      '<div id="auth-captcha"></div>' +
      '<div id="auth-msg" role="alert"></div>' +
      '<button class="btn primary" type="submit" id="auth-send">인증코드 받기</button>' +
      '</form>' +
      '<p class="hint">입력한 이메일로 일회용 인증코드를 보냅니다. 비밀번호는 만들지 않습니다. 같은 이메일로 인증해야 작성 중인 지원서를 이어서 볼 수 있습니다.</p>' +
      '</div>';
    var captchaState = null;
    RC.captcha(RC.$('#auth-captcha', container), 'otp').then(function (st) { captchaState = st; })
      .catch(function (e) { RC.$('#auth-msg', container).innerHTML = '<div class="notice-box error">' + RC.esc(e.message) + '</div>'; });
    RC.$('#auth-email-form', container).addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = RC.$('#auth-email', container).value.trim();
      var msg = RC.$('#auth-msg', container);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        RC.$('#auth-email', container).classList.add('invalid');
        msg.innerHTML = '<div class="notice-box error">이메일 주소를 정확히 입력해주세요.</div>';
        return;
      }
      if (captchaState && captchaState.enabled && !captchaState.token) {
        msg.innerHTML = '<div class="notice-box error">로봇이 아님을 확인해주세요.</div>';
        return;
      }
      var btn = RC.$('#auth-send', container);
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 보내는 중';
      var options = { shouldCreateUser: true };
      if (captchaState && captchaState.token) options.captchaToken = captchaState.token;
      sb.auth.signInWithOtp({ email: email, options: options }).then(function (r) {
        if (r.error) {
          btn.disabled = false;
          btn.textContent = '인증코드 받기';
          if (captchaState) captchaState.reset();
          var m = /rate|seconds|too many/i.test(r.error.message) ? '잠시 후 다시 시도해주세요. (인증코드는 짧은 시간에 여러 번 보낼 수 없습니다)' : '인증코드를 보내지 못했습니다. 이메일 주소를 확인하고 다시 시도해주세요.';
          msg.innerHTML = '<div class="notice-box error">' + RC.esc(m) + '</div>';
          return;
        }
        drawCodeStep(container, email, sb, onReady, intro);
      });
    });
  }

  function drawCodeStep(container, email, sb, onReady, intro) {
    container.innerHTML =
      '<div class="auth-box">' +
      '<h2>인증코드 입력</h2>' +
      '<p><strong>' + RC.esc(email) + '</strong>(으)로 보낸 인증코드를 입력해주세요. 메일이 보이지 않으면 스팸함을 확인해주세요.</p>' +
      '<form id="auth-code-form" novalidate>' +
      '<div class="field"><label for="auth-code">인증코드</label>' +
      '<input id="auth-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required></div>' +
      '<div id="auth-msg" role="alert"></div>' +
      '<div class="btn-row"><button class="btn primary" type="submit" id="auth-verify">확인</button>' +
      '<button class="btn" type="button" id="auth-back">이메일 다시 입력</button></div>' +
      '</form></div>';
    RC.$('#auth-code', container).focus();
    RC.$('#auth-back', container).addEventListener('click', function () { drawEmailStep(container, intro, sb, onReady); });
    RC.$('#auth-code-form', container).addEventListener('submit', function (ev) {
      ev.preventDefault();
      var code = RC.$('#auth-code', container).value.replace(/\s/g, '');
      var msg = RC.$('#auth-msg', container);
      if (!/^\d{6,10}$/.test(code)) { msg.innerHTML = '<div class="notice-box error">메일로 받은 숫자 인증코드를 입력해주세요.</div>'; return; }
      var btn = RC.$('#auth-verify', container);
      btn.disabled = true;
      sb.auth.verifyOtp({ email: email, token: code, type: 'email' }).then(function (r) {
        btn.disabled = false;
        if (r.error || !r.data.session) {
          msg.innerHTML = '<div class="notice-box error">인증코드가 맞지 않거나 만료되었습니다. 다시 확인해주세요.</div>';
          return;
        }
        var role = r.data.session.user.app_metadata && r.data.session.user.app_metadata.role;
        if (role) { sb.auth.signOut(); msg.innerHTML = '<div class="notice-box error">관리자 계정으로는 지원할 수 없습니다.</div>'; return; }
        onReady(r.data.session, sb);
      });
    });
  }

  // 로그인된 지원자 API 호출 (토큰은 자동 갱신된 최신값 사용)
  RC.applicantCall = function (body) {
    return RC.supabase().then(function (sb) {
      return sb.auth.getSession().then(function (r) {
        var s = r.data && r.data.session;
        if (!s) return { result: 'error', status: 401, msg: '인증 시간이 지났습니다. 다시 인증해주세요.' };
        return RC.api('/api/applicant', { token: s.access_token, body: body });
      });
    });
  };
  RC.applicantLogout = function () {
    return RC.supabase().then(function (sb) { return sb.auth.signOut(); }).then(function () { location.reload(); });
  };

  // 공통: 바닥글 문의처
  document.addEventListener('DOMContentLoaded', function () {
    if (RC.$('#footer-contact')) RC.board().then(function (b) { if (b.result === 'success') RC.renderFooter(b.settings); });
    var y = RC.$('#footer-year');
    if (y) y.textContent = String(new Date().getFullYear());
  });

  window.RC = RC;
})();
