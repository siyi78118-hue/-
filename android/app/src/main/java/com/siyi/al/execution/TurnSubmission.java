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
    public final String authoritativeTurnId;
    public final String bridgeAuthorityCheckpointJson;

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
        this(
            turnId, characterId, sourceMessageId, kind, inputJson, snapshotJson,
            cloudJobId, createdAt, turnId, null
        );
    }

    public TurnSubmission(
        String turnId,
        String characterId,
        String sourceMessageId,
        TurnKind kind,
        String inputJson,
        String snapshotJson,
        String cloudJobId,
        long createdAt,
        String authoritativeTurnId,
        String bridgeAuthorityCheckpointJson
    ) {
        this.turnId = requireText(turnId, "turnId");
        this.characterId = requireText(characterId, "characterId");
        this.sourceMessageId = requireText(sourceMessageId, "sourceMessageId");
        this.kind = kind == null ? TurnKind.DIRECT_REPLY : kind;
        this.inputJson = inputJson == null ? "{}" : inputJson;
        this.snapshotJson = snapshotJson == null ? "{}" : snapshotJson;
        this.cloudJobId = emptyToNull(cloudJobId);
        this.createdAt = createdAt;
        this.authoritativeTurnId = requireText(authoritativeTurnId, "authoritativeTurnId");
        this.bridgeAuthorityCheckpointJson = emptyToNull(bridgeAuthorityCheckpointJson);
        if (this.bridgeAuthorityCheckpointJson == null && !this.turnId.equals(this.authoritativeTurnId)) {
            throw new IllegalArgumentException("remote authority requires a bridge checkpoint");
        }
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
