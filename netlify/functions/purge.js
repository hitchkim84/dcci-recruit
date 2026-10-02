// 매일 자동 실행되는 파기 작업(Netlify Scheduled Function, 시간은 netlify.toml의 schedule).
// 외부에서 이 주소를 불러도 '보관기한이 지난 것만 지우는' 같은 작업이 한 번 더 도는 것뿐이다.
const { runPurge } = require('../lib/purge');

exports.handler = async function () {
  const r = await runPurge('schedule');
  console.log('purge result:', JSON.stringify(r));
  return { statusCode: 200, body: '' };
};
