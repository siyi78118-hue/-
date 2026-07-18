import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { contentHash } from './protocol.mjs';

const ROLES = new Set(['brain', 'memory', 'supervisor']);
const HIDDEN_BIOGRAPHY = /许弥|焦虑依恋|用户过去|用户曾经|原生家庭|隐藏画像|未透露.{0,10}(经历|事实)/i;

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`invalid semantic version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
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
      if (!ROLES.has(role)) throw new Error(`unknown preset role: ${role}`);
      modules[role] = readFileSync(join(this.presetDir, filename), 'utf8').trim();
    }
    const checksum = contentHash({ version: manifest.currentVersion, modules });
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
    if (!this.store.getCurrentPresetVersion()) this.store.setCurrentPresetVersion(seed.version);
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
    const stage = String(scene.stage || 'initial');
    const revealedFactIds = Array.isArray(scene.revealedFactIds) ? scene.revealedFactIds : [];
    return [
      preset.modules[role],
      '',
      '## 本轮运行边界',
      `当前关系阶段：${stage === 'initial' ? '初次认识' : stage}`,
      `允许引用的已揭示事实 ID：${revealedFactIds.length ? revealedFactIds.join(', ') : '无'}`,
      `当前预设版本：${preset.version}`
    ].join('\n');
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
