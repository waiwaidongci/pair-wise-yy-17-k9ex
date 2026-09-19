module.exports = {
  port: 3912,
  title: '洞穴巡测封控与补测台',
  lede: '每样点每天仅一条常规巡测，读数按基准自动判定封控；暂停开放样点只留档、不占额度、不改保护状态。游客干扰建立补测闭环，须由不同人员连续两次读数一致方可关闭，闭环期间样点保持重点保护。',
  tones: {
    '常规观察': 'ok',
    '正常': 'ok',
    '已复查': 'ok',
    '已闭环': 'ok',
    '留档': 'tone-muted',
    '重点保护': 'warn',
    '待补测': 'warn',
    '异常': 'warn',
    '异常待复查': 'bad',
    '暂停开放': 'bad',
    '封控': 'bad',
    '未闭环': 'bad'
  },
  collections: {
    sites: { label: '样点档案' },
    surveys: { label: '巡测记录' },
    remeasures: { label: '补测闭环' }
  },
  stats: [
    { label: '样点总数', collection: 'sites' },
    { label: '暂停开放', collection: 'sites', filter: { field: 'protectedStatus', value: '暂停开放' } },
    { label: '重点保护', collection: 'sites', filter: { field: 'protectedStatus', value: '重点保护' } },
    { label: '未闭环补测', collection: 'remeasures', filter: { field: 'status', value: '未闭环' } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '封控看板',
      type: 'dashboard',
      focusTitle: '未闭环补测',
      focus: { collection: 'remeasures', field: 'status', values: ['未闭环'], limit: 8 },
      closedTitle: '当前封控与重点保护样点'
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增样点',
      listTitle: '样点列表（保护状态按巡测读数统一派生）',
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
        { label: '敏感等级', name: 'sensitivity' },
        { label: '基准温度', name: 'baselineTemp' },
        { label: '基准湿度', name: 'baselineHumidity' },
        { label: '基准CO2', name: 'baselineCo2' }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '基准温度', name: 'baselineTemp', type: 'number', required: true },
        { label: '基准湿度', name: 'baselineHumidity', type: 'number', required: true },
        { label: '基准CO2', name: 'baselineCo2', type: 'number', required: true },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'surveys',
      label: '巡测记录',
      collection: 'surveys',
      formTitle: '登记巡测（每样点每天一条常规；暂停开放自动留档）',
      listTitle: '巡测历史',
      submitLabel: '保存巡测',
      searchPlaceholder: '搜索人员、干扰痕迹、照片',
      searchFields: ['surveyor', 'disturbance', 'photoUrl'],
      statusField: 'status',
      statusOptions: ['正常', '异常待复查', '待补测', '已复查', '已闭环', '留档'],
      titleFields: ['surveyor', 'date'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['disturbance'],
      detailFields: [
        { label: '温度', name: 'temperature' },
        { label: '湿度', name: 'humidity' },
        { label: 'CO2', name: 'co2' },
        { label: '滴水频率', name: 'dripRate' }
      ],
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '巡测人员', name: 'surveyor', required: true },
        { label: '日期', name: 'date', type: 'date', required: true },
        { label: '温度', name: 'temperature', type: 'number', required: true },
        { label: '湿度', name: 'humidity', type: 'number', required: true },
        { label: 'CO2', name: 'co2', type: 'number', required: true },
        { label: '滴水频率', name: 'dripRate', type: 'number', required: true },
        { label: '照片链接', name: 'photoUrl' },
        { label: '游客干扰痕迹', name: 'disturbance', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'remeasures',
      label: '补测闭环',
      type: 'remeasures',
      collection: 'remeasures',
      listTitle: '补测任务',
      searchPlaceholder: '搜索原巡测人、补测人、样点',
      statusField: 'status',
      statusOptions: ['未闭环', '已闭环']
    }
  ]
};
