package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import com.siyi.al.execution.api.ParsedReply;
import com.siyi.al.execution.api.ReplyParser;
import com.siyi.al.execution.bridge.BridgeResult;
import com.siyi.al.execution.bridge.BridgeAcceptedException;
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
        assertTrue(gateway.chatSystem.contains("【本轮隐藏导演卡】"));
        assertTrue(gateway.chatSystem.contains("不是台词提纲"));
        assertTrue(gateway.chatSystem.contains("【记忆 AI 本轮筛选结果】"));
        assertTrue(gateway.chatSystem.contains("原生执行时钟"));
        assertEquals(30, gateway.chatMessageCount);
        assertEquals("消息175", gateway.firstChatMessage);
        assertEquals(1, gateway.chatCalls);
    }

    @Test
    public void enabledBridgeCompletesTheWholeTurnWithoutCallingLegacyStages() throws Exception {
        FakeStore store = new FakeStore(turn("QUEUED", null), attempt("QUEUED", null));
        BridgedGateway gateway = new BridgedGateway();
        ExecutionEngine engine = new ExecutionEngine(store, gateway, new ReplyParser(), () -> 100L);

        assertTrue(engine.runNext());

        assertEquals(1, gateway.bridgeCalls);
        assertEquals(0, gateway.legacyCalls);
        assertEquals("memory,chat,commit", String.join(",", store.events));
        assertEquals("虞栖从电脑回复", store.replyParts.get(0).content);
        JSONObject checkpoint = new JSONObject(store.attempt.memoryResult);
        assertEquals("relay_pc_1", checkpoint.getJSONObject("bridgeResponse").getString("_relayMessageId"));
    }

    @Test
    public void bridgedAutomaticSkipCompletesWithoutCreatingReplyParts() throws Exception {
        ChatTurnEntity value = turn("QUEUED", null);
        value.kind = TurnKind.PROACTIVE_CHAT.name();
        FakeStore store = new FakeStore(value, attempt("QUEUED", null));
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) { return BridgeResult.skipped("codex", "{}"); }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) { throw new AssertionError(); }
        };
        ExecutionEngine engine = new ExecutionEngine(store, gateway, new ReplyParser(), () -> 100L);

        assertTrue(engine.runNext());

        assertEquals("memory,skip", String.join(",", store.events));
        assertEquals(TurnState.COMPLETED.name(), store.turn.state);
        assertTrue(store.replyParts.isEmpty());
    }

    @Test
    public void bridgedPaymentDecisionCommitsVisibleTextAndPaymentStatusTogether() throws Exception {
        FakeStore store = new FakeStore(turn("QUEUED", null), attempt("QUEUED", null));
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) {
                return BridgeResult.success("codex", "那我就收了", "{}", "received");
            }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) { throw new AssertionError(); }
        };
        ExecutionEngine engine = new ExecutionEngine(store, gateway, new ReplyParser(), () -> 100L);

        assertTrue(engine.runNext());

        assertEquals(2, store.replyParts.size());
        assertEquals("TEXT", store.replyParts.get(0).type);
        assertEquals("PAYMENT_STATUS", store.replyParts.get(1).type);
        assertEquals("received", new JSONObject(store.replyParts.get(1).payloadJson).getString("status"));
    }

    @Test
    public void bridgedPlanOnlyDecisionCommitsOneHiddenPlanPartWithoutInventingText() throws Exception {
        ChatTurnEntity value = turn("QUEUED", null);
        value.kind = TurnKind.PROACTIVE_CHAT.name();
        FakeStore store = new FakeStore(value, attempt("QUEUED", null));
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) {
                return BridgeResult.success(
                    "codex", "", "{}", "", "", "",
                    "[{\"op\":\"cancel\",\"planId\":\"plan_old\"}]"
                );
            }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                throw new AssertionError();
            }
        };
        ExecutionEngine engine = new ExecutionEngine(store, gateway, new ReplyParser(), () -> 100L);

        assertTrue(engine.runNext());

        assertEquals(1, store.replyParts.size());
        assertEquals("PLAN", store.replyParts.get(0).type);
        assertTrue(store.replyParts.get(0).content.isEmpty());
        assertEquals("cancel", new JSONObject(store.replyParts.get(0).payloadJson)
            .getJSONArray("operations").getJSONObject(0).getString("op"));
    }

    @Test
    public void recoveredMemoryRunningBridgeResumesTheSameRemoteTurnWithoutLegacyStages() throws Exception {
        FakeStore store = new FakeStore(turn("MEMORY_RUNNING", null), attempt("MEMORY_RUNNING", null));
        BridgedGateway gateway = new BridgedGateway();
        ExecutionEngine engine = new ExecutionEngine(store, gateway, new ReplyParser(), () -> 100L);

        engine.recoverInterruptedWork();

        assertEquals(1, gateway.bridgeCalls);
        assertEquals(0, gateway.legacyCalls);
        assertEquals(TurnState.COMPLETED.name(), store.turn.state);
    }

    @Test
    public void acceptedCloudHandoffBecomesWaitingAndReleasesTheDrain() throws Exception {
        FakeStore store = new FakeStore(turn("QUEUED", null), attempt("QUEUED", null));
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) throws Exception {
                throw new BridgeAcceptedException("cloud");
            }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                throw new AssertionError("legacy must not run");
            }
        };

        assertTrue(new ExecutionEngine(store, gateway, new ReplyParser(), () -> 100L).runNext());

        assertEquals(TurnState.BRIDGE_WAITING.name(), store.turn.state);
        assertEquals("cloud-accepted", String.join(",", store.events));
        assertEquals(null, store.claimNext(101L));
    }

    @Test
    public void bridgedRetryUsesTheFreshAttemptTimeForItsDeadline() throws Exception {
        ChatTurnEntity turn = turn("QUEUED", null);
        turn.createdAt = 1L;
        ExecutionAttemptEntity retry = attempt("QUEUED", null);
        retry.sequence = 2;
        retry.startedAt = 5_000L;
        FakeStore store = new FakeStore(turn, retry);
        BridgedGateway gateway = new BridgedGateway();
        ExecutionEngine engine = new ExecutionEngine(store, gateway, new ReplyParser(), () -> 6_000L);

        assertTrue(engine.runNext());

        assertEquals(5_000L, gateway.submissionCreatedAt);
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
    public void ordinaryDrainResumesMemoryDoneAtChatStage() throws Exception {
        FakeStore store = new FakeStore(turn("MEMORY_DONE", null), attempt("MEMORY_DONE", null));
        store.attempt.memoryResult = "已筛选记忆";
        RecordingGateway gateway = new RecordingGateway();
        ExecutionEngine engine = engine(store, gateway);

        assertTrue(engine.runNext());

        assertEquals(Collections.singletonList("chat"), gateway.calls);
        assertEquals(TurnState.COMPLETED.name(), store.turn.state);
    }

    @Test
    public void ordinaryDrainCommitsChatDoneWithoutCallingModel() throws Exception {
        FakeStore store = new FakeStore(turn("CHAT_DONE", "已经生成😊"), attempt("CHAT_DONE", "已经生成😊"));
        RecordingGateway gateway = new RecordingGateway();
        ExecutionEngine engine = engine(store, gateway);

        assertTrue(engine.runNext());

        assertEquals(0, gateway.calls.size());
        assertEquals(TurnState.COMPLETED.name(), store.turn.state);
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

    @Test
    public void invalidReplyUsesAtMostOneRewriteAndCommitsOnlyRewrittenParts() throws Exception {
        FakeStore store = new FakeStore(turn("QUEUED", null), attempt("QUEUED", null));
        RecordingGateway gateway = new RecordingGateway("晚点说\nend_turn", "晚点再说。");
        ExecutionEngine engine = engine(store, gateway);

        assertTrue(engine.runNext());

        assertEquals(2, gateway.chatCalls);
        assertEquals(1, store.replyParts.size());
        assertEquals("晚点再说。", store.replyParts.get(0).content);
        assertTrue(store.replyParts.stream().noneMatch(part -> part.content.contains("end_turn")));
    }

    @Test
    public void invalidRewriteDoesNotLoop() throws Exception {
        FakeStore store = new FakeStore(turn("QUEUED", null), attempt("QUEUED", null));
        RecordingGateway gateway = new RecordingGateway("晚点说\nend_turn", "还是晚点\nend_turn");
        ExecutionEngine engine = engine(store, gateway);

        assertTrue(engine.runNext());

        assertEquals(2, gateway.chatCalls);
        assertEquals(TurnState.COMPLETED.name(), store.turn.state);
    }

    @Test
    public void rewritePreservesPrimaryHiddenDirectiveExactlyOnce() throws Exception {
        FakeStore store = new FakeStore(turn("QUEUED", null), attempt("QUEUED", null));
        RecordingGateway gateway = new RecordingGateway(
            "晚点说\nend_turn\n<al_schedule>{\"nextProactiveAt\":\"2026-07-29T12:00:00+08:00\"}</al_schedule>",
            "晚点再说。"
        );
        ExecutionEngine engine = engine(store, gateway);

        assertTrue(engine.runNext());

        assertEquals(2, gateway.chatCalls);
        assertEquals(2, store.replyParts.size());
        assertEquals("TEXT", store.replyParts.get(0).type);
        assertEquals("SCHEDULE", store.replyParts.get(1).type);
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
        snapshot.put("playerName", "姜隽倚");
        snapshot.put("characterName", "虞栖");
        snapshot.put("directorContext", new JSONObject()
            .put("scene", "chat")
            .put("nowMs", 100L)
            .put("lastMessageAt", 1L)
            .put("relationshipStageId", "familiar")
            .put("previousContactPressure", "none")
            .put("latestMessageIds", new JSONArray()));
        snapshot.put("memoryMaxTokens", 1400);
        snapshot.put("chatMaxTokens", 1000);
        snapshot.put("memoryMessages", new JSONArray().put(message("user", "候选记忆")));
        JSONArray chatMessages = new JSONArray();
        for (int i = 0; i < 205; i++) chatMessages.put(message(i % 2 == 0 ? "user" : "assistant", "消息" + i));
        snapshot.put("chatMessages", chatMessages);
        return snapshot;
    }

    private static JSONObject message(String role, String content) throws Exception {
        return new JSONObject().put("role", role).put("content", content);
    }

    private static final class RecordingGateway implements ModelGateway {
        final List<String> calls = new ArrayList<>();
        final List<String> chatReplies = new ArrayList<>();
        String chatSystem = "";
        int chatMessageCount;
        String firstChatMessage = "";
        int chatCalls;

        RecordingGateway(String... replies) {
            if (replies != null) Collections.addAll(chatReplies, replies);
        }

        @Override
        public String call(String configId, String system, JSONArray messages, int maxTokens) {
            if ("memory-config".equals(configId)) {
                calls.add("memory");
                return "{\"memoryPack\":\"2026-07-12：昨天约好周六语音\","
                    + "\"director\":{\"scene\":\"chat\",\"relationshipStageId\":\"familiar\","
                    + "\"replyImpulse\":\"answer\",\"contactPressure\":\"low\",\"confidence\":0.7}}";
            }
            calls.add("chat");
            chatCalls += 1;
            chatSystem = system;
            chatMessageCount = messages.length();
            firstChatMessage = messages.length() == 0 ? "" : messages.optJSONObject(0).optString("content");
            if (chatCalls <= chatReplies.size()) return chatReplies.get(chatCalls - 1);
            return "第一句😊\n第二句";
        }
    }

    private static final class BridgedGateway implements TurnBridgeGateway {
        int bridgeCalls;
        int legacyCalls;
        long submissionCreatedAt;

        @Override public boolean hasBridge() { return true; }

        @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) {
            bridgeCalls += 1;
            submissionCreatedAt = submission.createdAt;
            return BridgeResult.success(
                "cloud",
                "虞栖从电脑回复",
                "{\"turnId\":\"turn-1\",\"_relayMessageId\":\"relay_pc_1\","
                    + "\"reply\":{\"messageId\":\"msg_yuqi_1\",\"content\":\"虞栖从电脑回复\"}}"
            );
        }

        @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
            legacyCalls += 1;
            return "不应调用";
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
            TurnState state = TurnState.valueOf(turn.state);
            return state == TurnState.QUEUED || state == TurnState.MEMORY_DONE || state == TurnState.CHAT_DONE
                ? turn
                : null;
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

        @Override public void markBridgeWaiting(String turnId, String attemptId, String route, long now) {
            events.add(route + "-accepted");
            turn.state = TurnState.BRIDGE_WAITING.name();
            attempt.state = TurnState.BRIDGE_WAITING.name();
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

        @Override public void commitSkip(String turnId, String attemptId, long now) {
            events.add("skip");
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
