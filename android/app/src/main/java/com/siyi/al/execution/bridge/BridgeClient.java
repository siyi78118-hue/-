package com.siyi.al.execution.bridge;

import android.util.Base64;
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
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

public final class BridgeClient {
    interface Transport {
        HttpResult request(String method, String target, String body, String[][] headers) throws Exception;
    }

    interface Clock { long now(); }
    interface Sleeper { void sleep(long millis) throws Exception; }

    static final class HttpResult {
        final int status;
        final String body;
        HttpResult(int status, String body) { this.status = status; this.body = body; }
    }

    private static final SecureRandom RANDOM = new SecureRandom();
    private final BridgeConfig config;
    private final FallbackJournal journal;
    private final Transport transport;
    private final Clock clock;
    private final Sleeper sleeper;

    public BridgeClient(BridgeConfig config) {
        this(config, null);
    }

    public BridgeClient(BridgeConfig config, FallbackJournal journal) {
        this(config, journal, null, System::currentTimeMillis, Thread::sleep);
    }

    BridgeClient(BridgeConfig config, FallbackJournal journal, Transport transport, Clock clock, Sleeper sleeper) {
        this.config = config == null ? BridgeConfig.disabled() : config;
        this.journal = journal;
        this.transport = transport == null ? this::http : transport;
        this.clock = clock == null ? System::currentTimeMillis : clock;
        this.sleeper = sleeper == null ? Thread::sleep : sleeper;
    }

    public BridgeRouter.RouteClient lanRoute() { return this::sendLan; }
    public BridgeRouter.RouteClient cloudRoute() { return this::sendCloud; }

    public BridgeResult sendLan(TurnSubmission submission) throws Exception {
        if (!config.hasLan()) throw new BridgeFinalException("LAN_BRIDGE_NOT_CONFIGURED", true);
        long deadline = deadline(submission);
        String path = "/v2/turns";
        String body = wireEnvelope(submission).toString();
        HttpResult response = signedLan("POST", path, body);
        requireSuccess(response, "LAN submit");
        BridgeTurnStatus status = BridgeTurnStatus.parse(response.body, submission.turnId);
        while (!status.terminal) {
            sleepForPoll(submission.turnId, deadline, status.retryAfterMs);
            path = "/v2/turns/" + URLEncoder.encode(submission.turnId, "UTF-8");
            response = signedLan("GET", path, "");
            requireSuccess(response, "LAN poll");
            status = BridgeTurnStatus.parse(response.body, submission.turnId);
        }
        acknowledgeRecovery(status);
        if (status.committed()) return status.toResult("lan");
        throw new BridgeFinalException(status.errorCode, status.allowFallback);
    }

    public BridgeResult sendCloud(TurnSubmission submission) throws Exception {
        if (!config.hasCloud()) throw new BridgeFinalException("CLOUD_BRIDGE_NOT_CONFIGURED", true);
        long deadline = deadline(submission);
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

        String encodedDevice = URLEncoder.encode(config.deviceId, "UTF-8");
        String pollTarget = config.cloudUrl + "/bridge/poll?deviceId=" + encodedDevice
            + "&direction=pc_to_phone&limit=50";
        while (clock.now() < deadline) {
            HttpResult polled = request("GET", pollTarget, "", bearerHeaders());
            requireSuccess(polled, "cloud poll");
            JSONArray messages = new JSONObject(polled.body).optJSONArray("messages");
            if (messages != null) {
                for (int index = 0; index < messages.length(); index += 1) {
                    JSONObject item = messages.optJSONObject(index);
                    if (item == null) continue;
                    String plaintext;
                    try { plaintext = decrypt(item.optString("ciphertext"), item.optString("nonce")); }
                    catch (Exception ignored) { continue; }
                    JSONObject decoded = new JSONObject(plaintext);
                    if (!submission.turnId.equals(decoded.optString("turnId"))) continue;
                    BridgeTurnStatus status = BridgeTurnStatus.parse(plaintext, submission.turnId);
                    acknowledgeCloud(item.optString("messageId"));
                    acknowledgeRecovery(status);
                    if (status.committed()) return status.toResult("cloud");
                    if (status.failedFinal()) {
                        throw new BridgeFinalException(status.errorCode, status.allowFallback);
                    }
                }
            }
            sleepForPoll(submission.turnId, deadline, config.cloudPollIntervalMs);
        }
        throw new BridgeDeadlineException(submission.turnId);
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
        byte[] key = Base64.decode(config.encryptionKeyBase64, Base64.DEFAULT);
        if (key.length != 32) throw new IllegalArgumentException("cloud encryption key must be 256-bit");
        byte[] nonce = new byte[12];
        RANDOM.nextBytes(nonce);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        return new Encrypted(
            Base64.encodeToString(ciphertext, Base64.NO_WRAP),
            Base64.encodeToString(nonce, Base64.NO_WRAP)
        );
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
}
