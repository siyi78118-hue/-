package com.siyi.al.execution.api;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class OpenAiCompatibleClient {
    private final HttpTransport transport;

    public OpenAiCompatibleClient(HttpTransport transport) {
        this.transport = transport;
    }

    public String call(ApiConfig config, String system, JSONArray messages, int maxTokens) throws IOException {
        validateHeaderValue(config.apiKey);
        JSONObject request;
        try {
            request = new JSONObject();
            JSONArray requestMessages = new JSONArray();
            requestMessages.put(new JSONObject().put("role", "system").put("content", system == null ? "" : system));
            if (messages != null) {
                for (int i = 0; i < messages.length(); i++) requestMessages.put(messages.get(i));
            }
            request.put("model", config.model);
            request.put("messages", requestMessages);
            request.put("temperature", config.temperature);
            request.put("max_tokens", Math.max(1, maxTokens));
            request.put("stream", false);
        } catch (JSONException error) {
            throw new ApiProtocolException("REQUEST_JSON", "Unable to encode the model request");
        }

        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/json; charset=utf-8");
        headers.put("Accept", "application/json");
        headers.put("Authorization", "Bearer " + config.apiKey);
        HttpResponse response = transport.post(endpoint(config.baseUrl), headers, request.toString());
        if (rejectsTemperature(response)) {
            request.remove("temperature");
            response = transport.post(endpoint(config.baseUrl), headers, request.toString());
        }
        return parseResponse(response);
    }

    private static boolean rejectsTemperature(HttpResponse response) {
        if (response.status != 400) return false;
        String body = response.body.toLowerCase();
        if (!body.contains("temperature")) return false;
        return body.contains("deprecated")
            || body.contains("unsupported")
            || body.contains("not supported")
            || body.contains("invalid_request_error")
            || body.contains("\"param\":\"temperature\"")
            || body.contains("\"param\": \"temperature\"");
    }

    static String endpoint(String baseUrl) {
        String normalized = baseUrl.trim().replaceAll("/+$", "");
        if (normalized.endsWith("/chat/completions")) return normalized;
        if (normalized.endsWith("/v1")) return normalized + "/chat/completions";
        return normalized + "/v1/chat/completions";
    }

    private static String parseResponse(HttpResponse response) throws ApiProtocolException {
        String body = response.body.trim();
        String type = response.contentType.toLowerCase();
        if (type.contains("text/html") || body.regionMatches(true, 0, "<!doctype html", 0, 15) || body.regionMatches(true, 0, "<html", 0, 5)) {
            throw new ApiProtocolException("HTML_RESPONSE", "The API returned an HTML page instead of JSON");
        }
        if (response.status < 200 || response.status >= 300) {
            throw new ApiProtocolException("HTTP_" + response.status, "API HTTP " + response.status + ": " + compact(body));
        }
        if (body.isEmpty()) throw new ApiProtocolException("EMPTY_RESPONSE", "The API returned an empty response");
        try {
            JSONObject json = new JSONObject(body);
            String text = firstText(json).trim();
            if (text.isEmpty()) throw new ApiProtocolException("EMPTY_CONTENT", "The model response did not contain final text");
            return text;
        } catch (JSONException error) {
            throw new ApiProtocolException("MALFORMED_JSON", "The API returned malformed JSON: " + compact(body));
        }
    }

    private static String firstText(JSONObject root) throws JSONException {
        JSONArray choices = root.optJSONArray("choices");
        if (choices != null && choices.length() > 0) {
            JSONObject choice = choices.optJSONObject(0);
            if (choice != null) {
                JSONObject message = choice.optJSONObject("message");
                String text = contentText(message == null ? null : message.opt("content"));
                if (!text.isEmpty()) return text;
                text = contentText(choice.opt("text"));
                if (!text.isEmpty()) return text;
            }
        }
        JSONArray candidates = root.optJSONArray("candidates");
        if (candidates != null && candidates.length() > 0) {
            JSONObject candidate = candidates.optJSONObject(0);
            if (candidate != null) {
                String text = contentText(candidate.opt("content"));
                if (!text.isEmpty()) return text;
            }
        }
        for (String key : new String[] {"output_text", "output", "content", "text"}) {
            String text = contentText(root.opt(key));
            if (!text.isEmpty()) return text;
        }
        return "";
    }

    private static String contentText(Object value) throws JSONException {
        if (value == null || value == JSONObject.NULL) return "";
        if (value instanceof String) return (String) value;
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            StringBuilder result = new StringBuilder();
            for (int i = 0; i < array.length(); i++) result.append(contentText(array.get(i)));
            return result.toString();
        }
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            for (String key : new String[] {"text", "content", "output_text", "parts", "value"}) {
                String text = contentText(object.opt(key));
                if (!text.isEmpty()) return text;
            }
        }
        return "";
    }

    private static void validateHeaderValue(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\r' || c == '\n' || c > 255) {
                throw new IllegalArgumentException("API key contains an invalid header character");
            }
        }
    }

    private static String compact(String value) {
        return value.replaceAll("\\s+", " ").trim().substring(0, Math.min(220, value.replaceAll("\\s+", " ").trim().length()));
    }
}
