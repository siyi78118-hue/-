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
    return actions.map((action, index) => {
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
  }

  function trimProofs(proofs) {
    const entries = Object.entries(proofs).sort((left, right) => (
      Number(right[1]?.appliedAt || 0) - Number(left[1]?.appliedAt || 0)
      || left[0].localeCompare(right[0])
    )).slice(0, PROOF_LIMIT);
    return Object.fromEntries(entries);
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
      if (!globalProofStore?.load || !globalProofStore?.save || typeof acknowledgeUiApplied !== 'function') {
        throw new Error('canonical action application dependency conflict');
      }

      let proofs = await globalProofStore.load();
      if (!plainObject(proofs)) throw new Error('canonical action proof store conflict');
      const work = actions.map(action => {
        const family = FAMILY_BY_KIND[action.kind];
        const adapter = adapters[family];
        if (typeof adapter.preflight !== 'function'
          || typeof adapter.verifyApplied !== 'function'
          || typeof adapter.apply !== 'function') {
          throw new Error('canonical action adapter conflict');
        }
        return {
          action,
          family,
          adapter,
          expected: immutableProof(action, authoritativeTurnId),
          stored: proofs[action.actionId]
        };
      });

      for (const item of work) {
        await item.adapter.preflight({
          action: item.action,
          request: item.expected,
          result: input.result,
          localTurnId: input.localTurnId
        });
      }

      const pending = [];
      const sessionProofs = {};
      for (const item of work) {
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
          continue;
        }
        pending.push(item);
      }

      for (const item of pending) {
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
        proofs = { ...proofs, [item.action.actionId]: applied.proof };
        proofs = trimProofs(proofs);
        await globalProofStore.save(proofs);
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
      return { status: pending.length ? 'ready_for_ui_ack' : 'already_proven' };
    }

    return { applyGroup };
  }

  root.ALCanonicalActionApplication = {
    createCanonicalActionApplier,
    createPaymentActionAdapter
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
