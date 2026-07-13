package com.siyi.al.execution.api;

import java.io.IOException;

public final class ApiProtocolException extends IOException {
    private final String code;

    public ApiProtocolException(String code, String message) {
        super(message);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
