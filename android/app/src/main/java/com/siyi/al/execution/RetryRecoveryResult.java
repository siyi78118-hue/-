package com.siyi.al.execution;

public final class RetryRecoveryResult {
    public final int restarted;
    public final long nextDelaySeconds;

    public RetryRecoveryResult(int restarted, long nextDelaySeconds) {
        this.restarted = restarted;
        this.nextDelaySeconds = nextDelaySeconds;
    }
}
