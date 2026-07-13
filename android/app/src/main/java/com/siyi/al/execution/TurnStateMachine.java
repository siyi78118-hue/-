package com.siyi.al.execution;

import java.util.EnumMap;
import java.util.EnumSet;

public final class TurnStateMachine {
    private static final EnumMap<TurnState, EnumSet<TurnState>> LEGAL =
        new EnumMap<>(TurnState.class);

    static {
        LEGAL.put(
            TurnState.QUEUED,
            EnumSet.of(TurnState.MEMORY_RUNNING, TurnState.CANCELLED)
        );
        LEGAL.put(
            TurnState.MEMORY_RUNNING,
            EnumSet.of(
                TurnState.MEMORY_DONE,
                TurnState.FAILED_RETRYABLE,
                TurnState.FAILED_FINAL,
                TurnState.CANCELLED
            )
        );
        LEGAL.put(
            TurnState.MEMORY_DONE,
            EnumSet.of(TurnState.CHAT_RUNNING, TurnState.CANCELLED)
        );
        LEGAL.put(
            TurnState.CHAT_RUNNING,
            EnumSet.of(
                TurnState.CHAT_DONE,
                TurnState.INTERRUPTED,
                TurnState.FAILED_RETRYABLE,
                TurnState.FAILED_FINAL,
                TurnState.CANCELLED
            )
        );
        LEGAL.put(
            TurnState.CHAT_DONE,
            EnumSet.of(TurnState.COMMITTED, TurnState.FAILED_FINAL, TurnState.CANCELLED)
        );
        LEGAL.put(
            TurnState.COMMITTED,
            EnumSet.of(TurnState.NOTIFIED, TurnState.COMPLETED)
        );
        LEGAL.put(TurnState.NOTIFIED, EnumSet.of(TurnState.COMPLETED));
        LEGAL.put(
            TurnState.FAILED_RETRYABLE,
            EnumSet.of(TurnState.QUEUED, TurnState.CANCELLED)
        );
        LEGAL.put(
            TurnState.INTERRUPTED,
            EnumSet.of(TurnState.QUEUED, TurnState.CANCELLED)
        );
    }

    private TurnStateMachine() {}

    public static void requireTransition(TurnState from, TurnState to) {
        EnumSet<TurnState> allowed = LEGAL.get(from);
        if (allowed == null || !allowed.contains(to)) {
            throw new IllegalStateException("Illegal turn transition: " + from + " -> " + to);
        }
    }

    public static TurnState deriveDisplayState(boolean hasReply, TurnState stored) {
        return hasReply ? TurnState.COMPLETED : stored;
    }
}
