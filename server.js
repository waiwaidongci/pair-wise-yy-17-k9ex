const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 封控判定阈值（相对样点基准值） ----------
const TEMP_WARN = 1;    // 温度偏高 ≥1℃ 异常
const TEMP_BAD = 2;     // ≥2℃ 封控
const HUM_WARN = 5;     // 湿度偏低 ≥5% 异常
const HUM_BAD = 10;     // ≥10% 封控
const CO2_WARN = 1.2;   // CO2 超基准 20% 异常
const CO2_BAD = 1.5;    // 超 50% 封控

const RANK = { 正常: 1, 异常: 2, 封控: 3 };
const READING_FIELDS = ['temperature', 'humidity', 'co2', 'dripRate'];

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const db = JSON.parse(raw);
  db.sites = db.sites || [];
  db.surveys = db.surveys || [];
  db.remeasures = db.remeasures || [];
  return db;
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function nowId(collection) {
  return `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

// ---------- 领域规则 ----------

// 按样点基准值对一组读数判定：正常 / 异常 / 封控
function verdict(site, r) {
  const reasons = [];
  let level = '正常';
  const raise = (next) => { if ((RANK[next] || 0) > (RANK[level] || 0)) level = next; };

  const tempDiff = Number(r.temperature) - Number(site.baselineTemp);
  if (tempDiff >= TEMP_BAD) {
    raise('封控');
    reasons.push(`温度偏高${tempDiff.toFixed(1)}℃达封控阈值`);
  } else if (tempDiff >= TEMP_WARN) {
    raise('异常');
    reasons.push(`温度偏高${tempDiff.toFixed(1)}℃`);
  }

  const humDeficit = Number(site.baselineHumidity) - Number(r.humidity);
  if (humDeficit >= HUM_BAD) {
    raise('封控');
    reasons.push(`湿度偏低${humDeficit.toFixed(0)}%达封控阈值`);
  } else if (humDeficit >= HUM_WARN) {
    raise('异常');
    reasons.push(`湿度偏低${humDeficit.toFixed(0)}%`);
  }

  const co2Ratio = Number(r.co2) / Number(site.baselineCo2);
  if (co2Ratio >= CO2_BAD) {
    raise('封控');
    reasons.push(`CO2为基准${(co2Ratio * 100).toFixed(0)}%达封控阈值`);
  } else if (co2Ratio >= CO2_WARN) {
    raise('异常');
    reasons.push(`CO2为基准${(co2Ratio * 100).toFixed(0)}%`);
  }

  return { level, reasons };
}

// 补测两次读数一致：四项读数全部相同
function sameReadings(a, b) {
  return READING_FIELDS.every((f) => Number(a[f]) === Number(b[f]));
}

// 样点保护状态唯一派生口径：
// 存在生效中的封控判定 → 暂停开放；否则有未闭环补测/异常 → 重点保护；否则常规观察。
// 留档巡测永不参与；已复查/已闭环巡测的旧结论不再生效（闭环判定以补测终读为准）。
function deriveSiteStatus(db, site) {
  let severe = false;
  let warn = false;
  const reasons = [];
  const seen = new Set();
  const addReason = (text) => { if (!seen.has(text)) { seen.add(text); reasons.push(text); } };

  for (const s of db.surveys.filter((x) => x.siteId === site.id && x.kind !== '留档')) {
    if (s.status === '已复查' || s.status === '已闭环') continue;
    let v = verdict(site, s);
    if (s.status === '待补测' && v.level === '正常') {
      v = { level: '异常', reasons: ['游客干扰待补测'] };
    }
    if (v.level === '封控') {
      severe = true;
      addReason(`封控判定：${s.date} ${s.surveyor}（${v.reasons.join('，') || '读数达封控阈值'}）`);
    } else if (v.level === '异常') {
      warn = true;
      addReason(`异常判定：${s.date} ${s.surveyor}（${v.reasons.join('，') || '读数异常'}）`);
    }
  }

  for (const rm of db.remeasures.filter((x) => x.siteId === site.id)) {
    if (rm.status === '未闭环') {
      warn = true;
      addReason(`补测未闭环：${rm.initialSurveyor} ${rm.sourceDate || ''}巡测的游客干扰`);
    } else if (rm.closingVerdict === '封控') {
      severe = true;
      addReason('补测两次读数一致，终读仍达封控阈值');
    } else if (rm.closingVerdict === '异常') {
      warn = true;
      addReason('补测已闭环，终读读数仍异常');
    }
  }

  if (severe) return { status: '暂停开放', reasons };
  if (warn) return { status: '重点保护', reasons };
  return { status: '常规观察', reasons: [] };
}

function parseReadings(body) {
  const r = {
    temperature: Number(body.temperature),
    humidity: Number(body.humidity),
    co2: Number(body.co2),
    dripRate: Number(body.dripRate)
  };
  if (READING_FIELDS.some((f) => !Number.isFinite(r[f]))) {
    return { error: '温度、湿度、CO2、滴水频率均须为数字' };
  }
  return { readings: r };
}

function fail(res, code, error) {
  return res.status(code).json({ error });
}

// ---------- 只读：统一派生，保证列表/统计/刷新同源 ----------

app.get('/api/config', (req, res) => res.json(config));

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  const siteMap = new Map(db.sites.map((site) => [site.id, site]));

  for (const survey of db.surveys) {
    const site = siteMap.get(survey.siteId);
    survey._verdict = site && survey.kind !== '留档' ? verdict(site, survey) : null;
  }
  for (const site of db.sites) {
    const derived = deriveSiteStatus(db, site);
    site.protectedStatus = derived.status; // 派生字段，客户端不直接写
    site.statusReasons = derived.reasons;
  }

  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

// ---------- 巡测：登记（每样点每日一条常规；暂停开放只留档） ----------

app.post('/api/surveys', async (req, res) => {
  const db = await readDb();
  const b = req.body || {};
  const site = db.sites.find((x) => x.id === b.siteId);
  if (!site) return fail(res, 404, '样点不存在');
  if (!b.surveyor || !String(b.surveyor).trim()) return fail(res, 400, '请填写巡测人员');
  if (!b.date) return fail(res, 400, '请选择巡测日期');
  const parsed = parseReadings(b);
  if (parsed.error) return fail(res, 400, parsed.error);

  const current = deriveSiteStatus(db, site).status;
  const now = new Date().toISOString();

  const base = {
    id: nowId('survey'),
    siteId: site.id,
    surveyor: String(b.surveyor).trim(),
    date: b.date,
    photoUrl: b.photoUrl || '',
    disturbance: b.disturbance || '',
    createdAt: now,
    updatedAt: now
  };

  let item;
  let note = '';

  if (current === '暂停开放') {
    // 暂停开放样点：只能留档，不占常规额度，不改变保护状态
    item = {
      ...base,
      ...parsed.readings,
      kind: '留档',
      status: '留档',
      conclusionLevel: '留档',
      conclusionReason: '暂停开放期间留档，不参与封控判定',
      superseded: [],
      history: [stamp('留档登记', '样点暂停开放，仅留档，不占常规额度，不改变保护状态')]
    };
    note = '样点已暂停开放，本次巡测仅留档';
  } else {
    const duplicate = db.surveys.some(
      (x) => x.siteId === site.id && x.date === b.date && x.kind === '常规'
    );
    if (duplicate) return fail(res, 409, '该样点当日已有常规巡测，每样点每天仅限一条');

    const v = verdict(site, parsed.readings);
    item = {
      ...base,
      ...parsed.readings,
      kind: '常规',
      status: v.level === '正常' ? '正常' : '异常待复查',
      conclusionLevel: v.level,
      conclusionReason: v.reasons.join('，'),
      superseded: [],
      history: [stamp('登记巡测', `常规巡测 · 判定${v.level}${v.reasons.length ? '：' + v.reasons.join('，') : ''}`)]
    };
    note = v.level === '正常' ? '常规巡测已登记' : `读数判定${v.level}，样点转为${v.level === '封控' ? '暂停开放' : '重点保护'}`;
  }

  db.surveys.push(item);
  await writeDb(db);
  res.status(201).json({ item, note });
});

// ---------- 巡测更正：旧结论失效，按更正值重判封控 ----------

app.post('/api/surveys/:id/correct', async (req, res) => {
  const db = await readDb();
  const survey = db.surveys.find((x) => x.id === req.params.id);
  if (!survey) return fail(res, 404, '巡测不存在');
  const site = db.sites.find((x) => x.id === survey.siteId);
  const parsed = parseReadings(req.body || {});
  if (parsed.error) return fail(res, 400, parsed.error);

  const now = new Date().toISOString();
  survey.superseded = survey.superseded || [];
  survey.superseded.push({
    at: now,
    level: survey.conclusionLevel || survey.status,
    reason: survey.conclusionReason || '',
    readings: READING_FIELDS.reduce((o, f) => ({ ...o, [f]: survey[f] }), {})
  });
  Object.assign(survey, parsed.readings);
  if (typeof (req.body || {}).disturbance === 'string') survey.disturbance = req.body.disturbance;

  let note = '';
  if (survey.kind === '留档') {
    // 留档记录可更正留档内容，但永不改变样点保护状态
    survey.history = survey.history || [];
    survey.history.unshift(stamp('留档更正', '旧留档读数已替换，不改变保护状态'));
    note = '留档已更正，样点保护状态不变';
  } else {
    const v = verdict(site, survey);
    survey.conclusionLevel = v.level;
    survey.conclusionReason = v.reasons.join('，');
    if (survey.status !== '待补测') {
      survey.status = v.level === '正常' ? '正常' : '异常待复查';
    }
    survey.history = survey.history || [];
    survey.history.unshift(stamp('按更正值重判封控', `旧结论失效，新判定：${v.level}${v.reasons.length ? '（' + v.reasons.join('，') + '）' : ''}`));
    const derived = deriveSiteStatus(db, site);
    note = `旧结论已失效，按更正值重判为${v.level}，样点保护状态：${derived.status}`;
  }
  survey.updatedAt = now;

  await writeDb(db);
  res.json({ item: survey, note });
});

// ---------- 游客干扰标记：建立（或沿用）未闭环补测 ----------

app.post('/api/surveys/:id/disturbance', async (req, res) => {
  const db = await readDb();
  const survey = db.surveys.find((x) => x.id === req.params.id);
  if (!survey) return fail(res, 404, '巡测不存在');
  if (survey.kind === '留档') return fail(res, 409, '暂停开放样点的留档记录不建立补测，也不得改变保护状态');
  if (typeof (req.body || {}).disturbance === 'string' && req.body.disturbance.trim()) {
    survey.disturbance = req.body.disturbance.trim();
  }
  if (!survey.disturbance || !survey.disturbance.trim()) {
    return fail(res, 409, '请先填写游客干扰痕迹，再标记建立补测');
  }

  // 重复补测沿用首次记录，不再新建
  const existing = db.remeasures.find((x) => x.sourceSurveyId === survey.id);
  if (existing) {
    return res.json({ item: existing, note: '该巡测已建立补测，沿用首次补测记录' });
  }

  const now = new Date().toISOString();
  const rmeasure = {
    id: nowId('remeasure'),
    siteId: survey.siteId,
    sourceSurveyId: survey.id,
    sourceDate: survey.date,
    initialSurveyor: survey.surveyor,
    disturbance: survey.disturbance,
    status: '未闭环',
    readings: [],
    closingVerdict: null,
    createdAt: now,
    updatedAt: now,
    history: [stamp('建立补测', `游客干扰标记，原巡测人 ${survey.surveyor}；补测须由其他人员完成`)]
  };
  survey.status = '待补测';
  survey.updatedAt = now;
  survey.history = survey.history || [];
  survey.history.unshift(stamp('标记游客干扰', '建立未闭环补测，样点保持重点保护'));
  db.remeasures.push(rmeasure);
  await writeDb(db);
  res.status(201).json({ item: rmeasure, note: '已建立未闭环补测，样点保持重点保护' });
});

// ---------- 非干扰异常复查 ----------

app.post('/api/surveys/:id/review', async (req, res) => {
  const db = await readDb();
  const survey = db.surveys.find((x) => x.id === req.params.id);
  if (!survey) return fail(res, 404, '巡测不存在');
  if (survey.kind === '留档') return fail(res, 409, '留档记录无需复查');
  if (survey.status === '待补测') return fail(res, 409, '游客干扰须由不同人员补测，两次读数一致后闭环');
  if (survey.status === '已复查' || survey.status === '已闭环') return fail(res, 409, '该巡测已闭环');

  const now = new Date().toISOString();
  survey.status = '已复查';
  survey.updatedAt = now;
  survey.history = survey.history || [];
  survey.history.unshift(stamp('完成复查', '异常已复核，原异常结论失效'));
  const site = db.sites.find((x) => x.id === survey.siteId);
  const derived = deriveSiteStatus(db, site);
  await writeDb(db);
  res.json({ item: survey, note: `复查完成，样点保护状态：${derived.status}` });
});

// ---------- 补测读数：不同人员 + 连续两次一致才闭环 ----------

app.post('/api/remeasures/:id/readings', async (req, res) => {
  const db = await readDb();
  const rm = db.remeasures.find((x) => x.id === req.params.id);
  if (!rm) return fail(res, 404, '补测单不存在');
  if (rm.status !== '未闭环') return fail(res, 409, '补测已闭环，记录已封存');

  const b = req.body || {};
  const surveyor = String(b.surveyor || '').trim();
  if (!surveyor) return fail(res, 400, '请填写补测人员');
  if (surveyor === rm.initialSurveyor) {
    return fail(res, 409, `补测须由原巡测人（${rm.initialSurveyor}）以外的人员完成`);
  }
  const parsed = parseReadings(b);
  if (parsed.error) return fail(res, 400, parsed.error);

  const now = new Date().toISOString();
  const last = rm.readings[rm.readings.length - 1];

  // 重复补测沿用首次记录：与上一条完全相同的提交不重复入账
  if (last && last.surveyor === surveyor && sameReadings(last, parsed.readings)) {
    return res.json({ item: rm, note: '与最近一次补测完全相同，沿用已有记录，未重复登记' });
  }

  const entry = { at: now, surveyor, ...parsed.readings, matched: false };
  if (last && sameReadings(last, entry)) entry.matched = true;
  rm.readings.push(entry);
  rm.updatedAt = now;

  const survey = db.surveys.find((x) => x.id === rm.sourceSurveyId);
  const site = db.sites.find((x) => x.id === rm.siteId);
  let note = '';

  if (entry.matched) {
    const v = verdict(site, entry);
    rm.status = '已闭环';
    rm.closedAt = now;
    rm.closingVerdict = v.level;
    rm.history = rm.history || [];
    rm.history.unshift(stamp('补测闭环', `连续两次读数一致（${surveyor}），终读判定${v.level}`));
    if (survey) {
      survey.status = '已闭环';
      survey.conclusionLevel = v.level;
      survey.conclusionReason = `补测终读判定${v.level}`;
      survey.updatedAt = now;
      survey.history = survey.history || [];
      survey.history.unshift(stamp('补测闭环', `两次读数一致，按终读判定${v.level}`));
    }
    const derived = deriveSiteStatus(db, site);
    note = `连续两次读数一致，补测闭环；终读判定${v.level}，样点保护状态：${derived.status}`;
  } else {
    rm.history = rm.history || [];
    rm.history.unshift(stamp(last ? '补测读数不一致' : '首次补测读数', `${surveyor} 提交，等待再一次一致读数`));
    note = last
      ? '本次读数与上一次不一致，补测保持未闭环，样点维持重点保护'
      : '首次补测读数已登记，尚需一次一致读数才能闭环';
  }

  await writeDb(db);
  res.status(201).json({ item: rm, note });
});

// ---------- 样点：通用建档/编辑（保护状态为派生字段，拒绝直写） ----------

app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return fail(res, 404, 'unknown collection');
  const body = req.body || {};
  delete body.protectedStatus;
  delete body.statusReasons;
  const now = new Date().toISOString();
  const item = {
    id: nowId(collection),
    ...body,
    protectedStatus: '常规观察',
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', body.note || body.memo || '')]
  };
  db[collection].push(item);
  await writeDb(db);
  res.status(201).json({ item });
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return fail(res, 404, 'unknown collection');
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return fail(res, 404, 'not found');
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  delete req.body.protectedStatus;
  delete req.body.statusReasons;
  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo) {
    item.history.unshift(stamp(historyAction || '更新', req.body.note || req.body.memo || ''));
  }
  await writeDb(db);
  res.json({ item });
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return fail(res, 404, 'unknown collection');
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (db[collection].length === before) return fail(res, 404, 'not found');
  if (collection === 'surveys') {
    db.remeasures = db.remeasures.filter((rm) => rm.sourceSurveyId !== id);
  }
  await writeDb(db);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
