package com.siyi.al.execution;

public final class AutomaticTaskCleanupResult {
    public final int cancelledTurns;
    public final int cancelledAttempts;
    public final int acknowledgedCompletedTurns;
    public final int deletedSnapshots;

    public AutomaticTaskCleanupResult(
        int cancelledTurns,
        int cancelledAttempts,
        int acknowledgedCompletedTurns,
        int deletedSnapshots
    ) {
        this.cancelledTurns = cancelledTurns;
        this.cancelledAttempts = cancelledAttempts;
        this.acknowledgedCompletedTurns = acknowledgedCompletedTurns;
        this.deletedSnapshots = deletedSnapshots;
    }
}
