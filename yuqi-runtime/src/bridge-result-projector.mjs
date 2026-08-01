export function projectBridgeResultForWire(canonicalResult, wireVersion) {
  if (!canonicalResult || typeof canonicalResult !== 'object' || Array.isArray(canonicalResult)) {
    throw new Error('canonical bridge result is required');
  }
  if (Number(wireVersion) !== 3) {
    throw new Error('unsupported bridge result wire version');
  }
  if (canonicalResult.status !== 'redacted'
    && Number(canonicalResult.protocolVersion) !== 3) {
    throw new Error('invalid canonical bridge result version');
  }
  return structuredClone(canonicalResult);
}
