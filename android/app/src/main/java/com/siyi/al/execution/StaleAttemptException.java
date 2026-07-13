package com.siyi.al.execution;

public final class StaleAttemptException extends IllegalStateException {
    public StaleAttemptException(String turnId, String attemptId) {
        super("Attempt " + attemptId + " is not active for turn " + turnId);
    }
}
