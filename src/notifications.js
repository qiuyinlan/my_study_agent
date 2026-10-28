// ── 手机通知（Android 本地通知）─────────────────────────────────
//
// 网页端只保存设置，真正的定时与投递全在 Android 壳里做。
// 这里所有原生调用都经过 native.js：模块顶层不出现裸模块导入，
// 否则网站会白屏（见 src/native.js 的说明）。
//
// 两个踩过的坑，改之前先看清楚：
//
//   1) 每日重复不能用 { at, repeats: true }。
//      Capacitor Android 的实现是
//        alarmManager.setRepeating(RTC, at.time, at.time - now, ...)
//      —— 它把"保存时刻到今天的触发点"这段间隔当成了重复周期。
//      早上 8 点保存一个 9:00 的提醒，就会变成每 1 小时响一次。
//      正确写法是 { on: { hour, minute }, repeats: true }，插件每触发一次会按
//      日历重排下一次（TimedNotificationPublisher 里的 CRON 分支）。
//
//   2) 权限要在用户"打开开关"的那一刻就要，不要等到点保存。
//      等保存时才要权限，用户点完看不出任何反馈，很容易以为按钮坏了。

import { getMeta, listTasks, setMeta } from './db.js';
import { isNativePlatform, nativePlatform } from './native.js';

const SETTINGS_KEY = 'notificationSettings';
const CHANNEL_ID = 'msa-reminders';
const DAILY_IDS = { morning: 81001, noon: 81002, evening: 81003 };
const TEST_ID = 81009;
const TASK_ID_BASE = 100000;
const TASK_ID_SPAN = 1000000000;
const MAX_TASK_NOTIFICATIONS = 120;

const DAILY_BODY = {
  morning: '开始今天的复盘，确认今天最重要的一步。',
  noon: '花几分钟回看上午进展，调整接下来的安排。',
  evening: '回顾今天的完成与卡点，为明天留下一步。',
};

export const DAILY_SLOTS = ['morning', 'noon', 'evening'];
export const DAILY_LABELS = { morning: '早间复盘', noon: '午间复盘', evening: '晚间复盘' };

export const DEFAULT_NOTIFICATION_SETTINGS = {
  enabled: false,
  morning: { enabled: true, time: '09:00' },
  noon: { enabled: true, time: '13:00' },
  evening: { enabled: true, time: '21:00' },
  taskNotifications: true,
};

export const isNativeNotifications = () => isNativePlatform();

/* ══════════════ 插件懒加载 ══════════════ */

let plugin = null;

/**
 * 原生调用一律加超时。
 * 桥没通、插件没注册、系统设置页没返回时，Capacitor 的 Promise 可能一直不 settle；
 * 那时 await 会挂住，界面就停在空白上 —— 用户看到的就是"白屏"。
 * 宁可给一句"读不到"，也不要什么都不显示。
 */
function withTimeout(promise, ms = 4000, fallbackValue) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms)),
  ]);
}

/** 拿到 LocalNotifications 插件实例；网页端直接抛可读错误。 */
async function notifications() {
  if (plugin) return plugin;
  if (!isNativePlatform()) throw new Error('手机系统通知仅在 Android App 中可用。');
  const module = await import('@capacitor/local-notifications');
  plugin = module.LocalNotifications;
  return plugin;
}

/* 仅用于测试：注入假插件，验证排期参数而不需要真机。 */
export function __setNotificationPluginForTest(fake) {
  plugin = fake;
}

async function ensureChannel(api) {
  if (nativePlatform() !== 'android') return;
  try {
    await api.createChannel({
      id: CHANNEL_ID,
      name: '学习提醒',
      description: '复盘提醒与任务开始提醒',
      importance: 5,
      visibility: 1,
      vibration: true,
      lights: true,
    });
  } catch {
    // 老系统没有通知渠道，忽略即可。
  }
}

/* ══════════════ 设置读写 ══════════════ */

const mergeSettings = input => ({
  ...DEFAULT_NOTIFICATION_SETTINGS,
  ...input,
  morning: { ...DEFAULT_NOTIFICATION_SETTINGS.morning, ...input?.morning },
  noon: { ...DEFAULT_NOTIFICATION_SETTINGS.noon, ...input?.noon },
  evening: { ...DEFAULT_NOTIFICATION_SETTINGS.evening, ...input?.evening },
});

export async function getNotificationSettings() {
  return mergeSettings(await getMeta(SETTINGS_KEY, {}));
}

/* ══════════════ 权限 ══════════════ */

export async function getNotificationPermission() {
  if (!isNativePlatform()) return 'unsupported';
  try {
    const result = await withTimeout((await notifications()).checkPermissions(), 4000, { display: 'unavailable' });
    return result?.display || 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** Android 12+ 的「闹钟和提醒」权限；低版本一律视为已授予。 */
export async function getExactAlarmPermission() {
  if (nativePlatform() !== 'android') return 'granted';
  try {
    const state = await withTimeout((await notifications()).checkExactNotificationSetting(), 4000, { exact_alarm: 'unknown' });
    return state?.exact_alarm || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 要系统通知权限。只抛"通知权限被拒绝"这一种错，
 * 「闹钟和提醒」没开不算失败 —— 那只会让提醒晚几分钟，不该拦住保存。
 * 每一步都带超时：系统弹窗没出现时也要给用户一句人话，不能卡在"点了没反应"。
 */
export async function requestNotificationPermission() {
  if (!isNativePlatform()) throw new Error('手机系统通知仅在 Android App 中可用。');
  const api = await notifications();
  let state = await withTimeout(api.checkPermissions(), 4000, { display: 'unavailable' });
  if (state?.display !== 'granted') {
    state = await withTimeout(api.requestPermissions(), 60000, { display: 'unavailable' });
  }
  if (state?.display === 'unavailable') {
    throw new Error('系统没有响应通知权限请求。请退出应用重进，然后在「设置 → 应用 → My Study Agent → 通知」里手动允许。');
  }
  if (state?.display !== 'granted') {
    throw new Error('系统通知权限没有开启：请到「设置 → 应用 → My Study Agent → 通知」里允许通知。');
  }
  return state.display;
}

/**
 * Android 13+ 用户连点两次拒绝后，系统就**不再弹权限框**了：
 * requestPermissions() 只会立刻返回 denied，用户看到的就是"点了没反应"。
 * 那时唯一有效的动作是把他送到系统设置页自己打开通知。
 *
 * 这里走壳里注册的 AppSettings 插件（android/.../AppSettingsPlugin.java）。
 * 插件名用动态 import + registerPlugin：src/ 下不能出现静态裸模块导入，
 * 否则网站会整页白屏（见 src/native.js）。
 */
export async function openNotificationSettings() {
  if (!isNativePlatform()) throw new Error('手机系统通知仅在 Android App 中可用。');
  const { Capacitor } = await import('@capacitor/core');
  const plugin = Capacitor.Plugins?.AppSettings || Capacitor.registerPlugin('AppSettings');
  if (!plugin) throw new Error('当前 App 版本还没有内置「打开通知设置」，请更新到最新版本。');
  await withTimeout(plugin.openNotificationSettings(), 6000, null);
}

/** 用户主动点了「让提醒更准时」才打开系统设置页，避免莫名其妙跳转。 */
export async function requestExactAlarmPermission() {
  if (nativePlatform() !== 'android') return 'granted';
  const api = await notifications();
  try {
    const before = await withTimeout(api.checkExactNotificationSetting(), 4000, { exact_alarm: 'unknown' });
    if (before?.exact_alarm === 'granted') return 'granted';
    const after = await withTimeout(api.changeExactNotificationSetting(), 60000, { exact_alarm: 'unknown' });
    return after?.exact_alarm || 'unknown';
  } catch (error) {
    throw new Error(error?.message || '无法打开「闹钟和提醒」设置。');
  }
}

/* ══════════════ 排期 ══════════════ */

export async function scheduleDaily(settings = null) {
  if (!isNativePlatform()) return 0;
  const config = settings || await getNotificationSettings();
  const api = await notifications();
  await ensureChannel(api);
  await api.cancel({ notifications: DAILY_SLOTS.map(key => ({ id: DAILY_IDS[key] })) });

  const list = [];
  for (const key of DAILY_SLOTS) {
    const slot = config[key];
    if (!config.enabled || !slot?.enabled) continue;
    const [hour, minute] = String(slot.time).split(':').map(Number);
    list.push({
      id: DAILY_IDS[key],
      title: '复盘时间',
      body: DAILY_BODY[key],
      channelId: CHANNEL_ID,
      // on + repeats = 每天这个时刻重复（不是"间隔重复"，见文件头注释 1）。
      schedule: { on: { hour, minute }, repeats: true, allowWhileIdle: true },
      extra: { panel: 'reviews', kind: 'daily-review', slot: key },
    });
  }
  if (list.length) await api.schedule({ notifications: list });
  return list.length;
}

function taskNotificationId(id) {
  let hash = 2166136261;
  for (const char of String(id)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return TASK_ID_BASE + (hash >>> 0) % TASK_ID_SPAN;
}

function parsePlannedStart(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function scheduleTaskReminders({ tasks = null, settings = null } = {}) {
  if (!isNativePlatform()) return 0;
  const config = settings || await getNotificationSettings();
  const api = await notifications();
  await ensureChannel(api);

  const all = tasks || await listTasks();
  // 先全部撤掉，再按当前状态重排：任务改了时间/完成/取消都不会留旧闹钟。
  const cancelIds = all.map(task => ({ id: taskNotificationId(task.id) }));
  if (cancelIds.length) await api.cancel({ notifications: cancelIds });
  if (!config.taskNotifications) return 0;

  const now = Date.now();
  const list = all
    .filter(task => task.plannedStart && !['DONE', 'CANCELLED'].includes(task.state))
    .map(task => ({ task, at: parsePlannedStart(task.plannedStart) }))
    .filter(item => item.at && item.at.getTime() > now)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_TASK_NOTIFICATIONS)
    .map(({ task, at }) => ({
      id: taskNotificationId(task.id),
      title: `任务开始：${task.title}`,
      body: task.nextAction || task.goal || '到计划时间了，开始当前任务。',
      channelId: CHANNEL_ID,
      schedule: { at, allowWhileIdle: true },
      extra: { panel: 'tasks', taskId: task.id },
    }));
  if (list.length) await api.schedule({ notifications: list });
  return list.length;
}

/* 兼容旧名字 */
export const syncTaskNotifications = scheduleTaskReminders;

export async function syncDailyNotifications() {
  if (!isNativePlatform()) return { scheduled: 0 };
  const permission = await getNotificationPermission();
  if (permission !== 'granted') return { scheduled: 0, permission };
  const settings = await getNotificationSettings();
  const scheduled = await scheduleDaily(settings);
  return { scheduled };
}

/** 保存设置：先要权限（失败就报错），再写库，再按新设置重排。 */
export async function saveNotificationSettings(input) {
  const settings = mergeSettings(input);
  for (const key of DAILY_SLOTS) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(settings[key].time)) {
      throw new Error(`${DAILY_LABELS[key]}的时间格式无效，请用 HH:MM。`);
    }
  }
  if (isNativePlatform() && (settings.enabled || settings.taskNotifications)) {
    await requestNotificationPermission();
  }
  await setMeta(SETTINGS_KEY, settings);
  if (!isNativePlatform()) return { ...settings, scheduled: null };
  const daily = await scheduleDaily(settings);
  const tasks = await scheduleTaskReminders({ settings });
  return { ...settings, scheduled: { daily, tasks } };
}

/* ══════════════ 一次性提醒（聊天工具 schedule_notification）════════ */

export async function scheduleChatNotification({ title, body = '', at }) {
  if (!isNativePlatform()) throw new Error('一次性手机通知仅在 Android App 中可用。');
  const api = await notifications();
  await requestNotificationPermission();
  const when = new Date(at);
  if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
    throw new Error('通知时间必须是未来时间，并包含时区或本地时间。');
  }
  await ensureChannel(api);
  const next = (await getMeta('nextCustomNotificationId', 1)) || 1;
  const id = 2000000000 + (next % 100000000);
  await setMeta('nextCustomNotificationId', next + 1);
  await api.schedule({ notifications: [{
    id,
    title: String(title).trim(),
    body: String(body).trim(),
    channelId: CHANNEL_ID,
    schedule: { at: when, allowWhileIdle: true },
    extra: { panel: 'chat' },
  }] });
  return { id, at: when };
}

/** 设置页的「发送测试提醒」：5 秒后到，点通知应该回到复盘页。 */
export async function sendTestNotification() {
  if (!isNativePlatform()) throw new Error('手机系统通知仅在 Android App 中可用。');
  const api = await notifications();
  await requestNotificationPermission();
  await ensureChannel(api);
  const at = new Date(Date.now() + 5000);
  await api.schedule({ notifications: [{
    id: TEST_ID,
    title: '测试提醒',
    body: '能看到这条，说明提醒能正常送达。点一下应该打开复盘页。',
    channelId: CHANNEL_ID,
    schedule: { at, allowWhileIdle: true },
    extra: { panel: 'reviews', kind: 'test' },
  }] });
  return at;
}

/* ══════════════ 点通知回到对应页面 ══════════════ */

export function listenForNotificationNavigation(onNavigate) {
  if (!isNativePlatform()) return () => {};
  let disposed = false;
  let handle = null;
  void (async () => {
    try {
      const api = await notifications();
      const listener = await api.addListener('localNotificationActionPerformed', event => {
        const extra = event?.notification?.extra || {};
        const panel = typeof extra.panel === 'string' && extra.panel ? extra.panel : 'tasks';
        onNavigate(panel, extra);
      });
      if (disposed) void listener?.remove?.();
      else handle = listener;
    } catch (error) {
      console.warn('[notification-nav]', error);
    }
  })();
  return () => {
    disposed = true;
    void handle?.remove?.();
  };
}

/* ══════════════ 状态查询（给通知页用）══════════════ */

export async function notificationCounts() {
  if (!isNativePlatform()) return { pending: 0, native: false };
  try {
    const result = await withTimeout((await notifications()).getPending(), 4000, null);
    if (!result) return { pending: 0, native: true, error: '读取待发送提醒超时' };
    return { pending: result.notifications?.length || 0, native: true };
  } catch (error) {
    return { pending: 0, native: true, error: error?.message || String(error) };
  }
}

export async function cancelAllNotifications() {
  if (!isNativePlatform()) return 0;
  const api = await notifications();
  const { notifications: pending } = await api.getPending();
  if (pending.length) await api.cancel({ notifications: pending.map(item => ({ id: item.id })) });
  return pending.length;
}

/**
 * 诊断用：一次把"外壳 / 平台 / 插件 / 权限"这些设备事实取出来。
 * 有了这行，用户说"点了没反应"时就不用猜 —— 直接看图里写的是哪一步断了。
 */
export async function notificationDiagnostics() {
  const native = isNativePlatform();
  const platform = nativePlatform();
  const pluginAvailable = Boolean(globalThis.Capacitor?.isPluginAvailable?.('LocalNotifications'));
  if (!native) return { native, platform, pluginAvailable, permission: 'unsupported', exactAlarm: 'n/a' };
  const [permission, exactAlarm] = await Promise.all([getNotificationPermission(), getExactAlarmPermission()]);
  return { native, platform, pluginAvailable, permission, exactAlarm };
}
