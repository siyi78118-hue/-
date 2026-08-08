package com.siyi.al.execution;

import java.util.Objects;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.Collections;
import com.siyi.al.execution.bridge.BridgeClient;
import com.siyi.al.execution.bridge.BridgeDeadlineException;
import com.siyi.al.execution.bridge.BridgePendingException;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Pure identity and lease-boundary helpers for the conversation-control outbox.
 *
 * <p>This class deliberately has no Room, transport, or service dependency.  The
 * store owns state transitions; a sender may use these helpers to derive the
 * stable external identities and to validate an applied proof before asking the
 * store to perform its exact CAS.</p>
 */
public final class LifecycleControlSender {
    public static final long MAX_SAFE_INTEGER = 9007199254740991L;
    public static final long LEASE_MILLIS = 60_000L;
    public static final long REFRESH_WINDOW_MILLIS = 24L * 60L * 60L * 1000L;
    public static final long MAX_RELAY_LIFETIME_MILLIS = 7L * 24L * 60L * 60L * 1000L;
    /** Inner applied body field name; relay identity stays outside this body. */
    public static final String APPLIED_CHECKSUM_FIELD = "controlChecksum";
    private static final Set<String> APPLIED_ACK_KEYS = new HashSet<>(Arrays.asList(
        "protocolVersion", "type", "controlId", "controlChecksum", "roleId", "peerId",
        "clearEpoch", "clearedThroughSequence", "appliedAt", "checksum"
    ));
    private static final Set<String> APPLIED_ACK_CONFLICT_MESSAGES = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList(
            "lifecycle applied ACK kind conflict",
            "lifecycle applied ACK keys conflict",
            "invalid lifecycle ACK header",
            "invalid lifecycle ACK protocolVersion",
            "invalid lifecycle ACK type",
            "invalid lifecycle ACK controlId",
            "invalid lifecycle ACK roleId",
            "invalid lifecycle ACK peerId",
            "invalid lifecycle ACK clearEpoch",
            "invalid lifecycle ACK clearedThroughSequence",
            "invalid lifecycle ACK controlChecksum",
            "invalid lifecycle ACK appliedAt",
            "invalid lifecycle ACK checksum",
            "lifecycle applied ACK authority conflict",
            "lifecycle applied ACK shape conflict",
            "lifecycle unknown ACK authority conflict",
            "lifecycle unknown ACK relay expiry conflict",
            "lifecycle unknown ACK peer is not store-owned"
        )));

    private LifecycleControlSender() { }

    public interface ControlRoute {
        ControlDelivery send(
            LifecycleControl control,
            String relayMessageId,
            String idempotencyKey,
            long expiresAt
        ) throws Exception;
    }

    public static final class ControlDelivery {
        public final boolean applied;
        public final String relayMessageId;
        public final long relayExpiresAt;
        public final long appliedAt;

        public ControlDelivery(boolean applied, String relayMessageId, long relayExpiresAt) {
            this(applied, relayMessageId, relayExpiresAt, 0L);
        }

        public ControlDelivery(boolean applied, String relayMessageId, long relayExpiresAt, long appliedAt) {
            this.applied = applied;
            this.relayMessageId = relayMessageId;
            this.relayExpiresAt = relayExpiresAt;
            this.appliedAt = appliedAt;
        }
    }

    /** Drain one store-owned clear control through a caller-selected route. */
    public static boolean drainOne(
        ExecutionStore store, ControlRoute route, boolean cloud, long now
    ) throws Exception {
        if (store == null || route == null) return false;
        LifecycleControl control = store.claimLifecycleControl(now);
        if (control == null) return false;
        if (!LifecycleControl.CLEAR_KIND.equals(control.controlKind)) {
            return false; // role_delete remains durable waiting until 20E.
        }
        return deliverClaimed(store, route, cloud, control, now);
    }

    /**
     * AUTO delivery claims once, then tries LAN and cloud with the same lease.
     * A route failure leaves the pending row untouched for the lease timeout.
     */
    public static boolean drainOneAuto(
        ExecutionStore store, ControlRoute lan, ControlRoute cloud, long now
    ) throws Exception {
        if (store == null || (lan == null && cloud == null)) return false;
        LifecycleControl control = store.claimLifecycleControl(now);
        if (control == null || !LifecycleControl.CLEAR_KIND.equals(control.controlKind)) return false;
        Exception lanFailure = null;
        if (lan != null) {
            try {
                return deliverClaimed(store, lan, false, control, now);
            } catch (Exception error) {
                if (!isLanTransportFailure(error)) throw error;
                lanFailure = error;
            }
        }
        if (cloud != null) {
            try {
                return deliverClaimed(store, cloud, true, control, now);
            } catch (Exception cloudFailure) {
                if (lanFailure != null) cloudFailure.addSuppressed(lanFailure);
                throw cloudFailure;
            }
        }
        if (lanFailure != null) throw lanFailure;
        return false;
    }

    /** Only transport-level LAN failures may switch the same lease to cloud. */
    static boolean isLanTransportFailure(Throwable error) {
        return error instanceof BridgePendingException
            || error instanceof BridgeDeadlineException
            || error instanceof java.io.IOException
            || error instanceof java.net.SocketTimeoutException
            || error instanceof java.net.UnknownHostException
            || error instanceof java.net.SocketException;
    }

    private static boolean deliverClaimed(
        ExecutionStore store, ControlRoute route, boolean cloud,
        LifecycleControl control, long now
    ) throws Exception {
        String stableRelayId = relayMessageId(control);
        String stableIdempotency = idempotencyKey(control);
        long expiresAt = nextRelayExpiry(control, now);
        ControlDelivery delivery = route.send(
            control, stableRelayId, stableIdempotency, expiresAt);
        if (delivery == null) throw new IllegalStateException("lifecycle route returned no result");
        if (cloud) {
            if (delivery.applied || !stableRelayId.equals(delivery.relayMessageId)
                || !validRelayExpiry(now, delivery.relayExpiresAt)) {
                throw new IllegalStateException("lifecycle cloud acceptance conflict");
            }
            return store.acceptLifecycleRelay(
                control.controlId, control.semanticChecksum, control.leaseId,
                control.leaseAttempt, control.leasedAt == null ? 0L : control.leasedAt,
                delivery.relayMessageId, delivery.relayExpiresAt, now);
        }
        if (!delivery.applied || delivery.relayMessageId != null || delivery.relayExpiresAt != 0L) {
            throw new IllegalStateException("lifecycle LAN applied proof conflict");
        }
        if (delivery.appliedAt <= 0L || delivery.appliedAt > MAX_SAFE_INTEGER) {
            throw new IllegalStateException("lifecycle LAN applied timestamp conflict");
        }
        return store.applyLifecycleControl(
            control.controlId, control.semanticChecksum, control.clearEpoch,
            control.clearedThroughSequence, control.leaseId, control.leaseAttempt,
            control.leasedAt, delivery.appliedAt, now);
    }

    public static ControlRoute bridgeRoute(BridgeClient client, boolean cloud) {
        if (client == null) throw new IllegalArgumentException("bridge client is required");
        return client.lifecycleControlRoute(cloud);
    }

    /** Derive a new lease identity for one control/semantic proof and attempt. */
    public static String leaseId(LifecycleControl control, long leaseAttempt) {
        requireControl(control);
        if (leaseAttempt <= 0L || leaseAttempt > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("invalid lifecycle lease attempt");
        }
        JSONObject basis = new JSONObject();
        try {
            basis.put("contract", "android-lifecycle-lease-id-v1");
            basis.put("controlId", control.controlId);
            basis.put("semanticChecksum", control.semanticChecksum);
            basis.put("leaseAttempt", leaseAttempt);
        } catch (JSONException error) {
            throw new IllegalArgumentException("lifecycle lease identity failed", error);
        }
        return "ctllease_" + BridgeAuthority.sha256CanonicalJson(basis);
    }

    /** Stable relay message identity; it never includes a lease or expiry. */
    public static String relayMessageId(LifecycleControl control) {
        requireControl(control);
        JSONObject basis = new JSONObject();
        try {
            basis.put("contract", "android-lifecycle-relay-message-id-v1");
            basis.put("controlId", control.controlId);
            basis.put("semanticChecksum", control.semanticChecksum);
        } catch (JSONException error) {
            throw new IllegalArgumentException("lifecycle relay identity failed", error);
        }
        return "ctlmsg_" + BridgeAuthority.sha256CanonicalJson(basis);
    }

    /** Stable enqueue idempotency identity; it is independent of route and lease. */
    public static String idempotencyKey(LifecycleControl control) {
        requireControl(control);
        JSONObject basis = new JSONObject();
        try {
            basis.put("contract", "android-lifecycle-idempotency-v1");
            basis.put("controlId", control.controlId);
            basis.put("semanticChecksum", control.semanticChecksum);
        } catch (JSONException error) {
            throw new IllegalArgumentException("lifecycle idempotency identity failed", error);
        }
        return "ctlidem_" + BridgeAuthority.sha256CanonicalJson(basis);
    }

    /** A pending lease becomes claimable exactly at leasedAt + 60 seconds. */
    public static boolean leaseExpired(LifecycleControl control, long now) {
        requireControl(control);
        if (!LifecycleControl.PENDING.equals(control.state)
            || control.leasedAt == null || now < 0L || now > MAX_SAFE_INTEGER) {
            return false;
        }
        return now >= saturatingAdd(control.leasedAt, LEASE_MILLIS);
    }

    /** A relay-accepted row may be refreshed only inside the final 24-hour window. */
    public static boolean refreshable(LifecycleControl control, long now) {
        requireControl(control);
        if (!LifecycleControl.RELAY_ACCEPTED.equals(control.state)
            || control.relayExpiresAt == null || now < 0L || now > MAX_SAFE_INTEGER) {
            return false;
        }
        return now >= Math.max(0L, control.relayExpiresAt - REFRESH_WINDOW_MILLIS);
    }

    /** Earliest store-owned wake time; Long.MAX_VALUE means not selectable. */
    public static long nextEligibleAt(LifecycleControl control, long now) {
        requireControl(control);
        if (now < 0L || now > MAX_SAFE_INTEGER) throw new IllegalArgumentException("invalid lifecycle clock");
        if (LifecycleControl.WAITING.equals(control.state)) return now;
        if (LifecycleControl.PENDING.equals(control.state) && control.leasedAt != null) {
            return saturatingAdd(control.leasedAt, LEASE_MILLIS);
        }
        if (LifecycleControl.RELAY_ACCEPTED.equals(control.state) && control.relayExpiresAt != null) {
            return Math.max(now, control.relayExpiresAt - REFRESH_WINDOW_MILLIS);
        }
        return Long.MAX_VALUE;
    }

    /**
     * Check the complete persisted proof tuple supplied by a remote applied ACK.
     * The store must repeat this check in its transaction; this helper is only a
     * transport-side fail-closed guard.
     */
    /** Build the closed applied-proof wire; relay identity stays outside this wire. */
    public static JSONObject encodeAppliedAck(LifecycleControl control, long appliedAt) {
        requireControl(control);
        requirePositiveSafe(appliedAt, "appliedAt");
        JSONObject wire = new JSONObject();
        try {
            wire.put("protocolVersion", 3L);
            wire.put("type", "CONVERSATION_CLEAR_APPLIED");
            wire.put("controlId", control.controlId);
            wire.put("roleId", control.characterId);
            wire.put("peerId", control.peerId);
            wire.put("clearEpoch", control.clearEpoch == null ? JSONObject.NULL : control.clearEpoch);
            wire.put("clearedThroughSequence",
                control.clearedThroughSequence == null ? JSONObject.NULL : control.clearedThroughSequence);
            wire.put("controlChecksum", control.semanticChecksum);
            wire.put("appliedAt", appliedAt);
            wire.put("checksum", BridgeAuthority.sha256CanonicalJson(wire));
            return wire;
        } catch (JSONException error) {
            throw new IllegalArgumentException("lifecycle applied ACK encoding failed", error);
        }
    }

    /** Validate only the closed, self-authenticating applied-proof shape. */
    public static void validateAppliedAckShape(JSONObject wire) {
        if (wire == null || !APPLIED_ACK_KEYS.equals(keysOf(wire))) {
            throw new IllegalArgumentException("lifecycle applied ACK keys conflict");
        }
        requireNativeLong(wire.opt("protocolVersion"), "protocolVersion", false);
        if (((Number) wire.opt("protocolVersion")).longValue() != 3L
            || !(wire.opt("type") instanceof String)
            || !"CONVERSATION_CLEAR_APPLIED".equals(wire.opt("type"))) {
            throw new IllegalArgumentException("invalid lifecycle ACK header");
        }
        requireNativeId(wire.opt("controlId"), "controlId");
        requireNativeId(wire.opt("roleId"), "roleId");
        requireNativeId(wire.opt("peerId"), "peerId");
        requireNullableSafe(wire.opt("clearEpoch"), "clearEpoch");
        requireNullableSafe(wire.opt("clearedThroughSequence"), "clearedThroughSequence");
        requireNativeChecksum(wire.opt("controlChecksum"), "controlChecksum");
        requireNativeLong(wire.opt("appliedAt"), "appliedAt", true);
        requireNativeChecksum(wire.opt("checksum"), "checksum");
        try {
            if (!wire.getString("checksum").equals(checksumWithoutField(wire))) {
                throw new IllegalArgumentException("lifecycle applied ACK authority conflict");
            }
        } catch (JSONException error) {
            throw new IllegalArgumentException("lifecycle applied ACK shape conflict", error);
        }
    }

    /** Validate an applied proof against the persisted control identity. */
    public static void validateAppliedAck(JSONObject wire, LifecycleControl control) {
        requireControl(control);
        if (!LifecycleControl.CLEAR_KIND.equals(control.controlKind)) {
            throw new IllegalArgumentException("lifecycle applied ACK kind conflict");
        }
        validateAppliedAckShape(wire);
        try {
            if (!control.controlId.equals(wire.getString("controlId"))
                || !control.characterId.equals(wire.getString("roleId"))
                || !control.peerId.equals(wire.getString("peerId"))
                || !control.semanticChecksum.equals(wire.getString("controlChecksum"))
                || !Objects.equals(nullableLong(wire.opt("clearEpoch")), control.clearEpoch)
                || !Objects.equals(nullableLong(wire.opt("clearedThroughSequence")), control.clearedThroughSequence)) {
                throw new IllegalArgumentException("lifecycle applied ACK authority conflict");
            }
        } catch (JSONException error) {
            throw new IllegalArgumentException("lifecycle applied ACK shape conflict", error);
        }
    }

    /** Only validator errors from the closed applied-ACK contract are recoverable inbox rejections. */
    public static boolean isAppliedAckConflict(Throwable error) {
        return error instanceof IllegalArgumentException
            && APPLIED_ACK_CONFLICT_MESSAGES.contains(error.getMessage());
    }

    /**
     * Return only a closed checksum token for a rejected ACK diagnostic.  A malformed
     * caller value is represented by a fixed sentinel so secrets never enter diagnostics.
     */
    public static String appliedAckConflictChecksum(JSONObject wire) {
        Object raw = wire == null ? null : wire.opt("controlChecksum");
        return appliedAckConflictChecksum(raw instanceof String ? (String) raw : null);
    }

    public static String appliedAckConflictChecksum(String raw) {
        return raw != null && raw.matches("[a-f0-9]{64}") ? raw : "invalid";
    }

    /** Validate a generated relay expiry against one captured clock value. */
    public static boolean validRelayExpiry(long now, long relayExpiresAt) {
        return now > 0L && now <= MAX_SAFE_INTEGER
            && relayExpiresAt > now && relayExpiresAt <= MAX_SAFE_INTEGER
            && relayExpiresAt - now <= MAX_RELAY_LIFETIME_MILLIS;
    }

    /** Closed outer relay identity accepted for an inbound terminal ACK. */
    public static boolean validInboundRelayMessageId(String value) {
        return value != null && value.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,127}");
    }

    private static long checkedExpiry(long now) {
        if (now <= 0L || now > MAX_SAFE_INTEGER - 24L * 60L * 60L * 1000L) {
            throw new IllegalArgumentException("invalid lifecycle relay clock");
        }
        return now + 24L * 60L * 60L * 1000L;
    }

    private static long nextRelayExpiry(LifecycleControl control, long now) {
        if (now <= 0L || now > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("invalid lifecycle relay clock");
        }
        long upper = now > MAX_SAFE_INTEGER - MAX_RELAY_LIFETIME_MILLIS
            ? MAX_SAFE_INTEGER : now + MAX_RELAY_LIFETIME_MILLIS;
        if (control.relayExpiresAt == null) return checkedExpiry(now);
        if (control.relayExpiresAt >= upper) {
            throw new IllegalStateException("lifecycle relay expiry cannot extend");
        }
        return upper;
    }

    private static void requireControl(LifecycleControl control) {
        if (control == null || control.controlId == null || control.controlId.trim().isEmpty()
            || control.semanticChecksum == null || !control.semanticChecksum.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("invalid lifecycle control proof");
        }
    }

    private static Set<String> keysOf(JSONObject value) {
        Set<String> result = new HashSet<>();
        org.json.JSONArray names = value.names();
        if (names == null) return result;
        for (int index = 0; index < names.length(); index += 1) result.add(names.optString(index));
        return result;
    }

    private static void requireNativeId(Object value, String name) {
        if (!(value instanceof String) || ((String) value).trim().isEmpty()
            || !value.equals(((String) value).trim())) {
            throw new IllegalArgumentException("invalid lifecycle ACK " + name);
        }
    }

    private static void requireNativeChecksum(Object value, String name) {
        if (!(value instanceof String) || !((String) value).matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("invalid lifecycle ACK " + name);
        }
    }

    private static void requireNativeLong(Object value, String name, boolean positive) {
        if (!(value instanceof Number) || value instanceof Float || value instanceof Double) {
            throw new IllegalArgumentException("invalid lifecycle ACK " + name);
        }
        long number = ((Number) value).longValue();
        if (number < (positive ? 1L : 0L) || number > MAX_SAFE_INTEGER
            || number != ((Number) value).doubleValue()) {
            throw new IllegalArgumentException("invalid lifecycle ACK " + name);
        }
    }

    private static void requireNullableSafe(Object value, String name) {
        if (value == null || JSONObject.NULL.equals(value)) return;
        requireNativeLong(value, name, false);
    }

    private static Long nullableLong(Object value) {
        if (value == null || JSONObject.NULL.equals(value)) return null;
        return ((Number) value).longValue();
    }

    private static String checksumWithoutField(JSONObject value) {
        JSONObject basis = new JSONObject();
        try {
            org.json.JSONArray names = value.names();
            if (names != null) for (int index = 0; index < names.length(); index += 1) {
                String name = names.getString(index);
                if (!"checksum".equals(name)) basis.put(name, value.get(name));
            }
        } catch (JSONException error) {
            throw new IllegalArgumentException("lifecycle ACK checksum failed", error);
        }
        return BridgeAuthority.sha256CanonicalJson(basis);
    }

    private static void requirePositiveSafe(long value, String name) {
        if (value <= 0L || value > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("invalid lifecycle " + name);
        }
    }

    private static long saturatingAdd(long value, long delta) {
        if (value > MAX_SAFE_INTEGER - delta) return MAX_SAFE_INTEGER;
        return value + delta;
    }
}
