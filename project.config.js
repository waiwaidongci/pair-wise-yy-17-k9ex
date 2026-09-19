module.exports = {
  port: 3912,
  title: '洞穴巡测封控与补测台',
  lede: '每个样点每天只准一条常规巡测；暂停开放的样点只能留档，不占常规额度，也不改变保护状态。游客干扰标记后建立未闭环补测，须由不同人员完成，连续两次读数一致才能闭环，期间该样点保持重点保护，其他样点不受影响。',
  judge: { tempTolerance: 1, humidityTolerance: 5, co2Tolerance: 200 },
  tones: {
    '常规观察': 'ok',
    '正常': 'ok',
    '已复查': 'ok',
    '已闭环': 'ok',
    '常规': 'ok',
    '重点保护': 'warn',
    '未闭环': 'warn',
    '留档': 'warn',
    '异常待复查': 'bad',
    '暂停开放': 'bad'
  },
  collections: {
    sites: { label: '样点档案' },
    surveys: { label: '巡测记录' },
    rechecks: { label: '补测任务' }
  },
  stats: [
    { label: '样点', collection: 'sites' },
    { label: '重点保护', collection: 'sites', filter: { field: 'protectedStatus', value: '重点保护' } },
    { label: '暂停开放', collection: 'sites', filter: { field: 'protectedStatus', value: '暂停开放' } },
    { label: '今日常规巡测', collection: 'surveys', filter: { field: 'kind', value: '常规' }, today: 'date' },
    { label: '未闭环补测', collection: 'rechecks', filter: { field: 'status', value: '未闭环' } },
    { label: '留档记录', collection: 'surveys', filter: { field: 'kind', value: '留档' } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '封控看板',
      type: 'dashboard',
      focuses: [
        { title: '未闭环补测', collection: 'rechecks', field: 'status', values: ['未闭环'], limit: 6, empty: '暂无未闭环补测' },
        { title: '异常待复查巡测', collection: 'surveys', field: 'status', values: ['异常待复查'], limit: 6, empty: '暂无异常巡测' }
      ]
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增样点',
      listTitle: '样点列表',
      submitLabel: '保存样点',
      searchPlaceholder: '搜索洞穴、分区、样点、路线',
      searchFields: ['cave', 'zone', 'pointCode', 'route'],
      statusField: 'protectedStatus',
      statusOptions: ['常规观察', '重点保护', '暂停开放'],
      titleFields: ['pointCode', 'zone'],
      summaryFields: ['note'],
      detailFields: [
        { label: '洞穴', name: 'cave' },
        { label: '巡测路线', name: 'route' },
        { label: '敏感等级', name: 'sensitivity' }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '保护状态', name: 'protectedStatus', type: 'select', options: ['常规观察', '重点保护', '暂停开放'] },
        { label: '基准温度', name: 'baselineTemp', type: 'number', step: '0.1', required: true },
        { label: '基准湿度', name: 'baselineHumidity', type: 'number', step: '0.1', required: true },
        { label: '基准CO2', name: 'baselineCo2', type: 'number', required: true },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'surveys',
      label: '巡测封控',
      collection: 'surveys',
      formTitle: '登记巡测',
      listTitle: '巡测历史',
      submitLabel: '保存巡测',
      searchPlaceholder: '搜索人员、日期、干扰痕迹',
      searchFields: ['surveyor', 'date', 'disturbance'],
      statusField: 'status',
      statusOptions: ['正常', '异常待复查', '已复查', '留档'],
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode', 'protectedStatus'], required: true, wide: true },
        { label: '巡测人员', name: 'surveyor', required: true },
        { label: '日期', name: 'date', type: 'date', required: true, defaultToday: true },
        { label: '温度', name: 'temperature', type: 'number', step: '0.1', required: true },
        { label: '湿度', name: 'humidity', type: 'number', step: '0.1', required: true },
        { label: 'CO2', name: 'co2', type: 'number', required: true },
        { label: '滴水频率', name: 'dripRate', type: 'number', required: true },
        { label: '照片链接', name: 'photoUrl' },
        { label: '游客干扰痕迹', name: 'disturbance', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'rechecks',
      label: '补测闭环',
      type: 'rechecks',
      collection: 'rechecks',
      formTitle: '登记补测读数',
      listTitle: '补测任务',
      submitLabel: '提交补测读数',
      searchPlaceholder: '搜索原巡测人员、干扰痕迹',
      searchFields: ['originSurveyor', 'disturbance'],
      statusField: 'status',
      statusOptions: ['未闭环', '已闭环']
    }
  ],
  actions: [
    {
      id: 'site-normal',
      label: '常规观察',
      collection: 'sites',
      guards: [{ op: 'noOpenRecheck', message: '补测未闭环，期间该样点保持重点保护' }],
      patches: [{ field: 'protectedStatus', value: '常规观察' }]
    },
    { id: 'site-focus', label: '重点保护', collection: 'sites', patches: [{ field: 'protectedStatus', value: '重点保护' }] },
    {
      id: 'site-close',
      label: '暂停开放',
      collection: 'sites',
      danger: true,
      guards: [{ op: 'noOpenRecheck', message: '补测未闭环，期间该样点保持重点保护' }],
      patches: [{ field: 'protectedStatus', value: '暂停开放' }]
    },
    {
      id: 'mark-disturbance',
      label: '标记游客干扰',
      collection: 'surveys',
      endpoint: '/api/surveys/:id/mark-disturbance',
      danger: true,
      visibleWhen: { field: 'kind', in: ['常规'] },
      doneMessage: '已建立未闭环补测，样点保持重点保护',
      reusedMessage: '该样点已有未闭环补测，沿用首次记录'
    },
    {
      id: 'correct-survey',
      label: '更正读数',
      collection: 'surveys',
      endpoint: '/api/surveys/:id/correct',
      doneMessage: '已更正，旧结论失效并按更正值重判封控',
      form: [
        { label: '温度', name: 'temperature', type: 'number', step: '0.1', prefill: 'temperature', required: true },
        { label: '湿度', name: 'humidity', type: 'number', step: '0.1', prefill: 'humidity', required: true },
        { label: 'CO2', name: 'co2', type: 'number', prefill: 'co2', required: true },
        { label: '滴水频率', name: 'dripRate', type: 'number', prefill: 'dripRate', required: true },
        { label: '更正说明', name: 'reason', wide: true }
      ]
    }
  ]
};
