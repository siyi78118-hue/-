package com.siyi.al.execution;

import com.siyi.al.execution.api.ApiProtocolException;
import java.net.ConnectException;
import java.net.UnknownHostException;

public final class RetryPolicy {
    public Decision classify(Throwable error) {
        if (error instanceof ApiProtocolException) {
            String code = ((ApiProtocolException) error).code();
            boolean retryable = "HTTP_429".equals(code)
                || "HTTP_502".equals(code)
                || "HTTP_503".equals(code)
                || "HTTP_504".equals(code);
            return new Decision(code, retryable);
        }
        if (error instanceof UnknownHostException || error instanceof ConnectException) {
            return new Decision("NETWORK_UNREACHABLE", true);
        }
        if (error instanceof IllegalStateException && error.getMessage() != null && error.getMessage().startsWith("Missing API configuration")) {
            return new Decision("CONFIG_MISSING", false);
        }
        return new Decision("EXECUTION_FAILED", false);
    }

    public static final class Decision {
        public final String code;
        public final boolean retryable;

        Decision(String code, boolean retryable) {
            this.code = code;
            this.retryable = retryable;
        }
    }
}
