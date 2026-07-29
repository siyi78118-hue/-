import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentHash } from './protocol.mjs';

export const PRESET_ROLES = Object.freeze([
  'cognition',
  'expression',
  'consolidation',
  'supervisor'
]);
export const PRESET_ROLE_ALIASES = Object.freeze({
  brain: 'expression',
  memory: 'consolidation'
});

const ROLE_SET = new Set(PRESET_ROLES);
const LEGACY_MODULES = new Set(['foundation', 'brain', 'memory', 'supervisor']);
const COGNITION_MODULES = new Set([
  'foundation',
  'cognition',
  'socialExperience',
  'expression',
  'consolidation',
  'supervisor'
]);
const defaultPresetDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'presets');
const HIDDEN_BIOGRAPHY = /许弥|焦虑依恋|用户过去|用户曾经|原生家庭|隐藏画像|未透露.{0,10}(经历|事实)/i;

export function normalizePresetRole(role) {
  const normalized = PRESET_ROLE_ALIASES[role] || role;
  if (!ROLE_SET.has(normalized)) throw new Error(`unknown preset role: ${role}`);
  return normalized;
}

function normalizeManifest(manifest) {
  if (manifest?.schemaVersion === 1) {
    return {
      schemaVersion: 1,
      currentVersion: manifest.currentVersion,
      candidateVersion: null,
      characterId: manifest.characterId,
      versions: {
        [manifest.currentVersion]: {
          modules: manifest.modules
        }
      }
    };
  }
  if (manifest?.schemaVersion === 2 && manifest.versions && typeof manifest.versions === 'object') {
    return manifest;
  }
  throw new Error(`unsupported preset manifest schema: ${manifest?.schemaVersion}`);
}

function loadManifest(presetDir) {
  return normalizeManifest(JSON.parse(readFileSync(join(presetDir, 'manifest.json'), 'utf8')));
}

function loadVersionModules(presetDir, manifest, version) {
  const entry = manifest.versions?.[version];
  if (!entry?.modules) throw new Error(`preset version is unavailable: ${version}`);
  const allowedModules = manifest.schemaVersion === 1 || entry.modules.brain
    ? LEGACY_MODULES
    : COGNITION_MODULES;
  const modules = {};
  for (const [moduleName, filename] of Object.entries(entry.modules)) {
    if (!allowedModules.has(moduleName)) throw new Error(`unknown preset module: ${moduleName}`);
    modules[moduleName] = readFileSync(join(presetDir, filename), 'utf8').trim();
    if (!modules[moduleName]) throw new Error(`missing preset module: ${moduleName}`);
  }
  for (const required of allowedModules) {
    if (!String(modules[required] || '').trim()) {
      throw new Error(`missing preset module: ${required}`);
    }
  }
  return modules;
}

function renderApprovedLessons(moduleText, selections) {
  let asset;
  try {
    asset = JSON.parse(moduleText);
  } catch {
    throw new Error('social experience asset must be valid JSON');
  }
  const selectedIds = new Set(
    (Array.isArray(selections) ? selections : [])
      .map((selection) => selection?.lessonId)
      .filter(Boolean)
  );
  const lessons = Array.isArray(asset.lessons)
    ? asset.lessons.filter(
        (lesson) => lesson?.status === 'approved' && selectedIds.has(lesson.lessonId)
      )
    : [];
  return [
    '## 已批准社会经验',
    ...lessons.map((lesson) => [
      `### ${lesson.lessonId}`,
      `适用场景：${lesson.scenes.join(', ')}`,
      `关系阶段：${lesson.relationshipStages.join(', ')}`,
      `原则：${lesson.principle}`,
      `反信号：${lesson.counterSignals.join('；')}`,
      `禁止推断：${lesson.forbiddenInference.join('；')}`
    ].join('\n'))
  ].join('\n\n');
}

function renderAnnotations(role, annotations) {
  const matching = (Array.isArray(annotations) ? annotations : [])
    .filter((annotation) => {
      try {
        return normalizePresetRole(annotation?.targetModule) === role;
      } catch {
        return false;
      }
    })
    .map((annotation) => String(annotation.instruction || '').trim())
    .filter(Boolean);
  return matching.length
    ? [`## ${role} 人工标注`, ...matching].join('\n\n')
    : '';
}

function resolveBundleFromPreset({ preset, role, annotations = [] }) {
  const normalizedRole = normalizePresetRole(role);
  const { modules } = preset;
  const annotationText = renderAnnotations(normalizedRole, annotations);
  let parts;
  if (modules.brain) {
    parts = normalizedRole === 'expression'
      ? [modules.foundation, modules.brain]
      : normalizedRole === 'consolidation'
        ? [modules.memory]
        : normalizedRole === 'supervisor'
          ? [
              modules.supervisor,
              '## 本轮权威生成预设\n以下内容是被监督回复实际使用的完整生成预设，必须据此复核人物一致性。',
              modules.foundation,
              modules.brain
            ]
          : null;
  } else {
    parts = normalizedRole === 'cognition'
      ? [
          modules.foundation,
          modules.cognition,
          renderApprovedLessons(modules.socialExperience, annotations),
          annotationText
        ]
      : normalizedRole === 'expression'
        ? [modules.expression, annotationText]
        : normalizedRole === 'consolidation'
          ? [modules.consolidation, annotationText]
          : [modules.supervisor, modules.foundation, modules.cognition, modules.expression, annotationText];
  }
  if (!parts) {
    throw new Error(`preset role ${normalizedRole} is unavailable in version ${preset.version}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

export function resolvePresetBundle({
  role,
  version,
  annotations = [],
  presetDir = defaultPresetDir
}) {
  const manifest = loadManifest(presetDir);
  const modules = loadVersionModules(presetDir, manifest, version);
  return resolveBundleFromPreset({
    preset: { version, characterId: manifest.characterId, modules },
    role,
    annotations
  });
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`invalid semantic version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function compareVersions(left, right) {
  const a = String(left || '').split('.').map(Number);
  const b = String(right || '').split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function clone(value) {
  return structuredClone(value);
}

export class PresetRegistry {
  constructor({ presetDir, store, clock = Date.now }) {
    if (!presetDir || !store) throw new Error('presetDir and store are required');
    this.presetDir = presetDir;
    this.store = store;
    this.clock = clock;
    this.initializeSeed();
  }

  initializeSeed() {
    const manifest = loadManifest(this.presetDir);
    for (const version of Object.keys(manifest.versions)) {
      const modules = loadVersionModules(this.presetDir, manifest, version);
      const checksum = contentHash({ version, modules });
      const existing = this.store.getPresetVersion(version);
      if (existing) {
        const isSameSeed = existing.parentVersion === null
          && existing.characterId === manifest.characterId
          && existing.checksum === checksum
          && existing.annotationIds.length === 0
          && existing.rollbackOf === null;
        if (!isSameSeed) throw new Error(`preset seed conflict: ${version}`);
        continue;
      }
      this.store.putPresetVersion({
        version,
        parentVersion: null,
        characterId: manifest.characterId,
        modules,
        changedModules: Object.keys(modules),
        annotationIds: [],
        rollbackOf: null,
        checksum,
        publishedAt: this.clock()
      });
    }

    const desired = this.store.getPresetVersion(manifest.currentVersion);
    if (!desired) throw new Error('manifest current preset version is unavailable');
    const currentVersion = this.store.getCurrentPresetVersion();
    const current = currentVersion ? this.store.getPresetVersion(currentVersion) : null;
    const currentIsUnannotatedSeed = current
      && current.parentVersion === null
      && current.annotationIds.length === 0;
    if (!currentVersion || (
      currentIsUnannotatedSeed
      && compareVersions(currentVersion, manifest.currentVersion) < 0
    )) {
      this.store.setCurrentPresetVersion(manifest.currentVersion);
    }
  }

  current() {
    const version = this.store.getCurrentPresetVersion();
    const preset = this.store.getPresetVersion(version);
    if (!preset) throw new Error('current preset version is unavailable');
    return clone(preset);
  }

  evidenceManifest(rolloutKey) {
    const preset = this.current();
    const modules = preset.modules || {};
    const shared = {
      cognitionPresetChecksum: contentHash(modules.cognition || modules.brain || {}),
      expressionPresetChecksum: contentHash(modules.expression || modules.brain || {}),
      supervisorPresetChecksum: contentHash(modules.supervisor || {}),
      schemaAdapterBundleChecksum: contentHash({
        rolloutKey,
        schema: modules.socialExperience || {},
        life: rolloutKey === 'LIFE_PLANNING' ? modules.lifePlanning || modules.memory || {} : null
      }),
      modelProfileChecksum: contentHash(modules.modelProfiles || {}),
      approvedAnnotationCatalogChecksum: contentHash(preset.annotationIds || []),
      comparisonEvaluatorChecksum: contentHash({ evaluator: 'yuqi-cognition-v2', schemaVersion: 1 }),
      legacyBaselineChecksum: contentHash({
        foundation: modules.foundation || {},
        brain: modules.brain || {},
        memory: modules.memory || {},
        supervisor: modules.supervisor || {}
      })
    };
    return { manifest: shared, checksum: contentHash(shared), presetVersion: preset.version };
  }

  resolvePresetBundle({ role, version, annotations = [] }) {
    const preset = this.store.getPresetVersion(version);
    if (!preset) throw new Error(`preset version is unavailable: ${version}`);
    return resolveBundleFromPreset({ preset, role, annotations });
  }

  compileFor(role, scene = {}) {
    const normalizedRole = normalizePresetRole(role);
    const preset = this.current();
    const dynamic = scene.scene && typeof scene.scene === 'object' ? scene.scene : scene;
    const relationshipStage = dynamic.relationshipStage && typeof dynamic.relationshipStage === 'object'
      ? dynamic.relationshipStage
      : { id: String(scene.stage || 'new'), label: scene.stage === 'initial' ? '初识' : String(scene.stage || '初识'), content: '' };
    const stageId = String(relationshipStage.id || 'new');
    const stageLabel = String(relationshipStage.label || (stageId === 'initial' || stageId === 'new' ? '初识' : stageId));
    const stageContent = String(relationshipStage.content || '').trim();
    const revealedFactIds = Array.isArray(scene.revealedFactIds) ? scene.revealedFactIds : [];
    const roleModules = [
      resolveBundleFromPreset({ preset, role: normalizedRole, annotations: [] })
    ];
    return [
      ...roleModules,
      '',
      '## 本轮运行边界',
      `当前关系阶段：${stageLabel}（${stageId === 'initial' ? 'new' : stageId}）`,
      stageContent ? `当前阶段人设补充：\n${stageContent}` : '',
      dynamic.playerName ? `玩家昵称：${dynamic.playerName}` : '',
      dynamic.characterName ? `角色昵称：${dynamic.characterName}` : '',
      dynamic.kind ? `当前场景：${dynamic.kind}` : '',
      dynamic.globalExtraPrompt ? `全局补充：\n${dynamic.globalExtraPrompt}` : '',
      dynamic.conversationExtraPrompt ? `当前会话补充：\n${dynamic.conversationExtraPrompt}` : '',
      dynamic.rolePlanCatalog ? `当前有效安排目录：\n${dynamic.rolePlanCatalog}` : '当前有效安排目录：无',
      dynamic.roleScheduleContext ? `当前生效的角色日程：\n${dynamic.roleScheduleContext}` : '当前生效的角色日程：无',
      dynamic.momentContext ? `最近朋友圈上下文：\n${dynamic.momentContext}` : '最近朋友圈上下文：无',
      `允许引用的已揭示事实 ID：${revealedFactIds.length ? revealedFactIds.join(', ') : '无'}`,
      `当前预设版本：${preset.version}`
    ].filter(Boolean).join('\n');
  }

  proposeAnnotation(annotation) {
    let normalizedTarget;
    try {
      normalizedTarget = normalizePresetRole(annotation?.targetModule);
    } catch {
      throw new Error('invalid annotation proposal');
    }
    if (!annotation?.annotationId || !annotation.turnId) {
      throw new Error('invalid annotation proposal');
    }
    const instruction = String(annotation.instruction || '').trim();
    if (!instruction) throw new Error('annotation instruction is required');
    if (HIDDEN_BIOGRAPHY.test(instruction)) {
      throw new Error('hidden biography or 未透露经历 cannot be injected as known fact (许弥 content is isolated)');
    }
    const current = this.current();
    const proposal = {
      ...annotation,
      targetModule: normalizedTarget,
      proposalId: `proposal_${annotation.annotationId}`,
      instruction,
      presetVersion: current.version,
      status: 'proposed',
      createdAt: this.clock()
    };
    this.store.putAnnotation(proposal);
    return clone(proposal);
  }

  publishVersion(proposalId) {
    const annotationId = String(proposalId || '').replace(/^proposal_/, '');
    const proposal = this.store.getAnnotation(annotationId);
    if (!proposal || proposal.status !== 'proposed') throw new Error('annotation proposal is unavailable');
    const parent = this.current();
    const modules = clone(parent.modules);
    const targetModule = proposal.targetModule === 'expression' && modules.brain
      ? 'brain'
      : proposal.targetModule === 'consolidation' && modules.memory
        ? 'memory'
        : proposal.targetModule;
    if (!modules[targetModule]) {
      throw new Error(`preset role ${proposal.targetModule} is unavailable in version ${parent.version}`);
    }
    modules[targetModule] = `${modules[targetModule]}\n\n## 已发布人工标注\n\n${proposal.instruction}`;
    const version = nextPatch(parent.version);
    const published = {
      version,
      parentVersion: parent.version,
      characterId: parent.characterId,
      modules,
      changedModules: [targetModule],
      annotationIds: [proposal.annotationId],
      rollbackOf: null,
      checksum: contentHash({ version, modules }),
      publishedAt: this.clock()
    };
    this.store.putPresetVersion(published);
    this.store.setCurrentPresetVersion(version);
    this.store.updateAnnotationStatus(annotationId, 'published');
    return clone(published);
  }

  rollback(targetVersion) {
    const target = this.store.getPresetVersion(targetVersion);
    if (!target) throw new Error('rollback target is unavailable');
    const parent = this.current();
    const version = nextPatch(parent.version);
    const rolledBack = {
      version,
      parentVersion: parent.version,
      characterId: target.characterId,
      modules: clone(target.modules),
      changedModules: Object.keys(target.modules).filter(role => target.modules[role] !== parent.modules[role]),
      annotationIds: [],
      rollbackOf: target.version,
      checksum: contentHash({ version, modules: target.modules }),
      publishedAt: this.clock()
    };
    this.store.putPresetVersion(rolledBack);
    this.store.setCurrentPresetVersion(version);
    return clone(rolledBack);
  }
}
