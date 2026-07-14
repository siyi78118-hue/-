package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import com.siyi.al.execution.api.ParsedReply;
import com.siyi.al.execution.api.ReplyParser;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ExecutionEngineTest {
    @Test
    public void directReplyRunsMemoryBeforeChatAndCommitsOnce() throws Exception {
        FakeStore store = new FakeStore(turn("QUEUED", null), attempt("QUEUED", null));
        RecordingGateway gateway = new RecordingGateway();
        ExecutionEngine engine = engine(store, gateway);

        assertTrue(engine.runNext());

        assertEquals("memory,chat,commit", String.join(",", store.events));
        assertEquals(TurnState.COMPLETED.name(), store.turn.state);
        assertEquals(2, store.replyParts.size());
        assertTrue(gateway.chatSystem.contains("昨天约好周六语音"));
        assertTrue(gateway.chatSystem.contains("原生执行时钟"));
        assertEquals(30, gateway.chatMessageCount);
        assertEquals("消息5", gateway.firstChatMessage);
    }

    @Test
    public void storedChatDoneResultResumesWithoutCallingModelAgain() throws Exception {
        FakeStore store = new FakeStore(turn("CHAT_DONE", "已经生成😊"), attempt("CHAT_DONE", "已经生成😊"));
        RecordingGateway gateway = new RecordingGateway();
        ExecutionEngine engine = engine(store, gateway);

        engine.recoverInterruptedWork();

        assertEquals(0, gateway.calls.size());
        assertEquals(TurnState.COMPLETED.name(), store.turn.state);
        assertEquals("已经生成😊", store.replyParts.get(0).content);
    }

    @Test
    public void processDeathDuringUnknownChatCallBecomesInterrupted() throws Exception {
        FakeStore store = new FakeStore(turn("CHAT_RUNNING", null), attempt("CHAT_RUNNING", null));
        RecordingGateway gateway = new RecordingGateway();
        ExecutionEngine engine = engine(store, gateway);

        engine.recoverInterruptedWork();

        assertEquals(TurnState.INTERRUPTED.name(), store.turn.state);
        assertEquals("PROCESS_DIED_DURING_CHAT", store.attempt.errorCode);
        assertEquals(0, gateway.calls.size());
    }

    private static ExecutionEngine engine(FakeStore store, RecordingGateway gateway) {
        return new ExecutionEngine(
            store,
            gateway,
            new ReplyParser(),
            () -> 100L
        );
    }

    private static ChatTurnEntity turn(String state, String rawReply) throws Exception {
        ChatTurnEntity turn = new ChatTurnEntity();
        turn.turnId = "turn-1";
        turn.characterId = "char-1";
        turn.sourceMessageId = "msg-1";
        turn.kind = TurnKind.DIRECT_REPLY.name();
        turn.state = state;
        turn.activeAttemptId = "attempt-1";
        turn.createdAt = 1L;
        turn.updatedAt = 1L;
        turn.inputJson = "{\"text\":\"在吗\"}";
        turn.snapshotJson = snapshot().toString();
        return turn;
    }

    private static ExecutionAttemptEntity attempt(String state, String rawReply) {
        ExecutionAttemptEntity attempt = new ExecutionAttemptEntity();
        attempt.attemptId = "attempt-1";
        attempt.turnId = "turn-1";
        attempt.sequence = 1;
        attempt.stage = state;
        attempt.state = state;
        attempt.rawReply = rawReply;
        return attempt;
    }

    private static JSONObject snapshot() throws Exception {
        JSONObject snapshot = new JSONObject();
        snapshot.put("memoryConfigId", "memory-config");
        snapshot.put("chatConfigId", "chat-config");
        snapshot.put("memorySystem", "筛选相关记忆并保留时间");
        snapshot.put("chatSystem", "完整 RP 规则和当前阶段人设");
        snapshot.put("memoryMaxTokens", 1400);
        snapshot.put("chatMaxTokens", 1000);
        snapshot.put("memoryMessages", new JSONArray().put(message("user", "候选记忆")));
        JSONArray chatMessages = new JSONArray();
        for (int i = 0; i < 35; i++) chatMessages.put(message(i % 2 == 0 ? "user" : "assistant", "消息" + i));
        snapshot.put("chatMessages", chatMessages);
        return snapshot;
    }

    private static JSONObject message(String role, String content) throws Exception {
        return new JSONObject().put("role", role).put("content", content);
    }

    private static final class RecordingGateway implements ModelGateway {
        final List<String> calls = new ArrayList<>();
        String chatSystem = "";
        int chatMessageCount;
        String firstChatMessage = "";

        @Override
        public String call(String configId, String system, JSONArray messages, int maxTokens) {
            if ("memory-config".equals(configId)) {
                calls.add("memory");
                return "2026-07-12：昨天约好周六语音";
            }
            calls.add("chat");
            chatSystem = system;
            chatMessageCount = messages.length();
            firstChatMessage = messages.length() == 0 ? "" : messages.optJSONObject(0).optString("content");
            return "第一句😊\n第二句";
        }
    }

    private static final class FakeStore implements ExecutionEngineStore {
        final ChatTurnEntity turn;
        final ExecutionAttemptEntity attempt;
        final List<String> events = new ArrayList<>();
        final List<ReplyPartEntity> replyParts = new ArrayList<>();

        FakeStore(ChatTurnEntity turn, ExecutionAttemptEntity attempt) {
            this.turn = turn;
            this.attempt = attempt;
        }

        @Override public ChatTurnEntity claimNext(long now) {
            return TurnState.QUEUED.name().equals(turn.state) ? turn : null;
        }

        @Override public List<ExecutionAttemptEntity> recoverableAttempts() {
            return Collections.singletonList(attempt);
        }

        @Override public ChatTurnEntity turn(String turnId) { return turn; }
        @Override public ExecutionAttemptEntity activeAttempt(String turnId) { return attempt; }

        @Override public void markStage(String turnId, String attemptId, TurnState state, AttemptStage stage, long now) {
            turn.state = state.name();
            attempt.state = state.name();
            attempt.stage = stage.name();
        }

        @Override public void saveMemoryResult(String turnId, String attemptId, String memory, long now) {
            events.add("memory");
            attempt.memoryResult = memory;
            turn.state = TurnState.MEMORY_DONE.name();
            attempt.state = TurnState.MEMORY_DONE.name();
        }

        @Override public void saveRawReply(String turnId, String attemptId, String rawReply, long now) {
            events.add("chat");
            attempt.rawReply = rawReply;
            turn.state = TurnState.CHAT_DONE.name();
            attempt.state = TurnState.CHAT_DONE.name();
        }

        @Override public void commitReply(String turnId, String attemptId, List<ReplyPartEntity> parts, long now) {
            events.add("commit");
            replyParts.addAll(parts);
            turn.state = TurnState.COMPLETED.name();
            attempt.state = TurnState.COMPLETED.name();
        }

        @Override public void markInterrupted(String turnId, String attemptId, String code, long now) {
            turn.state = TurnState.INTERRUPTED.name();
            attempt.state = TurnState.INTERRUPTED.name();
            attempt.errorCode = code;
        }

        @Override public void markFailed(String turnId, String attemptId, String code, String detail, boolean retryable, long now) {
            turn.state = retryable ? TurnState.FAILED_RETRYABLE.name() : TurnState.FAILED_FINAL.name();
            attempt.state = turn.state;
            attempt.errorCode = code;
        }
    }
}
