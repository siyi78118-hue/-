import { createHash } from 'node:crypto';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const SHANGHAI_OFFSET = 8 * HOUR;

const DAILY_TEMPLATE = Object.freeze([
  ['sleep', '睡觉', 0, 7.5],
  ['morning_routine', '起床、洗漱和吃早饭', 7.5, 8.5],
  ['commute', '去工作室', 8.5, 9],
  ['work', '在工作室处理编辑工作', 9, 12],
  ['lunch', '午饭和短暂休息', 12, 13.5],
  ['work', '继续处理稿件和临时项目', 13.5, 17],
  ['commute', '下班回去', 17, 18],
  ['dinner', '吃晚饭', 18, 19],
  ['personal', '散步、打游戏或随意消磨时间', 19, 20],
  ['evening', '收拾东西，安静待一会儿', 21, 23],
  ['sleep', '准备睡觉', 23, 24]
]);

function localDayStart(timestamp) {
  return Math.floor((Number(timestamp) + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET;
}

function episodeId(characterId, dayStart, index, kind) {
  const digest = createHash('sha256')
    .update(`${characterId}|${dayStart}|${index}|${kind}|life-v1`)
    .digest('hex')
    .slice(0, 20);
  return `life_${digest}`;
}

function buildDay(characterId, dayStart) {
  return DAILY_TEMPLATE.map(([kind, title, startHour, endHour], index) => ({
    episodeId: episodeId(characterId, dayStart, index, kind),
    kind,
    title,
    startAt: dayStart + startHour * HOUR,
    endAt: dayStart + endHour * HOUR,
    payload: {
      planVersion: 'life-v1',
      ordinaryLowRisk: true
    }
  }));
}

export class LifeSimulationCoordinator {
  constructor({ store, horizonMs = 30 * HOUR } = {}) {
    if (!store) throw new Error('life simulation store is required');
    this.store = store;
    this.horizonMs = Math.max(6 * HOUR, Number(horizonMs) || 30 * HOUR);
  }

  ensureHorizon(characterId, now = Date.now()) {
    const start = localDayStart(now);
    const end = Number(now) + this.horizonMs;
    for (let dayStart = start; dayStart < end; dayStart += DAY) {
      this.store.putLifePlan(characterId, buildDay(characterId, dayStart));
    }
    return this.store.listLifeEpisodes(characterId, { from: start, to: end });
  }

  advanceTo(characterId, now = Date.now()) {
    this.ensureHorizon(characterId, now);
    this.store.advanceLifeState(characterId, now, { timezone: 'Asia/Shanghai' });
    return this.contextFor(characterId, now);
  }

  contextFor(characterId, now = Date.now()) {
    const episodes = this.store.listLifeEpisodes(characterId);
    const current = episodes.find(item => (
      item.status !== 'cancelled' && item.startAt <= now && item.endAt > now
    )) || null;
    const recent = episodes
      .filter(item => item.status !== 'cancelled' && item.endAt <= now)
      .slice(-3);
    const upcoming = episodes
      .filter(item => item.status !== 'cancelled' && item.startAt >= now)
      .slice(0, 3);
    const lastEnd = episodes
      .filter(item => item.status !== 'cancelled')
      .reduce((maximum, item) => Math.max(maximum, item.endAt), 0);
    return {
      computedAt: Number(now),
      timezone: 'Asia/Shanghai',
      current,
      recent,
      upcoming,
      revision: this.store.getCharacterLifeState(characterId)?.revision || 0,
      horizonEndAt: lastEnd || null,
      needsPlan: !lastEnd || lastEnd - Number(now) < 6 * HOUR
    };
  }

  applyAdjustment(characterId, adjustment, turnId, now = Date.now()) {
    return this.store.transaction(() => (
      this.store.applyLifeAdjustment(characterId, adjustment, turnId, now)
    ));
  }
}

