package com.siyi.al.execution;

import com.siyi.al.execution.api.ApiConfig;
import com.siyi.al.execution.api.OpenAiCompatibleClient;
import com.siyi.al.execution.secure.AlSecretStore;
import org.json.JSONArray;

public final class NativeModelGateway implements ModelGateway {
    private final AlSecretStore secrets;
    private final OpenAiCompatibleClient client;

    public NativeModelGateway(AlSecretStore secrets, OpenAiCompatibleClient client) {
        this.secrets = secrets;
        this.client = client;
    }

    @Override
    public String call(String configId, String system, JSONArray messages, int maxTokens) throws Exception {
        ApiConfig config = secrets.loadApiConfig(configId);
        if (config == null) throw new IllegalStateException("Missing API configuration: " + configId);
        return client.call(config, system, messages, maxTokens);
    }
}
