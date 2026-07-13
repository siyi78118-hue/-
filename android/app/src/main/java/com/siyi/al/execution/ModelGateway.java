package com.siyi.al.execution;

import org.json.JSONArray;

public interface ModelGateway {
    String call(String configId, String system, JSONArray messages, int maxTokens) throws Exception;
}
