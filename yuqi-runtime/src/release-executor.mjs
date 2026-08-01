const RELEASE_ADAPTERS = new Map([
  ['stable-visible-baseline-2026-07-30', 'legacy-v1'],
  ['cognition-v2-candidate-2026-07-30', 'cognition-v2'],
  ['yuqi-lived-agency-v3', 'cognition-v3']
]);

const VISIBLE_CAPABILITIES = Object.freeze({
  visibleCommit: true,
  action: true,
  state: true,
  fact: true,
  memory: true,
  outbox: true,
  notification: true
});

const DRY_RUN_CAPABILITIES = Object.freeze({
  visibleCommit: false,
  action: false,
  state: false,
  fact: false,
  memory: false,
  outbox: false,
  notification: false
});
const REQUIRED_ADAPTER_IDS = Object.freeze(['legacy-v1', 'cognition-v2', 'cognition-v3']);

export function supportsPipelineVersion(pipelineVersion) {
  return RELEASE_ADAPTERS.has(String(pipelineVersion || ''));
}

function assertCompleteAdapterMap(collection, method) {
  if (!(collection instanceof Map)
    || collection.size !== REQUIRED_ADAPTER_IDS.length
    || REQUIRED_ADAPTER_IDS.some(id => typeof collection.get(id)?.[method] !== 'function')
    || [...collection.keys()].some(id => !REQUIRED_ADAPTER_IDS.includes(id))) {
    throw new Error('complete production release adapter set is required');
  }
}

export class ReleaseExecutor {
  constructor({
    store = null,
    getRelease = null,
    turnAdapters = new Map(),
    lifeAdapters = new Map()
  } = {}) {
    this.getRelease = getRelease || (releaseId => store?.getPipelineRelease(releaseId));
    if (typeof this.getRelease !== 'function') {
      throw new Error('release executor requires immutable release lookup');
    }
    assertCompleteAdapterMap(turnAdapters, 'executeTurn');
    assertCompleteAdapterMap(lifeAdapters, 'executeLife');
    this.turnAdapters = new Map(turnAdapters);
    this.lifeAdapters = new Map(lifeAdapters);
  }

  adapterIds() {
    return {
      turn: REQUIRED_ADAPTER_IDS.filter(id => this.turnAdapters.has(id)),
      life: REQUIRED_ADAPTER_IDS.filter(id => this.lifeAdapters.has(id))
    };
  }

  resolveAuthority(releaseId, releaseChecksum, adapters) {
    const release = this.getRelease(String(releaseId || ''));
    if (!release) throw new Error('release executor unavailable');
    if (String(release.releaseChecksum || '') !== String(releaseChecksum || '')) {
      throw new Error('release checksum authority conflict');
    }
    const adapterId = RELEASE_ADAPTERS.get(String(release.pipelineVersion || ''));
    const adapter = adapterId ? adapters.get(adapterId) : null;
    if (!adapter) throw new Error('release executor unavailable');
    return { release, adapterId, adapter };
  }

  async executeTurn({ releaseId, releaseChecksum, execution, dryRun = false }) {
    const authority = this.resolveAuthority(releaseId, releaseChecksum, this.turnAdapters);
    if (typeof authority.adapter.executeTurn !== 'function') {
      throw new Error('release turn executor unavailable');
    }
    const capabilities = dryRun ? DRY_RUN_CAPABILITIES : VISIBLE_CAPABILITIES;
    const draft = await authority.adapter.executeTurn({
      release: authority.release,
      execution,
      dryRun: Boolean(dryRun),
      capabilities
    });
    return {
      adapterId: authority.adapterId,
      releaseId: authority.release.releaseId,
      releaseChecksum: authority.release.releaseChecksum,
      draft,
      dryRun: Boolean(dryRun),
      capabilities
    };
  }

  async executeLife({ releaseId, releaseChecksum, execution, dryRun = false }) {
    const authority = this.resolveAuthority(releaseId, releaseChecksum, this.lifeAdapters);
    if (typeof authority.adapter.executeLife !== 'function') {
      throw new Error('release life executor unavailable');
    }
    const capabilities = dryRun ? DRY_RUN_CAPABILITIES : VISIBLE_CAPABILITIES;
    const draft = await authority.adapter.executeLife({
      release: authority.release,
      execution,
      dryRun: Boolean(dryRun),
      capabilities
    });
    return {
      adapterId: authority.adapterId,
      releaseId: authority.release.releaseId,
      releaseChecksum: authority.release.releaseChecksum,
      draft,
      dryRun: Boolean(dryRun),
      capabilities
    };
  }
}
