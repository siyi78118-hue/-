package com.siyi.al.execution;

import com.siyi.al.execution.api.ApiProtocolException;
import com.siyi.al.execution.api.ParsedReply;
import com.siyi.al.execution.api.ParsedReplyPart;
import com.siyi.al.execution.api.ReplyParser;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

public final class ExecutionEngine {
    private final ExecutionEngineStore store;
    private final ModelGateway models;
    private final ReplyParser parser;
    private final ExecutionClock clock;
    private final RetryPolicy retryPolicy;

    public ExecutionEngine(ExecutionEngineStore store, ModelGateway models, ReplyParser parser, ExecutionClock clock) {
        this(store, models, parser, clock, new RetryPolicy());
    }

    ExecutionEngine(ExecutionEngineStore store, ModelGateway models, ReplyParser parser, ExecutionClock clock, RetryPolicy retryPolicy) {
        this.store = store;
        this.models = models;
        this.parser = parser;
        this.clock = clock;
        this.retryPolicy = retryPolicy;
    }

    public boolean runNext() {
        ChatTurnEntity turn = store.claimNext(clock.now());
        if (turn == null) return false;
        ExecutionAttemptEntity attempt = requireActiveAttempt(turn);
        process(turn, attempt);
        return true;
    }

    public void recoverInterruptedWork() {
        for (ExecutionAttemptEntity attempt : store.recoverableAttempts()) {
            ChatTurnEntity turn = store.turn(attempt.turnId);
            if (turn == null || !attempt.attemptId.equals(turn.activeAttemptId)) continue;
            TurnState state = TurnState.valueOf(turn.state);
            if (state == TurnState.CHAT_RUNNING) {
                store.markInterrupted(turn.turnId, attempt.attemptId, "PROCESS_DIED_DURING_CHAT", clock.now());
                continue;
            }
            process(turn, attempt);
        }
    }

    private void process(ChatTurnEntity turn, ExecutionAttemptEntity attempt) {
        try {
            JSONObject snapshot = new JSONObject(turn.snapshotJson);
            TurnState state = TurnState.valueOf(turn.state);
            if (state == TurnState.QUEUED) {
                store.markStage(turn.turnId, attempt.attemptId, TurnState.MEMORY_RUNNING, AttemptStage.MEMORY, clock.now());
                state = TurnState.MEMORY_RUNNING;
            }
            if (state == TurnState.MEMORY_RUNNING) {
                String memory = models.call(
                    snapshot.getString("memoryConfigId"),
                    snapshot.getString("memorySystem"),
                    snapshot.optJSONArray("memoryMessages") == null ? new JSONArray() : snapshot.getJSONArray("memoryMessages"),
                    snapshot.optInt("memoryMaxTokens", 1400)
                );
                store.saveMemoryResult(turn.turnId, attempt.attemptId, memory, clock.now());
                attempt.memoryResult = memory;
                state = TurnState.MEMORY_DONE;
            }
            if (state == TurnState.MEMORY_DONE) {
                store.markStage(turn.turnId, attempt.attemptId, TurnState.CHAT_RUNNING, AttemptStage.CHAT, clock.now());
                String rawReply = models.call(
                    snapshot.getString("chatConfigId"),
                    withMemory(snapshot.getString("chatSystem"), attempt.memoryResult),
                    exactChatMessages(snapshot),
                    snapshot.optInt("chatMaxTokens", 1000)
                );
                store.saveRawReply(turn.turnId, attempt.attemptId, rawReply, clock.now());
                attempt.rawReply = rawReply;
                state = TurnState.CHAT_DONE;
            }
            if (state == TurnState.CHAT_DONE) commitStoredReply(turn, attempt);
        } catch (StaleAttemptException ignored) {
            // A newer retry owns this turn. The late attempt must not overwrite it.
        } catch (Exception error) {
            RetryPolicy.Decision decision = retryPolicy.classify(error);
            try {
                store.markFailed(
                    turn.turnId,
                    attempt.attemptId,
                    decision.code,
                    safeDetail(error),
                    decision.retryable,
                    clock.now()
                );
            } catch (StaleAttemptException ignored) {
                // A completed or retried turn always wins over this failure.
            }
        }
    }

    private void commitStoredReply(ChatTurnEntity turn, ExecutionAttemptEntity attempt) throws Exception {
        if (attempt.rawReply == null || attempt.rawReply.trim().isEmpty()) {
            throw new ApiProtocolException("EMPTY_CONTENT", "Stored model reply is empty");
        }
        ParsedReply parsed = parser.parse(attempt.rawReply, turn.turnId, attempt.attemptId);
        if (parsed.parts.isEmpty()) throw new ApiProtocolException("EMPTY_CONTENT", "Model reply contained no visible message");
        List<ReplyPartEntity> entities = new ArrayList<>();
        long now = clock.now();
        for (ParsedReplyPart source : parsed.parts) {
            ReplyPartEntity part = new ReplyPartEntity();
            part.replyPartId = source.partId;
            part.turnId = source.turnId;
            part.attemptId = source.attemptId;
            part.sequence = source.sequence;
            part.type = source.type;
            part.content = source.content;
            part.payloadJson = source.payloadJson;
            part.createdAt = now;
            entities.add(part);
        }
        store.commitReply(turn.turnId, attempt.attemptId, entities, now);
    }

    private static JSONArray exactChatMessages(JSONObject snapshot) {
        JSONArray source = snapshot.optJSONArray("chatMessages");
        if (source == null) return new JSONArray();
        if (source.length() > 30) throw new IllegalArgumentException("chatMessages must contain exactly the selected latest 30 or fewer messages");
        return source;
    }

    private static String withMemory(String fullSystemPrompt, String memory) {
        String selected = memory == null || memory.trim().isEmpty() ? "无相关记忆" : memory.trim();
        return fullSystemPrompt + "\n\n【记忆 AI 本轮筛选结果】\n" + selected + "\n以上事件时间必须按记录理解，不得把昨天改写成今天。";
    }

    private ExecutionAttemptEntity requireActiveAttempt(ChatTurnEntity turn) {
        ExecutionAttemptEntity attempt = store.activeAttempt(turn.turnId);
        if (attempt == null || !attempt.attemptId.equals(turn.activeAttemptId)) {
            throw new StaleAttemptException(turn.turnId, turn.activeAttemptId);
        }
        return attempt;
    }

    private static String safeDetail(Throwable error) {
        String detail = error.getMessage();
        if (detail == null || detail.trim().isEmpty()) detail = error.getClass().getSimpleName();
        return detail.length() > 500 ? detail.substring(0, 500) : detail;
    }
}
