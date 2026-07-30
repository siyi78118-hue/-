package com.siyi.al.execution.bridge;

public final class BridgeAcceptedException extends Exception {
    private final String route;

    public BridgeAcceptedException(String route) {
        super("bridge accepted the turn for asynchronous completion");
        this.route = route == null ? "" : route;
    }

    public String route() {
        return route;
    }
}
