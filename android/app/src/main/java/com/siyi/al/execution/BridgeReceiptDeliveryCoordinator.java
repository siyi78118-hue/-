package com.siyi.al.execution;

import org.json.JSONObject;

/**
 * Derives and delivers the v3 authority receipt from the persisted v12 checkpoint.
 *
 * <p>This class deliberately owns no receipt table.  The checkpoint and its checksum are the
 * durable authority; {@code uiAppliedAt} is the stable deliveredAt value, while the injected
 * clock records the later local confirmation event.  The store performs the exact local CAS.</p>
 */
public final class BridgeReceiptDeliveryCoordinator {
    public enum OutcomeStatus {
        NOT_READY,
        REDACTED,
        CONFIRMED,
        RETRYABLE,
        REJECTED
    }

    public enum ConfirmationResult {
        CONFIRMED,
        RETRYABLE,
        CONFLICT
    }

    public interface Store {
        AuthoritySnapshot readAuthority(String localTurnId);

        ConfirmationResult confirmCloudReceiptExact(AuthorityReceipt expected, long confirmedAt);
    }

    public interface Transport {
        void send(AuthorityReceipt receipt) throws Exception;
    }

    public interface Clock {
        long now();
    }

    public static final class AuthoritySnapshot {
        public final String localTurnId;
        public final String checkpointJson;
        public final String checkpointChecksum;
        public final Long uiAppliedAt;
        public final boolean redacted;
        public final boolean cloudConfirmed;
        public final String peerId;
        public final String route;
        public final String relayMessageId;

        public AuthoritySnapshot(
            String localTurnId,
            String checkpointJson,
            String checkpointChecksum,
            Long uiAppliedAt,
            boolean redacted,
            boolean cloudConfirmed,
            String peerId,
            String route,
            String relayMessageId
        ) {
            this.localTurnId = localTurnId;
            this.checkpointJson = checkpointJson;
            this.checkpointChecksum = checkpointChecksum;
            this.uiAppliedAt = uiAppliedAt;
            this.redacted = redacted;
            this.cloudConfirmed = cloudConfirmed;
            this.peerId = peerId;
            this.route = route;
            this.relayMessageId = relayMessageId;
        }
    }

    public static final class AuthorityReceipt {
        public final int protocolVersion;
        public final String type;
        public final String peerId;
        /** The remote authoritative PC member turn id carried by the wire receipt. */
        public final String turnId;
        /** Compatibility alias for callers that used the old name. */
        public final String authoritativeTurnId;
        public final String authorityLineageKey;
        public final String visibleGroupId;
        public final String commitChecksum;
        public final String terminalDisposition;
        public final long deliveredAt;
        public final String wireJson;
        public final String idempotencyKey;

        /** Internal CAS tuple, deliberately excluded from the nine wire fields. */
        public final String localTurnId;
        public final String checkpointChecksum;
        public final String route;
        public final String relayMessageId;

        private AuthorityReceipt(
            String localTurnId,
            String peerId,
            String turnId,
            String authorityLineageKey,
            String visibleGroupId,
            String commitChecksum,
            String terminalDisposition,
            long deliveredAt,
            String checkpointChecksum,
            String route,
            String relayMessageId
        ) {
            this.protocolVersion = 3;
            this.type = "AUTHORITY_DELIVERY_RECEIPT";
            this.peerId = peerId;
            this.turnId = turnId;
            this.authoritativeTurnId = turnId;
            this.authorityLineageKey = authorityLineageKey;
            this.visibleGroupId = visibleGroupId;
            this.commitChecksum = commitChecksum;
            this.terminalDisposition = terminalDisposition;
            this.deliveredAt = deliveredAt;
            this.localTurnId = localTurnId;
            this.checkpointChecksum = checkpointChecksum;
            this.route = route;
            this.relayMessageId = relayMessageId;
            try {
                JSONObject wire = new JSONObject()
                    .put("protocolVersion", protocolVersion)
                    .put("type", type)
                    .put("peerId", peerId)
                    .put("turnId", turnId)
                    .put("authorityLineageKey", authorityLineageKey)
                    .put("visibleGroupId", visibleGroupId)
                    .put("commitChecksum", commitChecksum)
                    .put("terminalDisposition", terminalDisposition)
                    .put("deliveredAt", deliveredAt);
                this.wireJson = BridgeAuthority.canonicalJson(wire);
                this.idempotencyKey = BridgeAuthority.sha256CanonicalJson(wire);
            } catch (Exception error) {
                throw new IllegalArgumentException("authority receipt serialization conflict", error);
            }
        }

        public boolean sameIdentity(AuthorityReceipt other) {
            return other != null
                && wireJson.equals(other.wireJson)
                && idempotencyKey.equals(other.idempotencyKey)
                && equalsValue(localTurnId, other.localTurnId)
                && equalsValue(checkpointChecksum, other.checkpointChecksum)
                && equalsValue(route, other.route)
                && equalsValue(relayMessageId, other.relayMessageId);
        }
    }

    public static final class Outcome {
        public final OutcomeStatus status;
        public final AuthorityReceipt receipt;
        public final String reason;

        private Outcome(OutcomeStatus status, AuthorityReceipt receipt, String reason) {
            this.status = status;
            this.receipt = receipt;
            this.reason = reason;
        }

        static Outcome of(OutcomeStatus status, AuthorityReceipt receipt, String reason) {
            return new Outcome(status, receipt, reason);
        }
    }

    private final Store store;
    private final Transport transport;
    private final Clock clock;

    public BridgeReceiptDeliveryCoordinator(Store store, Transport transport) {
        this(store, transport, System::currentTimeMillis);
    }

    public BridgeReceiptDeliveryCoordinator(Store store, Transport transport, Clock clock) {
        if (store == null || transport == null || clock == null) {
            throw new IllegalArgumentException("receipt coordinator dependencies are required");
        }
        this.store = store;
        this.transport = transport;
        this.clock = clock;
    }

    public Outcome deliver(String requestedLocalTurnId) {
        AuthoritySnapshot snapshot = store.readAuthority(requestedLocalTurnId);
        if (snapshot == null) {
            return Outcome.of(OutcomeStatus.REJECTED, null, "authority snapshot missing");
        }
        if (requestedLocalTurnId == null || !requestedLocalTurnId.equals(snapshot.localTurnId)) {
            return Outcome.of(OutcomeStatus.REJECTED, null, "local turn identity conflict");
        }
        if (snapshot.redacted) {
            return Outcome.of(OutcomeStatus.REDACTED, null, "authority is redacted");
        }
        if (snapshot.uiAppliedAt == null) {
            return Outcome.of(OutcomeStatus.NOT_READY, null, "ui has not applied the result");
        }

        AuthorityReceipt receipt = deriveReceipt(snapshot);
        if (snapshot.cloudConfirmed) {
            return Outcome.of(OutcomeStatus.CONFIRMED, receipt, null);
        }

        try {
            transport.send(receipt);
        } catch (Exception error) {
            return Outcome.of(OutcomeStatus.RETRYABLE, receipt, error.getMessage());
        }

        long confirmedAt = clock.now();
        if (confirmedAt <= 0L || confirmedAt > 9007199254740991L) {
            throw new IllegalArgumentException("receipt confirmation timestamp conflict");
        }
        ConfirmationResult confirmation = store.confirmCloudReceiptExact(receipt, confirmedAt);
        if (confirmation == ConfirmationResult.CONFIRMED) {
            return Outcome.of(OutcomeStatus.CONFIRMED, receipt, null);
        }
        if (confirmation == ConfirmationResult.RETRYABLE) {
            return Outcome.of(OutcomeStatus.RETRYABLE, receipt, "cloud confirmation pending");
        }
        throw new IllegalArgumentException("receipt confirmation conflict");
    }

    private static AuthorityReceipt deriveReceipt(AuthoritySnapshot snapshot) {
        requireNonEmpty(snapshot.localTurnId, "local turn");
        requireNonEmpty(snapshot.peerId, "peer");
        requireNonEmpty(snapshot.route, "route");
        if (snapshot.checkpointJson == null || snapshot.checkpointChecksum == null) {
            throw new IllegalArgumentException("authority checkpoint is incomplete");
        }
        JSONObject checkpoint;
        try {
            checkpoint = new JSONObject(snapshot.checkpointJson);
        } catch (Exception error) {
            throw new IllegalArgumentException("authority checkpoint JSON conflict", error);
        }
        String expectedCheckpointChecksum = BridgeAuthority.sha256CanonicalJson(checkpoint);
        if (!expectedCheckpointChecksum.equals(snapshot.checkpointChecksum)) {
            throw new IllegalArgumentException("authority checkpoint checksum conflict");
        }

        JSONObject payload = BridgeReceiptCheckpoint.extractAuthorityReceiptFromV12Checkpoint(
            snapshot.checkpointJson, snapshot.checkpointChecksum);
        if (payload == null) {
            throw new IllegalArgumentException("authority checkpoint receipt conflict");
        }
        String remoteTurnId = requiredString(payload, "turnId");
        String lineageKey = requiredString(payload, "authorityLineageKey");
        String groupId = requiredString(payload, "visibleGroupId");
        String commitChecksum = requiredString(payload, "commitChecksum");
        String disposition = requiredString(payload, "terminalDisposition");
        if (!("visible".equals(disposition)
            || "action_only".equals(disposition)
            || "skip".equals(disposition))) {
            throw new IllegalArgumentException("authority terminal disposition conflict");
        }

        String checkpointRoute = requiredString(payload, "_deliveryRoute");
        String checkpointRelay = nullableString(payload, "_relayMessageId");
        if (!snapshot.route.equals(checkpointRoute)
            || !equalsValue(snapshot.relayMessageId, checkpointRelay)) {
            throw new IllegalArgumentException("authority route/relay identity conflict");
        }
        if ("lan".equals(checkpointRoute) && checkpointRelay != null) {
            throw new IllegalArgumentException("LAN authority receipt relay conflict");
        }
        if ("cloud".equals(checkpointRoute)
            && (checkpointRelay == null || checkpointRelay.isEmpty())) {
            throw new IllegalArgumentException("cloud authority receipt relay conflict");
        }
        long deliveredAt = snapshot.uiAppliedAt.longValue();
        if (deliveredAt <= 0L) {
            throw new IllegalArgumentException("authority deliveredAt conflict");
        }
        return new AuthorityReceipt(
            snapshot.localTurnId,
            snapshot.peerId,
            remoteTurnId,
            lineageKey,
            groupId,
            commitChecksum,
            disposition,
            deliveredAt,
            snapshot.checkpointChecksum,
            checkpointRoute,
            checkpointRelay);
    }

    private static void requireNonEmpty(String value, String label) {
        if (value == null || value.isEmpty()) {
            throw new IllegalArgumentException("authority " + label + " identity conflict");
        }
    }

    private static String requiredString(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof String) || ((String) raw).isEmpty()) {
            throw new IllegalArgumentException("authority receipt " + key + " conflict");
        }
        return (String) raw;
    }

    private static String nullableString(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (raw == null || raw == JSONObject.NULL) return null;
        if (!(raw instanceof String) || ((String) raw).isEmpty()) {
            throw new IllegalArgumentException("authority receipt " + key + " conflict");
        }
        return (String) raw;
    }

    private static boolean equalsValue(String left, String right) {
        return left == null ? right == null : left.equals(right);
    }
}
