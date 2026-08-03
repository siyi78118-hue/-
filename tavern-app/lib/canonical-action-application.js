(function initCanonicalActionApplication(root) {
  'use strict';

  const FAMILY_BY_KIND = Object.freeze({
    payment_accept: 'payment',
    payment_decline: 'payment',
    moment_like: 'moment',
    moment_comment: 'moment',
    moment_reply: 'moment',
    relationship_transition: 'relationship',
    role_plan_create: 'role_plan',
    role_plan_update: 'role_plan',
    role_plan_cancel: 'role_plan',
    role_plan_pause: 'role_plan',
    role_plan_resume: 'role_plan',
    role_plan_complete: 'role_plan'
  });
  const RESERVED_KINDS = new Set([
    'moment_create',
    'life_episode_create',
    'life_episode_update',
    'life_episode_cancel'
  ]);
  const ACTION_KEYS = Object.freeze([
    'actionChecksum', 'actionId', 'kind', 'ordinal', 'payload', 'targetKey', 'targetRevision'
  ]);
  const SINGLE_FAMILIES = new Set(['payment', 'moment', 'relationship']);
  const PROOF_LIMIT = 1000;

  function plainObject(value) {
    return !!value && !Array.isArray(value) && Object.prototype.toString.call(value) === '[object Object]';
  }

  function exactKeys(value, keys) {
    return plainObject(value)
      && Object.keys(value).sort().join('\u0000') === [...keys].sort().join('\u0000');
  }

  function validId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value);
  }

  function validChecksum(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }

  function immutableProof(action, authoritativeTurnId) {
    return {
      turnId: authoritativeTurnId,
      actionId: action.actionId,
      actionChecksum: action.actionChecksum,
      type: action.kind
    };
  }

  function proofMatches(stored, expected) {
    return exactKeys(stored, ['turnId', 'actionId', 'actionChecksum', 'type', 'appliedAt'])
      && stored.turnId === expected.turnId
      && stored.actionId === expected.actionId
      && stored.actionChecksum === expected.actionChecksum
      && stored.type === expected.type
      && Number.isSafeInteger(stored.appliedAt)
      && stored.appliedAt > 0;
  }

  function normalizeActionSet(actions) {
    if (!Array.isArray(actions)) throw new Error('canonical action set conflict');
    const ids = new Set();
    const singleCounts = new Map();
    const normalized = actions.map((action, index) => {
      if (!exactKeys(action, ACTION_KEYS)
        || !validId(action.actionId)
        || !Number.isSafeInteger(action.ordinal)
        || action.ordinal !== index
        || typeof action.kind !== 'string'
        || !plainObject(action.payload)
        || typeof action.targetKey !== 'string'
        || !action.targetKey
        || typeof action.targetRevision !== 'string'
        || !action.targetRevision
        || !validChecksum(action.actionChecksum)
        || ids.has(action.actionId)) {
        throw new Error('canonical action set conflict');
      }
      ids.add(action.actionId);
      const family = FAMILY_BY_KIND[action.kind] || '';
      if (SINGLE_FAMILIES.has(family)) {
        const count = Number(singleCounts.get(family) || 0) + 1;
        singleCounts.set(family, count);
        if (count > 1) throw new Error('canonical action set conflict');
      }
      return action;
    });
    const roleOrdinals = normalized
      .map((action, index) => FAMILY_BY_KIND[action.kind] === 'role_plan' ? index : -1)
      .filter(index => index >= 0);
    if (roleOrdinals.length
      && roleOrdinals.at(-1) - roleOrdinals[0] + 1 !== roleOrdinals.length) {
      throw new Error('canonical action set conflict');
    }
    return normalized;
  }

  function trimProofs(proofs) {
    const retained = new Set(Object.entries(proofs).sort((left, right) => (
      Number(right[1]?.appliedAt || 0) - Number(left[1]?.appliedAt || 0)
      || left[0].localeCompare(right[0])
    )).slice(0, PROOF_LIMIT).map(([actionId]) => actionId));
    return Object.fromEntries(Object.entries(proofs).filter(([actionId]) => retained.has(actionId)));
  }

  const PAYMENT_PAYLOAD_KEYS = Object.freeze(['messageId']);
  const PAYMENT_REQUEST_KEYS = Object.freeze([
    'version', 'authoritativeTurnId', 'actionId', 'actionChecksum', 'kind',
    'targetKey', 'targetRevision', 'characterId', 'targetMessageId', 'payType',
    'amountCents', 'decision', 'balanceDeltaCents'
  ]);
  const PAYMENT_JOURNAL_KEYS = Object.freeze([
    ...PAYMENT_REQUEST_KEYS, 'balanceAfterCents', 'appliedAt'
  ]);

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function safePositiveTime(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(label);
    return value;
  }

  function paymentRequest(action, result, target) {
    if (!exactKeys(action.payload, PAYMENT_PAYLOAD_KEYS)) {
      throw new Error('payment action authority conflict');
    }
    const messageId = action.payload.messageId;
    const decision = action.kind === 'payment_accept' ? 'accept'
      : action.kind === 'payment_decline' ? 'decline' : '';
    if (!validId(messageId)
      || action.targetKey !== `payment:${messageId}`) {
      throw new Error('payment action authority conflict');
    }
    const payType = String(target?.payType || target?.type || '').toLowerCase();
    if (!['transfer', 'redpacket'].includes(payType)) {
      throw new Error('payment action authority conflict');
    }
    const amountCents = Math.round(Number(target.amount) * 100);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error('payment action authority conflict');
    }
    return {
      version: 1,
      authoritativeTurnId: String(result.authoritativeTurnId || ''),
      actionId: action.actionId,
      actionChecksum: action.actionChecksum,
      kind: action.kind,
      targetKey: action.targetKey,
      targetRevision: action.targetRevision,
      characterId: String(result.roleId || ''),
      targetMessageId: messageId,
      payType,
      amountCents,
      decision,
      balanceDeltaCents: decision === 'decline' && payType === 'transfer' ? amountCents : 0
    };
  }

  function sameFields(left, right, keys) {
    return keys.every(key => left?.[key] === right?.[key]);
  }

  function validPaymentJournal(value, request) {
    return exactKeys(value, PAYMENT_JOURNAL_KEYS)
      && sameFields(value, request, PAYMENT_REQUEST_KEYS)
      && Number.isSafeInteger(value.balanceAfterCents)
      && value.balanceAfterCents >= 0
      && Number.isSafeInteger(value.appliedAt)
      && value.appliedAt > 0;
  }

  function validPaymentMarker(value, action) {
    return exactKeys(value, ['actionId', 'actionChecksum', 'appliedAt'])
      && value.actionId === action.actionId
      && value.actionChecksum === action.actionChecksum
      && Number.isSafeInteger(value.appliedAt)
      && value.appliedAt > 0;
  }

  function validPaymentLanding(target, request, appliedAt) {
    if (request.decision === 'accept') {
      return target.payStatus === 'received'
        && target.payStatusTime === appliedAt
        && target.payMemoryRecordedStatus === 'received';
    }
    if (request.payType === 'transfer') {
      return target.payStatus === 'refused'
        && target.payStatusTime === appliedAt
        && target.refunded === true
        && target.payMemoryRecordedStatus === 'refused';
    }
    return target.payStatus === 'pending'
      && target.payDeclinedAt === appliedAt
      && target.payMemoryRecordedStatus === 'refused';
  }

  function trimJournals(journals) {
    return Object.fromEntries(Object.entries(journals).sort((left, right) => (
      Number(right[1]?.appliedAt || 0) - Number(left[1]?.appliedAt || 0)
      || left[0].localeCompare(right[0])
    )).slice(0, PROOF_LIMIT));
  }

  function createPaymentActionAdapter(options = {}) {
    const store = options.store;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const fault = typeof options.fault === 'function' ? options.fault : async () => {};
    if (!store?.readSettings || !store?.writeSettings || !store?.readChat || !store?.writeChat) {
      throw new Error('payment action store conflict');
    }

    async function inspect({ action, result }) {
      if (!exactKeys(action?.payload, PAYMENT_PAYLOAD_KEYS)
        || !validId(action.payload.messageId)
        || action.targetKey !== `payment:${action.payload.messageId}`) {
        throw new Error('payment action authority conflict');
      }
      const characterId = String(result?.roleId || '');
      const [settingsValue, chatValue] = await Promise.all([
        store.readSettings(),
        store.readChat(characterId)
      ]);
      const settings = clone(settingsValue || {});
      const chat = clone(chatValue || {});
      if (!Array.isArray(chat.messages)) throw new Error('payment action target conflict');
      const matches = chat.messages
        .map((message, index) => ({ message, index }))
        .filter(row => row.message?.id === action.payload?.messageId);
      if (matches.length !== 1) throw new Error('payment action target conflict');
      const target = matches[0].message;
      const request = paymentRequest(action, result, target);
      const journals = plainObject(settings.nativePaymentActionApplications)
        ? settings.nativePaymentActionApplications : {};
      const journal = journals[action.actionId];
      if (journal != null && !validPaymentJournal(journal, request)) {
        throw new Error('payment action authority conflict');
      }
      const marker = target.nativePaymentActionApplication;
      if (marker != null && !validPaymentMarker(marker, action)) {
        throw new Error('payment action authority conflict');
      }
      if (journal && marker && journal.appliedAt !== marker.appliedAt) {
        throw new Error('payment action authority conflict');
      }
      if (!journal && !marker && String(target.payStatus || 'pending') !== 'pending') {
        throw new Error('payment action target conflict');
      }
      if (marker && !validPaymentLanding(target, request, marker.appliedAt)) {
        throw new Error('payment action target conflict');
      }
      return { settings, chat, targetIndex: matches[0].index, request, journal, marker };
    }

    async function preflight(context) {
      await inspect(context);
    }

    async function verifyApplied(context) {
      const snapshot = await inspect(context);
      if (!snapshot.marker) throw new Error('payment action application proof conflict');
      return {
        outcome: 'already_applied',
        proof: {
          ...immutableProof(context.action, snapshot.request.authoritativeTurnId),
          appliedAt: snapshot.marker.appliedAt
        }
      };
    }

    async function apply(context) {
      let snapshot = await inspect(context);
      const { action } = context;
      let appliedAt = snapshot.journal?.appliedAt || snapshot.marker?.appliedAt || null;
      let newlyApplied = false;
      if (!snapshot.journal && !snapshot.marker) {
        appliedAt = safePositiveTime(Number(now()), 'payment action time conflict');
        const balanceCents = Math.round(Number(snapshot.settings.walletBalance || 0) * 100);
        const balanceAfterCents = balanceCents + snapshot.request.balanceDeltaCents;
        if (!Number.isSafeInteger(balanceCents)
          || balanceCents < 0
          || !Number.isSafeInteger(balanceAfterCents)
          || balanceAfterCents < 0) {
          throw new Error('payment action balance conflict');
        }
        const entry = {
          ...snapshot.request,
          balanceAfterCents,
          appliedAt
        };
        const journals = plainObject(snapshot.settings.nativePaymentActionApplications)
          ? snapshot.settings.nativePaymentActionApplications : {};
        snapshot.settings.walletBalance = balanceAfterCents / 100;
        snapshot.settings.nativePaymentActionApplications = trimJournals({
          ...journals,
          [action.actionId]: entry
        });
        if (!snapshot.settings.nativePaymentActionApplications[action.actionId]) {
          throw new Error('payment action journal retention conflict');
        }
        await store.writeSettings(snapshot.settings);
        await fault('payment_after_settings');
        snapshot = await inspect(context);
        appliedAt = snapshot.journal?.appliedAt || appliedAt;
        newlyApplied = true;
      }

      if (!snapshot.marker) {
        const chat = clone(snapshot.chat);
        const target = chat.messages[snapshot.targetIndex];
        if (snapshot.request.decision === 'accept') {
          target.payStatus = 'received';
          target.payStatusTime = appliedAt;
        } else if (snapshot.request.payType === 'transfer') {
          target.payStatus = 'refused';
          target.payStatusTime = appliedAt;
          target.refunded = true;
        } else {
          target.payStatus = 'pending';
          target.payDeclinedAt = appliedAt;
        }
        target.payMemoryRecordedStatus = snapshot.request.decision === 'accept' ? 'received' : 'refused';
        target.nativePaymentActionApplication = {
          actionId: action.actionId,
          actionChecksum: action.actionChecksum,
          appliedAt
        };
        if (!chat.messages.some(message => message?.sourceActionId === action.actionId)
          && typeof store.createMemoryEvent === 'function') {
          const event = store.createMemoryEvent({
            request: snapshot.request,
            target: clone(target),
            appliedAt
          });
          if (event) chat.messages.push(clone(event));
        }
        await store.writeChat(snapshot.request.characterId, chat);
        await fault('payment_after_chat');
        newlyApplied = true;
      }

      const verified = await verifyApplied(context);
      return {
        outcome: newlyApplied ? 'applied' : 'already_applied',
        proof: verified.proof
      };
    }

    return { preflight, verifyApplied, apply };
  }

  function createRolePlanActionAdapter(options = {}) {
    const repository = options.repository;
    if (!repository?.prepareCanonicalBatch
      || !repository?.inspectPreparedCanonicalBatch
      || !repository?.applyPreparedCanonicalBatch) {
      throw new Error('role plan action repository conflict');
    }

    function descriptors(items, result) {
      return items.map(item => ({
        authoritativeTurnId: result.authoritativeTurnId,
        actionId: item.action.actionId,
        actionChecksum: item.action.actionChecksum,
        kind: item.action.kind,
        targetKey: item.action.targetKey,
        targetRevision: item.action.targetRevision,
        operation: clone(item.action.payload)
      }));
    }

    async function preflightBatch({ items, result }) {
      return repository.prepareCanonicalBatch(result.roleId, descriptors(items, result));
    }

    function projectedResults(items, proofs, outcomes) {
      return items.map(item => {
        const proof = proofs?.[item.action.actionId];
        if (!proof) throw new Error('canonical action application proof conflict');
        return {
          outcome: outcomes?.[item.action.actionId] || 'already_applied',
          proof: clone(proof)
        };
      });
    }

    async function verifyAppliedBatch({ prepared, items }) {
      const inspected = await repository.inspectPreparedCanonicalBatch(prepared);
      return projectedResults(items, inspected.proofs, null);
    }

    async function applyBatch({ prepared, items }) {
      const applied = await repository.applyPreparedCanonicalBatch(prepared);
      const outcomes = Object.fromEntries(items.map(item => [
        item.action.actionId,
        applied.plansChanged || applied.historyChanged ? 'applied' : 'already_applied'
      ]));
      return projectedResults(items, applied.proofs, outcomes);
    }

    return { preflightBatch, verifyAppliedBatch, applyBatch };
  }

  function createCanonicalActionApplier(options = {}) {
    const adapters = options.adapters || {};
    const globalProofStore = options.globalProofStore;
    const acknowledgeUiApplied = options.acknowledgeUiApplied;
    const fault = typeof options.fault === 'function' ? options.fault : async () => {};

    async function applyGroup(input = {}) {
      const actions = normalizeActionSet(input.actions || []);
      if (actions.length === 0) throw new Error('canonical action set conflict');
      const authoritativeTurnId = input.result?.authoritativeTurnId;
      const visibleGroupId = input.result?.visibleGroupId;
      const roleId = input.result?.roleId;
      const terminalDisposition = input.result?.terminalDisposition;
      if (!validId(authoritativeTurnId)
        || !validId(visibleGroupId)
        || !validId(roleId)
        || !validId(input.localTurnId)
        || !['visible', 'action_only'].includes(terminalDisposition)) {
        throw new Error('canonical action group identity conflict');
      }
      for (const action of actions) {
        const kind = action.kind;
        if (RESERVED_KINDS.has(kind)) {
          return { status: 'unsupported', actionId: action.actionId, kind };
        }
        if (!FAMILY_BY_KIND[kind] || !adapters[FAMILY_BY_KIND[kind]]) {
          return { status: 'unsupported', actionId: action.actionId, kind };
        }
      }
      if (!globalProofStore?.load || !globalProofStore?.mergeCanonicalProofs || typeof acknowledgeUiApplied !== 'function') {
        throw new Error('canonical action application dependency conflict');
      }

      let proofs = await globalProofStore.load();
      if (!plainObject(proofs)) throw new Error('canonical action proof store conflict');
      const work = actions.map(action => {
        const family = FAMILY_BY_KIND[action.kind];
        const adapter = adapters[family];
        return {
          action,
          family,
          adapter,
          expected: immutableProof(action, authoritativeTurnId),
          stored: proofs[action.actionId]
        };
      });
      const blocks = [];
      for (const item of work) {
        if (item.family === 'role_plan') {
          const last = blocks.at(-1);
          if (last?.family === 'role_plan') last.items.push(item);
          else blocks.push({ family: item.family, adapter: item.adapter, items: [item], batch: true });
        } else {
          blocks.push({ family: item.family, adapter: item.adapter, items: [item], batch: false });
        }
      }
      for (const block of blocks) {
        if (block.batch) {
          if (typeof block.adapter.preflightBatch !== 'function'
            || typeof block.adapter.verifyAppliedBatch !== 'function'
            || typeof block.adapter.applyBatch !== 'function') {
            throw new Error('canonical action adapter conflict');
          }
          block.prepared = await block.adapter.preflightBatch({
            items: block.items,
            result: input.result,
            localTurnId: input.localTurnId
          });
        } else {
          const item = block.items[0];
          if (typeof item.adapter.preflight !== 'function'
            || typeof item.adapter.verifyApplied !== 'function'
            || typeof item.adapter.apply !== 'function') {
            throw new Error('canonical action adapter conflict');
          }
          await item.adapter.preflight({
            action: item.action,
            request: item.expected,
            result: input.result,
            localTurnId: input.localTurnId
          });
        }
      }

      function orderedBatchResults(items, outcomes) {
        if (Array.isArray(outcomes)) {
          if (outcomes.length !== items.length) throw new Error('canonical action application proof conflict');
          return outcomes;
        }
        const expectedIds = items.map(item => item.action.actionId);
        if (!plainObject(outcomes)
          || Object.keys(outcomes).join('\u0000') !== expectedIds.join('\u0000')) {
          throw new Error('canonical action application proof conflict');
        }
        return items.map(item => outcomes[item.action.actionId]);
      }

      async function mergeGlobalProof(actionId, proof) {
        const merged = await globalProofStore.mergeCanonicalProofs({ [actionId]: proof });
        if (!plainObject(merged)) throw new Error('canonical action proof store conflict');
        proofs = merged;
      }

      const pendingIds = new Set();
      const sessionProofs = {};
      for (const block of blocks) {
        if (block.batch) {
          const existing = [];
          for (const item of block.items) {
            if (item.stored == null) {
              pendingIds.add(item.action.actionId);
              continue;
            }
            if (!proofMatches(item.stored, item.expected)) {
              return { status: 'conflict', actionId: item.action.actionId, kind: item.action.kind };
            }
            existing.push(item);
          }
          if (existing.length) {
            const verified = await block.adapter.verifyAppliedBatch({
              prepared: block.prepared,
              items: existing,
              result: input.result,
              localTurnId: input.localTurnId
            });
            const outcomes = orderedBatchResults(existing, verified);
            for (let index = 0; index < existing.length; index += 1) {
              const item = existing[index];
              const outcome = outcomes[index];
              if (outcome?.outcome !== 'already_applied'
                || !proofMatches(outcome?.proof, item.expected)
                || !sameFields(outcome.proof, item.stored,
                  ['turnId', 'actionId', 'actionChecksum', 'type', 'appliedAt'])) {
                throw new Error('canonical action application proof conflict');
              }
              sessionProofs[item.action.actionId] = outcome.proof;
            }
          }
          continue;
        }
        const item = block.items[0];
        if (item.stored != null) {
          if (!proofMatches(item.stored, item.expected)) {
            return { status: 'conflict', actionId: item.action.actionId, kind: item.action.kind };
          }
          const verified = await item.adapter.verifyApplied({
            action: item.action,
            request: item.expected,
            result: input.result,
            localTurnId: input.localTurnId
          });
          if (verified?.outcome !== 'already_applied'
            || !proofMatches(verified?.proof, item.expected)
            || !sameFields(verified.proof, item.stored,
              ['turnId', 'actionId', 'actionChecksum', 'type', 'appliedAt'])) {
            throw new Error('canonical action application proof conflict');
          }
          sessionProofs[item.action.actionId] = verified.proof;
        } else {
          pendingIds.add(item.action.actionId);
        }
      }

      for (const block of blocks) {
        const pendingItems = block.items.filter(item => pendingIds.has(item.action.actionId));
        if (!pendingItems.length) continue;
        if (block.batch) {
          const applied = await block.adapter.applyBatch({
            prepared: block.prepared,
            items: block.items,
            pendingActionIds: pendingItems.map(item => item.action.actionId),
            result: input.result,
            localTurnId: input.localTurnId
          });
          const outcomes = orderedBatchResults(block.items, applied);
          for (let index = 0; index < block.items.length; index += 1) {
            const item = block.items[index];
            const outcome = outcomes[index];
            if (!['applied', 'already_applied'].includes(outcome?.outcome)
              || !proofMatches(outcome?.proof, item.expected)
              || (item.stored != null && !sameFields(outcome.proof, item.stored,
                ['turnId', 'actionId', 'actionChecksum', 'type', 'appliedAt']))) {
              throw new Error('canonical action application proof conflict');
            }
            sessionProofs[item.action.actionId] = outcome.proof;
          }
          await fault(`after_domain_batch:${block.family}:${block.items[0].action.ordinal}:${block.items.at(-1).action.ordinal}`);
          for (const item of pendingItems) {
            const proof = outcomes[block.items.indexOf(item)].proof;
            await mergeGlobalProof(item.action.actionId, proof);
            await fault(`after_global_proof:${item.action.actionId}`);
          }
          continue;
        }
        const item = pendingItems[0];
        const applied = await item.adapter.apply({
          action: item.action,
          request: item.expected,
          result: input.result,
          localTurnId: input.localTurnId
        });
        if (!['applied', 'already_applied'].includes(applied?.outcome)
          || !proofMatches(applied?.proof, item.expected)) {
          throw new Error('canonical action application proof conflict');
        }
        sessionProofs[item.action.actionId] = applied.proof;
        await fault(`after_domain:${item.action.actionId}`);
        await mergeGlobalProof(item.action.actionId, applied.proof);
        await fault(`after_global_proof:${item.action.actionId}`);
      }

      const finalProofs = await globalProofStore.load();
      for (const action of actions) {
        const expected = immutableProof(action, authoritativeTurnId);
        const sessionProof = sessionProofs[action.actionId];
        const persistedProof = finalProofs?.[action.actionId];
        if (!proofMatches(sessionProof, expected)
          || (persistedProof != null
            && (!proofMatches(persistedProof, expected)
              || !sameFields(persistedProof, sessionProof,
                ['turnId', 'actionId', 'actionChecksum', 'type', 'appliedAt'])))) {
          throw new Error('canonical action application proof conflict');
        }
      }
      await acknowledgeUiApplied({
        localTurnId: input.localTurnId,
        authoritativeTurnId,
        visibleGroupId
      });
      await fault('after_ui_ack');
      return { status: pendingIds.size ? 'ready_for_ui_ack' : 'already_proven' };
    }

    return { applyGroup };
  }

  root.ALCanonicalActionApplication = {
    createCanonicalActionApplier,
    createPaymentActionAdapter,
    createRolePlanActionAdapter
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
