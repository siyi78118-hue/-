package com.siyi.al.execution.bridge;

public final class BridgePendingException extends Exception {
    public BridgePendingException(String message) { super(message); }
    public BridgePendingException(String message, Throwable cause) { super(message, cause); }
}
