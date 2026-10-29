#!/usr/bin/env node
// ── 通知排期的纯逻辑测试 ────────────────────────────────────────
//
// 真机不容易复现，而通知最容易错的恰恰是"参数形状"：
//   · 每日重复必须用 { on: { hour, minute }, repeats: true }
//     写成 { at, repeats: true } 会被 Capacitor 当成"按间隔重复"，
//     早上 8 点保存 9:00 的提醒会变成每小时响一次（真踩过）。
//   · 任务提醒必须是单次 { at }，且只排未来时间。
//   · 网页端不能碰插件，只能抛「仅在 Android App 中可用」。
//
// 这里用假的 Capacitor 全局 + 假插件把排期参数抓下来断言，不需要真机。

import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

/* ── 假插件：只记录调用 ── */
const calls = { scheduled: [], cancelled: [], channels: [] };
const fakePlugin = {
  async checkPermissions() { return { display: 'granted' }; },
  async requestPermissions() { return { display: 'granted' }; },
  async checkExactNotificationSetting() { return { exact_alarm: 'granted' }; },
  async changeExactNotificationSetting() { return { exact_alarm: 'granted' }; },
  async createChannel(channel) { calls.channels.push(channel); },
  async schedule({ notifications }) { calls.scheduled.push(...notifications); },
  async cancel({ notifications }) { calls.cancelled.push(...notifications); },
  async getPending() { return { notifications: calls.scheduled.map(n => ({ id: n.id })) }; },
  async addListener(name, handler) { calls.listener = { name, handler }; return { remove() {} }; },
};

/* ── 先按"网页端"跑一遍：不该碰任何原生能力 ── */
delete globalThis.Capacitor;
const web = await import('../src/notifications.js');
assert.equal(web.isNativeNotifications(), false);
assert.equal(await web.getNotificationPermission(), 'unsupported');
assert.equal(await web.syncDailyNotifications().then(r => r.scheduled), 0);
assert.equal(await web.scheduleTaskReminders(), 0);
await assert.rejects(() => web.scheduleChatNotification({ title: 'x', at: new Date(Date.now() + 60000).toISOString() }),
  /Android App/);
await assert.rejects(() => web.sendTestNotification(), /Android App/);
const webSave = await web.saveNotificationSettings({ ...web.DEFAULT_NOTIFICATION_SETTINGS, enabled: true });
assert.equal(webSave.scheduled, null, '网页端只存设置，不排期');

/* ── 再按"Android 壳"跑一遍 ── */
globalThis.Capacitor = {
  isNativePlatform: () => true,
  getPlatform: () => 'android',
  isPluginAvailable: name => name === 'LocalNotifications',
  registerPlugin: name => name === 'NotificationPermission'
    ? permissionPlugin
    : ({}),
};
let permissionRequests = 0;
const permissionPlugin = {
  async check() { return { display: 'granted' }; },
  async request() { permissionRequests++; return { display: 'granted' }; },
};
web.__setNotificationPluginForTest(fakePlugin);

calls.scheduled.length = 0;
calls.cancelled.length = 0;
calls.channels.length = 0;

const dailyCount = await web.scheduleDaily({
  enabled: true,
  morning: { enabled: true, time: '09:00' },
  noon: { enabled: true, time: '13:30' },
  evening: { enabled: false, time: '21:00' },
  taskNotifications: true,
});
assert.equal(dailyCount, 2, '两个开启的时段各一条');
assert.equal(calls.channels.length, 1, '创建了通知渠道');
assert.equal(calls.channels[0].id, 'msa-reminders');
assert.equal(calls.channels[0].importance, 5, '渠道是高重要性，才会横幅弹出');
assert.equal(calls.cancelled.length, 3, '排期前先撤掉三个旧时段');

const morning = calls.scheduled.find(n => n.id === 81001);
assert.ok(morning, '早间提醒被排期');
assert.deepEqual(morning.schedule.on, { hour: 9, minute: 0 }, '每日重复用 on，而不是 at');
assert.equal(morning.schedule.repeats, true);
assert.equal(morning.schedule.at, undefined, '不能同时带 at：会被当成间隔重复');
assert.equal(morning.extra.panel, 'reviews', '点通知要回到复盘页');
assert.equal(calls.scheduled.find(n => n.id === 81003), undefined, '关掉的时段不排期');
assert.equal(calls.scheduled.find(n => n.id === 81002).schedule.on.minute, 30);

/* ── 任务提醒：只排未来，只排未完成 ── */
const { db } = await import('../src/db.js');
const now = Date.now();
const hour = 60 * 60 * 1000;
const stamp = ms => {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
await db.tasks.clear();
await db.tasks.bulkPut([
  { id: 'future-task', title: '未来任务', state: 'READY', plannedStart: stamp(now + 2 * hour) },
  { id: 'past-task', title: '过去的任务', state: 'READY', plannedStart: stamp(now - 2 * hour) },
  { id: 'done-task', title: '已完成任务', state: 'DONE', plannedStart: stamp(now + 3 * hour) },
  { id: 'no-time-task', title: '没排时间的任务', state: 'READY' },
]);

calls.scheduled.length = 0;
const taskCount = await web.scheduleTaskReminders({ settings: { taskNotifications: true } });
assert.equal(taskCount, 1, '只有"未来 + 未完成 + 有时间"的任务排提醒');
const taskNotification = calls.scheduled[0];
assert.equal(taskNotification.extra.taskId, 'future-task');
assert.equal(taskNotification.extra.panel, 'tasks');
assert.ok(taskNotification.schedule.at instanceof Date, '任务提醒是单次 at');
assert.equal(taskNotification.schedule.repeats, undefined);
assert.ok(taskNotification.schedule.at.getTime() > Date.now(), 'at 在未来');

calls.scheduled.length = 0;
assert.equal(await web.scheduleTaskReminders({ settings: { taskNotifications: false } }), 0, '关掉后一条都不排');

/* ── 一次性提醒 ── */
calls.scheduled.length = 0;
const custom = await web.scheduleChatNotification({
  title: ' 该喝水了 ',
  body: '两小时后',
  at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
});
assert.equal(calls.scheduled[0].title, '该喝水了', '标题去掉首尾空格');
assert.equal(calls.scheduled[0].extra.panel, 'chat');
assert.equal(permissionRequests, 1, '直接注册的原生权限插件不依赖自动生成的 PluginHeader');
await assert.rejects(() => web.scheduleChatNotification({ title: 'x', at: new Date(Date.now() - 1000).toISOString() }),
  /未来时间/);
assert.ok(custom.id >= 2000000000);

/* ── 测试提醒：5 秒后 ── */
calls.scheduled.length = 0;
const testAt = await web.sendTestNotification();
const testDelay = testAt.getTime() - Date.now();
assert.ok(testDelay > 3000 && testDelay <= 5200, `测试提醒大约 5 秒后到达，实际 ${testDelay}ms`);
assert.equal(calls.scheduled[0].id, 81009);
assert.equal(calls.scheduled[0].extra.panel, 'reviews');

/* ── 点通知的回调：拿 extra.panel 决定去哪个面板 ── */
let navigated = null;
web.listenForNotificationNavigation((panel, extra) => { navigated = { panel, extra }; });
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(calls.listener?.name, 'localNotificationActionPerformed');
calls.listener.handler({ notification: { extra: { panel: 'tasks', taskId: 'future-task' } } });
assert.deepEqual(navigated.panel, 'tasks');
assert.equal(navigated.extra.taskId, 'future-task');
calls.listener.handler({ notification: { extra: {} } });
assert.equal(navigated.panel, 'tasks', '缺 extra 时兜底到任务页，不能什么都不做');

/* ── 保存设置：时间格式错误要说人话 ── */
await assert.rejects(() => web.saveNotificationSettings({
  enabled: true,
  morning: { enabled: true, time: '25:99' },
}), /早间复盘的时间格式无效/);

calls.scheduled.length = 0;
calls.cancelled.length = 0;
const saved = await web.saveNotificationSettings({
  enabled: true,
  morning: { enabled: true, time: '07:30' },
  noon: { enabled: false, time: '13:00' },
  evening: { enabled: true, time: '22:15' },
  taskNotifications: true,
});
assert.equal(saved.scheduled.daily, 2);
assert.equal(saved.scheduled.tasks, 1, '保存后会顺手重排任务提醒');
assert.equal(saved.morning.time, '07:30');

const stored = await web.getNotificationSettings();
assert.equal(stored.evening.time, '22:15', '设置写进了库');

console.log('Notification scheduling passed.');
