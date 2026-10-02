// 지원서 입력 규칙 — 화면(브라우저)과 서버(netlify/lib)가 같은 파일을 쓴다.
// DB 함수(sql/02_common_public.sql의 rc_validate_application)와 같은 기준으로 유지한다. 하나를 바꾸면 다른 쪽도 바꾼다.
(function (root) {
  'use strict';

  var STAGES = {
    received: '접수 완료', doc_pass: '서류전형 합격', doc_fail: '서류전형 불합격',
    written_pass: '필기전형 합격', written_fail: '필기전형 불합격', interview_pass: '면접전형 합격',
    interview_fail: '면접전형 불합격', final_pass: '최종 합격', final_fail: '최종 불합격', hold: '보류'
  };
  var ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'hwp', 'hwpx', 'docx'];
  // 증명사진(공고 설정 photo.use일 때만, 서류 구분값 'photo'): sql/03 begin_attachment와 같은 기준
  var PHOTO_EXT = ['jpg', 'jpeg', 'png'];
  var PHOTO_MAX_MB = 2;
  var ITEM_KEYS = {
    education: ['school', 'major', 'degree', 'from', 'to', 'state'],
    career: ['org', 'dept', 'title', 'from', 'to', 'duties'],
    certs: ['name', 'issuer', 'date']
  };
  var ITEM_MAX = { education: 10, career: 20, certs: 20 };
  var SECTION_LABEL = { education: '학력', career: '경력', certs: '자격사항' };
  var PHONE_RE = /^[0-9 -]+$/;
  var BIRTH_RE = /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

  function s(v) { return v === undefined || v === null ? '' : String(v).trim(); }
  function cfgOf(posting) { return (posting && posting.form_config) || {}; }
  function on(obj, key) { return !!(obj && obj[key] === true); }

  // 오류가 있으면 { field, msg }를, 없으면 null을 돌려준다. field는 화면에서 강조할 입력칸 id.
  function validateApplication(posting, data, final) {
    var cfg = cfgOf(posting);
    var basicCfg = cfg.basic || {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { field: '', msg: '지원서 형식이 올바르지 않습니다.' };
    if (JSON.stringify(data).length > 200000) return { field: '', msg: '지원서 내용이 너무 깁니다.' };
    var b = data.basic || {};
    var name = s(b.name), phone = s(b.phone), birth = s(b.birth), addr = s(b.address), mil = s(b.military);
    if (name.length > 50) return { field: 'f-name', msg: '성명이 너무 깁니다.' };
    if (phone.length > 20) return { field: 'f-phone', msg: '휴대폰 번호가 너무 깁니다.' };
    if (addr.length > 200) return { field: 'f-address', msg: '주소가 너무 깁니다.' };
    if (mil.length > 50) return { field: 'f-military', msg: '병역사항이 너무 깁니다.' };
    var digits = phone.replace(/\D/g, '');
    if (phone && (!PHONE_RE.test(phone) || digits.length < 9 || digits.length > 11)) return { field: 'f-phone', msg: '휴대폰 번호를 정확히 입력해주세요.' };
    if (birth && !BIRTH_RE.test(birth)) return { field: 'f-birth', msg: '생년월일은 YYYY-MM-DD 형식으로 입력해주세요.' };
    if (final) {
      if (!name) return { field: 'f-name', msg: '성명을 입력해주세요.' };
      if (!phone) return { field: 'f-phone', msg: '휴대폰 번호를 입력해주세요.' };
      if (on(basicCfg, 'birth') && !birth) return { field: 'f-birth', msg: '생년월일을 입력해주세요.' };
      if (on(basicCfg, 'address') && !addr) return { field: 'f-address', msg: '주소를 입력해주세요.' };
    }
    var names = ((posting && posting.fields) || []).map(function (f) { return s(f && f.name); }).filter(Boolean);
    var field = s(data.field);
    if (names.length > 1) {
      if (field && names.indexOf(field) < 0) return { field: 'f-field', msg: '모집 분야를 다시 선택해주세요.' };
      if (final && !field) return { field: 'f-field', msg: '지원 분야를 선택해주세요.' };
    }
    var sections = ['education', 'career', 'certs'];
    for (var i = 0; i < sections.length; i++) {
      var sec = sections[i];
      var arr = data[sec];
      if (arr === undefined || arr === null) arr = [];
      if (!Array.isArray(arr)) return { field: 'sec-' + sec, msg: SECTION_LABEL[sec] + ' 형식이 올바르지 않습니다.' };
      if (arr.length > ITEM_MAX[sec]) return { field: 'sec-' + sec, msg: SECTION_LABEL[sec] + '은(는) 최대 ' + ITEM_MAX[sec] + '개까지 입력할 수 있습니다.' };
      var filled = 0;
      for (var j = 0; j < arr.length; j++) {
        var item = arr[j];
        if (!item || typeof item !== 'object') return { field: 'sec-' + sec, msg: SECTION_LABEL[sec] + ' 형식이 올바르지 않습니다.' };
        var any = false;
        for (var k = 0; k < ITEM_KEYS[sec].length; k++) {
          var key = ITEM_KEYS[sec][k];
          var val = s(item[key]);
          if (val.length > (key === 'duties' ? 1000 : 100)) return { field: 'sec-' + sec, msg: SECTION_LABEL[sec] + ' 항목의 입력값이 너무 깁니다.' };
          if (val) any = true;
        }
        if (any) filled++;
      }
      var sc = cfg[sec] || {};
      if (final && on(sc, 'use') && on(sc, 'required') && filled === 0) return { field: 'sec-' + sec, msg: SECTION_LABEL[sec] + '을(를) 1개 이상 입력해주세요.' };
    }
    var essays = cfg.essays || [];
    var answers = data.essays === undefined || data.essays === null ? [] : data.essays;
    if (!Array.isArray(answers)) return { field: 'sec-essays', msg: '자기소개 형식이 올바르지 않습니다.' };
    for (var e = 0; e < essays.length; e++) {
      var max = essays[e].max_len || 1000;
      var ans = answers[e] === undefined || answers[e] === null ? '' : String(answers[e]);
      if (ans.length > max) return { field: 'f-essay-' + e, msg: '자기소개 ' + (e + 1) + '번 문항은 ' + max + '자 이내로 작성해주세요.' };
      if (final && essays[e].required && !ans.trim()) return { field: 'f-essay-' + e, msg: '자기소개 ' + (e + 1) + '번 문항을 작성해주세요.' };
    }
    return null;
  }

  function extOf(filename) {
    var m = /\.([A-Za-z0-9]{1,10})$/.exec(String(filename || ''));
    return m ? m[1].toLowerCase() : '';
  }

  var R = { STAGES: STAGES, ALLOWED_EXT: ALLOWED_EXT, PHOTO_EXT: PHOTO_EXT, PHOTO_MAX_MB: PHOTO_MAX_MB, ITEM_KEYS: ITEM_KEYS, ITEM_MAX: ITEM_MAX, validateApplication: validateApplication, extOf: extOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
  else root.RCRules = R;
})(this);
