// ── 间隔重复调度（简化版 SM-2）─────────────────────────────
// 这是让"学习助手"区别于"聊天机器人"的核心：它记得你什么时候会忘。

import { clamp, nowISO } from './util.js';
import { db, addLog } from './db.js';

/** 自评档位。0-2 视为没想起来，会重置进度 */
export const GRADES = [
  { g: 0, label: '完全忘了', hint: '毫无印象' },
  { g: 1, label: '想不起来', hint: '见过，但答不出' },
  { g: 2, label: '很吃力',   hint: '提示后才想起来' },
  { g: 3, label: '想起来了', hint: '有点卡，但对了' },
  { g: 4, label: '顺利',     hint: '比较流畅' },
  { g: 5, label: '秒答',     hint: '毫不费力' },
];

export function masteryFromInterval(interval) {
  if (interval >= 90) return 5;
  if (interval >= 40) return 4;
  if (interval >= 16) return 3;
  if (interval >= 6) return 2;
  if (interval >= 1) return 1;
  return 0;
}

export function describeInterval(days) {
  if (!days) return '今天稍后';
  if (days === 1) return '明天';
  if (days < 30) return `${days} 天后`;
  const m = Math.round(days / 30);
  return m < 12 ? `${m} 个月后` : `${Math.round(days / 365)} 年后`;
}

/**
 * 纯函数：给定知识点当前 SRS 状态和本次自评，算出下一次的状态。
 * 不碰数据库，方便单独测试。
 */
export function scheduleNext(topic, grade, from = new Date()) {
  let { ease = 2.5, interval = 0, reps = 0, lapses = 0 } = topic;
  ease = clamp(ease, 1.3, 2.8);
  let nextInterval;

  if (grade < 3) {
    // 没想起来 → 重置进度，当天或明天再来
    reps = 0;
    lapses += 1;
    nextInterval = 1;
    ease = clamp(ease - 0.2, 1.3, 2.8);
  } else {
    reps += 1;
    if (reps === 1) nextInterval = 1;
    else if (reps === 2) nextInterval = 6;
    else nextInterval = Math.min(Math.round(Math.max(interval, 1) * ease), 365);
    // SM-2 的难度修正：高分拉长间隔，低分压缩
    ease = clamp(ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)), 1.3, 2.8);
  }

  const due = new Date(from);
  if (grade === 0) {
    due.setTime(from.getTime() + 10 * 60 * 1000); // 10 分钟后再来一次
    nextInterval = 0;
  } else {
    due.setDate(due.getDate() + nextInterval);
  }

  return {
    ease,
    interval: nextInterval,
    reps,
    lapses,
    lastReviewedAt: nowISO(),
    nextReviewAt: due.toISOString(),
    mastery: masteryFromInterval(nextInterval),
    dueInDays: nextInterval,
  };
}

/**
 * 落库版：给知识点评分，写回 SRS 状态，并记一条学习日志。
 */
export async function gradeTopic(topicId, grade, { minutes = 0, note = '' } = {}) {
  const topic = await db.topics.get(topicId);
  if (!topic) throw new Error('知识点不存在');

  const patch = scheduleNext(topic, grade);
  await db.topics.update(topicId, { ...patch, updatedAt: nowISO() });

  await addLog({
    topicId,
    topicName: topic.name,
    taskId: topic.taskId,
    minutes,
    what: note || `复习「${topic.name}」`,
    grade,
  });

  return { topic: { ...topic, ...patch }, dueInDays: patch.dueInDays };
}

/** 今天到期（含逾期）的知识点 */
export function dueTopics(topics, endISO) {
  return topics
    .filter(t => t.nextReviewAt && t.nextReviewAt <= endISO)
    .sort((a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt));
}

export const isDue = (topic, endISO) =>
  Boolean(topic.nextReviewAt) && topic.nextReviewAt <= endISO;
