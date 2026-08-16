package com.siyi.al.execution.bridge;

import android.util.Base64;
import androidx.annotation.VisibleForTesting;
import com.siyi.al.execution.AuthorityIdentity;
import com.siyi.al.execution.AndroidRoomBackupHead;
import com.siyi.al.execution.BridgeAuthority;
import com.siyi.al.execution.LifecycleControl;
import com.siyi.al.execution.LifecycleControlCodec;
import com.siyi.al.execution.LifecycleControlSender;
import com.siyi.al.execution.TurnSubmission;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Iterator;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

public final class BridgeClient {
    public interface StatusListener {
        void onStatus(String turnId, String raw);
    }

    public interface CloudInboxConsumer {
        boolean persist(String raw) throws Exception;
        default void recordRejected(String relayMessageId, String reason, long now) throws Exception {}
        default boolean applyLifecycleControl(
            String raw, String relayMessageId, Long relayExpiresAt, long now
        ) throws Exception { return false; }
    }

    /**
     * Test-only transport injection.  The public bytecode visibility is retained
     * solely because the connected harness lives in the parent execution
     * package; @VisibleForTesting marks it as non-production API and production
     * callers continue to use the configured HTTP transport.
     */
    @VisibleForTesting(otherwise = VisibleForTesting.PRIVATE)
    public interface Transport {
        HttpResult request(String method, String target, String body, String[][] headers) throws Exception;
    }

    interface CloudInboxDecoder {
        JSONObject decode(JSONObject item) throws Exception;
    }

    interface Base64Codec {
        byte[] decode(String value);
        String encode(byte[] value);
    }

    interface Clock { long now(); }
    interface Sleeper { void sleep(long millis) throws Exception; }

    @VisibleForTesting(otherwise = VisibleForTesting.PRIVATE)
    public static final class HttpResult {
        final int status;
        final String body;
        public HttpResult(int status, String body) { this.status = status; this.body = body; }
    }

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Set<String> AUTHORITY_RECEIPT_KEYS = new HashSet<>(Arrays.asList(
        "protocolVersion", "type", "peerId", "turnId", "authorityLineageKey",
        "visibleGroupId", "commitChecksum", "terminalDisposition", "deliveredAt",
        "_checkpointChecksum", "_deliveryRoute"));
    private static final Set<String> CLOUD_AUTHORITY_RECEIPT_KEYS = new HashSet<>(Arrays.asList(
        "protocolVersion", "type", "peerId", "turnId", "authorityLineageKey",
        "visibleGroupId", "commitChecksum", "terminalDisposition", "deliveredAt",
        "_checkpointChecksum", "_deliveryRoute", "_relayMessageId"));
    private static final Set<String> CLOUD_POLL_ENVELOPE_KEYS = new HashSet<>(Arrays.asList(
        "messageId", "deviceId", "direction", "ciphertext", "nonce", "idempotencyKey",
        "byteCount", "createdAt", "expiresAt"));
    private static final Set<String> LIFECYCLE_ACCEPTED_RESPONSE_KEYS = new HashSet<>(Arrays.asList(
        "ok", "messageId", "expiresAt", "idempotent"));
    private static final Set<String> LIFECYCLE_ENQUEUE_RESPONSE_KEYS = new HashSet<>(Arrays.asList(
        "ok", "messageId", "idempotent"));
    private final BridgeConfig config;
    private final FallbackJournal journal;
    private final Transport transport;
    private final Clock clock;
    private final Sleeper sleeper;
    private final StatusListener statusListener;
    private final CloudInboxConsumer inboxConsumer;
    private final Base64Codec base64Codec;
    private final ConcurrentHashMap<String, String> authorityReceiptPins = new ConcurrentHashMap<>();

    public BridgeClient(BridgeConfig config) {
        this(config, null);
    }

    public BridgeClient(BridgeConfig config, FallbackJournal journal) {
        this(config, journal, null);
    }

    public BridgeClient(BridgeConfig config, FallbackJournal journal, StatusListener statusListener) {
        this(config, journal, null, System::currentTimeMillis, Thread::sleep, statusListener, null);
    }

    public BridgeClient(
        BridgeConfig config, FallbackJournal journal, StatusListener statusListener,
        CloudInboxConsumer inboxConsumer
    ) {
        this(config, journal, null, System::currentTimeMillis, Thread::sleep, statusListener, inboxConsumer);
    }

    /** Narrow test ingress factory; it keeps the production decoder/consumer path intact. */
    @VisibleForTesting(otherwise = VisibleForTesting.PRIVATE)
    public static BridgeClient forTestingTransport(
        BridgeConfig config, FallbackJournal journal, Transport transport,
        CloudInboxConsumer inboxConsumer
    ) {
        if (transport == null) throw new IllegalArgumentException("transport required");
        return new BridgeClient(
            config, journal, transport, System::currentTimeMillis, Thread::sleep,
            null, inboxConsumer);
    }

    BridgeClient(
        BridgeConfig config, FallbackJournal journal, Transport transport, Clock clock, Sleeper sleeper,
        StatusListener statusListener
    ) {
        this(config, journal, transport, clock, sleeper, statusListener, null);
    }

    BridgeClient(
        BridgeConfig config, FallbackJournal journal, Transport transport, Clock clock, Sleeper sleeper,
        StatusListener statusListener, CloudInboxConsumer inboxConsumer
    ) {
        this(config, journal, transport, clock, sleeper, statusListener, inboxConsumer, null);
    }

    BridgeClient(
        BridgeConfig config, FallbackJournal journal, Transport transport, Clock clock, Sleeper sleeper,
        StatusListener statusListener, CloudInboxConsumer inboxConsumer, Base64Codec base64Codec
    ) {
        this.config = config == null ? BridgeConfig.disabled() : config;
        this.journal = journal;
        this.transport = transport == null ? this::http : transport;
        this.clock = clock == null ? System::currentTimeMillis : clock;
        this.sleeper = sleeper == null ? Thread::sleep : sleeper;
        this.statusListener = statusListener;
        this.inboxConsumer = inboxConsumer;
        this.base64Codec = base64Codec == null ? new Base64Codec() {
            @Override public byte[] decode(String value) {
                return Base64.decode(value, Base64.DEFAULT);
            }

            @Override public String encode(byte[] value) {
                return Base64.encodeToString(value, Base64.NO_WRAP);
            }
        } : base64Codec;
    }

    public BridgeRouter.RouteClient lanRoute() { return this::sendLan; }
    public BridgeRouter.RouteClient cloudRoute() { return this::sendCloud; }

    public JSONObject requestVerifiedBackup(
        String roleId, JSONObject androidRoomHead, long requestedAt
    ) throws Exception {
        if (!config.hasLan() && !config.hasCloud()) {
            throw new BridgeFinalException("VERIFIED_BACKUP_BRIDGE_NOT_CONFIGURED", false);
        }
        if (roleId == null || !roleId.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
            || config.deviceId == null
            || !config.deviceId.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
            || requestedAt <= 0L || requestedAt > LifecycleControlSender.MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("Yuqi backup request identity conflict");
        }
        JSONObject head = AndroidRoomBackupHead.validate(androidRoomHead, roleId);
        if (head.getLong("capturedAt") != requestedAt) {
            throw new IllegalArgumentException("Yuqi backup request Room time conflict");
        }
        JSONObject backupRequest = new JSONObject()
            .put("protocolVersion", 3)
            .put("type", "YUQI_BACKUP_REQUEST")
            .put("requestVersion", "yuqi-backup-request-v1")
            .put("roleId", roleId)
            .put("peerId", config.deviceId)
            .put("requestedAt", requestedAt)
            .put("androidRoomHead", head);
        backupRequest.put("checksum", BridgeAuthority.sha256CanonicalJson(backupRequest));
        if (config.hasLan()) {
            try {
                HttpResult response = signedLan(
                    "POST", "/v3/backups/yuqi", backupRequest.toString());
                requireSuccess(response, "LAN verified backup");
                return validateVerifiedBackupReceipt(
                    new JSONObject(response.body == null ? "{}" : response.body),
                    roleId, requestedAt);
            } catch (BridgePendingException error) {
                if (!config.hasCloud()) throw error;
            }
        }
        return requestVerifiedBackupCloud(backupRequest);
    }

    private JSONObject validateVerifiedBackupReceipt(
        JSONObject value, String roleId, long requestedAt
    ) throws Exception {
        JSONObject receipt = LifecycleControlCodec.validateBackupReceipt(value);
        if (!roleId.equals(receipt.getString("roleId"))
            || receipt.getLong("createdAt") != requestedAt) {
            throw new IllegalArgumentException("Yuqi backup receipt authority conflict");
        }
        return receipt;
    }

    private JSONObject requestVerifiedBackupCloud(JSONObject backupRequest) throws Exception {
        String requestChecksum = backupRequest.getString("checksum");
        String relayMessageId = "bkreq_" + sha256(
            "android-backup-request-message-id-v1\n" + requestChecksum).substring(0, 24);
        String idempotencyKey = "bkreqidem_" + sha256(
            "android-backup-request-idempotency-v1\n" + requestChecksum).substring(0, 24);
        Encrypted encrypted = encryptLifecycle(backupRequest.toString(), relayMessageId);
        long now = clock.now();
        long expiresAt = now + 24L * 60L * 60L * 1000L;
        if (expiresAt <= now || expiresAt > LifecycleControlSender.MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("cloud Yuqi backup expiry conflict");
        }
        JSONObject enqueue = new JSONObject()
            .put("deviceId", config.deviceId)
            .put("messageId", relayMessageId)
            .put("idempotencyKey", idempotencyKey)
            .put("direction", "phone_to_pc")
            .put("ciphertext", encrypted.ciphertext)
            .put("nonce", encrypted.nonce)
            .put("expiresAt", expiresAt);
        HttpResult enqueued = request(
            "POST", config.cloudUrl + "/bridge/enqueue", enqueue.toString(), bearerHeaders());
        requireSuccess(enqueued, "cloud Yuqi backup enqueue");
        validateLifecycleEnqueueResponse(enqueued.body, relayMessageId);

        int interval = Math.max(100, config.cloudPollIntervalMs);
        // A verified backup copies and validates the PC database before the
        // receipt exists. Keep the synchronous waiter alive long enough for a
        // real vault while still respecting the configured poll-attempt cap.
        int attempts = Math.max(1, Math.min(config.cloudPollAttempts, 90_000 / interval));
        String pollTarget = config.cloudUrl + "/bridge/poll?deviceId="
            + URLEncoder.encode(config.deviceId, "UTF-8")
            + "&direction=pc_to_phone&limit=50";
        for (int attempt = 0; attempt < attempts; attempt++) {
            HttpResult polled = request("GET", pollTarget, "", bearerHeaders());
            requireSuccess(polled, "cloud Yuqi backup poll");
            JSONArray messages = new JSONObject(polled.body == null ? "{}" : polled.body)
                .optJSONArray("messages");
            JSONArray normalized = normalizeCloudPollBatch(
                messages == null ? new JSONArray() : messages, config.deviceId, clock.now());
            for (int index = 0; index < normalized.length(); index++) {
                JSONObject item = normalized.getJSONObject(index);
                JSONObject decoded;
                try {
                    decoded = new JSONObject(decrypt(
                        item.getString("ciphertext"), item.getString("nonce")));
                } catch (Exception ignored) {
                    continue;
                }
                if (!"YUQI_BACKUP_RECEIPT".equals(decoded.opt("type"))
                    || !requestChecksum.equals(decoded.opt("requestChecksum"))) {
                    continue;
                }
                JSONObject receipt = LifecycleControlCodec.validateBackupReceiptResponse(
                    decoded,
                    requestChecksum,
                    backupRequest.getString("roleId"),
                    backupRequest.getString("peerId"),
                    backupRequest.getLong("requestedAt")
                );
                acknowledgeCloud(item.getString("messageId"));
                return receipt;
            }
            if (attempt + 1 < attempts) sleeper.sleep(interval);
        }
        throw new BridgePendingException("电脑仍在处理备份凭证，请稍后重试完整恢复");
    }

    static boolean matchesTurn(TurnSubmission submission, String remoteTurnId) {
        return BridgeInput.wireTurnId(submission).equals(remoteTurnId);
    }

    static String classifyCloudResult(TurnSubmission submission, JSONObject decoded) {
        String remoteTurnId = decoded.optString("turnId", "");
        boolean current = submission != null && matchesTurn(submission, remoteTurnId);
        JSONObject reply = decoded.optJSONObject("reply");
        boolean committed = decoded.optBoolean("terminal", false)
            && reply != null && !reply.optString("content", "").trim().isEmpty();
        if (current) return committed ? "CURRENT_COMMITTED" : "CURRENT_FAILED";
        return committed ? "BACKLOG_COMMITTED" : "BACKLOG_FAILED";
    }

    public BridgeResult sendLan(TurnSubmission submission) throws Exception {
        if (!config.hasLan()) throw new BridgeFinalException("LAN_BRIDGE_NOT_CONFIGURED", true);
        long deadline = deadline(submission);
        String path = "/v2/turns";
        JSONObject wire = wireEnvelope(submission);
        boolean canonicalV3 = submission.bridgeAuthorityCheckpointJson != null;
        String wireTurnId = wire.getString("turnId");
        String body = wire.toString();
        HttpResult response = signedLan("POST", path, body);
        requireSuccess(response, "LAN submit");
        while (true) {
            if (canonicalV3 && isTerminalResponse(response.body)) {
                BridgeResult result = BridgeTurnStatus.parseV3(response.body, "lan", null);
                reportRawStatus(submission.turnId, response.body);
                acknowledgeRecovery(response.body);
                return result;
            }
            BridgeTurnStatus status = BridgeTurnStatus.parse(response.body, wireTurnId);
            reportStatus(submission.turnId, status);
            acknowledgeRecovery(status);
            if (status.terminal) {
                if (status.committed()) return status.toResult("lan");
                throw new BridgeFinalException(status.errorCode, status.allowFallback);
            }
            sleepForPoll(submission.turnId, deadline, status.retryAfterMs);
            path = "/v2/turns/" + URLEncoder.encode(wireTurnId, "UTF-8");
            response = signedLan("GET", path, "");
            requireSuccess(response, "LAN poll");
        }
    }

    public BridgeResult sendCloud(TurnSubmission submission) throws Exception {
        if (!config.hasCloud()) throw new BridgeFinalException("CLOUD_BRIDGE_NOT_CONFIGURED", true);
        JSONObject wire = wireEnvelope(submission);
        Encrypted encrypted = encrypt(wire.toString());
        String relayMessageId = "relay_" + sha256(submission.turnId).substring(0, 24);
        JSONObject enqueue = new JSONObject()
            .put("deviceId", config.deviceId)
            .put("messageId", relayMessageId)
            .put("idempotencyKey", "turn_" + sha256(submission.turnId).substring(0, 24))
            .put("direction", "phone_to_pc")
            .put("ciphertext", encrypted.ciphertext)
            .put("nonce", encrypted.nonce)
            .put("expiresAt", clock.now() + 24L * 60L * 60L * 1000L);
        HttpResult enqueued = request(
            "POST", config.cloudUrl + "/bridge/enqueue", enqueue.toString(), bearerHeaders()
        );
        requireSuccess(enqueued, "cloud enqueue");
        completeCloudHandoff();
        throw new IllegalStateException("unreachable");
    }

    /** Independent control route; it never uses a turn endpoint or TurnSubmission. */
    public LifecycleControlSender.ControlRoute lifecycleControlRoute(boolean cloud) {
        return (control, relayMessageId, idempotencyKey, expiresAt) ->
            sendLifecycleControl(control, cloud, relayMessageId, idempotencyKey, expiresAt);
    }

    private LifecycleControlSender.ControlDelivery sendLifecycleControl(
        LifecycleControl control,
        boolean cloud,
        String relayMessageId,
        String idempotencyKey,
        long expiresAt
    ) throws Exception {
        if (control == null || (!LifecycleControl.CLEAR_KIND.equals(control.controlKind)
            && !LifecycleControl.ROLE_DELETE_KIND.equals(control.controlKind))) {
            throw new IllegalArgumentException("unsupported lifecycle control kind");
        }
        LifecycleControlCodec.validateSemantic(new JSONObject(control.semanticJson));
        if (!config.enabled) throw new BridgeFinalException("BRIDGE_NOT_CONFIGURED", false);
        if (!cloud) {
            if (!config.hasLan()) throw new BridgeFinalException("LAN_BRIDGE_NOT_CONFIGURED", false);
            boolean roleDelete = LifecycleControl.ROLE_DELETE_KIND.equals(control.controlKind);
            HttpResult response = signedLan(
                "POST", roleDelete ? "/v3/controls/role-delete"
                    : "/v3/controls/conversation-clear", control.semanticJson);
            requireSuccess(response, roleDelete ? "LAN role delete" : "LAN conversation clear");
            JSONObject applied = new JSONObject(response.body == null ? "{}" : response.body);
            if (roleDelete && response.status == 202) {
                LifecycleControlSender.validateRoleDeletePending(applied, control);
                return new LifecycleControlSender.ControlDelivery(false, null, 0L, 0L);
            }
            if (response.status != 200) {
                throw new IllegalArgumentException("lifecycle LAN response status conflict");
            }
            LifecycleControlSender.validateAppliedAck(applied, control);
            return new LifecycleControlSender.ControlDelivery(
                true, null, 0L, applied.getLong("appliedAt"));
        }
        long capturedNow = clock.now();
        if (!config.hasCloud() || relayMessageId == null || idempotencyKey == null
            || !LifecycleControlSender.validRelayExpiry(capturedNow, expiresAt)) {
            throw new BridgeFinalException("CLOUD_BRIDGE_NOT_CONFIGURED", false);
        }
        if (control.relayMessageId != null) {
            if (!relayMessageId.equals(control.relayMessageId)
                || control.relayExpiresAt == null || expiresAt <= control.relayExpiresAt) {
                throw new IllegalArgumentException("lifecycle relay refresh identity conflict");
            }
            JSONObject refresh = new JSONObject()
                .put("deviceId", config.deviceId)
                .put("messageId", relayMessageId)
                .put("idempotencyKey", idempotencyKey)
                .put("direction", "phone_to_pc")
                .put("expiresAt", expiresAt);
            long persistedExpiry = refreshLifecycleExpiry(
                refresh, relayMessageId, capturedNow, control.relayExpiresAt);
            return new LifecycleControlSender.ControlDelivery(false, relayMessageId, persistedExpiry);
        }
        Encrypted encrypted = encryptLifecycle(control.semanticJson, relayMessageId);
        JSONObject enqueue = new JSONObject()
            .put("deviceId", config.deviceId)
            .put("messageId", relayMessageId)
            .put("idempotencyKey", idempotencyKey)
            .put("direction", "phone_to_pc")
            .put("ciphertext", encrypted.ciphertext)
            .put("nonce", encrypted.nonce)
            .put("expiresAt", expiresAt);
        HttpResult response = request(
            "POST", config.cloudUrl + "/bridge/enqueue", enqueue.toString(), bearerHeaders());
        requireSuccess(response, "cloud conversation clear");
        boolean idempotent = validateLifecycleEnqueueResponse(response.body, relayMessageId);
        if (idempotent) {
            long refreshTarget = capturedNow > LifecycleControlSender.MAX_SAFE_INTEGER
                - LifecycleControlSender.MAX_RELAY_LIFETIME_MILLIS
                ? LifecycleControlSender.MAX_SAFE_INTEGER
                : capturedNow + LifecycleControlSender.MAX_RELAY_LIFETIME_MILLIS;
            JSONObject refresh = new JSONObject()
                .put("deviceId", config.deviceId)
                .put("messageId", relayMessageId)
                .put("idempotencyKey", idempotencyKey)
                .put("direction", "phone_to_pc")
                .put("expiresAt", refreshTarget);
            long persistedExpiry = refreshLifecycleExpiry(
                refresh, relayMessageId, capturedNow, expiresAt);
            return new LifecycleControlSender.ControlDelivery(false, relayMessageId, persistedExpiry);
        }
        return new LifecycleControlSender.ControlDelivery(false, relayMessageId, expiresAt);
    }

    private long refreshLifecycleExpiry(
        JSONObject refresh, String relayMessageId, long now, Long oldExpiry
    ) throws Exception {
        Object requested = refresh.opt("expiresAt");
        if (!(requested instanceof Number) || requested instanceof Float || requested instanceof Double) {
            throw new IllegalArgumentException("cloud lifecycle refresh request conflict");
        }
        long requestedExpiry = ((Number) requested).longValue();
        if (!LifecycleControlSender.validRelayExpiry(now, requestedExpiry)
            || (oldExpiry != null && requestedExpiry <= oldExpiry)) {
            throw new IllegalArgumentException("cloud lifecycle refresh request conflict");
        }
        HttpResult response = request(
            "POST", config.cloudUrl + "/bridge/refresh-expiry", refresh.toString(), bearerHeaders());
        requireSuccess(response, "cloud conversation clear expiry refresh");
        long persistedExpiry = validateLifecycleAcceptedResponse(
            response.body, relayMessageId, now, oldExpiry);
        if (persistedExpiry > requestedExpiry) {
            throw new IllegalArgumentException("cloud relay refresh expiry conflict");
        }
        return persistedExpiry;
    }

    private static boolean validateLifecycleEnqueueResponse(
        String raw, String expectedMessageId
    ) throws Exception {
        JSONObject body = new JSONObject(raw == null ? "{}" : raw);
        if (!LIFECYCLE_ENQUEUE_RESPONSE_KEYS.equals(keysOf(body))
            || !(body.opt("ok") instanceof Boolean) || !body.getBoolean("ok")
            || !(body.opt("messageId") instanceof String)
            || !expectedMessageId.equals(body.getString("messageId"))
            || !(body.opt("idempotent") instanceof Boolean)) {
            throw new IllegalArgumentException("cloud lifecycle enqueue acceptance conflict");
        }
        return body.getBoolean("idempotent");
    }

    private static long validateLifecycleAcceptedResponse(
        String raw, String expectedMessageId, long now, Long oldExpiry
    ) throws Exception {
        JSONObject body = new JSONObject(raw == null ? "{}" : raw);
        if (!LIFECYCLE_ACCEPTED_RESPONSE_KEYS.equals(keysOf(body))
            || !(body.opt("ok") instanceof Boolean) || !body.getBoolean("ok")
            || !(body.opt("messageId") instanceof String)
            || !expectedMessageId.equals(body.getString("messageId"))
            || !(body.opt("idempotent") instanceof Boolean)) {
            throw new IllegalArgumentException("cloud lifecycle acceptance conflict");
        }
        Object rawExpiry = body.opt("expiresAt");
        if (!(rawExpiry instanceof Number)
            || rawExpiry instanceof Float || rawExpiry instanceof Double) {
            throw new IllegalArgumentException("cloud lifecycle acceptance expiry conflict");
        }
        long expiry = ((Number) rawExpiry).longValue();
        boolean idempotent = body.getBoolean("idempotent");
        if (!LifecycleControlSender.validRelayExpiry(now, expiry)
            || (oldExpiry != null && (idempotent ? expiry < oldExpiry : expiry <= oldExpiry))) {
            throw new IllegalArgumentException("cloud lifecycle acceptance expiry conflict");
        }
        return expiry;
    }

    static void completeCloudHandoff() throws BridgeAcceptedException {
        throw new BridgeAcceptedException("cloud");
    }

    public int drainCloudInbox() throws Exception {
        if (!config.hasCloud() || inboxConsumer == null) return 0;
        String encodedDevice = URLEncoder.encode(config.deviceId, "UTF-8");
        String pollTarget = config.cloudUrl + "/bridge/poll?deviceId=" + encodedDevice
            + "&direction=pc_to_phone&limit=50";
        HttpResult polled = request("GET", pollTarget, "", bearerHeaders());
        requireSuccess(polled, "cloud poll");
        JSONArray messages = new JSONObject(polled.body).optJSONArray("messages");
        if (messages == null) return 0;
        JSONArray normalized = normalizeCloudPollBatch(messages, config.deviceId, clock.now());
        return processCloudInboxBatch(normalized, item -> {
            String plaintext = decrypt(item.optString("ciphertext"), item.optString("nonce"));
            return new JSONObject(plaintext);
        });
    }

    /**
     * Validates and de-duplicates the complete cloud poll envelope before any
     * ciphertext is decrypted or inbox consumer is invoked.  A repeated relay
     * id is accepted only when all nine persisted outer fields are identical;
     * any self-consistent mutation poisons the whole batch.
     */
    static JSONArray normalizeCloudPollBatch(
        JSONArray messages, String expectedDeviceId, long now
    ) throws Exception {
        if (messages == null || expectedDeviceId == null || expectedDeviceId.trim().isEmpty()) {
            throw new IllegalArgumentException("cloud poll envelope conflict");
        }
        Map<String, JSONObject> unique = new LinkedHashMap<>();
        for (int index = 0; index < messages.length(); index += 1) {
            JSONObject item = messages.optJSONObject(index);
            if (item == null || !CLOUD_POLL_ENVELOPE_KEYS.equals(keysOf(item))) {
                throw new IllegalArgumentException("cloud poll envelope conflict");
            }
            String messageId = requireWorkerId(item, "messageId");
            String deviceId = requireWorkerId(item, "deviceId");
            String direction = requireNativeNonEmptyString(item, "direction");
            requireNativeNonEmptyString(item, "ciphertext");
            String nonce = requireNativeNonEmptyString(item, "nonce");
            requireWorkerId(item, "idempotencyKey");
            if (!expectedDeviceId.equals(deviceId) || !"pc_to_phone".equals(direction)) {
                throw new IllegalArgumentException("cloud poll envelope authority conflict");
            }
            Object byteCountValue = item.opt("byteCount");
            Object createdAtValue = item.opt("createdAt");
            Object expiresAtValue = item.opt("expiresAt");
            if (!isSafeInteger(byteCountValue) || !isSafeInteger(createdAtValue)
                || !isSafeInteger(expiresAtValue)) {
                throw new IllegalArgumentException("cloud poll envelope integer conflict");
            }
            long byteCount = ((Number) byteCountValue).longValue();
            long createdAt = ((Number) createdAtValue).longValue();
            long expiresAt = ((Number) expiresAtValue).longValue();
            if (byteCount < 1L || byteCount > 512L * 1024L
                || createdAt <= 0L || expiresAt <= createdAt) {
                throw new IllegalArgumentException("cloud poll envelope time conflict");
            }
            if (base64DecodedLength(nonce) != 12
                || base64DecodedLength(item.getString("ciphertext")) != byteCount) {
                throw new IllegalArgumentException("cloud poll envelope bytes conflict");
            }
            JSONObject prior = unique.get(messageId);
            if (prior == null) {
                unique.put(messageId, item);
            } else if (!BridgeAuthority.canonicalJson(prior)
                .equals(BridgeAuthority.canonicalJson(item))) {
                throw new IllegalArgumentException("cloud poll duplicate relay conflict");
            }
        }
        JSONArray normalized = new JSONArray();
        for (JSONObject item : unique.values()) normalized.put(item);
        return normalized;
    }

    private static String requireWorkerId(JSONObject value, String key) {
        Object raw = value == null ? null : value.opt(key);
        if (!(raw instanceof String)
            || !((String) raw).matches("[A-Za-z0-9_-]{6,128}")) {
            throw new IllegalArgumentException("cloud poll envelope identity conflict");
        }
        return (String) raw;
    }

    private static int base64DecodedLength(String value) {
        if (value == null || value.isEmpty() || (value.length() % 4) != 0
            || !value.matches("[A-Za-z0-9+/]*={0,2}")
            || (value.indexOf('=') >= 0 && value.indexOf('=') < value.length() - 2
                && value.charAt(value.length() - 2) != '=')) {
            return -1;
        }
        int padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
        return (value.length() / 4) * 3 - padding;
    }

    private static boolean isSafeInteger(Object value) {
        if (!(value instanceof Number) || value instanceof Float || value instanceof Double) return false;
        long integer = ((Number) value).longValue();
        return integer >= 0L && integer <= 9007199254740991L
            && !(value instanceof java.math.BigDecimal
                && ((java.math.BigDecimal) value).scale() > 0);
    }

    int processCloudInboxBatch(JSONArray messages, CloudInboxDecoder decoder) throws Exception {
        int processed = 0;
        if (messages == null || decoder == null) return processed;
        for (int index = 0; index < messages.length(); index += 1) {
            JSONObject item = messages.optJSONObject(index);
            if (item == null) continue;
            JSONObject decoded;
            try { decoded = decoder.decode(item); }
            catch (Exception ignored) { continue; }
            try {
                if (processDecodedCloudInboxItem(item, decoded)) processed += 1;
            } catch (RuntimeException error) {
                if (!isCanonicalInboxRejection(error)) throw error;
                inboxConsumer.recordRejected(
                    item.optString("messageId", ""), canonicalRejectionReason(error), clock.now());
                // A bad authority item remains unacknowledged, but must not starve later valid relays.
            }
        }
        return processed;
    }

    boolean processDecodedCloudInboxItem(JSONObject item, JSONObject decoded) throws Exception {
        String relayMessageId = item == null ? "" : item.optString("messageId", "").trim();
        if (relayMessageId.isEmpty() || decoded == null) return false;
        rejectPredeclaredTransportMetadata(decoded);
        if (isYuqiBackupReceiptCandidate(decoded)) {
            // The synchronous verified-backup waiter owns this response.  The
            // ordinary inbox drain must leave it queued and unacknowledged.
            return false;
        }
        if (isLifecycleControlCandidate(decoded)) {
            Object rawExpiry = item.opt("expiresAt");
            Long relayExpiresAt = null;
            if (rawExpiry != null && !JSONObject.NULL.equals(rawExpiry)) {
                if (!(rawExpiry instanceof Number)
                    || rawExpiry instanceof Float || rawExpiry instanceof Double) {
                    throw new IllegalArgumentException("lifecycle applied relay expiry conflict");
                }
                relayExpiresAt = ((Number) rawExpiry).longValue();
            }
            if (inboxConsumer == null
                || !inboxConsumer.applyLifecycleControl(
                    decoded.toString(), relayMessageId, relayExpiresAt, clock.now())) {
                return false;
            }
            acknowledgeCloud(relayMessageId);
            return true;
        }
        int protocolVersion = declaredProtocolVersion(decoded);
        if (protocolVersion == 0 && hasCanonicalAuthorityMarker(decoded)) {
            throw new IllegalArgumentException("canonical bridge protocol marker conflict");
        }
        decoded.put("_relayMessageId", relayMessageId);
        decoded.put("_deliveryRoute", "cloud");
        if (protocolVersion == 3) {
            if (inboxConsumer == null || !inboxConsumer.persist(decoded.toString())) return false;
            acknowledgeCloud(relayMessageId);
            return true;
        }
        String disposition = classifyCloudResult(null, decoded);
        if ("BACKLOG_COMMITTED".equals(disposition)) {
            return processBacklogCommitted(decoded, decoded.toString());
        }
        if ("BACKLOG_FAILED".equals(disposition)) {
            if (!persistBacklogFailure(inboxConsumer, decoded.toString())) return false;
            acknowledgeCloud(relayMessageId);
            return true;
        }
        acknowledgeCloud(relayMessageId);
        return true;
    }

    private static int declaredProtocolVersion(JSONObject value) {
        if (!value.has("protocolVersion")) return 0;
        Object raw = value.opt("protocolVersion");
        if (!(raw instanceof Number) || raw instanceof Float || raw instanceof Double) {
            throw new IllegalArgumentException("bridge protocol version conflict");
        }
        long version = ((Number) raw).longValue();
        if (version < 1L || version > 3L) {
            throw new IllegalArgumentException("bridge protocol version conflict");
        }
        return (int) version;
    }

    private static void rejectPredeclaredTransportMetadata(JSONObject value) {
        if (value.has("_relayMessageId") || value.has("_deliveryRoute")) {
            throw new IllegalArgumentException("canonical bridge transport metadata conflict");
        }
    }

    private static boolean hasCanonicalAuthorityMarker(JSONObject value) {
        String[] markers = new String[] {
            "authorityOrigin", "authorityLineageKey", "visibleGroupId", "lineageRevision",
            "turnRevision", "laneRevision", "inputVisibilitySequence", "inputClearEpoch",
            "commitPayloadVersion", "commitChecksum", "rawStatusChecksum", "retryAllowed"
        };
        for (String marker : markers) if (value.has(marker)) return true;
        return false;
    }

    private static boolean isYuqiBackupReceiptCandidate(JSONObject value) {
        if (value == null) return false;
        return "YUQI_BACKUP_RECEIPT".equals(value.opt("type"))
            || value.has("requestChecksum")
            || value.has("receipt") && value.has("requestedAt");
    }

    private static boolean isLifecycleControlCandidate(JSONObject value) {
        if (value == null) return false;
        if ("CONVERSATION_CLEAR_APPLIED".equals(value.opt("type"))
            || "ROLE_DELETE_APPLIED".equals(value.opt("type"))) return true;
        for (String marker : new String[] {
            "controlId", "controlChecksum", "clearEpoch", "clearedThroughSequence",
            "backupReceiptId", "appliedAt"
        }) {
            if (value.has(marker)) return true;
        }
        return false;
    }

    static boolean isCanonicalInboxRejection(Throwable error) {
        if (error == null) return false;
        if (error instanceof BridgeTurnStatus.CanonicalPayloadRejectedException) return true;
        String message = error.getMessage() == null ? "" : error.getMessage();
        if ("BRIDGE_AUTHORITY_CONFLICT".equals(message)
            && (error instanceof IllegalStateException || error instanceof IllegalArgumentException)) return true;
        if ("LIFECYCLE_APPLIED_ACK_CONFLICT".equals(message)
            && error instanceof IllegalArgumentException) return true;
        if (LifecycleControlSender.isAppliedAckConflict(error)) return true;
        if (!(error instanceof IllegalArgumentException)) return false;
        return "bridge protocol version conflict".equals(message)
            || "canonical bridge protocol marker conflict".equals(message)
            || "canonical bridge transport metadata conflict".equals(message);
    }

    static String canonicalRejectionReason(Throwable error) {
        String message = error == null || error.getMessage() == null ? "" : error.getMessage();
        if ("bridge protocol version conflict".equals(message)
            || "canonical bridge protocol marker conflict".equals(message)
            || "canonical bridge transport metadata conflict".equals(message)) {
            return "protocol_conflict";
        }
        if (LifecycleControlSender.isAppliedAckConflict(error)
            || "LIFECYCLE_APPLIED_ACK_CONFLICT".equals(message)) {
            return "lifecycle_ack_conflict";
        }
        if (error instanceof BridgeTurnStatus.CanonicalPayloadRejectedException) {
            return "parse_conflict";
        }
        return "apply_conflict";
    }

    static boolean persistBacklogFailure(CloudInboxConsumer consumer, String raw) throws Exception {
        return consumer != null && consumer.persist(raw);
    }

    public boolean confirmCloudResult(String responseJson) throws Exception {
        JSONObject decoded = new JSONObject(responseJson == null ? "{}" : responseJson);
        String relayMessageId = decoded.optString("_relayMessageId", "").trim();
        if (relayMessageId.isEmpty()) return false;
        publishDeliveryReceipt(decoded);
        acknowledgeCloud(relayMessageId);
        return true;
    }

    public boolean confirmAppliedResult(String responseJson) throws Exception {
        JSONObject decoded = new JSONObject(responseJson == null ? "{}" : responseJson);
        if (decoded.has("_checkpointChecksum")
            || "AUTHORITY_DELIVERY_RECEIPT".equals(decoded.opt("type"))) {
            return confirmAuthorityAppliedResult(decoded);
        }
        String route = decoded.optString("_deliveryRoute", "").trim();
        if ("cloud".equals(route) || !decoded.optString("_relayMessageId", "").trim().isEmpty()) {
            return confirmCloudResult(decoded.toString());
        }
        if (!"lan".equals(route) || !config.hasLan()) return false;
        JSONObject receipt = itemizedDeliveryReceipt(decoded);
        String turnId = receipt.getString("turnId");
        String path = "/v2/turns/" + URLEncoder.encode(turnId, "UTF-8") + "/delivery-receipt";
        HttpResult response = signedLan("POST", path, receipt.toString());
        requireSuccess(response, "LAN delivery receipt");
        return true;
    }

    private boolean confirmAuthorityAppliedResult(JSONObject decoded) throws Exception {
        AuthorityReceiptProjection projection = validateAuthorityReceiptProjection(decoded);
        String prior = authorityReceiptPins.putIfAbsent(
            projection.checkpointChecksum, projection.pin);
        if (prior != null && !prior.equals(projection.pin)) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT");
        }
        if ("lan".equals(projection.route)) {
            if (!config.hasLan()) return false;
            String path = "/v3/groups/"
                + URLEncoder.encode(projection.visibleGroupId, "UTF-8")
                + "/delivery-receipt";
            HttpResult response = signedLan("POST", path, projection.wireJson);
            requireSuccess(response, "LAN authority delivery receipt");
            return true;
        }

        Encrypted encrypted = encrypt(projection.wireJson);
        String stableId = "authority_receipt_" + projection.idempotencyKey.substring(0, 24);
        JSONObject output = new JSONObject()
            .put("deviceId", config.deviceId)
            .put("messageId", stableId)
            .put("idempotencyKey", stableId)
            .put("direction", "phone_to_pc")
            .put("ciphertext", encrypted.ciphertext)
            .put("nonce", encrypted.nonce)
            .put("expiresAt", clock.now() + 24L * 60L * 60L * 1000L);
        HttpResult response = request(
            "POST", config.cloudUrl + "/bridge/enqueue", output.toString(), bearerHeaders());
        requireSuccess(response, "authority delivery receipt enqueue");
        acknowledgeCloud(projection.relayMessageId);
        return true;
    }

    private AuthorityReceiptProjection validateAuthorityReceiptProjection(JSONObject decoded)
        throws Exception {
        String route = requireNativeNonEmptyString(decoded, "_deliveryRoute");
        boolean cloud = "cloud".equals(route);
        if (!(cloud || "lan".equals(route))
            || !(cloud ? CLOUD_AUTHORITY_RECEIPT_KEYS : AUTHORITY_RECEIPT_KEYS)
                .equals(keysOf(decoded))) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT");
        }
        Object version = decoded.opt("protocolVersion");
        Object type = decoded.opt("type");
        Object delivered = decoded.opt("deliveredAt");
        if (!(version instanceof Number) || version instanceof Float || version instanceof Double
            || ((Number) version).longValue() != 3L
            || !(type instanceof String)
            || !"AUTHORITY_DELIVERY_RECEIPT".equals(type)
            || !(delivered instanceof Number) || delivered instanceof Float || delivered instanceof Double) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT");
        }
        long deliveredAt = ((Number) delivered).longValue();
        if (deliveredAt <= 0L || deliveredAt > 9007199254740991L) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT");
        }
        String peerId = requireNativeNonEmptyString(decoded, "peerId");
        String turnId = requireNativeNonEmptyString(decoded, "turnId");
        String lineageKey = requireNativeNonEmptyString(decoded, "authorityLineageKey");
        String groupId = requireNativeNonEmptyString(decoded, "visibleGroupId");
        String commitChecksum = requireNativeNonEmptyString(decoded, "commitChecksum");
        String disposition = requireNativeNonEmptyString(decoded, "terminalDisposition");
        String checkpointChecksum = requireNativeNonEmptyString(decoded, "_checkpointChecksum");
        String relayMessageId = cloud
            ? requireNativeNonEmptyString(decoded, "_relayMessageId") : null;
        if (!config.deviceId.equals(peerId)
            || !AuthorityIdentity.groupId(lineageKey).equals(groupId)
            || !commitChecksum.matches("[a-f0-9]{64}")
            || !checkpointChecksum.matches("[a-f0-9]{64}")
            || !("visible".equals(disposition)
                || "action_only".equals(disposition) || "skip".equals(disposition))) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT");
        }
        JSONObject wire = new JSONObject()
            .put("protocolVersion", 3)
            .put("type", "AUTHORITY_DELIVERY_RECEIPT")
            .put("peerId", peerId)
            .put("turnId", turnId)
            .put("authorityLineageKey", lineageKey)
            .put("visibleGroupId", groupId)
            .put("commitChecksum", commitChecksum)
            .put("terminalDisposition", disposition)
            .put("deliveredAt", deliveredAt);
        String wireJson = BridgeAuthority.canonicalJson(wire);
        String idempotencyKey = sha256(wireJson);
        String pin = route + "\n" + (relayMessageId == null ? "" : relayMessageId)
            + "\n" + idempotencyKey;
        return new AuthorityReceiptProjection(
            groupId, checkpointChecksum, route, relayMessageId, wireJson, idempotencyKey, pin);
    }

    private boolean processBacklogCommitted(JSONObject decoded, String raw) throws Exception {
        if (inboxConsumer == null || !inboxConsumer.persist(raw)) return false;
        publishDeliveryReceipt(decoded);
        acknowledgeCloud(decoded.optString("_relayMessageId"));
        return true;
    }

    private void publishDeliveryReceipt(JSONObject decoded) throws Exception {
        JSONObject receipt;
        if (decoded.optJSONArray("deliveryItems") == null) {
            JSONObject reply = decoded.optJSONObject("reply");
            if (reply == null) throw new IllegalStateException("cloud reply is missing");
            String turnId = decoded.optString("turnId", "").trim();
            String messageId = reply.optString("messageId", "").trim();
            String content = reply.optString("content", "");
            if (turnId.isEmpty() || messageId.isEmpty() || content.trim().isEmpty()) {
                throw new IllegalStateException("cloud reply identity is incomplete");
            }
            receipt = new JSONObject()
                .put("type", "DELIVERY_RECEIPT")
                .put("peerId", config.deviceId)
                .put("turnId", turnId)
                .put("messageId", messageId)
                .put("contentSha256", sha256(content))
                .put("receivedAt", clock.now());
        } else {
            receipt = itemizedDeliveryReceipt(decoded);
            receipt.put("type", "DELIVERY_RECEIPT").put("peerId", config.deviceId);
        }
        String turnId = receipt.getString("turnId");
        Encrypted encrypted = encrypt(receipt.toString());
        String identity = turnId + ":" + (
            receipt.optJSONArray("items") == null
                ? receipt.optString("messageId", "")
                : sha256(receipt.getJSONArray("items").toString())
        );
        JSONObject output = new JSONObject()
            .put("deviceId", config.deviceId)
            .put("messageId", "receipt_" + sha256(identity).substring(0, 24))
            .put("idempotencyKey", "receipt_" + sha256(identity).substring(0, 24))
            .put("direction", "phone_to_pc")
            .put("ciphertext", encrypted.ciphertext)
            .put("nonce", encrypted.nonce)
            .put("expiresAt", clock.now() + 24L * 60L * 60L * 1000L);
        HttpResult response = request(
            "POST", config.cloudUrl + "/bridge/enqueue", output.toString(), bearerHeaders()
        );
        requireSuccess(response, "delivery receipt enqueue");
    }

    private JSONObject itemizedDeliveryReceipt(JSONObject decoded) throws Exception {
        String turnId = decoded.optString("turnId", "").trim();
        JSONArray items = decoded.optJSONArray("deliveryItems");
        if (turnId.isEmpty() || items == null || items.length() == 0) {
            throw new IllegalStateException("delivery receipt identity is incomplete");
        }
        return new JSONObject()
            .put("protocolVersion", 1)
            .put("turnId", turnId)
            .put("deliveredAt", clock.now())
            .put("items", items);
    }

    private static String requireNativeNonEmptyString(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof String) || ((String) raw).isEmpty()) {
            throw new IllegalArgumentException("BRIDGE_AUTHORITY_CONFLICT");
        }
        return (String) raw;
    }

    private static Set<String> keysOf(JSONObject value) {
        Set<String> keys = new HashSet<>();
        Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        return keys;
    }

    private static final class AuthorityReceiptProjection {
        final String visibleGroupId;
        final String checkpointChecksum;
        final String route;
        final String relayMessageId;
        final String wireJson;
        final String idempotencyKey;
        final String pin;

        AuthorityReceiptProjection(
            String visibleGroupId,
            String checkpointChecksum,
            String route,
            String relayMessageId,
            String wireJson,
            String idempotencyKey,
            String pin
        ) {
            this.visibleGroupId = visibleGroupId;
            this.checkpointChecksum = checkpointChecksum;
            this.route = route;
            this.relayMessageId = relayMessageId;
            this.wireJson = wireJson;
            this.idempotencyKey = idempotencyKey;
            this.pin = pin;
        }
    }

    public static String signLanRequest(
        String secret, String method, String path, long timestamp, String nonce, String body
    ) throws Exception {
        String canonical = timestamp + "\n" + nonce + "\n" + method.toUpperCase() + "\n" + path + "\n" + sha256(body);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return hex(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
    }

    private JSONObject wireEnvelope(TurnSubmission submission) throws Exception {
        JSONObject envelope = BridgeInput.envelope(submission, config);
        if (journal != null) envelope.put("recovery", journal.pendingPacket(1000));
        return envelope;
    }

    private HttpResult signedLan(String method, String path, String body) throws Exception {
        long timestamp = clock.now();
        String nonce = UUID.randomUUID().toString().replace("-", "");
        return request(method, config.lanUrl + path, body, new String[][] {
            {"X-Yuqi-Timestamp", Long.toString(timestamp)},
            {"X-Yuqi-Nonce", nonce},
            {"X-Yuqi-Signature", signLanRequest(config.pairingSecret, method, path, timestamp, nonce, body)}
        });
    }

    private long deadline(TurnSubmission submission) {
        long createdAt = Math.max(1L, submission.createdAt);
        long result = createdAt + (long) config.turnDeadlineMs;
        return result < createdAt ? Long.MAX_VALUE : result;
    }

    private void sleepForPoll(String turnId, long deadline, long requestedMs) throws Exception {
        long remaining = deadline - clock.now();
        if (remaining <= 0L) throw new BridgeDeadlineException(turnId);
        sleeper.sleep(Math.min(remaining, Math.max(1L, requestedMs)));
    }

    private void acknowledgeRecovery(BridgeTurnStatus status) {
        if (journal != null) journal.acknowledge(status.recoveryAckSeq);
    }

    private void acknowledgeRecovery(String raw) {
        if (journal == null) return;
        try {
            JSONObject value = new JSONObject(raw);
            Object field = value.opt("recoveryAckSeq");
            if (!(field instanceof Number) || field instanceof Float || field instanceof Double) {
                if (field == null) return;
                throw new IllegalArgumentException("v3 bridge recovery cursor conflict");
            }
            long sequence = ((Number) field).longValue();
            if (sequence < 0L || sequence > 9007199254740991L) {
                throw new IllegalArgumentException("v3 bridge recovery cursor conflict");
            }
            journal.acknowledge(sequence);
        } catch (RuntimeException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("v3 bridge recovery cursor conflict", error);
        }
    }

    private void reportStatus(String localTurnId, BridgeTurnStatus status) {
        if (statusListener == null || status == null) return;
        try {
            statusListener.onStatus(localTurnId, status.raw);
        } catch (Exception ignored) {
            // Progress reporting is observational and must never break reply delivery.
        }
    }

    private void reportRawStatus(String localTurnId, String raw) {
        if (statusListener == null) return;
        try {
            statusListener.onStatus(localTurnId, raw);
        } catch (Exception ignored) {
            // Progress reporting is observational and must never break reply delivery.
        }
    }

    private static boolean isTerminalResponse(String raw) {
        try {
            JSONObject value = new JSONObject(raw == null ? "{}" : raw);
            return value.opt("terminal") instanceof Boolean && value.getBoolean("terminal");
        } catch (Exception error) {
            throw new IllegalArgumentException("v3 bridge result JSON conflict", error);
        }
    }

    private static void requireSuccess(HttpResult response, String operation) throws Exception {
        if (response.status < 200 || response.status >= 300) {
            if (response.status == 408 || response.status == 425 || response.status == 429 || response.status >= 500) {
                throw new BridgePendingException(operation + " HTTP " + response.status);
            }
            throw new BridgeFinalException(operation.toUpperCase().replace(' ', '_') + "_HTTP_" + response.status, true);
        }
    }

    private HttpResult request(String method, String target, String body, String[][] headers) throws Exception {
        try {
            return transport.request(method, target, body, headers);
        } catch (BridgePendingException | BridgeFinalException | BridgeDeadlineException error) {
            throw error;
        } catch (SocketTimeoutException | UnknownHostException | SocketException error) {
            throw new BridgePendingException("bridge network is temporarily unavailable", error);
        } catch (java.io.IOException error) {
            throw new BridgePendingException("bridge transport failed", error);
        }
    }

    private void acknowledgeCloud(String messageId) throws Exception {
        if (messageId.isEmpty()) return;
        JSONObject ack = new JSONObject().put("deviceId", config.deviceId)
            .put("messageIds", new JSONArray().put(messageId));
        HttpResult response = request(
            "POST", config.cloudUrl + "/bridge/ack", ack.toString(), bearerHeaders()
        );
        requireSuccess(response, "cloud ack");
    }

    private String[][] bearerHeaders() {
        return new String[][] {{"Authorization", "Bearer " + config.deviceToken}};
    }

    private Encrypted encrypt(String plaintext) throws Exception {
        byte[] key = base64Codec.decode(config.encryptionKeyBase64);
        if (key.length != 32) throw new IllegalArgumentException("cloud encryption key must be 256-bit");
        byte[] nonce = new byte[12];
        RANDOM.nextBytes(nonce);
        return encryptWithNonce(plaintext, key, nonce);
    }

    private Encrypted encryptLifecycle(String plaintext, String relayMessageId) throws Exception {
        byte[] key = base64Codec.decode(config.encryptionKeyBase64);
        if (key.length != 32 || relayMessageId == null || relayMessageId.trim().isEmpty()) {
            throw new IllegalArgumentException("cloud lifecycle encryption identity conflict");
        }
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        byte[] fullNonce = mac.doFinal(("android-lifecycle-gcm-nonce-v1\n" + relayMessageId)
            .getBytes(StandardCharsets.UTF_8));
        byte[] nonce = java.util.Arrays.copyOf(fullNonce, 12);
        return encryptWithNonce(plaintext, key, nonce);
    }

    private Encrypted encryptWithNonce(String plaintext, byte[] key, byte[] nonce) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        return new Encrypted(
            base64Codec.encode(ciphertext),
            base64Codec.encode(nonce)
        );
    }

    private String decrypt(String ciphertextBase64, String nonceBase64) throws Exception {
        byte[] key = base64Codec.decode(config.encryptionKeyBase64);
        byte[] ciphertext = base64Codec.decode(ciphertextBase64);
        byte[] nonce = base64Codec.decode(nonceBase64);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    private HttpResult http(String method, String target, String body, String[][] headers) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(target).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(config.connectTimeoutMs);
        connection.setReadTimeout(config.readTimeoutMs);
        connection.setRequestProperty("Accept", "application/json");
        for (String[] header : headers) connection.setRequestProperty(header[0], header[1]);
        if (!body.isEmpty()) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        StringBuilder response = new StringBuilder();
        if (stream != null) {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                for (String line; (line = reader.readLine()) != null;) response.append(line);
            }
        }
        connection.disconnect();
        return new HttpResult(status, response.toString());
    }

    private static String sha256(String value) throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }

    private static String hex(byte[] bytes) {
        StringBuilder output = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) output.append(String.format("%02x", value & 0xff));
        return output.toString();
    }

    private static final class Encrypted {
        final String ciphertext;
        final String nonce;
        Encrypted(String ciphertext, String nonce) { this.ciphertext = ciphertext; this.nonce = nonce; }
    }
}
