package com.siyi.al.execution.api;

import java.util.Collections;
import java.util.List;

public final class ParsedReply {
    public final List<ParsedReplyPart> parts;

    ParsedReply(List<ParsedReplyPart> parts) {
        this.parts = Collections.unmodifiableList(parts);
    }
}
