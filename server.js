const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function touch(item, action, note) {
  item.updatedAt = new Date().toISOString();
  item.history = item.history || [];
  item.history.unshift(stamp(action, note));
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

const JUDGE = config.judge || { tempTolerance: 1, humidityTolerance: 5, co2Tolerance: 200 };

// 按基准值判定巡测结论：任一指标超差即异常
function judgeSurvey(site, readings) {
  if (!site) return '正常';
  if (Math.abs(Number(readings.temperature) - Number(site.baselineTemp)) > JUDGE.tempTolerance) return '异常待复查';
  if (Math.abs(Number(readings.humidity) - Number(site.baselineHumidity)) > JUDGE.humidityTolerance) return '异常待复查';
  if (Number(readings.co2) - Number(site.baselineCo2) > JUDGE.co2Tolerance) return '异常待复查';
  return '正常';
}

function openRecheckForSite(db, siteId) {
  return (db.rechecks || []).find((entry) => entry.siteId === siteId && entry.status === '未闭环');
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

// 登记巡测：每样点每天只准一条常规巡测；暂停开放样点仅留档，不占额度、不改状态
app.post('/api/surveys', async (req, res) => {
  const db = await readDb();
  const site = db.sites.find((entry) => entry.id === req.body.siteId);
  if (!site) return res.status(400).json({ error: '关联样点不存在' });
  if (!req.body.date) return res.status(400).json({ error: '请填写巡测日期' });
  const archived = site.protectedStatus === '暂停开放';
  if (!archived) {
    const duplicate = db.surveys.find((entry) => entry.siteId === site.id && entry.date === req.body.date && entry.kind === '常规');
    if (duplicate) {
      return res.status(409).json({ error: `样点 ${site.pointCode} 在 ${req.body.date} 已有常规巡测，每个样点每天只准一条` });
    }
  }
  const now = new Date().toISOString();
  const survey = {
    id: newId('surveys'),
    siteId: site.id,
    surveyor: req.body.surveyor || '',
    date: req.body.date,
    temperature: Number(req.body.temperature),
    humidity: Number(req.body.humidity),
    co2: Number(req.body.co2),
    dripRate: Number(req.body.dripRate),
    photoUrl: req.body.photoUrl || '',
    disturbance: req.body.disturbance || '',
    kind: archived ? '留档' : '常规',
    status: archived ? '留档' : judgeSurvey(site, req.body),
    reviewNote: '',
    corrections: [],
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', archived ? '暂停开放样点，仅留档不占常规额度' : '常规巡测登记')]
  };
  db.surveys.push(survey);
  if (!archived && survey.status === '异常待复查' && site.protectedStatus !== '重点保护') {
    site.protectedStatus = '重点保护';
    touch(site, '重点保护', `巡测读数超差（${survey.date}），自动封控`);
  }
  await writeDb(db);
  res.status(201).json(survey);
});

// 标记游客干扰：建立未闭环补测；同一样点已有未闭环补测时沿用首次记录
app.post('/api/surveys/:id/mark-disturbance', async (req, res) => {
  const db = await readDb();
  const survey = db.surveys.find((entry) => entry.id === req.params.id);
  if (!survey) return res.status(404).json({ error: '巡测记录不存在' });
  const site = db.sites.find((entry) => entry.id === survey.siteId);
  if (survey.kind === '留档' || !site || site.protectedStatus === '暂停开放') {
    return res.status(409).json({ error: '暂停开放样点只能留档，不建立补测，也不改变保护状态' });
  }
  survey.status = '异常待复查';
  survey.reviewNote = '游客干扰，已建立未闭环补测';
  touch(survey, '标记游客干扰', survey.disturbance || '现场发现游客干扰痕迹');
  let recheck = openRecheckForSite(db, survey.siteId);
  let reused = false;
  if (recheck) {
    reused = true;
    touch(recheck, '重复标记', '该样点已有未闭环补测，沿用首次记录');
  } else {
    recheck = {
      id: newId('rechecks'),
      surveyId: survey.id,
      siteId: survey.siteId,
      originSurveyor: survey.surveyor,
      disturbance: survey.disturbance || '',
      status: '未闭环',
      entries: [],
      closedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [stamp('建立补测', `来源巡测 ${survey.date} / ${survey.surveyor}，须不同人员两次读数一致方可闭环`)]
    };
    db.rechecks.push(recheck);
  }
  if (site.protectedStatus !== '重点保护') {
    site.protectedStatus = '重点保护';
    touch(site, '重点保护', '游客干扰补测未闭环，期间保持重点保护');
  }
  await writeDb(db);
  res.json({ recheck, reused, survey });
});

// 更正巡测：旧结论失效，按更正值重判封控；留档记录只修正读数，不动保护状态
app.post('/api/surveys/:id/correct', async (req, res) => {
  const db = await readDb();
  const survey = db.surveys.find((entry) => entry.id === req.params.id);
  if (!survey) return res.status(404).json({ error: '巡测记录不存在' });
  const site = db.sites.find((entry) => entry.id === survey.siteId);
  const fields = ['temperature', 'humidity', 'co2', 'dripRate'];
  const before = {};
  const after = {};
  for (const field of fields) {
    before[field] = survey[field];
    after[field] = req.body[field] === undefined || req.body[field] === '' ? survey[field] : Number(req.body[field]);
  }
  const oldStatus = survey.status;
  survey.corrections = survey.corrections || [];
  survey.corrections.unshift({
    at: new Date().toISOString(),
    before,
    after,
    oldStatus,
    reason: req.body.reason || ''
  });
  Object.assign(survey, after);
  if (survey.kind === '留档') {
    touch(survey, '更正留档', '暂停开放样点仅修正留档读数，不改变保护状态');
    await writeDb(db);
    return res.json({ survey, siteUnchanged: true });
  }
  const newStatus = judgeSurvey(site, survey);
  survey.status = newStatus;
  touch(survey, '更正巡测', `旧结论「${oldStatus}」失效，按更正值重判为「${newStatus}」${req.body.reason ? '：' + req.body.reason : ''}`);
  if (site && site.protectedStatus !== '暂停开放') {
    if (newStatus === '异常待复查') {
      if (site.protectedStatus !== '重点保护') {
        site.protectedStatus = '重点保护';
        touch(site, '重点保护', '更正值超差，重判封控为重点保护');
      }
    } else if (site.protectedStatus === '重点保护' && !openRecheckForSite(db, site.id)) {
      site.protectedStatus = '常规观察';
      touch(site, '常规观察', '更正值恢复正常且无未闭环补测，解除封控');
    }
  }
  await writeDb(db);
  res.json({ survey, site });
});

// 登记补测读数：须不同人员完成，重复补测沿用首次记录，连续两次读数一致才能闭环
app.post('/api/rechecks/:id/entries', async (req, res) => {
  const db = await readDb();
  const recheck = (db.rechecks || []).find((entry) => entry.id === req.params.id);
  if (!recheck) return res.status(404).json({ error: '补测任务不存在' });
  if (recheck.status === '已闭环') return res.status(409).json({ error: '补测已闭环，不能再登记读数' });
  const surveyor = String(req.body.surveyor || '').trim();
  if (!surveyor) return res.status(400).json({ error: '请填写补测人员' });
  if (surveyor === recheck.originSurveyor) {
    return res.status(409).json({ error: `补测须由不同人员完成（原巡测人员：${recheck.originSurveyor}）` });
  }
  const entry = {
    surveyor,
    temperature: Number(req.body.temperature),
    humidity: Number(req.body.humidity),
    co2: Number(req.body.co2),
    note: req.body.note || '',
    at: new Date().toISOString()
  };
  recheck.entries = recheck.entries || [];
  const duplicate = recheck.entries.find((existing) =>
    existing.surveyor === entry.surveyor &&
    existing.temperature === entry.temperature &&
    existing.humidity === entry.humidity &&
    existing.co2 === entry.co2
  );
  if (duplicate) {
    return res.json({ recheck, reused: true, closed: false });
  }
  recheck.entries.push(entry);
  touch(recheck, '补测读数', `${surveyor}：${entry.temperature}℃ / ${entry.humidity}% / ${entry.co2}ppm`);
  let closed = false;
  const count = recheck.entries.length;
  if (count >= 2) {
    const prev = recheck.entries[count - 2];
    const last = recheck.entries[count - 1];
    if (prev.temperature === last.temperature && prev.humidity === last.humidity && prev.co2 === last.co2) {
      recheck.status = '已闭环';
      recheck.closedAt = new Date().toISOString();
      touch(recheck, '补测闭环', `${prev.surveyor} 与 ${last.surveyor} 连续两次读数一致`);
      const origin = db.surveys.find((entry) => entry.id === recheck.surveyId);
      if (origin && origin.status === '异常待复查') {
        origin.status = '已复查';
        origin.reviewNote = '补测连续两次读数一致，闭环';
        touch(origin, '已复查', '补测闭环，旧异常结论复核完成');
      }
      closed = true;
    }
  }
  await writeDb(db);
  res.json({ recheck, reused: false, closed });
});

app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  if (collection === 'rechecks') return res.status(405).json({ error: '补测只能通过游客干扰标记建立' });
  const now = new Date().toISOString();
  const item = {
    id: newId(collection),
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  db[collection].push(item);
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  await writeDb(db);
  res.json(item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
  await writeDb(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });
  await writeDb(db);
  res.json(result.item);
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    if (guard.op === 'noOpenRecheck') {
      const blocked = (db.rechecks || []).some((entry) => entry.siteId === item.id && entry.status === '未闭环');
      if (blocked) return { error: guard.message };
      continue;
    }
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
