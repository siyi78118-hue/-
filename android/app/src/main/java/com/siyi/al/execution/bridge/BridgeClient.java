package com.siyi.al.execution.bridge;

import android.util.Base64;
import com.siyi.al.execution.TurnSubmission;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

public final class BridgeClient {
    private static final SecureRandom RANDOM = new SecureRandom();
    private final BridgeConfig config;
    private final FallbackJournal journal;

    public BridgeClient(BridgeConfig config) {
        this(config, null);
    }

    public BridgeClient(BridgeConfig config, FallbackJournal journal) {
        this.config = config == null ? BridgeConfig.disabled() : config;
        this.journal = journal;
    }

    public BridgeRouter.RouteClient lanRoute() { return this::sendLan; }
    public BridgeRouter.RouteClient cloudRoute() { return this::sendCloud; }

    public BridgeResult sendLan(TurnSubmission submission) throws Exception {
        if (!config.hasLan()) throw new IllegalStateException("LAN bridge is not configured");
        String path = "/v1/turns";
        String body = wireEnvelope(submission).toString();
        long timestamp = System.currentTimeMillis();
        String nonce = UUID.randomUUID().toString().replace("-", "");
        HttpResult response = http("POST", config.lanUrl + path, body, new String[][] {
            {"X-Yuqi-Timestamp", Long.toString(timestamp)},
            {"X-Yuqi-Nonce", nonce},
            {"X-Yuqi-Signature", signLanRequest(config.pairingSecret, "POST", path, timestamp, nonce, body)}
        });
        if (response.status < 200 || response.status >= 300) throw new IllegalStateException("LAN bridge HTTP " + response.status);
        return parseRuntimeReply("lan", response.body);
    }

    public BridgeResult sendCloud(TurnSubmission submission) throws Exception {
        if (!config.hasCloud()) throw new IllegalStateException("cloud bridge is not configured");
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
            .put("expiresAt", System.currentTimeMillis() + 24L * 60L * 60L * 1000L);
        HttpResult enqueued = http("POST", config.cloudUrl + "/bridge/enqueue", enqueue.toString(), bearerHeaders());
        if (enqueued.status < 200 || enqueued.status >= 300) throw new IllegalStateException("cloud enqueue HTTP " + enqueued.status);

        String encodedDevice = URLEncoder.encode(config.deviceId, "UTF-8");
        for (int attempt = 0; attempt < config.cloudPollAttempts; attempt += 1) {
            HttpResult polled = http("GET", config.cloudUrl + "/bridge/poll?deviceId=" + encodedDevice + "&direction=pc_to_phone&limit=50", "", bearerHeaders());
            if (polled.status >= 200 && polled.status < 300) {
                JSONArray messages = new JSONObject(polled.body).optJSONArray("messages");
                if (messages != null) {
                    for (int index = 0; index < messages.length(); index += 1) {
                        JSONObject item = messages.optJSONObject(index);
                        if (item == null) continue;
                        String plaintext;
                        try { plaintext = decrypt(item.optString("ciphertext"), item.optString("nonce")); }
                        catch (Exception ignored) { continue; }
                        JSONObject decoded = new JSONObject(plaintext);
                        if (!submission.turnId.equals(decoded.optString("turnId"))) {
                            acknowledgeCloud(item.optString("messageId"));
                            continue;
                        }
                        acknowledgeCloud(item.optString("messageId"));
                        return parseRuntimeReply("cloud", plaintext);
                    }
                }
            }
            if (attempt + 1 < config.cloudPollAttempts) Thread.sleep(config.cloudPollIntervalMs);
        }
        throw new IllegalStateException("cloud bridge reply timed out");
    }

    public static String signLanRequest(String secret, String method, String path, long timestamp, String nonce, String body) throws Exception {
        String canonical = timestamp + "\n" + nonce + "\n" + method.toUpperCase() + "\n" + path + "\n" + sha256(body);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return hex(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
    }

    private JSONObject wireEnvelope(TurnSubmission submission) throws Exception {
        JSONObject input = new JSONObject(submission.inputJson);
        JSONObject source = input.optJSONObject("message");
        JSONObject message = source == null ? new JSONObject() : new JSONObject(source.toString());
        if (!message.has("messageId")) message.put("messageId", submission.sourceMessageId);
        message.put("speakerId", "user");
        message.put("speakerType", "user");
        message.put("recipientId", submission.characterId);
        if (!message.has("content")) message.put("content", input.optString("text", ""));
        if (!message.has("sentAt")) message.put("sentAt", submission.createdAt);
        JSONObject envelope = new JSONObject()
            .put("protocolVersion", 1)
            .put("turnId", submission.turnId)
            .put("characterId", submission.characterId)
            .put("deviceId", config.deviceId)
            .put("deviceSeq", input.optLong("deviceSeq", Math.max(1L, submission.createdAt)))
            .put("createdAt", Math.max(1L, submission.createdAt))
            .put("message", message);
        if (journal != null) envelope.put("recovery", journal.pendingPacket(1000));
        return envelope;
    }

    private BridgeResult parseRuntimeReply(String origin, String raw) throws Exception {
        JSONObject root = new JSONObject(raw);
        if (journal != null) journal.acknowledge(root.optLong("recoveryAckSeq", 0L));
        JSONObject reply = root.optJSONObject("reply");
        if (reply == null && root.optJSONObject("result") != null) reply = root.optJSONObject("result").optJSONObject("reply");
        String content = reply == null ? root.optString("replyText", "") : reply.optString("content", "");
        if (content.trim().isEmpty()) throw new IllegalStateException("runtime reply content is empty");
        return BridgeResult.success(origin, content, raw);
    }

    private void acknowledgeCloud(String messageId) throws Exception {
        if (messageId.isEmpty()) return;
        JSONObject ack = new JSONObject().put("deviceId", config.deviceId).put("messageIds", new JSONArray().put(messageId));
        HttpResult response = http("POST", config.cloudUrl + "/bridge/ack", ack.toString(), bearerHeaders());
        if (response.status < 200 || response.status >= 300) throw new IllegalStateException("cloud ack HTTP " + response.status);
    }

    private String[][] bearerHeaders() {
        return new String[][] {{"Authorization", "Bearer " + config.deviceToken}};
    }

    private Encrypted encrypt(String plaintext) throws Exception {
        byte[] key = Base64.decode(config.encryptionKeyBase64, Base64.DEFAULT);
        if (key.length != 32) throw new IllegalArgumentException("cloud encryption key must be 256-bit");
        byte[] nonce = new byte[12];
        RANDOM.nextBytes(nonce);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        return new Encrypted(Base64.encodeToString(ciphertext, Base64.NO_WRAP), Base64.encodeToString(nonce, Base64.NO_WRAP));
    }

    private String decrypt(String ciphertextBase64, String nonceBase64) throws Exception {
        byte[] key = Base64.decode(config.encryptionKeyBase64, Base64.DEFAULT);
        byte[] ciphertext = Base64.decode(ciphertextBase64, Base64.DEFAULT);
        byte[] nonce = Base64.decode(nonceBase64, Base64.DEFAULT);
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

    private static final class HttpResult {
        final int status;
        final String body;
        HttpResult(int status, String body) { this.status = status; this.body = body; }
    }
}
