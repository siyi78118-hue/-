package com.siyi.al.execution;

public final class ExecutionServicePolicy {
    private ExecutionServicePolicy() {}

    /**
     * The only completed-turn delivery paths understood by the service.  A v3
     * row is deliberately fail-closed unless its persisted checkpoint proves
     * which authority owns the result.
     */
    public enum CompletedDeliveryPath {
        CANONICAL_RECEIPT,
        JOURNAL_ONLY,
        LEGACY_RECEIPT,
        NONE
    }

    public static boolean restartAfterProcessReclaim() {
        return true;
    }

    public static boolean isRedacted(Long deletedAt) {
        return deletedAt != null;
    }

    /** Redacted terminal rows wake reconciliation but must look cancelled to UI code. */
    public static String publicDisplayState(String displayState, Long deletedAt) {
        return isRedacted(deletedAt) ? TurnState.CANCELLED.name() : displayState;
    }

    public static boolean shouldUseCanonicalReceipt(
        Integer bridgeProtocolVersion,
        String state,
        Long deletedAt
    ) {
        return shouldUseCanonicalReceipt(
            bridgeProtocolVersion, state, deletedAt, null, null, null, null);
    }

    public static boolean shouldUseCanonicalReceipt(
        Integer bridgeProtocolVersion,
        String state,
        Long deletedAt,
        Integer checkpointVersion,
        String authorityOrigin,
        String outcomeType,
        String outcomeRoute
    ) {
        return classifyCompletedDelivery(
            bridgeProtocolVersion,
            state,
            deletedAt,
            checkpointVersion,
            authorityOrigin,
            outcomeType,
            outcomeRoute
        ) == CompletedDeliveryPath.CANONICAL_RECEIPT;
    }

    public static CompletedDeliveryPath classifyCompletedDelivery(
        Integer bridgeProtocolVersion,
        String state,
        Long deletedAt,
        Integer checkpointVersion,
        String authorityOrigin,
        String outcomeType,
        String outcomeRoute
    ) {
        if (!TurnState.COMPLETED.name().equals(state) || deletedAt != null) {
            return CompletedDeliveryPath.NONE;
        }
        if (bridgeProtocolVersion == null || bridgeProtocolVersion == 1 || bridgeProtocolVersion == 2) {
            return CompletedDeliveryPath.LEGACY_RECEIPT;
        }
        if (bridgeProtocolVersion != 3) {
            return CompletedDeliveryPath.NONE;
        }

        if (checkpointVersion == null || authorityOrigin == null
            || outcomeType == null || outcomeRoute == null) {
            return CompletedDeliveryPath.NONE;
        }
        if (!"committed".equals(outcomeType)) {
            return CompletedDeliveryPath.NONE;
        }
        if (checkpointVersion == 2
            && "android_fallback".equals(authorityOrigin)
            && "local".equals(outcomeRoute)) {
            return CompletedDeliveryPath.JOURNAL_ONLY;
        }
        if (checkpointVersion == 1
            && "pc".equals(authorityOrigin)
            && ("lan".equals(outcomeRoute) || "cloud".equals(outcomeRoute))) {
            return CompletedDeliveryPath.CANONICAL_RECEIPT;
        }
        return CompletedDeliveryPath.NONE;
    }
}
