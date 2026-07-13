package com.siyi.al.execution.api;

import java.io.IOException;
import java.util.Map;

public interface HttpTransport {
    HttpResponse post(String url, Map<String, String> headers, String body) throws IOException;
}
