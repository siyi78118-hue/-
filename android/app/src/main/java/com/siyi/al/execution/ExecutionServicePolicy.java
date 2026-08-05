package com.siyi.al.execution;

public final class ExecutionServicePolicy {
    private ExecutionServicePolicy() {}

    public static boolean restartAfterProcessReclaim() {
        return true;
    }

    public static boolean shouldUseCanonicalReceipt(
        Integer bridgeProtocolVersion,
        String state,
        Long deletedAt
    ) {
        return bridgeProtocolVersion != null
            && bridgeProtocolVersion == 3
            && TurnState.COMPLETED.name().equals(state);
    }
}
