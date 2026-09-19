// 端到端冒烟：启动独立实例（临时数据库），逐条验证封控与补测规则
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function api(pathName, options = {}) {
  const res = await fetch(`${BASE}${pathName}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

const post = (pathName, payload) => api(pathName, { method: 'POST', body: JSON.stringify(payload ?? {}) });

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'cave-smoke-'));
  const dbFile = path.join(dir, 'db.json');
  await copyFile(new URL('../data/db.json', import.meta.url), dbFile);

  const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile },
    stdio: 'ignore'
  });
  await new Promise((resolve) => setTimeout(resolve, 900));

  try {
    console.log('1. 常规巡测每日额度');
    const today = '2026-09-19';
    let r = await post('/api/surveys', { siteId: 'site-seed-2', surveyor: '测试员甲', date: today, temperature: 15.9, humidity: 94, co2: 640, dripRate: 6 });
    check('首条常规巡测创建成功', r.status === 201 && r.body.kind === '常规' && r.body.status === '正常', JSON.stringify(r.body));
    const routineId = r.body.id;
    r = await post('/api/surveys', { siteId: 'site-seed-2', surveyor: '测试员乙', date: today, temperature: 15.8, humidity: 95, co2: 630, dripRate: 6 });
    check('同样点同日第二条常规巡测被拒', r.status === 409, `got ${r.status}`);
    r = await post('/api/surveys', { siteId: 'site-seed-2', surveyor: '测试员乙', date: '2026-09-20', temperature: 15.8, humidity: 95, co2: 630, dripRate: 6 });
    check('换一天可再登记', r.status === 201, `got ${r.status}`);

    console.log('2. 暂停开放样点仅留档');
    r = await post('/api/surveys', { siteId: 'site-seed-3', surveyor: '测试员甲', date: today, temperature: 15.0, humidity: 96, co2: 560, dripRate: 3 });
    check('暂停开放样点巡测自动留档', r.status === 201 && r.body.kind === '留档' && r.body.status === '留档', JSON.stringify(r.body));
    const archiveId = r.body.id;
    r = await post('/api/surveys', { siteId: 'site-seed-3', surveyor: '测试员乙', date: today, temperature: 15.1, humidity: 96, co2: 555, dripRate: 3 });
    check('留档不占常规额度（同日可再留档）', r.status === 201 && r.body.kind === '留档', `got ${r.status}`);
    let db = (await api('/api/db')).body;
    check('留档后保护状态不变', db.sites.find((s) => s.id === 'site-seed-3').protectedStatus === '暂停开放');
    r = await post(`/api/surveys/${archiveId}/mark-disturbance`);
    check('留档记录标记干扰被拒', r.status === 409, `got ${r.status}`);
    db = (await api('/api/db')).body;
    check('留档标记后保护状态仍不变', db.sites.find((s) => s.id === 'site-seed-3').protectedStatus === '暂停开放');

    console.log('3. 游客干扰建立未闭环补测');
    r = await post(`/api/surveys/${routineId}/mark-disturbance`);
    check('标记干扰建立补测', r.status === 200 && r.body.recheck?.status === '未闭环' && !r.body.reused, JSON.stringify(r.body));
    const recheckId = r.body.recheck.id;
    db = (await api('/api/db')).body;
    check('样点转入重点保护', db.sites.find((s) => s.id === 'site-seed-2').protectedStatus === '重点保护');
    check('其他样点不受影响', db.sites.find((s) => s.id === 'site-seed-1').protectedStatus === '重点保护' && db.sites.find((s) => s.id === 'site-seed-3').protectedStatus === '暂停开放');
    r = await post(`/api/surveys/${routineId}/mark-disturbance`);
    check('重复标记沿用首次补测', r.status === 200 && r.body.reused === true && r.body.recheck.id === recheckId, JSON.stringify(r.body));
    db = (await api('/api/db')).body;
    check('未产生第二条补测', db.rechecks.filter((x) => x.siteId === 'site-seed-2').length === 1);

    console.log('4. 补测未闭环期间保持重点保护');
    r = await post('/api/action/site-normal/site-seed-2');
    check('未闭环时转常规观察被拒', r.status === 409, `got ${r.status}`);
    r = await post('/api/action/site-close/site-seed-2');
    check('未闭环时暂停开放被拒', r.status === 409, `got ${r.status}`);
    db = (await api('/api/db')).body;
    check('样点仍为重点保护', db.sites.find((s) => s.id === 'site-seed-2').protectedStatus === '重点保护');

    console.log('5. 补测读数：不同人员 + 去重 + 两次一致闭环');
    r = await post(`/api/rechecks/${recheckId}/entries`, { surveyor: '测试员甲', temperature: 16, humidity: 90, co2: 700 });
    check('原巡测人员补测被拒', r.status === 409, `got ${r.status}`);
    r = await post(`/api/rechecks/${recheckId}/entries`, { surveyor: '补测员乙', temperature: 16, humidity: 90, co2: 700 });
    check('不同人员首次读数登记成功', r.status === 200 && r.body.recheck.entries.length === 1 && !r.body.closed, JSON.stringify(r.body));
    r = await post(`/api/rechecks/${recheckId}/entries`, { surveyor: '补测员乙', temperature: 16, humidity: 90, co2: 700 });
    check('重复补测沿用首次记录', r.status === 200 && r.body.reused === true && r.body.recheck.entries.length === 1, JSON.stringify(r.body));
    r = await post(`/api/rechecks/${recheckId}/entries`, { surveyor: '补测员乙', temperature: 17, humidity: 90, co2: 700 });
    check('不同读数可登记为第二条', r.status === 200 && r.body.recheck.entries.length === 2 && !r.body.closed);
    r = await post(`/api/rechecks/${recheckId}/entries`, { surveyor: '补测员丙', temperature: 17, humidity: 90, co2: 700 });
    check('连续两次读数一致闭环', r.status === 200 && r.body.closed === true && r.body.recheck.status === '已闭环', JSON.stringify(r.body));
    db = (await api('/api/db')).body;
    check('原巡测转为已复查', db.surveys.find((s) => s.id === routineId).status === '已复查');
    r = await post(`/api/rechecks/${recheckId}/entries`, { surveyor: '补测员丁', temperature: 17, humidity: 90, co2: 700 });
    check('闭环后不能再登记', r.status === 409, `got ${r.status}`);
    r = await post('/api/action/site-normal/site-seed-2');
    check('闭环后状态锁定解除', r.status === 200 && r.body.protectedStatus === '常规观察', JSON.stringify(r.body));

    console.log('6. 更正巡测：旧结论失效并重判封控');
    r = await post('/api/surveys', { siteId: 'site-seed-2', surveyor: '测试员甲', date: '2026-09-21', temperature: 18.5, humidity: 80, co2: 990, dripRate: 9 });
    check('超差巡测自动判异常', r.status === 201 && r.body.status === '异常待复查', JSON.stringify(r.body));
    const abnormalId = r.body.id;
    db = (await api('/api/db')).body;
    check('异常巡测自动封控重点保护', db.sites.find((s) => s.id === 'site-seed-2').protectedStatus === '重点保护');
    r = await post(`/api/surveys/${abnormalId}/correct`, { temperature: 15.9, humidity: 94, co2: 640, dripRate: 6, reason: '传感器未校准' });
    check('更正后旧结论失效重判为正常', r.status === 200 && r.body.survey.status === '正常', JSON.stringify(r.body.survey));
    check('更正记录留痕', r.body.survey.corrections.length === 1 && r.body.survey.corrections[0].oldStatus === '异常待复查');
    db = (await api('/api/db')).body;
    check('更正值正常且无未闭环补测，解除封控', db.sites.find((s) => s.id === 'site-seed-2').protectedStatus === '常规观察');
    r = await post(`/api/surveys/${abnormalId}/correct`, { temperature: 19.1, humidity: 78, co2: 1010, dripRate: 9, reason: '复核确认超差' });
    check('再次更正为超差，重判异常', r.status === 200 && r.body.survey.status === '异常待复查');
    db = (await api('/api/db')).body;
    check('重新封控为重点保护', db.sites.find((s) => s.id === 'site-seed-2').protectedStatus === '重点保护');
    r = await post(`/api/surveys/${archiveId}/correct`, { temperature: 15.2, humidity: 96, co2: 560, dripRate: 3 });
    check('留档记录可更正但不改状态', r.status === 200 && r.body.siteUnchanged === true && r.body.survey.status === '留档');
    db = (await api('/api/db')).body;
    check('留档更正后样点仍暂停开放', db.sites.find((s) => s.id === 'site-seed-3').protectedStatus === '暂停开放');

    console.log('7. 刷新后列表与统计一致');
    db = (await api('/api/db')).body;
    const routineToday = db.surveys.filter((s) => s.kind === '常规' && s.date === today).length;
    check('今日常规巡测统计口径正确', routineToday === 1, `got ${routineToday}`);
    check('留档记录计入留档而非巡测状态', db.surveys.filter((s) => s.kind === '留档').length === 2);
    check('补测闭环状态持久', db.rechecks.find((x) => x.id === recheckId).status === '已闭环');
    const raw = JSON.parse(await readFile(dbFile, 'utf8'));
    check('数据已落盘（刷新一致）', raw.rechecks.find((x) => x.id === recheckId).entries.length === 3);
  } finally {
    server.kill();
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
