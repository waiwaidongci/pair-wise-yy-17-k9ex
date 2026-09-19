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

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), 2600);
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

function siteOf(siteId) {
  return (state.db.sites || []).find((entry) => entry.id === siteId);
}

function siteLabel(siteId) {
  const site = siteOf(siteId);
  if (!site) return '未关联';
  return [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'date' && !field.default) {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="date" name="${field.name}" value="${todayStr()}" ${required}></label>`;
  }
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
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
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

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view) => `
    <button class="tab" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

// ---------- 样点卡片：保护状态来自服务端统一派生 ----------

function renderSiteCard(site) {
  const reasons = site.statusReasons || [];
  return `<article class="card${site.protectedStatus === '暂停开放' ? ' card-bad' : site.protectedStatus === '重点保护' ? ' card-warn' : ''}">
    <div class="card-head">
      <h3>${escapeHtml([site.pointCode, site.zone].filter(Boolean).join(' / '))}</h3>
      ${pill(site.protectedStatus, toneFor(site.protectedStatus))}
    </div>
    <div class="meta">${escapeHtml([site.cave, site.route].filter(Boolean).join(' · '))}</div>
    <div class="detail">
      <div>敏感等级<br><strong>${escapeHtml(site.sensitivity || '-')}</strong></div>
      <div>基准温度<br><strong>${escapeHtml(site.baselineTemp)}℃</strong></div>
      <div>基准湿度<br><strong>${escapeHtml(site.baselineHumidity)}%</strong></div>
      <div>基准CO2<br><strong>${escapeHtml(site.baselineCo2)}</strong></div>
    </div>
    ${reasons.length ? `<ul class="reasons">${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '<div class="meta quiet">无生效异常/封控判定</div>'}
  </article>`;
}

// ---------- 巡测卡片 ----------

function surveyActionButtons(survey) {
  const buttons = [];
  if (survey.kind === '留档') {
    buttons.push(`<button class="ghost" data-modal="correct" data-id="${survey.id}">更正留档读数</button>`);
    return buttons.join('');
  }
  if (survey.status === '正常' || survey.status === '异常待复查') {
    buttons.push(`<button class="danger" data-modal="disturbance" data-id="${survey.id}">标记游客干扰</button>`);
  }
  if (survey.status === '异常待复查') {
    buttons.push(`<button class="ghost" data-action="review" data-id="${survey.id}">完成复查</button>`);
  }
  if (survey.status !== '待补测') {
    buttons.push(`<button class="ghost" data-modal="correct" data-id="${survey.id}">更正读数并重判</button>`);
  } else {
    buttons.push(`<span class="tag">补测闭环处理中</span>`);
  }
  return buttons.join('');
}

function renderSurveyCard(survey) {
  const v = survey._verdict;
  const verdictHtml = v ? `
    <div class="verdict ${toneFor(v.level)}">
      <strong>当前判定：${escapeHtml(v.level)}</strong>
      ${v.reasons.length ? `<span>${escapeHtml(v.reasons.join('；'))}</span>` : '<span>读数在基准允许范围内</span>'}
    </div>` : `
    <div class="verdict tone-muted"><strong>留档</strong><span>暂停开放期间留档，不占常规额度，不改变保护状态</span></div>`;
  const superseded = (survey.superseded || []).map((old) => `
    <div class="superseded">${fmtDate(old.at)} 更正：旧结论「${escapeHtml(old.level || '-')}」${escapeHtml(old.reason ? '（' + old.reason + '）' : '')}已失效</div>
  `).join('');
  const site = siteOf(survey.siteId);
  return `<article class="card">
    <div class="card-head">
      <h3>${escapeHtml([survey.surveyor, survey.date].filter(Boolean).join(' / '))}</h3>
      <span class="pills">
        ${survey.kind === '留档' ? pill('留档', 'tone-muted') : pill('常规', 'ok')}
        ${pill(survey.status, toneFor(survey.status))}
      </span>
    </div>
    <div class="meta">${escapeHtml(siteLabel(survey.siteId))}${site ? ` · 样点当前：${escapeHtml(site.protectedStatus)}` : ''}</div>
    ${survey.disturbance ? `<p class="disturbance">游客干扰：${escapeHtml(survey.disturbance)}</p>` : ''}
    <div class="detail">
      <div>温度<br><strong>${escapeHtml(survey.temperature)}℃</strong></div>
      <div>湿度<br><strong>${escapeHtml(survey.humidity)}%</strong></div>
      <div>CO2<br><strong>${escapeHtml(survey.co2)}</strong></div>
      <div>滴水频率<br><strong>${escapeHtml(survey.dripRate)}</strong></div>
    </div>
    ${verdictHtml}
    ${superseded}
    <div class="actions">${surveyActionButtons(survey)}</div>
    ${historyHtml(survey)}
  </article>`;
}

function renderSurveyList(view) {
  const query = ($(`#search-${view.id}`)?.value || '').trim();
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db.surveys || [])];
  if (query) items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  if (status) items = items.filter((item) => item[view.statusField] === status);
  return items.length ? items.map(renderSurveyCard).join('') : '<div class="empty">暂无巡测记录</div>';
}

// ---------- 补测卡片 ----------

function readingRows(rm) {
  return (rm.readings || []).map((r, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${fmtDate(r.at)}</td>
      <td>${escapeHtml(r.surveyor)}</td>
      <td>${escapeHtml(r.temperature)} / ${escapeHtml(r.humidity)} / ${escapeHtml(r.co2)} / ${escapeHtml(r.dripRate)}</td>
      <td>${r.matched ? pill('与上次一致', 'ok') : index === 0 ? '首次' : pill('不一致', 'bad')}</td>
    </tr>`).join('');
}

function renderRemeasureCard(rm) {
  const open = rm.status === '未闭环';
  const form = open ? `
    <form class="reading-form" data-rm="${rm.id}">
      <div class="form-grid">
        <label>补测人员（不得为原巡测人 ${escapeHtml(rm.initialSurveyor)}）<input name="surveyor" required></label>
        <label>温度<input name="temperature" type="number" step="0.1" required></label>
        <label>湿度<input name="humidity" type="number" step="0.1" required></label>
        <label>CO2<input name="co2" type="number" step="1" required></label>
        <label>滴水频率<input name="dripRate" type="number" step="0.1" required></label>
      </div>
      <div class="actions"><button>提交补测读数</button><span class="meta quiet">连续两次读数一致自动闭环；重复提交沿用首次记录</span></div>
    </form>` : `
    <div class="verdict ${toneFor(rm.closingVerdict)}"><strong>已闭环 · 终读判定：${escapeHtml(rm.closingVerdict || '-')}</strong><span>${fmtDate(rm.closedAt)}</span></div>`;
  return `<article class="card${open ? ' card-warn' : ''}">
    <div class="card-head">
      <h3>${escapeHtml(siteLabel(rm.siteId))} · ${escapeHtml(rm.sourceDate || '')}</h3>
      ${pill(rm.status, toneFor(rm.status))}
    </div>
    <div class="meta">原巡测人：${escapeHtml(rm.initialSurveyor)} · 补测须由其他人员完成</div>
    <p class="disturbance">游客干扰：${escapeHtml(rm.disturbance)}</p>
    <table class="reading-table">
      <thead><tr><th>#</th><th>时间</th><th>补测人</th><th>温度/湿度/CO2/滴水</th><th>比对</th></tr></thead>
      <tbody>${readingRows(rm) || '<tr><td colspan="5" class="empty-cell">尚无补测读数</td></tr>'}</tbody>
    </table>
    ${form}
    ${historyHtml(rm)}
  </article>`;
}

// ---------- 视图 ----------

function renderDashboardView(view) {
  const open = (state.db.remeasures || []).filter((rm) => rm.status === '未闭环');
  const focusSites = (state.db.sites || [])
    .filter((site) => site.protectedStatus !== '常规观察')
    .sort((a, b) => (a.protectedStatus === '暂停开放' ? -1 : 1));
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel">
      <h2>${escapeHtml(view.focusTitle)}（${open.length}）</h2>
      <div class="list">${open.length ? open.map(renderRemeasureCard).join('') : '<div class="empty">暂无未闭环补测</div>'}</div>
    </div>
    <div class="panel" style="margin-top:18px">
      <h2>${escapeHtml(view.closedTitle)}</h2>
      <div class="list">${focusSites.length ? focusSites.map(renderSiteCard).join('') : '<div class="empty">全部样点处于常规观察</div>'}</div>
    </div>
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
        <div class="list" id="list-${view.id}">${renderSurveyList(view)}</div>
      </div>
    </div>
  </section>`;
}

function renderSitesView(view) {
  const statusOptions = view.statusOptions || [];
  const query = ($(`#search-sites`)?.value || '').trim();
  const status = $(`#status-sites`)?.value || '';
  let items = [...(state.db.sites || [])];
  if (query) items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  if (status) items = items.filter((item) => item.protectedStatus === status);
  const list = items.length ? items.map(renderSiteCard).join('') : '<div class="empty">暂无样点档案</div>';
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="sites" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-sites" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-sites">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-sites">${list}</div>
      </div>
    </div>
  </section>`;
}

function renderRemeasuresView(view) {
  const query = ($(`#search-remeasures`)?.value || '').trim();
  const status = $(`#status-remeasures`)?.value || '';
  let items = [...(state.db.remeasures || [])];
  if (query) {
    items = items.filter((item) =>
      [item.initialSurveyor, item.disturbance, siteLabel(item.siteId), ...(item.readings || []).map((r) => r.surveyor)]
        .some((text) => String(text || '').includes(query)));
  }
  if (status) items = items.filter((item) => item.status === status);
  return `<section class="view" id="${view.id}">
    <div class="panel">
      <h2>${escapeHtml(view.listTitle)}</h2>
      <p class="meta">补测须由原巡测人以外的人员完成；连续两次四项读数完全一致方可闭环，闭环前样点保持重点保护；重复提交沿用首次记录。</p>
      <div class="toolbar">
        <input id="search-remeasures" placeholder="${escapeHtml(view.searchPlaceholder)}">
        <select id="status-remeasures">
          <option value="">全部状态</option>
          ${view.statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
        </select>
      </div>
      <div class="list" id="list-remeasures">${items.length ? items.map(renderRemeasureCard).join('') : '<div class="empty">暂无补测任务</div>'}</div>
    </div>
  </section>`;
}

function rerenderList() {
  const view = state.config.views.find((entry) => entry.id === state.activeTab);
  if (!view) return;
  if (view.id === 'surveys') $(`#list-surveys`).innerHTML = renderSurveyList(view);
  if (view.id === 'sites') $('#main').innerHTML = state.config.views.map(renderViewHtml).join('');
  if (view.id === 'remeasures' || view.id === 'dashboard') $('#main').innerHTML = state.config.views.map(renderViewHtml).join('');
  setTab(state.activeTab);
}

function renderViewHtml(view) {
  if (view.type === 'dashboard') return renderDashboardView(view);
  if (view.id === 'sites') return renderSitesView(view);
  if (view.type === 'remeasures') return renderRemeasuresView(view);
  return renderCrudView(view);
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map(renderViewHtml).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

// ---------- 弹窗：更正读数 / 填写干扰 ----------

function closeModal() {
  $('#modal').classList.remove('show');
  $('#modal').innerHTML = '';
}

function openCorrectModal(survey) {
  $('#modal').innerHTML = `
    <div class="modal-card">
      <h2>更正巡测读数</h2>
      <p class="meta">${escapeHtml(survey.surveyor)} / ${escapeHtml(survey.date)} · 提交后旧结论留痕失效，并按更正值重新判定封控。</p>
      <form data-modal-form="correct" data-id="${survey.id}">
        <div class="form-grid">
          <label>温度<input name="temperature" type="number" step="0.1" value="${escapeHtml(survey.temperature)}" required></label>
          <label>湿度<input name="humidity" type="number" step="0.1" value="${escapeHtml(survey.humidity)}" required></label>
          <label>CO2<input name="co2" type="number" step="1" value="${escapeHtml(survey.co2)}" required></label>
          <label>滴水频率<input name="dripRate" type="number" step="0.1" value="${escapeHtml(survey.dripRate)}" required></label>
          ${survey.kind === '留档' ? '' : `<label class="wide">游客干扰痕迹（可选）<textarea name="disturbance">${escapeHtml(survey.disturbance || '')}</textarea></label>`}
        </div>
        <div class="actions">
          <button type="submit">按更正值重判封控</button>
          <button type="button" class="ghost" data-close-modal>取消</button>
        </div>
      </form>
    </div>`;
  $('#modal').classList.add('show');
}

function openDisturbanceModal(survey) {
  $('#modal').innerHTML = `
    <div class="modal-card">
      <h2>标记游客干扰</h2>
      <p class="meta">标记后将建立未闭环补测：补测须由 ${escapeHtml(survey.surveyor)} 以外的人员完成，连续两次读数一致才能关闭；期间样点保持重点保护。</p>
      <form data-modal-form="disturbance" data-id="${survey.id}">
        <label class="wide">游客干扰痕迹<textarea name="disturbance" required>${escapeHtml(survey.disturbance || '')}</textarea></label>
        <div class="actions">
          <button class="danger" type="submit">建立补测</button>
          <button type="button" class="ghost" data-close-modal>取消</button>
        </div>
      </form>
    </div>`;
  $('#modal').classList.add('show');
}

// ---------- 事件 ----------

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const closer = event.target.closest('[data-close-modal]');
  const modalTrigger = event.target.closest('[data-modal]');
  const action = event.target.closest('[data-action]');

  if (tab) setTab(tab.dataset.tab);
  if (closer) closeModal();
  if (event.target.id === 'modal') closeModal();

  if (modalTrigger) {
    const survey = state.db.surveys.find((x) => x.id === modalTrigger.dataset.id);
    if (!survey) return;
    if (modalTrigger.dataset.modal === 'correct') openCorrectModal(survey);
    if (modalTrigger.dataset.modal === 'disturbance') openDisturbanceModal(survey);
  }

  if (action) {
    try {
      const result = await api(`/api/surveys/${action.dataset.id}/${action.dataset.action}`, { method: 'POST' });
      await load();
      toast(result.note || '已更新');
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  if (!event.target.id) return;
  if (event.target.id.startsWith('search-') || event.target.id.startsWith('status-')) {
    const tabId = event.target.id.split('-')[1];
    if (tabId === 'surveys' || tabId === 'sites' || tabId === 'remeasures') rerenderList();
  }
});

document.addEventListener('submit', async (event) => {
  const modalForm = event.target.closest('[data-modal-form]');
  const readingForm = event.target.closest('[data-rm]');
  const createForm = event.target.closest('[data-create]');
  if (!modalForm && !readingForm && !createForm) return;
  event.preventDefault();

  try {
    if (modalForm) {
      const kind = modalForm.dataset.modalForm;
      const id = modalForm.dataset.id;
      const formData = Object.fromEntries(new FormData(modalForm).entries());
      const payload = kind === 'correct'
        ? {
            temperature: Number(formData.temperature),
            humidity: Number(formData.humidity),
            co2: Number(formData.co2),
            dripRate: Number(formData.dripRate),
            disturbance: formData.disturbance
          }
        : { disturbance: formData.disturbance };
      const result = await api(`/api/surveys/${id}/${kind === 'correct' ? 'correct' : 'disturbance'}`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      closeModal();
      await load();
      toast(result.note || '已保存');
      return;
    }

    if (readingForm) {
      const formData = Object.fromEntries(new FormData(readingForm).entries());
      const payload = {
        surveyor: formData.surveyor,
        temperature: Number(formData.temperature),
        humidity: Number(formData.humidity),
        co2: Number(formData.co2),
        dripRate: Number(formData.dripRate)
      };
      const result = await api(`/api/remeasures/${readingForm.dataset.rm}/readings`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      await load();
      toast(result.note || '已提交');
      return;
    }

    const view = state.config.views.find((entry) => entry.id === createForm.dataset.view);
    const result = await api(`/api/${createForm.dataset.create}`, {
      method: 'POST',
      body: JSON.stringify(values(createForm, view))
    });
    createForm.reset();
    await load();
    toast(result.note || '已保存');
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新，状态与服务端一致')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
