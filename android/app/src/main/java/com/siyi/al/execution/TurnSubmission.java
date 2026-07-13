package com.siyi.al.execution;

public final class TurnSubmission {
    public final String turnId;
    public final String characterId;
    public final String sourceMessageId;
    public final TurnKind kind;
    public final String inputJson;
    public final String snapshotJson;
    public final String cloudJobId;
    public final long createdAt;

    public TurnSubmission(
        String turnId,
        String characterId,
        String sourceMessageId,
        TurnKind kind,
        String inputJson,
        String snapshotJson,
        String cloudJobId,
        long createdAt
    ) {
        this.turnId = requireText(turnId, "turnId");
        this.characterId = requireText(characterId, "characterId");
        this.sourceMessageId = requireText(sourceMessageId, "sourceMessageId");
        this.kind = kind == null ? TurnKind.DIRECT_REPLY : kind;
        this.inputJson = inputJson == null ? "{}" : inputJson;
        this.snapshotJson = snapshotJson == null ? "{}" : snapshotJson;
        this.cloudJobId = emptyToNull(cloudJobId);
        this.createdAt = createdAt;
    }

    private static String requireText(String value, String label) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException(label + " is required");
        }
        return value.trim();
    }

    private static String emptyToNull(String value) {
        return value == null || value.trim().isEmpty() ? null : value.trim();
    }
}
