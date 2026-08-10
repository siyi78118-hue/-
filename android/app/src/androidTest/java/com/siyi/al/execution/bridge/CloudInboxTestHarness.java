package com.siyi.al.execution;

import android.content.Context;
import android.util.Base64;
import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import com.siyi.al.execution.bridge.BridgeClient;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgeMode;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Test-only transport harness. It enters through ExecutionRuntime's real cloud
 * drain, with only HTTP transport injected; no Room rows or private bridge
 * state transition is replaced.
 */
public final class CloudInboxTestHarness {
    private static final String TEST_KEY_BASE64 = Base64.encodeToString(
        new byte[32], Base64.NO_WRAP);

    private CloudInboxTestHarness() {}

    public static BridgeConfig cloudConfig(String deviceId) {
        return new BridgeConfig(
            true, BridgeMode.CLOUD, "", "https://cloud.test", deviceId,
            "", "device-token-connected-race-123", TEST_KEY_BASE64,
            1_200, 2_000, 1, 100
        );
    }

    public static final class Envelope {
        public final JSONObject json;
        public final String messageId;
        private Envelope(JSONObject json, String messageId) {
            this.json = json;
            this.messageId = messageId;
        }
    }

    public static Envelope encryptEnvelope(
        BridgeConfig config, String messageId, JSONObject plaintext
    ) throws Exception {
        if (config == null || plaintext == null) throw new IllegalArgumentException("envelope input required");
        byte[] key = Base64.decode(config.encryptionKeyBase64, Base64.DEFAULT);
        byte[] nonce = java.util.Arrays.copyOf(
            MessageDigest.getInstance("SHA-256")
                .digest(("cloud-test-nonce-v1:" + messageId).getBytes(StandardCharsets.UTF_8)),
            12);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"),
            new GCMParameterSpec(128, nonce));
        byte[] ciphertext = cipher.doFinal(plaintext.toString().getBytes(StandardCharsets.UTF_8));
        long createdAt = Math.max(1L, System.currentTimeMillis());
        JSONObject wrapper = new JSONObject()
            .put("messageId", messageId)
            .put("deviceId", config.deviceId)
            .put("direction", "pc_to_phone")
            .put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .put("nonce", Base64.encodeToString(nonce, Base64.NO_WRAP))
            .put("idempotencyKey", "cloud-idem-" + messageId)
            .put("byteCount", ciphertext.length)
            .put("createdAt", createdAt)
            .put("expiresAt", createdAt + TimeUnit.DAYS.toMillis(1));
        return new Envelope(wrapper, messageId);
    }

    public static int drainOnce(
        Context context,
        ScriptedCloudTransport transport,
        AtomicInteger persistCalls
    ) throws Exception {
        if (context == null) throw new IllegalArgumentException("context required");
        if (transport == null) throw new IllegalArgumentException("transport required");
        return ExecutionRuntime.drainCloudInboxForTesting(context, transport, persistCalls);
    }

    public static final class ScriptedCloudTransport implements BridgeClient.Transport {
        private final BridgeConfig config;
        private final List<JSONArray> pollBatches = new ArrayList<>();
        private int nextBatch;
        private int ackAttempts;
        private int successfulAcks;
        private final List<JSONObject> ackBodies = new ArrayList<>();
        private boolean failNextAck;

        public ScriptedCloudTransport(BridgeConfig config) {
            this.config = config;
        }

        public ScriptedCloudTransport pollBatch(JSONObject... envelopes) {
            JSONArray batch = new JSONArray();
            if (envelopes != null) {
                for (JSONObject envelope : envelopes) batch.put(envelope);
            }
            pollBatches.add(batch);
            return this;
        }

        public ScriptedCloudTransport failNextAck() {
            failNextAck = true;
            return this;
        }

        public int ackAttempts() { return ackAttempts; }
        public int successfulAcks() { return successfulAcks; }

        public List<JSONObject> ackBodies() {
            return new ArrayList<>(ackBodies);
        }

        @Override public BridgeClient.HttpResult request(
            String method, String target, String body, String[][] headers
        ) throws Exception {
            if ("GET".equals(method) && isExactPollTarget(target)) {
                JSONArray batch = nextBatch < pollBatches.size()
                    ? pollBatches.get(nextBatch++) : new JSONArray();
                return new BridgeClient.HttpResult(200,
                    new JSONObject().put("messages", batch).toString());
            }
            if ("POST".equals(method) && isExactAckTarget(target)) {
                ackAttempts += 1;
                if (body == null) throw new IllegalArgumentException("ack body required");
                ackBodies.add(new JSONObject(body));
                if (failNextAck) {
                    failNextAck = false;
                    throw new IOException("cloud ACK deliberately dropped");
                }
                successfulAcks += 1;
                return new BridgeClient.HttpResult(200, "{}");
            }
            throw new IllegalArgumentException("unexpected cloud transport target: " + target);
        }

        private boolean isExactPollTarget(String target) throws Exception {
            URI actual = new URI(target);
            URI expected = new URI(config.cloudUrl);
            if (!sameAuthority(actual, expected) || !"/bridge/poll".equals(actual.getPath())
                || actual.getRawQuery() == null) return false;
            String[] fields = actual.getRawQuery().split("&", -1);
            if (fields.length != 3) return false;
            Map<String, String> query = new HashMap<>();
            for (String field : fields) {
                String[] pair = field.split("=", -1);
                if (pair.length != 2 || query.put(
                    URLDecoder.decode(pair[0], "UTF-8"),
                    URLDecoder.decode(pair[1], "UTF-8")) != null) return false;
            }
            Map<String, String> expectedQuery = new HashMap<>();
            expectedQuery.put("deviceId", config.deviceId);
            expectedQuery.put("direction", "pc_to_phone");
            expectedQuery.put("limit", "50");
            return expectedQuery.equals(query);
        }

        private boolean isExactAckTarget(String target) throws Exception {
            URI actual = new URI(target);
            URI expected = new URI(config.cloudUrl);
            return sameAuthority(actual, expected)
                && "/bridge/ack".equals(actual.getPath())
                && actual.getRawQuery() == null;
        }

        private static boolean sameAuthority(URI actual, URI expected) {
            return expected.getScheme().equals(actual.getScheme())
                && expected.getHost().equals(actual.getHost())
                && expected.getPort() == actual.getPort();
        }
    }
}
