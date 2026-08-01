import { createHash } from 'node:crypto';

function authorityLengthPrefix(value) {
  const text = String(value ?? '');
  return `${Buffer.byteLength(text, 'utf8')}:${text}`;
}

function authorityHash(namespace, values) {
  const hash = createHash('sha256');
  hash.update(`${namespace}\0`, 'utf8');
  for (const value of values) hash.update(authorityLengthPrefix(value), 'utf8');
  return hash.digest('hex');
}

export function deriveAuthorityLineageKey({ roleId, laneKey, rootSourceId }) {
  return `lin_${authorityHash('al-turn-lineage-v1', [roleId, laneKey, rootSourceId])}`;
}

export function deriveVisibleGroupId(lineageKey) {
  return `grp_${authorityHash('al-visible-group-v1', [lineageKey])}`;
}

export function deriveVisibleMessageId(groupId, ordinal) {
  return `msg_${authorityHash('al-visible-message-v1', [groupId, String(ordinal)])}`;
}

export function deriveVisibleActionId(groupId, ordinal) {
  return `act_${authorityHash('al-visible-action-v1', [groupId, String(ordinal)])}`;
}
