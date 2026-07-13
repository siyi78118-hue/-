package com.siyi.al.execution.api;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;

import java.util.Map;
import org.json.JSONArray;
import org.junit.Test;

public class OpenAiCompatibleClientTest {
    @Test
    public void rejectsHtmlLoginPageAsApiResponse() {
        FakeTransport transport = new FakeTransport(200, "text/html", "<!DOCTYPE html><html>login</html>");
        OpenAiCompatibleClient client = new OpenAiCompatibleClient(transport);

        ApiProtocolException error = assertThrows(
            ApiProtocolException.class,
            () -> client.call(config(), "sys", new JSONArray(), 1000)
        );

        assertEquals("HTML_RESPONSE", error.code());
    }

    @Test
    public void readsUnicodeEmojiFromOpenAiContent() throws Exception {
        FakeTransport transport = new FakeTransport(
            200,
            "application/json; charset=utf-8",
            "{\"choices\":[{\"message\":{\"content\":\"好呀😊\"}}]}"
        );
        OpenAiCompatibleClient client = new OpenAiCompatibleClient(transport);

        assertEquals("好呀😊", client.call(config(), "sys", new JSONArray(), 1000));
        assertFalse(transport.lastBody.contains("\"stream\":true"));
    }

    @Test
    public void readsCompatibleContentArrays() throws Exception {
        FakeTransport transport = new FakeTransport(
            200,
            "application/json",
            "{\"choices\":[{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"第一句\"},{\"type\":\"text\",\"text\":\"😊\"}]}}]}"
        );
        OpenAiCompatibleClient client = new OpenAiCompatibleClient(transport);

        assertEquals("第一句😊", client.call(config(), "sys", new JSONArray(), 1000));
    }

    private static ApiConfig config() {
        return new ApiConfig("https://api.example.com/v1", "secret", "model-1", 0.8);
    }

    private static final class FakeTransport implements HttpTransport {
        private final HttpResponse response;
        private String lastBody = "";

        FakeTransport(int status, String contentType, String body) {
            response = new HttpResponse(status, contentType, body);
        }

        @Override
        public HttpResponse post(String url, Map<String, String> headers, String body) {
            lastBody = body;
            return response;
        }
    }
}
