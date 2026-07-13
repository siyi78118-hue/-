package com.siyi.al.execution;

public final class ExecutionServicePolicy {
    private ExecutionServicePolicy() {}

    public static boolean restartAfterProcessReclaim() {
        return true;
    }
}
