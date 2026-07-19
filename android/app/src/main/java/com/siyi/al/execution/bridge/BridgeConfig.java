package com.siyi.al.execution.bridge;

public final class BridgeConfig {
    public final boolean enabled;
    public final BridgeMode mode;
    public final String lanUrl;
    public final String cloudUrl;
    public final String deviceId;
    public final String pairingSecret;
    public final String deviceToken;
    public final String encryptionKeyBase64;
    public final int connectTimeoutMs;
    public final int readTimeoutMs;
    public final int cloudPollAttempts;
    public final int cloudPollIntervalMs;
    public final int turnDeadlineMs;

    public BridgeConfig(
        boolean enabled,
        BridgeMode mode,
        String lanUrl,
        String cloudUrl,
        String deviceId,
        String pairingSecret,
        String deviceToken,
        String encryptionKeyBase64,
        int connectTimeoutMs,
        int readTimeoutMs,
        int cloudPollAttempts,
        int cloudPollIntervalMs
    ) {
        this(enabled, mode, lanUrl, cloudUrl, deviceId, pairingSecret, deviceToken,
            encryptionKeyBase64, connectTimeoutMs, readTimeoutMs, cloudPollAttempts,
            cloudPollIntervalMs, 1_200_000);
    }

    public BridgeConfig(
        boolean enabled,
        BridgeMode mode,
        String lanUrl,
        String cloudUrl,
        String deviceId,
        String pairingSecret,
        String deviceToken,
        String encryptionKeyBase64,
        int connectTimeoutMs,
        int readTimeoutMs,
        int cloudPollAttempts,
        int cloudPollIntervalMs,
        int turnDeadlineMs
    ) {
        this.enabled = enabled;
        this.mode = mode == null ? BridgeMode.AUTO : mode;
        this.lanUrl = trimTrailingSlash(lanUrl);
        this.cloudUrl = trimTrailingSlash(cloudUrl);
        this.deviceId = safe(deviceId);
        this.pairingSecret = safe(pairingSecret);
        this.deviceToken = safe(deviceToken);
        this.encryptionKeyBase64 = safe(encryptionKeyBase64);
        this.connectTimeoutMs = clamp(connectTimeoutMs, 200, 30_000, 1_200);
        this.readTimeoutMs = clamp(readTimeoutMs, 500, 180_000, 90_000);
        this.cloudPollAttempts = clamp(cloudPollAttempts, 1, 240, 60);
        this.cloudPollIntervalMs = clamp(cloudPollIntervalMs, 100, 10_000, 1_000);
        this.turnDeadlineMs = clamp(turnDeadlineMs, 60_000, 3_600_000, 1_200_000);
    }

    public static BridgeConfig disabled() {
        return new BridgeConfig(false, BridgeMode.AUTO, "", "", "", "", "", "", 1_200, 90_000, 60, 1_000);
    }

    public boolean hasLan() {
        return enabled && (lanUrl.startsWith("http://") || lanUrl.startsWith("https://")) && pairingSecret.length() >= 12 && !deviceId.isEmpty();
    }

    public boolean hasCloud() {
        return enabled && cloudUrl.startsWith("https://") && deviceToken.length() >= 16 && !deviceId.isEmpty() && !encryptionKeyBase64.isEmpty();
    }

    private static String trimTrailingSlash(String value) {
        String text = safe(value);
        while (text.endsWith("/")) text = text.substring(0, text.length() - 1);
        return text;
    }

    private static String safe(String value) { return value == null ? "" : value.trim(); }

    private static int clamp(int value, int min, int max, int fallback) {
        if (value <= 0) return fallback;
        return Math.max(min, Math.min(max, value));
    }
}
