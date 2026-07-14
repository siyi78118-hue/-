package com.siyi.al.execution.api;

public final class ApiConfig {
    public final String baseUrl;
    public final String apiKey;
    public final String model;
    public final Double temperature;

    public ApiConfig(String baseUrl, String apiKey, String model, Double temperature) {
        this.baseUrl = requireText(baseUrl, "baseUrl");
        this.apiKey = requireText(apiKey, "apiKey");
        this.model = requireText(model, "model");
        this.temperature = temperature;
    }

    private static String requireText(String value, String name) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.isEmpty()) throw new IllegalArgumentException(name + " is required");
        return normalized;
    }
}
