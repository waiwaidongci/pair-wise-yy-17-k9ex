const state = {
  config: null,
  db: {},
  activeTab: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function localToday() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function siteOf(item) {
  return (state.db.sites || []).find((entry) => entry.id === item.siteId);
}

function siteLabel(site) {
  return site ? `${site.cave} / ${site.zone} / ${site.pointCode}` : '未关联';
}

function openRecheckForSite(siteId) {
  return (state.db.rechecks || []).find((entry) => entry.siteId === siteId && entry.status === '未闭环');
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const step = field.step ? `step="${field.step}"` : '';
  let value = '';
  if (field.default) value = `value="${escapeHtml(field.default)}"`;
  else if (field.defaultToday) value = `value="${localToday()}"`;
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${step} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...(view.defaults || {}), ...payload };
}

function passesWhen(cond, item) {
  if (!cond) return true;
  const value = item[cond.field];
  if (cond.in) return cond.in.includes(value);
  if (cond.notIn) return !cond.notIn.includes(value);
  return true;
}

function actionButtons(collection, item) {
  return state.config.actions
    .filter((action) => action.collection === collection && passesWhen(action.visibleWhen, item))
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  const today = localToday();
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = items.filter((item) => {
      if (stat.filter && item[stat.filter.field] !== stat.filter.value) return false;
      if (stat.today && item[stat.today] !== today) return false;
      return true;
    }).length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function renderSiteCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const openRecheck = openRecheckForSite(item.id);
  const details = (view.detailFields || []).map((field) => {
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(item[field.name] ?? '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = actionButtons(collection, item);
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${openRecheck ? `<div class="meta warn-text">补测未闭环，期间保持重点保护，状态调整已锁定</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderSurveyCard(item) {
  const site = siteOf(item);
  const openRecheck = item.kind === '常规' ? openRecheckForSite(item.siteId) : null;
  const readings = [
    ['温度', item.temperature, site?.baselineTemp, '℃'],
    ['湿度', item.humidity, site?.baselineHumidity, '%'],
    ['CO2', item.co2, site?.baselineCo2, 'ppm'],
    ['滴水频率', item.dripRate, null, '']
  ].map(([label, value, baseline, unit]) => `
    <div>${label}<br><strong>${value ?? '-'}${unit}</strong>${baseline !== null && baseline !== undefined ? `<span class="base">基准 ${baseline}${unit}</span>` : ''}</div>
  `).join('');
  const pills = `${pill(item.kind, toneFor(item.kind))}${item.status !== item.kind ? pill(item.status, toneFor(item.status)) : ''}`;
  const actions = actionButtons('surveys', item);
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(`${item.surveyor} / ${item.date}`)}</h3><div class="pills">${pills}</div></div>
    <div class="meta">${escapeHtml(siteLabel(site))}${site ? `（${escapeHtml(site.route)}）` : ''}</div>
    ${item.disturbance ? `<p>干扰痕迹：${escapeHtml(item.disturbance)}</p>` : ''}
    ${item.reviewNote ? `<p>${escapeHtml(item.reviewNote)}</p>` : ''}
    <div class="detail">${readings}</div>
    ${openRecheck ? `<div class="meta warn-text">补测未闭环：须由不同人员完成，连续两次读数一致才能关闭</div>` : ''}
    ${item.kind === '留档' ? `<div class="meta">暂停开放样点留档记录，不占常规额度，不改变保护状态</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderRecheckCard(item) {
  const site = (state.db.sites || []).find((entry) => entry.id === item.siteId);
  const survey = (state.db.surveys || []).find((entry) => entry.id === item.surveyId);
  const entries = (item.entries || []).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.surveyor)}：${entry.temperature}℃ / ${entry.humidity}% / ${entry.co2}ppm${entry.note ? `（${escapeHtml(entry.note)}）` : ''}</span></div>
  `).join('');
  const hint = item.status === '未闭环'
    ? `已登记 ${(item.entries || []).length} 次读数，须由不同人员完成，连续两次读数一致才能关闭`
    : `已于 ${fmtDate(item.closedAt)} 闭环`;
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(site ? `${site.pointCode} · ${site.zone}` : item.siteId)}</h3>${pill(item.status, toneFor(item.status))}</div>
    <div class="meta">${escapeHtml(site ? `${site.cave}（${site.route}）` : '')}｜原巡测 ${escapeHtml(item.originSurveyor)}${survey ? ` / ${escapeHtml(survey.date)}` : ''}</div>
    ${item.disturbance ? `<p>干扰痕迹：${escapeHtml(item.disturbance)}</p>` : ''}
    <div class="meta ${item.status === '未闭环' ? 'warn-text' : ''}">${escapeHtml(hint)}</div>
    ${entries ? `<div class="history">${entries}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function cardFor(collection, item, view) {
  if (collection === 'surveys') return renderSurveyCard(item);
  if (collection === 'rechecks') return renderRecheckCard(item);
  return renderSiteCard(item, collection, view);
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length
    ? items.map((item) => cardFor(collection, item, view)).join('')
    : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderDashboardView(view) {
  const panels = view.focuses.map((focus) => {
    let items = [...(state.db[focus.collection] || [])];
    if (focus.field) items = items.filter((item) => focus.values.includes(item[focus.field]));
    items = items.slice(0, focus.limit || 8);
    const cards = items.map((item) => cardFor(focus.collection, item, view)).join('');
    return `<div class="panel"><h2>${escapeHtml(focus.title)}</h2><div class="list">${cards || `<div class="empty">${escapeHtml(focus.empty || '暂无')}</div>`}</div></div>`;
  }).join('');
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="dash-grid">${panels}</div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function renderRechecksView(view) {
  const openRechecks = (state.db.rechecks || []).filter((entry) => entry.status === '未闭环');
  const options = openRechecks.map((recheck) => {
    const site = (state.db.sites || []).find((entry) => entry.id === recheck.siteId);
    return `<option value="${recheck.id}">${escapeHtml(`${siteLabel(site)}｜原巡测 ${recheck.originSurveyor}`)}</option>`;
  }).join('');
  const disabled = openRechecks.length ? '' : 'disabled';
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-recheck-entry>
        <h2>${escapeHtml(view.formTitle)}</h2>
        <p class="meta">补测须由不同人员完成，连续两次读数一致才能闭环；重复提交沿用首次记录。</p>
        <div class="form-grid">
          <label class="wide">未闭环补测<select name="recheckId" required ${disabled}>${options || '<option value="">暂无未闭环补测</option>'}</select></label>
          <label>补测人员<input name="surveyor" required ${disabled}></label>
          <label>温度<input type="number" step="0.1" name="temperature" required ${disabled}></label>
          <label>湿度<input type="number" step="0.1" name="humidity" required ${disabled}></label>
          <label>CO2<input type="number" name="co2" required ${disabled}></label>
          <label class="wide">备注<input name="note" ${disabled}></label>
        </div>
        <div class="actions"><button ${disabled}>${escapeHtml(view.submitLabel)}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${(view.statusOptions || []).map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'rechecks') return renderRechecksView(view);
    return renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

let modalContext = null;

function openModal(action, item) {
  modalContext = { action, item };
  $('#modalTitle').textContent = `${action.label}｜${item.surveyor || ''} ${item.date || ''}`;
  $('#modalFields').innerHTML = action.form.map((field) => {
    const value = field.prefill ? item[field.prefill] : '';
    const required = field.required ? 'required' : '';
    const step = field.step ? `step="${field.step}"` : '';
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" value="${escapeHtml(value ?? '')}" ${step} ${required}></label>`;
  }).join('');
  $('#modal').hidden = false;
}

function closeModal() {
  modalContext = null;
  $('#modal').hidden = true;
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const actionEl = event.target.closest('[data-action]');
  if (tab) setTab(tab.dataset.tab);
  if (event.target.closest('#modalCancel')) closeModal();
  if (event.target.id === 'modal') closeModal();
  if (actionEl) {
    const action = state.config.actions.find((entry) => entry.id === actionEl.dataset.action);
    const item = (state.db[action.collection] || []).find((entry) => entry.id === actionEl.dataset.id);
    if (!action || !item) return;
    if (action.form) {
      openModal(action, item);
      return;
    }
    try {
      const url = action.endpoint ? action.endpoint.replace(':id', item.id) : `/api/action/${action.id}/${item.id}`;
      const result = await api(url, { method: 'POST', body: '{}' });
      await load();
      if (result?.reused && action.reusedMessage) toast(action.reusedMessage);
      else toast(action.doneMessage || '已更新');
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const entryForm = event.target.closest('[data-recheck-entry]');
  if (entryForm) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(entryForm).entries());
    for (const key of ['temperature', 'humidity', 'co2']) payload[key] = Number(payload[key]);
    try {
      const result = await api(`/api/rechecks/${payload.recheckId}/entries`, { method: 'POST', body: JSON.stringify(payload) });
      entryForm.reset();
      await load();
      if (result.reused) toast('重复补测，已沿用首次记录');
      else if (result.closed) toast('连续两次读数一致，补测已闭环');
      else toast('已登记补测读数');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  try {
    const created = await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(values(form, view)) });
    form.reset();
    await load();
    if (created?.kind === '留档') toast('暂停开放样点仅留档，不占常规额度');
    else if (created?.status === '异常待复查') toast('读数超差，已标记异常并转入重点保护');
    else toast('已保存');
  } catch (error) {
    toast(error.message);
  }
});

$('#modalForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!modalContext) return;
  const { action, item } = modalContext;
  const payload = Object.fromEntries(new FormData(event.target).entries());
  for (const field of action.form) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name]);
  }
  try {
    await api(action.endpoint.replace(':id', item.id), { method: 'POST', body: JSON.stringify(payload) });
    closeModal();
    await load();
    toast(action.doneMessage || '已更新');
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
