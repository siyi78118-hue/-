package com.siyi.al.execution.secure;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.siyi.al.execution.api.ApiConfig;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class AlSecretStore {
    private static final String KEY_ALIAS = "al.execution.secrets.v1";
    private static final String PREFS_NAME = "al.execution.secrets.v1.prefs";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String SEPARATOR = ".";
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

    private void put(String configId, String field, String value) {
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String encoded = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + SEPARATOR
                + Base64.encodeToString(encrypted, Base64.NO_WRAP);
            preferences.edit().putString(storageKey(configId, field), encoded).apply();
        } catch (Exception error) {
            throw new IllegalStateException("Unable to encrypt API configuration", error);
        }
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
