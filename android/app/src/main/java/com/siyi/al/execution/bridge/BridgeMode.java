package com.siyi.al.execution.bridge;

public enum BridgeMode {
    AUTO,
    LAN,
    CLOUD;

    public static BridgeMode parse(String value) {
        if (value == null) return AUTO;
        try { return valueOf(value.trim().toUpperCase()); }
        catch (IllegalArgumentException ignored) { return AUTO; }
    }
}
