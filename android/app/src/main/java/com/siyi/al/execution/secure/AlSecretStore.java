package com.siyi.al.execution.secure;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.siyi.al.execution.api.ApiConfig;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgeMode;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class AlSecretStore {
    private static final String KEY_ALIAS = "al.execution.secrets.v1";
    private static final String PREFS_NAME = "al.execution.secrets.v1.prefs";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String SEPARATOR = ".";
    // Test-only outcome seam.  It changes only the commit result; encryption,
    // SharedPreferences, and the Room graph remain real.  Tests must reset it.
    private static final AtomicReference<String> failNextBridgeCommitForDeviceId =
        new AtomicReference<>();
    private final SharedPreferences preferences;

    public AlSecretStore(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public synchronized void saveApiConfig(String configId, ApiConfig config) {
        put(configId, "baseUrl", config.baseUrl);
        put(configId, "apiKey", config.apiKey);
        put(configId, "model", config.model);
        put(configId, "temperature", config.temperature == null ? "disabled" : Double.toString(config.temperature));
    }

    public synchronized ApiConfig loadApiConfig(String configId) {
        String baseUrl = get(configId, "baseUrl");
        String apiKey = get(configId, "apiKey");
        String model = get(configId, "model");
        String temperature = get(configId, "temperature");
        if (baseUrl == null || apiKey == null || model == null) return null;
        Double parsedTemperature = null;
        if (!"disabled".equals(temperature)) {
            try {
                parsedTemperature = Double.parseDouble(temperature == null ? "0.8" : temperature);
            } catch (NumberFormatException ignored) {
                parsedTemperature = 0.8;
            }
        }
        return new ApiConfig(baseUrl, apiKey, model, parsedTemperature);
    }

    public synchronized void removeApiConfig(String configId) {
        SharedPreferences.Editor editor = preferences.edit();
        for (String field : new String[] {"baseUrl", "apiKey", "model", "temperature"}) {
            editor.remove(storageKey(configId, field));
        }
        editor.apply();
    }

    public synchronized void saveBridgeConfig(BridgeConfig config) {
        String[] fields = new String[] {
            "enabled", "mode", "lanUrl", "cloudUrl", "deviceId", "pairingSecret",
            "deviceToken", "encryptionKey", "connectTimeoutMs", "readTimeoutMs",
            "cloudPollAttempts", "cloudPollIntervalMs", "turnDeadlineMs"
        };
        String[] values = new String[] {
            Boolean.toString(config.enabled), config.mode.name(), config.lanUrl, config.cloudUrl,
            config.deviceId, config.pairingSecret, config.deviceToken, config.encryptionKeyBase64,
            Integer.toString(config.connectTimeoutMs), Integer.toString(config.readTimeoutMs),
            Integer.toString(config.cloudPollAttempts), Integer.toString(config.cloudPollIntervalMs),
            Integer.toString(config.turnDeadlineMs)
        };
        SharedPreferences.Editor editor = preferences.edit();
        try {
            for (int i = 0; i < fields.length; i++) {
                editor.putString(storageKey("yuqi-bridge", fields[i]), encrypt(values[i]));
            }
            String failureToken = failNextBridgeCommitForDeviceId.get();
            boolean forcedFailure = failureToken != null
                && failureToken.equals(config.deviceId)
                && failNextBridgeCommitForDeviceId.compareAndSet(failureToken, null);
            boolean committed = !forcedFailure && editor.commit();
            if (!committed) {
                throw new IllegalStateException("Unable to persist bridge configuration");
            }
        } catch (IllegalStateException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalStateException("Unable to encrypt API configuration", error);
        }
    }

    static void setForcedCommitOutcomeForTests(String deviceId) {
        if (deviceId != null && (deviceId.trim().isEmpty()
            || "true".equalsIgnoreCase(deviceId)
            || "false".equalsIgnoreCase(deviceId)
            || "success".equalsIgnoreCase(deviceId))) {
            throw new IllegalArgumentException("commit failure token must be a device id");
        }
        failNextBridgeCommitForDeviceId.set(deviceId);
    }

    public synchronized BridgeConfig loadBridgeConfig() {
        String enabled = get("yuqi-bridge", "enabled");
        if (enabled == null) return BridgeConfig.disabled();
        return new BridgeConfig(
            Boolean.parseBoolean(enabled),
            BridgeMode.parse(get("yuqi-bridge", "mode")),
            get("yuqi-bridge", "lanUrl"),
            get("yuqi-bridge", "cloudUrl"),
            get("yuqi-bridge", "deviceId"),
            get("yuqi-bridge", "pairingSecret"),
            get("yuqi-bridge", "deviceToken"),
            get("yuqi-bridge", "encryptionKey"),
            parseInt(get("yuqi-bridge", "connectTimeoutMs"), 1200),
            parseInt(get("yuqi-bridge", "readTimeoutMs"), 90000),
            parseInt(get("yuqi-bridge", "cloudPollAttempts"), 60),
            parseInt(get("yuqi-bridge", "cloudPollIntervalMs"), 1000),
            parseInt(get("yuqi-bridge", "turnDeadlineMs"), 1200000)
        );
    }

    private static int parseInt(String value, int fallback) {
        try { return Integer.parseInt(value == null ? "" : value); }
        catch (NumberFormatException ignored) { return fallback; }
    }

    private void put(String configId, String field, String value) {
        try {
            preferences.edit().putString(storageKey(configId, field), encrypt(value)).apply();
        } catch (Exception error) {
            throw new IllegalStateException("Unable to encrypt API configuration", error);
        }
    }

    private static String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
            + SEPARATOR
            + Base64.encodeToString(encrypted, Base64.NO_WRAP);
    }

    private String get(String configId, String field) {
        String encoded = preferences.getString(storageKey(configId, field), null);
        if (encoded == null) return null;
        int separator = encoded.indexOf(SEPARATOR);
        if (separator <= 0 || separator == encoded.length() - 1) {
            throw new IllegalStateException("Encrypted API configuration is invalid");
        }
        try {
            byte[] iv = Base64.decode(encoded.substring(0, separator), Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(encoded.substring(separator + 1), Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to decrypt API configuration", error);
        }
    }

    private static String storageKey(String configId, String field) {
        if (configId == null || configId.trim().isEmpty()) throw new IllegalArgumentException("configId is required");
        return configId.trim() + ":" + field;
    }

    private static SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        KeyStore.Entry existing = keyStore.getEntry(KEY_ALIAS, null);
        if (existing instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }
}
