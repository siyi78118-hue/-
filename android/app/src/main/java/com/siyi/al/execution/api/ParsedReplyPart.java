package com.siyi.al.execution.api;

public final class ParsedReplyPart {
    public final String partId;
    public final String turnId;
    public final String attemptId;
    public final int sequence;
    public final String type;
    public final String content;
    public final String payloadJson;

    ParsedReplyPart(String partId, String turnId, String attemptId, int sequence, String type, String content, String payloadJson) {
        this.partId = partId;
        this.turnId = turnId;
        this.attemptId = attemptId;
        this.sequence = sequence;
        this.type = type;
        this.content = content;
        this.payloadJson = payloadJson;
    }
}
