package com.siyi.al.execution;

public enum TurnState {
    QUEUED,
    MEMORY_RUNNING,
    BRIDGE_WAITING,
    MEMORY_DONE,
    CHAT_RUNNING,
    CHAT_DONE,
    COMMITTED,
    NOTIFIED,
    COMPLETED,
    FAILED_RETRYABLE,
    FAILED_FINAL,
    INTERRUPTED,
    CANCELLED
}
