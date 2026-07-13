package com.siyi.al.execution.api;

public final class HttpResponse {
    public final int status;
    public final String contentType;
    public final String body;

    public HttpResponse(int status, String contentType, String body) {
        this.status = status;
        this.contentType = contentType == null ? "" : contentType;
        this.body = body == null ? "" : body;
    }
}
