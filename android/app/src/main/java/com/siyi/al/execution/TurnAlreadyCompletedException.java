package com.siyi.al.execution;

public final class TurnAlreadyCompletedException extends IllegalStateException {
    public TurnAlreadyCompletedException(String turnId) {
        super("Turn already has a committed reply: " + turnId);
    }
}
