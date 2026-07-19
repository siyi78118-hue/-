package com.siyi.al.execution.bridge;

public final class BridgeFinalException extends Exception {
    private final String code;
    private final boolean allowFallback;

    public BridgeFinalException(String code, boolean allowFallback) {
        super(code == null || code.trim().isEmpty() ? "BRIDGE_FINAL_FAILURE" : code.trim());
        this.code = getMessage();
        this.allowFallback = allowFallback;
    }

    public String code() { return code; }
    public boolean allowFallback() { return allowFallback; }
}
