import { readFileSync } from 'node:fs';

const TURN_SCENES = Object.freeze({
  DIRECT_REPLY: 'direct_chat',
  ROLE_PLAN_CHAT: 'role_plan_chat',
  ROLE_PLAN_MOMENT: 'role_plan_moment',
  ROLE_PLAN_CHAT_PRIVATE: 'role_plan_chat_private',
  ROLE_PLAN_MOMENT_PRIVATE: 'role_plan_moment_private',
  PROACTIVE_CHAT: 'proactive_chat',
  PROACTIVE_MOMENT: 'proactive_moment',
  MOMENT_INTERACTION: 'moment_interaction',
  MOMENT_REPLY: 'moment_reply'
});

function strings(value) {
  return Array.isArray(value) ? value.map(String).map(item => item.trim()).filter(Boolean) : [];
}

function validateLesson(value) {
  if (!value || typeof value !== 'object') throw new Error('social lesson must be an object');
  if (!String(value.lessonId || '')) throw new Error('social lesson requires lessonId');
  if (value.status !== 'approved') throw new Error(`social lesson ${value.lessonId} must be approved`);
  for (const field of ['scenes', 'relationshipStages', 'appliesWhen', 'counterSignals']) {
    if (!Array.isArray(value[field])) throw new Error(`social lesson ${value.lessonId} requires ${field}`);
  }
  if (!String(value.principle || '')) throw new Error(`social lesson ${value.lessonId} requires principle`);
  return Object.freeze({
    ...value,
    lessonId: String(value.lessonId),
    priority: Number(value.priority || 0),
    scenes: strings(value.scenes),
    relationshipStages: strings(value.relationshipStages),
    appliesWhen: strings(value.appliesWhen),
    counterSignals: strings(value.counterSignals),
    forbiddenInference: strings(value.forbiddenInference)
  });
}

export function loadSocialExperienceCatalog(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (parsed?.schemaVersion !== 1) throw new Error('unsupported social-experience schemaVersion');
  if (!Array.isArray(parsed.lessons)) throw new Error('social-experience lessons must be an array');
  return Object.freeze({
    ...parsed,
    lessons: Object.freeze(parsed.lessons.map(validateLesson))
  });
}

export function selectSocialExperience({
  catalog,
  turnKind,
  currentBatch,
  trigger,
  relationshipStage,
  routeReasons,
  limit = 5
}) {
  const scene = TURN_SCENES[String(turnKind || '')] || String(turnKind || '').toLowerCase();
  const stage = String(relationshipStage?.id || relationshipStage?.base?.id || '');
  const haystack = [
    ...(currentBatch?.messages || []).map(item => item?.content),
    trigger?.content,
    trigger?.text,
    ...(routeReasons || [])
  ].filter(Boolean).join(' ').toLowerCase();
  const safeLimit = Math.max(0, Math.min(5, Number(limit) || 5));

  return (catalog?.lessons || [])
    .filter(item => item?.status === 'approved')
    .filter(item => strings(item.scenes).includes(scene))
    .filter(item => {
      const stages = strings(item.relationshipStages);
      return stages.includes('all') || !stages.length || stages.includes(stage);
    })
    .filter(item => !strings(item.counterSignals).some(signal => haystack.includes(signal.toLowerCase())))
    .map(item => {
      const matchedTerms = strings(item.appliesWhen)
        .filter(term => haystack.includes(term.toLowerCase()));
      const matchedReasons = strings(routeReasons)
        .filter(reason => haystack.includes(reason.toLowerCase()));
      const selectionScore = Number(item.priority || 0)
        + 20
        + (stage && strings(item.relationshipStages).includes(stage) ? 10 : 0)
        + matchedTerms.length * 15
        + matchedReasons.length * 3;
      return {
        ...item,
        selectionScore,
        selectionReasons: [
          `scene:${scene}`,
          ...(stage ? [`stage:${stage}`] : []),
          ...matchedTerms.map(term => `term:${term}`),
          ...matchedReasons.map(reason => `route:${reason}`)
        ]
      };
    })
    .sort((left, right) => right.selectionScore - left.selectionScore
      || String(left.lessonId).localeCompare(String(right.lessonId)))
    .slice(0, safeLimit);
}
