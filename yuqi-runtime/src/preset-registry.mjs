import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { contentHash } from './protocol.mjs';

const ROLES = new Set(['brain', 'memory', 'supervisor']);
const MODULES = new Set(['foundation', ...ROLES]);
const HIDDEN_BIOGRAPHY = /许弥|焦虑依恋|用户过去|用户曾经|原生家庭|隐藏画像|未透露.{0,10}(经历|事实)/i;

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
    const manifest = JSON.parse(readFileSync(join(this.presetDir, 'manifest.json'), 'utf8'));
    const modules = {};
    for (const [role, filename] of Object.entries(manifest.modules || {})) {
      if (!MODULES.has(role)) throw new Error(`unknown preset role: ${role}`);
      modules[role] = readFileSync(join(this.presetDir, filename), 'utf8').trim();
    }
    for (const role of MODULES) {
      if (!String(modules[role] || '').trim()) throw new Error(`missing preset module: ${role}`);
    }
    const checksum = contentHash({ version: manifest.currentVersion, modules });
    const existing = this.store.getPresetVersion(manifest.currentVersion);
    if (existing) {
      const isSameSeed = existing.parentVersion === null
        && existing.characterId === manifest.characterId
        && existing.checksum === checksum
        && existing.annotationIds.length === 0
        && existing.rollbackOf === null;
      if (!isSameSeed) throw new Error('preset seed conflict');
      if (!this.store.getCurrentPresetVersion()) this.store.setCurrentPresetVersion(existing.version);
      return;
    }
    const seed = {
      version: manifest.currentVersion,
      parentVersion: null,
      characterId: manifest.characterId,
      modules,
      changedModules: Object.keys(modules),
      annotationIds: [],
      rollbackOf: null,
      checksum,
      publishedAt: this.clock()
    };
    this.store.putPresetVersion(seed);
    const currentVersion = this.store.getCurrentPresetVersion();
    const current = currentVersion ? this.store.getPresetVersion(currentVersion) : null;
    const currentIsUnannotatedSeed = current && current.parentVersion === null && current.annotationIds.length === 0;
    if (!currentVersion || (currentIsUnannotatedSeed && compareVersions(currentVersion, seed.version) < 0)) {
      this.store.setCurrentPresetVersion(seed.version);
    }
  }

  current() {
    const version = this.store.getCurrentPresetVersion();
    const preset = this.store.getPresetVersion(version);
    if (!preset) throw new Error('current preset version is unavailable');
    return clone(preset);
  }

  compileFor(role, scene = {}) {
    if (!ROLES.has(role)) throw new Error(`unknown preset role: ${role}`);
    const preset = this.current();
    const dynamic = scene.scene && typeof scene.scene === 'object' ? scene.scene : scene;
    const relationshipStage = dynamic.relationshipStage && typeof dynamic.relationshipStage === 'object'
      ? dynamic.relationshipStage
      : { id: String(scene.stage || 'new'), label: scene.stage === 'initial' ? '初识' : String(scene.stage || '初识'), content: '' };
    const stageId = String(relationshipStage.id || 'new');
    const stageLabel = String(relationshipStage.label || (stageId === 'initial' || stageId === 'new' ? '初识' : stageId));
    const stageContent = String(relationshipStage.content || '').trim();
    const revealedFactIds = Array.isArray(scene.revealedFactIds) ? scene.revealedFactIds : [];
    const roleModules = role === 'memory'
      ? [preset.modules.memory]
      : role === 'brain'
        ? [preset.modules.foundation, preset.modules.brain]
        : [
            preset.modules.supervisor,
            '## 本轮权威生成预设\n以下内容是被监督回复实际使用的完整生成预设，必须据此复核人物一致性。',
            preset.modules.foundation,
            preset.modules.brain,
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
    if (!annotation?.annotationId || !annotation.turnId || !ROLES.has(annotation.targetModule)) {
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
    modules[proposal.targetModule] = `${modules[proposal.targetModule]}\n\n## 已发布人工标注\n\n${proposal.instruction}`;
    const version = nextPatch(parent.version);
    const published = {
      version,
      parentVersion: parent.version,
      characterId: parent.characterId,
      modules,
      changedModules: [proposal.targetModule],
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
