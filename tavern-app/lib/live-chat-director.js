(function initLiveChatDirector(root) {
  'use strict';

  const SCENES = new Set(['chat', 'proactive-chat', 'payment']);
  const TIME_GAPS = new Set(['instant', 'short', 'hours', 'overnight', 'days']);
  const SILENCE_CAUSES = new Set([
    'not_applicable', 'natural_pause', 'temporary_absence', 'conflict',
    'explicit_distance', 'repeated_unexplained', 'uncertain'
  ]);
  const PRESSURES = new Set(['none', 'low', 'medium', 'high']);
  const IMPULSES = new Set(['answer', 'share', 'tease', 'refuse', 'check_in', 'repair', 'pause', 'skip']);
  const STAGES = new Set(['new', 'acquainted', 'familiar', 'close', 'committed']);
  const TEXT_LIMITS = Object.freeze({
    playerIntent: 60,
    currentMood: 24,
    moodCause: 48,
    stanceTowardPlayer: 36,
    ownLifeFocus: 48,
    noticedPoint: 48,
    recommendedDirection: 80
  });
  const HIDDEN_TAGS = [
    'al_schedule', 'al_plan', 'al_payment', 'al_send_payment',
    'al_relationship_stage', 'al_moment_action'
  ];
  const HIDDEN_TAG_RE = new RegExp(
    `<(?:${HIDDEN_TAGS.join('|')})>\\s*[\\s\\S]*?\\s*<\\/(?:${HIDDEN_TAGS.join('|')})>`,
    'gi'
  );

  function compact(value, maxLength) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.slice(0, maxLength);
  }

  function enumValue(value, values, fallback) {
    return values.has(value) ? value : fallback;
  }

  function clampConfidence(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
  }

  function timeGapFor(context) {
    const now = Number(context && context.nowMs) || Date.now();
    const last = Number(context && context.lastMessageAt) || 0;
    if (!last || last > now) return 'instant';
    const gap = now - last;
    if (gap < 5 * 60 * 1000) return 'instant';
    if (gap < 2 * 60 * 60 * 1000) return 'short';
    if (gap < 18 * 60 * 60 * 1000) return 'hours';
    if (gap < 48 * 60 * 60 * 1000) return 'overnight';
    return 'days';
  }

  function fallbackDirectorCard(context = {}) {
    const scene = enumValue(context.scene, SCENES, 'chat');
    const timeGap = timeGapFor(context);
    const previousPressure = enumValue(context.previousContactPressure, PRESSURES, 'none');
    const proactive = scene === 'proactive-chat';
    const openingNeeded = proactive && ['hours', 'overnight', 'days'].includes(timeGap);
    const contactPressure = proactive && ['medium', 'high'].includes(previousPressure) ? 'low' : 'low';
    const direction = proactive
      ? openingNeeded
        ? '隔了一段时间，使用能独立看懂的自然开口或新的真实触发，不强求对方立刻回应'
        : previousPressure === 'high'
          ? '降低联系压力，换一个真实的新触发；没有自然内容时可以暂停'
          : '根据当前生活自然分享或轻量关心，不擅自判断玩家为何沉默'
      : '先按玩家消息的字面含义自然回应；潜台词证据不足时不强行心理分析';
    return {
      schemaVersion: 1,
      scene,
      timeGap,
      silenceCause: proactive ? 'uncertain' : 'not_applicable',
      previousContactPressure: previousPressure,
      relationshipStageId: enumValue(context.relationshipStageId, STAGES, 'new'),
      playerIntent: '',
      playerIntentConfidence: 0,
      currentMood: '',
      moodCause: '',
      stanceTowardPlayer: proactive ? '保持自然联系，同时尊重对方节奏' : '按当前关系自然回应',
      ownLifeFocus: '',
      noticedPoint: '',
      replyImpulse: proactive && previousPressure === 'high' ? 'pause' : proactive ? 'share' : 'answer',
      contactPressure,
      openingNeeded,
      recommendedDirection: direction,
      avoid: proactive ? ['把沉默直接解释成疏远', '连续催促回复'] : ['强行心理分析'],
      evidenceMessageIds: [],
      confidence: 0.25
    };
  }

  function normalizeDirectorCard(raw, context = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { card: fallbackDirectorCard(context), source: 'invalid', issues: ['DIRECTOR_NOT_OBJECT'] };
    }
    const fallback = fallbackDirectorCard(context);
    const issues = [];
    const validIds = new Set(Array.isArray(context.latestMessageIds) ? context.latestMessageIds.map(String) : []);
    const avoid = (Array.isArray(raw.avoid) ? raw.avoid : [])
      .map(value => compact(value, 40))
      .filter(Boolean)
      .slice(0, 5);
    const evidenceMessageIds = [...new Set(
      (Array.isArray(raw.evidenceMessageIds) ? raw.evidenceMessageIds : []).map(String)
    )].filter(id => validIds.has(id)).slice(0, 12);
    if ((raw.evidenceMessageIds || []).length !== evidenceMessageIds.length) issues.push('INVALID_EVIDENCE_IDS_REMOVED');

    const card = {
      schemaVersion: 1,
      scene: enumValue(raw.scene, SCENES, fallback.scene),
      timeGap: enumValue(raw.timeGap, TIME_GAPS, fallback.timeGap),
      silenceCause: enumValue(raw.silenceCause, SILENCE_CAUSES, fallback.silenceCause),
      previousContactPressure: enumValue(raw.previousContactPressure, PRESSURES, fallback.previousContactPressure),
      relationshipStageId: enumValue(raw.relationshipStageId, STAGES, fallback.relationshipStageId),
      playerIntent: compact(raw.playerIntent, TEXT_LIMITS.playerIntent),
      playerIntentConfidence: clampConfidence(raw.playerIntentConfidence),
      currentMood: compact(raw.currentMood, TEXT_LIMITS.currentMood),
      moodCause: compact(raw.moodCause, TEXT_LIMITS.moodCause),
      stanceTowardPlayer: compact(raw.stanceTowardPlayer, TEXT_LIMITS.stanceTowardPlayer),
      ownLifeFocus: compact(raw.ownLifeFocus, TEXT_LIMITS.ownLifeFocus),
      noticedPoint: compact(raw.noticedPoint, TEXT_LIMITS.noticedPoint),
      replyImpulse: enumValue(raw.replyImpulse, IMPULSES, fallback.replyImpulse),
      contactPressure: enumValue(raw.contactPressure, PRESSURES, fallback.contactPressure),
      openingNeeded: raw.openingNeeded === true,
      recommendedDirection: compact(raw.recommendedDirection, TEXT_LIMITS.recommendedDirection),
      avoid,
      evidenceMessageIds,
      confidence: clampConfidence(raw.confidence)
    };
    if (card.scene === 'chat') card.silenceCause = 'not_applicable';
    if (!card.stanceTowardPlayer) card.stanceTowardPlayer = fallback.stanceTowardPlayer;
    if (!card.recommendedDirection) card.recommendedDirection = fallback.recommendedDirection;
    return { card, source: 'memory-ai', issues };
  }

  function formatDirectorCard(card, names = {}) {
    const safe = card && typeof card === 'object' ? card : fallbackDirectorCard({});
    const playerName = compact(names.playerName || '玩家', 24);
    const characterName = compact(names.characterName || '角色', 24);
    const avoid = Array.isArray(safe.avoid) && safe.avoid.length ? safe.avoid.join('；') : '无额外事项';
    return [
      '【本轮隐藏导演卡】',
      '以下内容只用于决定角色此刻的理解、情绪、边界和开口方向。',
      '它不是台词提纲，不要求逐项表达，不得复述、解释或提及导演卡。',
      `场景：${safe.scene || 'chat'}；时间间隔：${safe.timeGap || 'instant'}；关系阶段：${safe.relationshipStageId || 'new'}`,
      `对${playerName}意图的判断：${safe.playerIntent || '证据不足，按字面含义理解'}（置信度 ${Number(safe.playerIntentConfidence || 0).toFixed(2)}）`,
      `${characterName}当前情绪：${safe.currentMood || '按当前语境自然形成'}；原因：${safe.moodCause || '无额外证据'}`,
      `本轮态度与边界：${safe.stanceTowardPlayer || '按当前关系自然回应'}`,
      `自己的生活重心：${safe.ownLifeFocus || '无须强行补充'}`,
      `最值得接住的一点：${safe.noticedPoint || '当前可见消息本身'}`,
      `回复冲动：${safe.replyImpulse || 'answer'}；联系压力：${safe.contactPressure || 'low'}；需要重新开口：${safe.openingNeeded === true ? '是' : '否'}`,
      `建议方向：${safe.recommendedDirection || '自然回应'}`,
      `本轮避免：${avoid}`
    ].join('\n');
  }

  function visibleReplyText(rawReply) {
    return String(rawReply == null ? '' : rawReply)
      .replace(HIDDEN_TAG_RE, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizedComparable(text) {
    return String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  function diceSimilarity(left, right) {
    const a = normalizedComparable(left);
    const b = normalizedComparable(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const grams = value => {
      const counts = new Map();
      if (value.length < 2) return new Map([[value, 1]]);
      for (let index = 0; index < value.length - 1; index++) {
        const gram = value.slice(index, index + 2);
        counts.set(gram, (counts.get(gram) || 0) + 1);
      }
      return counts;
    };
    const ag = grams(a);
    const bg = grams(b);
    let overlap = 0;
    for (const [gram, count] of ag) overlap += Math.min(count, bg.get(gram) || 0);
    const total = [...ag.values()].reduce((sum, count) => sum + count, 0)
      + [...bg.values()].reduce((sum, count) => sum + count, 0);
    return total ? (2 * overlap) / total : 0;
  }

  function explicitPeriodConflict(text, nowMs) {
    const hour = new Date(Number(nowMs) || Date.now()).getHours();
    const current = hour < 5 ? 'late' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'night';
    const cleaned = String(text || '').replace(/昨晚|昨天晚上|今早说过|早上说过|下午说过|晚上说过/g, '');
    const claims = [];
    if (/(?:现在|这会儿|此刻).{0,3}(?:凌晨|半夜|深夜)/.test(cleaned)) claims.push('late');
    if (/(?:现在|这会儿|此刻).{0,3}(?:早上|上午|清晨)/.test(cleaned)) claims.push('morning');
    if (/(?:现在|这会儿|此刻).{0,3}(?:中午|下午)/.test(cleaned)) claims.push('afternoon');
    if (/(?:现在|这会儿|此刻).{0,3}(?:晚上|夜里)/.test(cleaned)) claims.push('night');
    return claims.some(claim => claim !== current);
  }

  function validateLiveChatReply(rawReply, context = {}) {
    const scene = enumValue(context.scene, SCENES, 'chat');
    const visibleText = visibleReplyText(rawReply);
    const hardCodes = [];
    const softCodes = [];
    const add = (list, code) => { if (!list.includes(code)) list.push(code); };
    const rawWithoutKnownTags = visibleText;

    if (/\b(?:end_turn|turn_end)\b|<al_[a-z_]+>/i.test(rawWithoutKnownTags)) {
      add(hardCodes, 'CONTROL_MARKER_LEAK');
    }
    if (/^\s*\{[\s\S]*"(?:reply|text|usedFactIds)"\s*:/i.test(visibleText)) {
      add(hardCodes, 'JSON_WRAPPER_LEAK');
    }
    if (/(?:^|\n)\s*\*[^*\n]{1,100}\*\s*(?:$|\n)|（\s*(?:她|他|我)[^）]{0,80}）|\[\s*旁白\s*\]/m.test(visibleText)) {
      add(hardCodes, 'NARRATION_LEAK');
    }
    if (explicitPeriodConflict(visibleText, context.nowMs)) add(hardCodes, 'TIME_PERIOD_CONFLICT');
    if (context.lastAssistantText && diceSimilarity(visibleText, context.lastAssistantText) >= 0.9) {
      add(hardCodes, 'NEAR_DUPLICATE_REPLY');
    }
    const gap = (Number(context.nowMs) || Date.now()) - (Number(context.lastMessageAt) || 0);
    const firstBubble = visibleText.split(/\n+/).map(value => value.trim()).find(Boolean) || '';
    if (
      scene === 'proactive-chat'
      && gap >= 2 * 60 * 60 * 1000
      && /^(?:然后|还有呢|所以呢|那就|可是|但是|而且|至于|接着)/.test(firstBubble)
    ) add(hardCodes, 'PROACTIVE_OPENING_MISSING');

    const questionCount = (visibleText.match(/[？?]/g) || []).length;
    if (questionCount >= 3) add(softCodes, 'QUESTION_OVERLOAD');
    const bubbles = visibleText.split(/\n+/).map(value => value.trim()).filter(Boolean);
    if (bubbles.length >= 2 && bubbles.every(value => /[？?]\s*$/.test(value))) {
      add(softCodes, 'ALL_BUBBLES_QUESTIONS');
    }
    const responsePressure = /(?:怎么|为什么).{0,6}(?:不回|没回)|(?:回我|理我|在吗|干嘛呢|说话)/.test(visibleText);
    if (scene === 'proactive-chat' && context.previousContactPressure === 'high' && responsePressure) {
      add(softCodes, 'REPEATED_CONTACT_PRESSURE');
    }
    const director = context.directorCard || {};
    if (
      scene === 'proactive-chat'
      && (director.contactPressure === 'low' || director.replyImpulse === 'skip')
      && responsePressure
    ) add(softCodes, 'DIRECTOR_PRESSURE_CONFLICT');
    if (bubbles.length === 1 && visibleText.length > 180 && (visibleText.match(/[，。；！？!?]/g) || []).length >= 5) {
      add(softCodes, 'OVERSIZED_SINGLE_BUBBLE');
    }

    const codes = [...hardCodes, ...softCodes];
    const rewriteNeeded = scene !== 'payment' && (hardCodes.length > 0 || softCodes.length >= 2);
    return {
      ok: codes.length === 0,
      scene,
      severity: hardCodes.length ? 'hard' : softCodes.length ? 'soft' : 'none',
      codes,
      hardCodes,
      softCodes,
      visibleText,
      rewriteNeeded
    };
  }

  function shouldRewriteReply(report) {
    if (!report || report.scene === 'payment') return false;
    return report.rewriteNeeded === true
      || (Array.isArray(report.hardCodes) && report.hardCodes.length > 0)
      || (Array.isArray(report.softCodes) && report.softCodes.length >= 2);
  }

  function buildRewriteInstruction(rawReply, report = {}, directorText = '', context = {}) {
    const visible = visibleReplyText(rawReply);
    const codes = Array.isArray(report.codes) ? report.codes.join(', ') : '';
    const now = new Date(Number(context.nowMs) || Date.now()).toLocaleString('zh-CN', { hour12: false });
    return [
      '请重写下面这次回复。',
      '只输出修正后的可见聊天正文，不输出 JSON、分析、标签、系统说明或导演卡。',
      '保留原意、角色态度和关系边界，不要自动变得更温柔、更亲密。',
      '如果需要多条气泡，用换行分隔。每轮只允许这一次重写。',
      `当前场景：${context.scene || 'chat'}；当前设备时间：${now}`,
      `需要修正的问题代码：${codes || 'UNKNOWN'}`,
      directorText ? `本轮方向参考：\n${directorText}` : '',
      `原可见回复：\n${visible}`
    ].filter(Boolean).join('\n\n');
  }

  root.ALLiveChatDirector = {
    normalizeDirectorCard,
    fallbackDirectorCard,
    formatDirectorCard,
    visibleReplyText,
    validateLiveChatReply,
    shouldRewriteReply,
    buildRewriteInstruction
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
