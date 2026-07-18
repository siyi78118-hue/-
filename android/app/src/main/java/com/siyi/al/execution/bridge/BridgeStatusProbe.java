package com.siyi.al.execution.bridge;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public final class BridgeStatusProbe {
    public static final class Snapshot {
        public boolean lanOnline;
        public boolean cloudOnline;
        public int quotaWarningLevel;
        public String threadHealth = "电脑未连接";
        public String presetVersion = "";
        public String lanError = "";
        public String cloudError = "";
    }

    private BridgeStatusProbe() {}

    public static Snapshot probe(BridgeConfig config) {
        Snapshot result = new Snapshot();
        if (config.hasLan()) {
            try {
                JSONObject health = get(config.lanUrl + "/v1/health", null, Math.min(config.connectTimeoutMs, 2000));
                parseHealth(health, result);
                result.lanOnline = health.optBoolean("ok", false);
            } catch (Exception error) {
                result.lanError = safe(error);
            }
        }
        if (config.hasCloud()) {
            try {
                String target = config.cloudUrl + "/bridge/quota?deviceId=" + URLEncoder.encode(config.deviceId, "UTF-8");
                JSONObject quota = get(target, config.deviceToken, Math.min(config.readTimeoutMs, 5000));
                parseQuota(quota, result);
                result.cloudOnline = quota.optBoolean("ok", false);
            } catch (Exception error) {
                result.cloudError = safe(error);
            }
        }
        return result;
    }

    static void parseHealth(JSONObject health, Snapshot result) {
        JSONObject roles = health.optJSONObject("roleThreads");
        if (roles != null) {
            int ready = 0;
            for (String role : new String[] {"memory", "brain", "supervisor"}) if (roles.optBoolean(role, false)) ready += 1;
            result.threadHealth = ready + "/3 已建立";
        }
        result.presetVersion = health.optString("presetVersion", "");
    }

    static void parseQuota(JSONObject quota, Snapshot result) {
        result.quotaWarningLevel = Math.max(0, quota.optInt("warningLevel", 0));
    }

    private static JSONObject get(String target, String bearerToken, int timeoutMs) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(target).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(Math.max(300, timeoutMs));
        connection.setReadTimeout(Math.max(500, timeoutMs));
        connection.setRequestProperty("Accept", "application/json");
        if (bearerToken != null && !bearerToken.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + bearerToken);
        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        StringBuilder body = new StringBuilder();
        if (stream != null) {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                for (String line; (line = reader.readLine()) != null;) body.append(line);
            }
        }
        connection.disconnect();
        if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status);
        return new JSONObject(body.toString());
    }

    private static String safe(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) message = error.getClass().getSimpleName();
        return message.length() > 160 ? message.substring(0, 160) : message;
    }
}
