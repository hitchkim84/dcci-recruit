// 브라우저 통합 검증: 공고 등록 → 이메일 인증 → 작성·임시저장·복구 → 첨부 → 제출 → 담당자 조회·다운로드 → 결과 공개 → 파기
// 실제 PostgreSQL + 실제 서버 함수 + 실제 화면(Chromium)으로 돌리고, Supabase Auth·Storage만 흉내 낸다(tests/e2e/mock-supabase.js).
// 실행: npm run test:e2e   결과 화면 캡처: test-results/
const fs = require('fs');
const path = require('path');
const { start } = require('./devserver');

function loadPlaywright() {
  for (const p of ['playwright', '/opt/node-tools/node_modules/playwright', '/opt/node22/lib/node_modules/playwright']) {
    try { return require(p); } catch (e) { /* 다음 경로 */ }
  }
  throw new Error('playwright가 필요합니다: npm i -g playwright');
}

const OUT = path.join(__dirname, '..', '..', 'test-results');
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? '' : (detail || '') });
  console.log(`${cond ? '  통과' : '  실패'}: ${name}${cond ? '' : ' — ' + (detail || '')}`);
}
const kstInput = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 16);
const today = (addDays) => new Date(Date.now() + 9 * 3600e3 + addDays * 86400e3).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await start({ webPort: 8890, mockPort: 54330, pgPort: 55441 });
  const { chromium, devices } = loadPlaywright();
  const browser = await chromium.launch();
  const cspErrors = [];
  const dialogs = [];
  function watch(page, label) {
    page.on('console', m => { if (/Content Security Policy|Refused to/.test(m.text())) cspErrors.push(label + ': ' + m.text()); });
    page.on('pageerror', e => cspErrors.push(label + ' JS 오류: ' + e.message));
    page.on('dialog', async d => { dialogs.push(d.message()); if (d.type() === 'prompt') await d.accept('삭제'); else await d.accept(); });
  }
  const q = (sql, p) => srv.pool.query(sql, p).then(r => r.rows);
  const otp = async (email) => (await (await fetch(`${srv.mockUrl}/__dev/otp?email=${encodeURIComponent(email)}`)).json()).code;
  const apiAs = async (fn, token, body) => (await fetch(`${srv.url}/api/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) })).json().then(j => j);
  const apiStatus = async (fn, token, body) => (await fetch(`${srv.url}/api/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) })).status;
  const tokenOf = async (page, key) => page.evaluate(k => { const v = sessionStorage.getItem(k); return v ? JSON.parse(v).access_token : ''; }, key);

  let postingId, staffPage, adminPage, aPage;
  try {
    // ---------------------------------------------------------------- A. 슈퍼관리자: OTP 등록·공고 등록·담당자 계정
    console.log('\n[관리자] 로그인·OTP·공고 등록');
    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    adminPage = await adminCtx.newPage();
    watch(adminPage, 'admin');
    await adminPage.goto(srv.url + '/admin.html');
    await adminPage.fill('#login-id', 'admin@dev.local');
    await adminPage.fill('#login-pw', 'wrong-password');
    await adminPage.click('#login-btn');
    await adminPage.waitForSelector('#login-msg .notice-box');
    check('잘못된 비밀번호 로그인 거절', /맞지 않습니다/.test(await adminPage.textContent('#login-msg')));
    await adminPage.fill('#login-pw', 'dev-admin-password-0000');
    await adminPage.click('#login-btn');
    await adminPage.waitForSelector('#otp-code');
    check('슈퍼관리자 첫 로그인 시 OTP 등록 QR 표시', await adminPage.isVisible('img.qr'));
    // OTP 없이(aal1) 관리자 API 호출 → 차단
    const aal1 = await tokenOf(adminPage, 'rc-admin');
    check('OTP 전(aal1) 슈퍼관리자 API 차단(서버)', (await apiStatus('admin', aal1, { action: 'postings' })) === 403);
    const rpcAal1 = await fetch(`${srv.mockUrl}/rest/v1/rpc/admin_postings`, { method: 'POST', headers: { apikey: srv.mock.ANON_KEY, Authorization: 'Bearer ' + aal1, 'Content-Type': 'application/json' }, body: '{}' });
    check('OTP 전(aal1) 슈퍼관리자 DB 함수 직접 호출 차단(DB)', rpcAal1.status === 403);
    await adminPage.fill('#otp-code', '000000');
    await adminPage.click('#otp-form button[type=submit]');
    await adminPage.waitForSelector('#otp-msg .notice-box');
    check('틀린 OTP 거절', /맞지 않습니다/.test(await adminPage.textContent('#otp-msg')));
    await adminPage.fill('#otp-code', srv.mock.DEV_TOTP);
    await adminPage.click('#otp-form button[type=submit]');
    await adminPage.waitForSelector('#tabs [data-tab=postings]');
    check('OTP 통과 후 슈퍼관리자 메뉴 6개', (await adminPage.$$('#tabs [data-tab]')).length === 6);

    // 담당자 계정 만들기
    await adminPage.click('[data-tab=staff]');
    await adminPage.waitForSelector('#s-create');
    await adminPage.fill('#s-id', 'kim');
    await adminPage.fill('#s-pw', 'short');
    await adminPage.fill('#s-pw2', 'short');
    await adminPage.click('#s-create');
    await adminPage.waitForSelector('#s-msg .notice-box');
    check('담당자 비밀번호 12자 미만 거절', /12자/.test(await adminPage.textContent('#s-msg')));
    await adminPage.fill('#s-pw', 'staff-pass-1234!');
    await adminPage.fill('#s-pw2', 'staff-pass-1234!');
    await adminPage.click('#s-create');
    await adminPage.waitForFunction(() => document.querySelector('#tab-body table') && document.querySelector('#tab-body table').textContent.includes('kim'));
    check('담당자 계정 생성', true);

    // 공고 등록
    await adminPage.click('[data-tab=postings]');
    await adminPage.click('#new-posting');
    await adminPage.waitForSelector('#p-title');
    await adminPage.fill('#p-title', '[테스트] 브라우저 검증 공고');
    await adminPage.fill('#p-type', '[테스트] 정규직');
    await adminPage.fill('#p-opens', kstInput(Date.now() - 3600e3));
    await adminPage.fill('#p-closes', kstInput(Date.now() + 2 * 86400e3));
    await adminPage.fill('#p-fields [data-k=name]', '일반행정');
    await adminPage.click('#add-field');
    await adminPage.fill('#p-fields .row-sub:nth-child(2) [data-k=name]', '전산');
    await adminPage.fill('#p-qual', '[테스트] 지원자격');
    await adminPage.check('#c-birth');
    await adminPage.check('#c-education-req');
    await adminPage.click('#add-essay');
    await adminPage.fill('#p-essays [data-k=question]', '[테스트] 지원 동기');
    await adminPage.fill('#p-essays [data-k=max_len]', '300');
    await adminPage.click('#add-doc');
    await adminPage.fill('#p-docs-list [data-k=label]', '이력서');
    await adminPage.check('#p-docs-list [data-k=required]');
    await adminPage.fill('#p-consent', '[테스트] 개인정보 수집·이용 동의문');
    await adminPage.fill('#p-retention', today(365));
    await adminPage.check('[data-staff]');
    await adminPage.click('#p-save');
    await adminPage.waitForSelector('#new-posting');
    const rows = await q("SELECT id FROM public.postings WHERE title = '[테스트] 브라우저 검증 공고'");
    postingId = rows[0] && rows[0].id;
    check('공고 등록(초안 상태로 저장)', !!postingId);
    const pubBefore = await (await fetch(srv.url + '/api/public?r=posting&id=' + postingId)).json();
    check('초안 공고는 홈페이지에 공개되지 않음', pubBefore.result === 'error');
    await adminPage.click(`[data-status=published][data-id="${postingId}"]`);
    await adminPage.waitForFunction(id => !document.querySelector(`[data-status=published][data-id="${id}"]`), postingId);
    check('공고 게시', (await q('SELECT status FROM public.postings WHERE id = $1', [postingId]))[0].status === 'published');
    await adminPage.screenshot({ path: path.join(OUT, 'admin-postings.png'), fullPage: true });

    // ---------------------------------------------------------------- B. 지원자 A (모바일)
    console.log('\n[지원자 A·모바일] 인증·작성·임시저장·복구·첨부·제출');
    const mobile = devices['iPhone 13'] || { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
    const aCtx = await browser.newContext({ ...mobile });
    aPage = await aCtx.newPage();
    watch(aPage, 'applicantA');
    await aPage.goto(srv.url + '/');
    await aPage.waitForSelector('#open-list .card');
    check('메인: 진행 중 공고 카드 표시', (await aPage.textContent('#open-list')).includes('[테스트] 브라우저 검증 공고'));
    check('메인: 마감 공고 표시', (await aPage.textContent('#closed-list')).includes('지난 채용'));
    await aPage.screenshot({ path: path.join(OUT, 'mobile-index.png'), fullPage: true });
    await aPage.goto(srv.url + '/posting.html?id=' + postingId);
    await aPage.waitForSelector('.kv');
    const detailText = await aPage.textContent('#posting');
    check('공고 상세: 입력한 항목 표시', detailText.includes('[테스트] 지원자격') && detailText.includes('일반행정'));
    check('공고 상세: 입력하지 않은 항목(우대사항·근무조건)은 표시 안 함', !detailText.includes('우대사항') && !detailText.includes('근무조건'));
    await aPage.screenshot({ path: path.join(OUT, 'mobile-posting.png'), fullPage: true });
    await aPage.click('.apply-bar a.btn.primary');
    await aPage.waitForSelector('#auth-email');
    await aPage.fill('#auth-email', 'applicant.a@example.com');
    await aPage.click('#auth-send');
    await aPage.waitForSelector('#auth-code');
    await aPage.fill('#auth-code', '000000');
    await aPage.click('#auth-verify');
    await aPage.waitForSelector('#auth-msg .notice-box');
    check('틀린 이메일 인증코드 거절', /맞지 않거나/.test(await aPage.textContent('#auth-msg')));
    await aPage.fill('#auth-code', await otp('applicant.a@example.com'));
    await aPage.click('#auth-verify');
    await aPage.waitForSelector('#f-name');
    check('이메일 인증 후 지원서 화면', true);
    await aPage.fill('#f-name', '=1+1 가상지원자');
    await aPage.fill('#f-phone', '010-0000-1234');
    await aPage.selectOption('#f-field', '일반행정');
    await aPage.click('#save-btn');
    await aPage.waitForFunction(() => /임시저장됨/.test(document.querySelector('#save-state').textContent));
    check('임시저장', true);
    await aPage.reload();
    await aPage.waitForSelector('#f-name');
    check('새로고침 후 임시저장 내용 복구', (await aPage.inputValue('#f-name')) === '=1+1 가상지원자' && (await aPage.inputValue('#f-field')) === '일반행정');
    await aPage.click('#preview-btn');
    await aPage.waitForSelector('#form-msg .notice-box');
    check('필수값 누락 안내(생년월일) + 입력칸 강조 + 칸 아래 안내', /생년월일/.test(await aPage.textContent('#form-msg')) && await aPage.$eval('#f-birth', el => el.classList.contains('invalid')) && await aPage.isVisible('.field-error'));
    await aPage.screenshot({ path: path.join(OUT, 'mobile-required-error.png') });
    await aPage.fill('#f-birth', '1995-05-05');
    await aPage.fill('[id^=f-education-][id$=-school]', '가상대학교');
    await aPage.fill('#f-essay-0', '가'.repeat(301));
    await aPage.click('#preview-btn');
    await aPage.waitForFunction(() => /300자/.test(document.querySelector('#form-msg').textContent));
    check('자기소개 글자 수 초과 안내', true);
    await aPage.fill('#f-essay-0', '[테스트] 가상 지원 동기입니다.');
    await aPage.click('#preview-btn');
    await aPage.waitForFunction(() => /필수 첨부서류/.test(document.querySelector('#form-msg').textContent));
    check('필수 첨부서류 누락 안내', true);
    const fileInput = await aPage.$('input[type=file][data-doc]');
    const dialogCount = dialogs.length;
    await fileInput.setInputFiles({ name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is not a pdf') });
    await aPage.waitForFunction(n => window.__d === undefined && true, dialogCount);
    await aPage.waitForTimeout(1500);
    check('확장자만 바꾼 가짜 파일 거절', dialogs.slice(dialogCount).some(m => /확장자와 맞지 않습니다/.test(m)), dialogs.slice(dialogCount).join(' | '));
    check('거절된 파일은 저장소에서 삭제', [...srv.mock.files.keys()].length === 0);
    await fileInput.setInputFiles({ name: 'exe.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') });
    await aPage.waitForTimeout(300);
    check('허용하지 않는 확장자 거절', dialogs.some(m => /올릴 수 없는 파일 형식/.test(m)));
    await (await aPage.$('input[type=file][data-doc]')).setInputFiles({ name: '이력서.pdf', mimeType: 'application/pdf', buffer: PDF });
    await aPage.waitForFunction(() => document.querySelector('[data-files]').textContent.includes('이력서.pdf'));
    check('PDF 첨부 업로드·확인 완료', srv.mock.files.size === 1);
    await aPage.click('#preview-btn');
    await aPage.waitForSelector('#submit-btn');
    await aPage.screenshot({ path: path.join(OUT, 'mobile-preview.png'), fullPage: true });
    await aPage.click('#submit-btn');
    check('동의 없이 제출 불가', /동의해야/.test(await aPage.textContent('#form-msg')));
    await aPage.check('#consent');
    // 제출 버튼 연타(같은 순간 3번 클릭)
    await aPage.evaluate(() => { const b = document.querySelector('#submit-btn'); b.click(); b.click(); b.click(); });
    await aPage.waitForSelector('.receipt');
    const receipt = (await aPage.textContent('.receipt')).trim();
    check('제출 완료 + 접수번호 표시', /^\d{4}-\d{3}-0001$/.test(receipt), receipt);
    const subs = await q("SELECT count(*)::int AS n FROM public.applications WHERE posting_id = $1 AND status = 'submitted'", [postingId]);
    const seq = await q('SELECT receipt_seq FROM public.postings WHERE id = $1', [postingId]);
    check('버튼 연타해도 접수 1건·접수번호 1개', subs[0].n === 1 && seq[0].receipt_seq === 1);
    // 서버에 같은 제출 요청을 동시에 5번 보내도 같은 접수번호
    const aTok0 = await tokenOf(aPage, 'rc-applicant');
    const saved = (await q('SELECT data FROM public.applications WHERE posting_id = $1', [postingId]))[0].data;
    const par = await Promise.all(Array.from({ length: 5 }, () => apiAs('applicant', aTok0, { action: 'submit', posting_id: postingId, consent: true, data: saved })));
    check('동시 제출 요청 5번 → 모두 같은 접수번호, 접수 1건', par.every(r => r.result === 'success' && r.receipt_no === receipt) &&
      (await q('SELECT receipt_seq FROM public.postings WHERE id = $1', [postingId]))[0].receipt_seq === 1, JSON.stringify(par[0]));
    check('모바일 화면 가로 넘침 없음', await aPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await aPage.screenshot({ path: path.join(OUT, 'mobile-receipt.png'), fullPage: true });
    const aToken = await tokenOf(aPage, 'rc-applicant');
    const again = await apiAs('applicant', aToken, { action: 'submit', posting_id: postingId, consent: true, data: { basic: { name: '바꿈', phone: '01000000000', birth: '1995-05-05' }, field: '일반행정', education: [{ school: 'x' }], essays: ['x'] } });
    check('수정 불가 공고: 제출 후 내용 변경 거절', again.result === 'error' && /수정할 수 없습니다/.test(again.msg), JSON.stringify(again));
    await aPage.goto(srv.url + '/my.html');
    await aPage.waitForSelector('#my-root .card');
    const myText = await aPage.textContent('#my-root');
    check('지원내역: 제출 완료·접수번호 표시', myText.includes(receipt) && myText.includes('제출 완료'));
    check('지원내역: 공개 전에는 결과 없음', myText.includes('공개된 전형 결과가 없습니다'));

    // ---------------------------------------------------------------- C. 지원자 B: 다른 사람 데이터 접근 차단
    console.log('\n[지원자 B] 다른 지원자 데이터 접근 차단');
    const bCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const bPage = await bCtx.newPage();
    watch(bPage, 'applicantB');
    await bPage.goto(srv.url + '/my.html');
    await bPage.fill('#auth-email', 'applicant.b@example.com');
    await bPage.click('#auth-send');
    await bPage.waitForSelector('#auth-code');
    await bPage.fill('#auth-code', await otp('applicant.b@example.com'));
    await bPage.click('#auth-verify');
    await bPage.waitForSelector('#my-root .empty');
    check('B의 지원내역에 A의 지원서가 보이지 않음', !(await bPage.textContent('#my-root')).includes(receipt));
    const bToken = await tokenOf(bPage, 'rc-applicant');
    const aAtt = (await q('SELECT t.id FROM public.attachments t JOIN public.applications a ON a.id = t.application_id WHERE a.posting_id = $1', [postingId]))[0].id;
    const steal = await apiAs('applicant', bToken, { action: 'file_url', attachment_id: aAtt });
    check('B가 A의 첨부파일 주소 요청 → 거절', steal.result === 'error' && !steal.url);
    const stealDel = await apiAs('applicant', bToken, { action: 'remove_file', attachment_id: aAtt });
    check('B가 A의 첨부파일 삭제 요청 → 거절', stealDel.result === 'error' && srv.mock.files.size === 1);
    const bView = await apiAs('applicant', bToken, { action: 'my_app', posting_id: postingId });
    check('B가 같은 공고 지원서 조회 → 본인 것(없음)만', bView.result === 'success' && bView.application === null);
    const bAdmin = await apiStatus('admin', bToken, { action: 'applications', posting_id: postingId });
    check('지원자 토큰으로 관리자 API → 거절', bAdmin === 403);
    const anonList = await fetch(`${srv.mockUrl}/rest/v1/rpc/admin_applications`, { method: 'POST', headers: { apikey: srv.mock.ANON_KEY, Authorization: 'Bearer ' + bToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_posting_id: postingId, p_q: '', p_stage: '' }) });
    check('지원자 토큰으로 관리자 DB 함수 직접 호출 → 거절', anonList.status === 403);

    // ---------------------------------------------------------------- D. 일반 담당자
    console.log('\n[일반 담당자] 지정 공고 조회·다운로드, 수정·삭제 차단');
    const sCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    staffPage = await sCtx.newPage();
    watch(staffPage, 'staff');
    await staffPage.goto(srv.url + '/admin.html');
    await staffPage.fill('#login-id', 'kim');
    await staffPage.fill('#login-pw', 'staff-pass-1234!');
    await staffPage.click('#login-btn');
    await staffPage.waitForSelector('#tabs [data-tab=apps]');
    check('담당자: OTP 없이 아이디·비밀번호 로그인, 메뉴는 [지원자]만', (await staffPage.$$('#tabs [data-tab]')).length === 1);
    await staffPage.waitForSelector('#a-list table');
    check('담당자: 지정 공고 지원자 목록 조회', (await staffPage.textContent('#a-list')).includes(receipt));
    check('담당자: 일괄 변경·삭제 버튼 없음', !(await staffPage.$('#b-del')));
    const options = await staffPage.$$eval('#a-posting option', os => os.map(o => o.value));
    check('담당자: 지정되지 않은 공고는 목록에 없음', options.length === 1 && options[0] === postingId);
    await staffPage.click('[data-detail]');
    await staffPage.waitForSelector('.modal .print-area');
    check('담당자: 지원서 상세 조회', (await staffPage.textContent('.modal')).includes('가상대학교'));
    const [resp] = await Promise.all([
      staffPage.waitForResponse(r => r.url().endsWith('/api/admin') && (r.request().postData() || '').includes('file_url')),
      staffPage.click('.modal [data-file]')
    ]);
    const signedUrl = (await resp.json()).url;
    const fileRes = await fetch(signedUrl);
    check('담당자: 첨부파일 열람(짧게 유효한 서명 주소)', fileRes.status === 200 && (await fileRes.text()).startsWith('%PDF') && /token=/.test(signedUrl));
    check('다운로드 파일명은 접수번호_서류구분(개인정보 없음)', new URL(signedUrl).searchParams.get('download') === `${receipt}_doc1.pdf`, signedUrl);
    for (const pg of sCtx.pages()) if (pg !== staffPage) await pg.close();
    await staffPage.screenshot({ path: path.join(OUT, 'staff-detail.png'), fullPage: true });
    await staffPage.click('#modal-close');
    const [download] = await Promise.all([staffPage.waitForEvent('download'), staffPage.click('#a-csv')]);
    const csv = fs.readFileSync(await download.path(), 'utf8');
    check('CSV 다운로드(한글 BOM 포함)', csv.charCodeAt(0) === 0xfeff && csv.includes(receipt));
    check('CSV 수식 실행 방지(=로 시작하는 값 앞에 \')', csv.includes("\"'=1+1 가상지원자\""));
    const sToken = await tokenOf(staffPage, 'rc-admin');
    const otherPosting = '20000000-0000-4000-8000-000000000001';
    check('담당자: 미지정 공고 지원자 조회 → 거절', (await apiStatus('admin', sToken, { action: 'applications', posting_id: otherPosting })) === 403);
    check('담당자: 미지정 공고 CSV → 거절', (await apiStatus('admin', sToken, { action: 'export_csv', posting_id: otherPosting })) === 403);
    const appId = (await q('SELECT id FROM public.applications WHERE posting_id = $1', [postingId]))[0].id;
    for (const [label, body] of [
      ['전형 단계 변경', { action: 'set_stage', ids: [appId], stage: 'final_pass' }],
      ['결과 공개', { action: 'publish', ids: [appId], publish: true }],
      ['지원서 삭제', { action: 'delete_applications', ids: [appId] }],
      ['공고 수정', { action: 'save_posting', id: postingId, data: { title: 'x', opens_at: '2026-01-01T00:00', closes_at: '2026-01-02T00:00' } }],
      ['공고 마감', { action: 'set_status', id: postingId, status: 'closed' }],
      ['계정 목록', { action: 'staff_list' }], ['계정 생성', { action: 'staff_create', login_id: 'evil', password: 'evil-password-123' }],
      ['설정 변경', { action: 'save_settings', data: {} }], ['기록 조회', { action: 'logs' }]
    ]) check(`담당자: ${label} → 서버에서 거절`, (await apiStatus('admin', sToken, body)) === 403);
    const rpcStaff = await fetch(`${srv.mockUrl}/rest/v1/rpc/admin_set_stage`, { method: 'POST', headers: { apikey: srv.mock.ANON_KEY, Authorization: 'Bearer ' + sToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_ids: [appId], p_stage: 'final_pass', p_memo: null }) });
    check('담당자: DB 함수 직접 호출로 단계 변경 → DB에서 거절', rpcStaff.status === 403);
    check('담당자 시도 후에도 전형 단계 그대로', (await q('SELECT stage FROM public.application_reviews WHERE application_id = $1', [appId]))[0].stage === 'received');

    // ---------------------------------------------------------------- E. 비공개 저장소·서명 주소
    console.log('\n[첨부파일 저장소] 비공개·서명 주소 (흉내 서버 기준)');
    const objPath = (await q('SELECT storage_path FROM public.attachments WHERE id = $1', [aAtt]))[0].storage_path;
    const direct = await fetch(`${srv.mockUrl}/storage/v1/object/applicant-files/${objPath}`, { headers: { apikey: srv.mock.ANON_KEY, Authorization: 'Bearer ' + bToken } });
    check('서버 키 없이 저장소 파일 직접 다운로드 → 거절', direct.status !== 200);
    const directUp = await fetch(`${srv.mockUrl}/storage/v1/object/applicant-files/x/evil.pdf`, { method: 'POST', headers: { apikey: srv.mock.ANON_KEY, Authorization: 'Bearer ' + bToken }, body: 'x' });
    check('서버 키 없이 저장소에 직접 업로드 → 거절', directUp.status === 403);
    const tampered = signedUrl.replace(/token=([^&]+)/, (m, t) => 'token=' + t.slice(0, -2) + 'xx');
    check('위조한 서명 주소 → 거절', (await fetch(tampered)).status === 400);
    const { createClient } = require('@supabase/supabase-js');
    const svc = createClient(srv.mockUrl, srv.mock.SERVICE_KEY, { auth: { persistSession: false } });
    const short = await svc.storage.from('applicant-files').createSignedUrl(objPath, 1);
    await new Promise(r => setTimeout(r, 2200));
    check('만료된 서명 주소 → 거절', (await fetch(short.data.signedUrl)).status === 400);

    // ---------------------------------------------------------------- F. 결과 공개
    console.log('\n[결과 공개] 담당자가 공개한 결과만 본인에게');
    await adminPage.click('[data-tab=apps]');
    await adminPage.selectOption('#a-posting', postingId);
    await adminPage.waitForSelector('#a-list [data-chk]');
    await adminPage.check('#a-list [data-chk]');
    await adminPage.selectOption('#b-stage', 'doc_pass');
    await adminPage.click('#b-set');
    await adminPage.waitForTimeout(800);
    await aPage.reload();
    await aPage.waitForSelector('#my-root .card');
    check('단계만 바꾸고 공개 전 → 지원자에게 안 보임', !(await aPage.textContent('#my-root')).includes('서류전형 합격'));
    await adminPage.check('#a-list [data-chk]');
    await adminPage.click('#b-pub');
    await adminPage.waitForTimeout(800);
    await aPage.reload();
    await aPage.waitForSelector('#my-root .card');
    check('결과 공개 후 → 본인 지원내역에 표시', (await aPage.textContent('#my-root')).includes('서류전형 합격'));
    await aPage.screenshot({ path: path.join(OUT, 'mobile-my-result.png'), fullPage: true });

    // ---------------------------------------------------------------- G. 마감
    console.log('\n[마감] 서버 시각 기준 마감 후 차단');
    await q("UPDATE public.postings SET closes_at = now() - interval '1 second' WHERE id = $1", [postingId]);
    const late = await apiAs('applicant', bToken, { action: 'save', posting_id: postingId, data: { basic: { name: '늦음' } } });
    check('마감 후 임시저장·접수 거절(서버 시각)', late.result === 'error' && /마감/.test(late.msg), JSON.stringify(late));
    await bPage.goto(srv.url + '/apply.html?id=' + postingId);
    await bPage.waitForSelector('#apply-root .empty');
    check('마감 후 지원서 화면: 마감 안내', /마감/.test(await bPage.textContent('#apply-root')));
    const upload = await apiAs('applicant', bToken, { action: 'upload_begin', posting_id: postingId, doc_key: 'doc1', filename: 'a.pdf', size: 100 });
    check('마감 후 첨부 업로드 거절', upload.result === 'error');

    // ---------------------------------------------------------------- H. 기록·파기
    console.log('\n[기록·파기]');
    await adminPage.click('[data-tab=logs]');
    await adminPage.waitForSelector('#purge-now');
    const logText = await adminPage.textContent('#tab-body');
    check('관리자 기록: 담당자의 명단 조회·CSV·첨부 열람 기록', logText.includes('kim@staff') && logText.includes('CSV 다운로드') && logText.includes('첨부 열람') && logText.includes('명단 조회'));
    await q("UPDATE public.postings SET retention_until = current_date - 2 WHERE id = $1", [postingId]);
    await adminPage.click('#purge-now');
    await adminPage.waitForFunction(() => document.querySelector('#tab-body table') && /수동/.test(document.querySelector('#tab-body').textContent));
    const leftApps = await q('SELECT count(*)::int AS n FROM public.applications WHERE posting_id = $1', [postingId]);
    check('보관기한 지난 지원서 파기', leftApps[0].n === 0);
    check('지원서와 함께 첨부파일도 저장소에서 삭제', srv.mock.files.size === 0);
    const plog = await q('SELECT * FROM public.purge_log ORDER BY run_at DESC LIMIT 1');
    check('파기 실행 결과 기록(지원서 1건·파일 1개·실패 0)', plog[0].applications_deleted === 1 && plog[0].files_deleted === 1 && plog[0].files_failed === 0 && plog[0].ok, JSON.stringify(plog[0]));
    await adminPage.screenshot({ path: path.join(OUT, 'admin-logs.png'), fullPage: true });

    // ---------------------------------------------------------------- I. 데스크톱 화면 캡처·CSP
    const dPage = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    watch(dPage, 'desktop');
    await dPage.goto(srv.url + '/');
    await dPage.waitForSelector('#closed-list table');
    await dPage.screenshot({ path: path.join(OUT, 'desktop-index.png'), fullPage: true });
    await dPage.goto(srv.url + '/privacy.html');
    await dPage.waitForSelector('#privacy-body .notice-box');
    check('개인정보처리방침 미입력 시 [검토 필요] 표시', (await dPage.textContent('#privacy-body')).includes('검토 필요'));
    check('모든 화면에서 CSP 위반·스크립트 오류 없음', cspErrors.length === 0, cspErrors.slice(0, 5).join(' | '));
  } catch (e) {
    check('시나리오 실행 중 오류 없음', false, e.stack);
    for (const [p, n] of [[aPage, 'fail-applicant'], [adminPage, 'fail-admin'], [staffPage, 'fail-staff']]) {
      if (p) await p.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true }).catch(() => {});
    }
  } finally {
    await browser.close();
    await srv.stop();
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n브라우저 통합 검증: ${results.length - failed.length}/${results.length} 통과`);
  fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})();
