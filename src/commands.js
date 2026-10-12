// ── 指令系统（§十七）+ 意图识别 ──────────────────────────────
//
// 设计决定：把 §17 的指令分成两类
//
//   handler: 'code'  → 纯数据操作。由代码直接跑，零 token、瞬时、不会出错。
//                      计时、打卡、积分、查看指令、导出。
//   handler: 'model' → 需要判断力。注入对应流程段落，交给模型处理。
//                      小黑屋、拆解、规划、SOP、拖延分析、总结。
//
// 分成两类的理由：让模型去"记住开始时间"或"算出积分累计"是让它做它做不好的
// 事，而且每一次都要烧 token。凡是有确定答案的，代码答。

/* ══════════════ 指令表 ══════════════ */

export const COMMAND_GROUPS = [
  {
    group: '执行监督',
    items: [
      { id: 'start_task',   label: '任务启动',   handler: 'model', flows: ['start'], hint: '"我要开始学习了"' },
      { id: 'timer_start',  label: '开始计时',   handler: 'code',  codeAction: 'timer_start', hint: '记下真实开始时间' },
      { id: 'timer_stop',   label: '结束计时',   handler: 'code',  codeAction: 'timer_stop',  hint: '算出实际耗时' },
      { id: 'report',       label: '汇报进度',   handler: 'model', flows: ['report'], hint: '"我做完了"' },
      { id: 'check_block',  label: '检查阻碍',   handler: 'model', flows: ['hope'], hint: '"我卡住了"' },
      { id: 'hope',         label: 'HOPE 流程',  handler: 'model', flows: ['hope'] },
      { id: 'resume',       label: '恢复执行',   handler: 'model', flows: ['start'] },
      { id: 'suspend',      label: '暂停监督',   handler: 'code',  codeAction: 'suspend', hint: '危机时用，立刻停掉一切催促' },
      { id: 'unsuspend',    label: '解除暂停',   handler: 'code',  codeAction: 'unsuspend' },
    ],
  },
  {
    group: '任务管理',
    items: [
      { id: 'add_task',     label: '添加任务',   handler: 'model' },
      { id: 'list_tasks',   label: '查看任务',   handler: 'code',  codeAction: 'panel_tasks' },
      { id: 'edit_task',    label: '修改任务',   handler: 'model' },
      { id: 'done_task',    label: '完成任务',   handler: 'model', flows: ['report'] },
      { id: 'defer_task',   label: '延期任务',   handler: 'model' },
      { id: 'cancel_task',  label: '取消任务',   handler: 'model' },
      { id: 'break_task',   label: '任务拆解',   handler: 'model', flows: ['start'] },
      { id: 'task_review',  label: '任务复盘',   handler: 'model', flows: ['blackroom'] },
    ],
  },
  {
    group: '规划管理',
    items: [
      { id: 'plan',         label: '我要做规划', handler: 'model', flows: ['planning'] },
      { id: 'list_plans',   label: '查看规划',   handler: 'code',  codeAction: 'panel_plans' },
      { id: 'edit_plan',    label: '修改规划',   handler: 'model', flows: ['planning'] },
      { id: 'sop',          label: '制定 SOP',   handler: 'model', flows: ['sop'] },
      { id: 'list_sops',    label: '查看 SOP',   handler: 'code',  codeAction: 'panel_sops' },
    ],
  },
  {
    group: '生活管理',
    items: [
      { id: 'checkin',      label: '生活打卡',   handler: 'code',  codeAction: 'panel_checkin' },
      { id: 'mood_log',     label: '情绪记录',   handler: 'code',  codeAction: 'panel_checkin' },
      { id: 'focus_log',    label: '注意力记录', handler: 'code',  codeAction: 'panel_checkin' },
      { id: 'sleep_log',    label: '睡眠打卡',   handler: 'code',  codeAction: 'panel_checkin' },
      { id: 'daily_review', label: '每日复盘',   handler: 'model', flows: ['blackroom'] },
    ],
  },
  {
    group: '奖励管理',
    items: [
      { id: 'show_points',  label: '查看积分',   handler: 'code',  codeAction: 'panel_points' },
      { id: 'add_points',   label: '添加积分',   handler: 'model' },
      { id: 'show_rewards', label: '查看奖励',   handler: 'code',  codeAction: 'panel_points' },
      { id: 'edit_rewards', label: '修改奖励机制', handler: 'code', codeAction: 'panel_points' },
    ],
  },
  {
    group: '深度复盘',
    items: [
      { id: 'blackroom',    label: '小黑屋',     handler: 'model', flows: ['blackroom'], hint: '深度复盘，不是羞辱' },
      { id: 'analyze',      label: '分析拖延',   handler: 'model', flows: ['procrastination'] },
      { id: 'triggers',     label: '识别触发因素', handler: 'model', flows: ['blackroom'] },
      { id: 'reframe',      label: '重构自动化思维', handler: 'model', flows: ['blackroom'] },
    ],
  },
  {
    group: '记忆与总结',
    items: [
      { id: 'summary',      label: '总结一下',   handler: 'model', flows: [] },
      { id: 'profile',      label: '查看用户档案', handler: 'code', codeAction: 'panel_profile' },
      { id: 'edit_profile', label: '更新用户档案', handler: 'code', codeAction: 'panel_profile' },
      { id: 'export',       label: '导出记录',   handler: 'code', codeAction: 'export_md' },
      // 刻意不做成面板：§17 要求用户不必记指令名，
      // 摆一张指令表既矛盾又把实现细节漏给用户。交给帕尼尼用话讲。
      { id: 'help',         label: '能做什么',   handler: 'model', flows: ['help'] },
    ],
  },
];

export const ALL_COMMANDS = COMMAND_GROUPS.flatMap(g => g.items.map(i => ({ ...i, group: g.group })));

/* ══════════════ 意图识别 ══════════════
 *
 * 这里**只剩代码动作**，流程触发词已经删掉。
 *
 * 原来的流程正则按"注不注入对应流程段落"来决定模型走不走那套步骤，实测
 * 8 条常用说法漏 4 条（"我想开始学线代了"匹配不到 start，"你都能干啥"
 * 匹配不到 help）。漏掉的后果是模型拿不到用户自己定的步骤，只能即兴发挥。
 * 现在改成**全量注入所有流程**，由模型按各段落开头写的触发条件自己选。
 *
 * 这些代码动作正则保留，但**它们不再是能力开关，只是快路径**：
 * 命中了就省一次模型往返、立刻执行；没命中就把话交给模型，模型手上有
 * 对应的工具（timer_start / open_panel / export_records / suspend_supervision…）
 * 照样能做成事。
 *
 * 判据很简单：**每一条代码动作，都必须有一个工具能做同样的事。**
 * 否则一旦正则漏了，用户就会遇到"说了但没反应"。 */

const CODE_TRIGGERS = [
  // 每条都注明对应的兜底工具，方便核对
  { action: 'suspend',       tool: 'suspend_supervision', re: /暂停监督|先别管我|别催我|暂时别监督|停止监督/i },
  { action: 'unsuspend',     tool: 'resume_supervision',  re: /恢复监督|继续监督|可以催我了|监督恢复/i },
  { action: 'timer_start',   tool: 'timer_start',         re: /开始计时|计时开始|开始记录时间|现在开始计时|现在开始[，,、\s]*计时\s*\d+\s*分钟/i },
  { action: 'timer_stop',    tool: 'timer_stop',          re: /结束计时|停止计时|计时结束|计时停止/i },
  { action: 'panel_points',  tool: 'open_panel',          re: /查看积分|我的积分|积分多少|积分账本|查看奖励/i },
  { action: 'panel_checkin', tool: 'open_panel',          re: /^生活打卡$|开始打卡|每日打卡/i },
  { action: 'panel_profile', tool: 'open_panel',          re: /查看用户档案|我的档案|用户档案/i },
  { action: 'panel_plans',   tool: 'open_panel',          re: /查看规划|我的规划|规划列表/i },
  { action: 'panel_sops',    tool: 'open_panel',          re: /查看\s*sop|我的\s*sop|sop\s*列表/i },
  { action: 'panel_tasks',   tool: 'open_panel',          re: /^\s*(?:请)?(?:查看|打开)(?:一下)?(?:我的)?任务(?:列表)?[。！!]?\s*$/i },
  { action: 'export_md',     tool: 'export_records',      re: /导出记录|导出数据|导出档案|备份记录/i },
];

/**
 * 看一眼用户这句话，判断要不要走代码快路径。
 * 纯正则、零 token，能在调模型之前就把确定性操作做掉。
 *
 * @returns {{codeAction:string|null, matched:string[]}}
 */
export function detectIntent(text) {
  const s = String(text || '');
  if (!s.trim()) return { codeAction: null, matched: [] };

  for (const t of CODE_TRIGGERS) {
    if (t.re.test(s)) {
      // 只取第一个命中的，避免"查看规划"这类同时命中多条时产生歧义
      return { codeAction: t.action, matched: [`code:${t.action}→${t.tool}`] };
    }
  }
  return { codeAction: null, matched: [] };
}

/** 代码动作 → 兜底工具名。测试用它保证"每条动作都有工具能替代"。 */
export const ACTION_FALLBACK_TOOL = Object.fromEntries(
  CODE_TRIGGERS.map(t => [t.action, t.tool]),
);

/** 供调试/界面渲染"这一句会触发什么" */
export function describeIntent(intent) {
  if (intent.codeAction) return `代码快路径：${intent.codeAction}`;
  return '交给模型处理';
}
