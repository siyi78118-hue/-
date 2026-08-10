package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import com.siyi.al.execution.api.ParsedReply;
import com.siyi.al.execution.api.ReplyParser;
import com.siyi.al.execution.bridge.BridgeResult;
import com.siyi.al.execution.bridge.BridgeTurnStatus;
import com.siyi.al.execution.bridge.BridgeAcceptedException;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgeMode;
import com.siyi.al.execution.bridge.BridgeRouter;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ExecutionEngineTest {
    @Test
    public void rejectedWorkerCleanupWaitsForTerminationAndRunsOnce() throws Exception {
        ExecutorService worker = Executors.newSingleThreadExecutor();
        CountDownLatch running = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger cleanupCalls = new AtomicInteger();
        try {
            worker.execute(() -> {
                running.countDown();
                for (;;) {
                    try {
                        if (release.await(25L, TimeUnit.MILLISECONDS)) return;
                    } catch (InterruptedException ignored) {
                        // Model a worker that is still in its bounded operation
                        // cleanup despite shutdownNow interruption.
                    }
                }
            });
            assertTrue(running.await(2L, TimeUnit.SECONDS));
            worker.shutdownNow();
            AlExecutionService.deferCleanupAfterRejectedWorker(worker, cleanupCalls::incrementAndGet);
            assertEquals(0, cleanupCalls.get());
            release.countDown();
            assertTrue(worker.awaitTermination(2L, TimeUnit.SECONDS));
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2L);
            while (cleanupCalls.get() == 0 && System.nanoTime() < deadline) {
                Thread.yield();
            }
            assertEquals(1, cleanupCalls.get());
        } finally {
            release.countDown();
            worker.shutdownNow();
            worker.awaitTermination(2L, TimeUnit.SECONDS);
        }
    }

    @Test
    public void pinnedGatewayRejectsProviderSwapBeforeNetworkAndAcceptsStableIdentity() throws Exception {
        AtomicInteger selected = new AtomicInteger(0);
        AtomicInteger networkCalls = new AtomicInteger(0);
        BridgeRouter routerA = router("device-A", networkCalls);
        BridgeRouter routerB = router("device-B", networkCalls);
        NativeModelGateway gateway = new NativeModelGateway(null, null);
        gateway.setBridgeRouterProvider(() -> selected.get() == 0 ? routerA : routerB);
        TurnSubmission submission = new TurnSubmission(
            "turn-pinned", "yuqi", "source-pinned", TurnKind.DIRECT_REPLY,
            "{}", "{}", null, 1L);

        String pinned = gateway.bridgeDeviceId();
        selected.set(1);
        assertThrows(IllegalStateException.class,
            () -> gateway.executeBridgeTurnPinned(submission, pinned));
        assertEquals(0, networkCalls.get());

        selected.set(0);
        assertEquals(BridgeResult.Kind.LEGACY_V2,
            gateway.executeBridgeTurnPinned(submission, "device-A").kind);
        assertEquals(1, networkCalls.get());
    }

    private static BridgeRouter router(String deviceId, AtomicInteger networkCalls) {
        BridgeConfig config = new BridgeConfig(
            true, BridgeMode.LAN, "http://127.0.0.1:1", "", deviceId,
            "pairing-secret-123", "", "", 1200, 2000, 1, 100);
        return new BridgeRouter(
            config,
            submission -> {
                networkCalls.incrementAndGet();
                return BridgeResult.skipped("lan", "{}");
            },
            submission -> BridgeResult.skipped("cloud", "{}"),
            submission -> BridgeResult.success("fallback", "fallback"),
            new BridgeRouter.MessageMirror() {
                @Override public void persistSubmission(TurnSubmission ignored) {}
                @Override public void persistReply(TurnSubmission ignored, BridgeResult result) {}
            });
    }

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
    public void bridgeSubmissionIsPreparedImmediatelyBeforeNetworkExecution() throws Exception {
        FakeStore store = new FakeStore(turn("QUEUED", null), attempt("QUEUED", null));
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public String bridgeDeviceId() { return "device-from-gateway"; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) {
                store.bridgePreparationEvents.add("network");
                return BridgeResult.skipped("codex", "{}");
            }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                throw new AssertionError("legacy must not run");
            }
        };

        assertTrue(new ExecutionEngine(store, gateway, new ReplyParser(), () -> 100L).runNext());

        assertEquals("prepare,network", String.join(",", store.bridgePreparationEvents));
        assertEquals("device-from-gateway", store.preparedBridgeDeviceId);
    }

    @Test
    public void roleDeleteAfterPrepareSuppressesNetworkDispatch() throws Exception {
        FakeStore store = new FakeStore(turn("QUEUED", null), attempt("QUEUED", null));
        store.rejectPreparedBridge = true;
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public String bridgeDeviceId() { return "device-from-gateway"; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) {
                store.bridgePreparationEvents.add("network");
                return BridgeResult.skipped("codex", "{}");
            }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                throw new AssertionError("legacy must not run");
            }
        };

        assertTrue(new ExecutionEngine(store, gateway, new ReplyParser(), () -> 100L).runNext());
        assertEquals("prepare", String.join(",", store.bridgePreparationEvents));
    }

    @Test
    public void parsedV3TerminalUsesOnlyTheCanonicalWriter() throws Exception {
        ChatTurnEntity turn = turn("QUEUED", null);
        turn.bridgeProtocolVersion = 3;
        turn.characterId = "yuqi";
        turn.kind = TurnKind.PROACTIVE_CHAT.name();
        FakeStore store = new FakeStore(turn, attempt("QUEUED", null));
        BridgeResult terminal = canonicalSkipResult("turn-1");
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public String bridgeDeviceId() { return "device1"; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) { return terminal; }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                throw new AssertionError("legacy must not run");
            }
        };

        assertTrue(new ExecutionEngine(store, gateway, new ReplyParser(), () -> 100L).runNext());

        assertEquals(Collections.singletonList("canonical-terminal"), store.events);
    }

    @Test
    public void canonicalWriterConflictEscapesWithoutLegacyFailureOrCheckpointWrites() throws Exception {
        ChatTurnEntity turn = turn("QUEUED", null);
        turn.bridgeProtocolVersion = 3;
        turn.characterId = "yuqi";
        turn.kind = TurnKind.PROACTIVE_CHAT.name();
        FakeStore store = new FakeStore(turn, attempt("QUEUED", null));
        store.canonicalApplyFailure = new IllegalStateException("BRIDGE_AUTHORITY_CONFLICT");
        BridgeResult terminal = canonicalSkipResult("turn-1");
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public String bridgeDeviceId() { return "device1"; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) { return terminal; }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                throw new AssertionError("legacy must not run");
            }
        };

        assertThrows(IllegalStateException.class,
            () -> new ExecutionEngine(store, gateway, new ReplyParser(), () -> 100L).runNext());
        assertEquals(Collections.singletonList("canonical-terminal"), store.events);
    }

    @Test
    public void parsedV3VerifiedFailureUsesOnlyTheCanonicalFailureWriter() throws Exception {
        ChatTurnEntity turn = turn("QUEUED", null);
        turn.bridgeProtocolVersion = 3;
        turn.characterId = "yuqi";
        FakeStore store = new FakeStore(turn, attempt("QUEUED", null));
        BridgeResult failure = canonicalFailureResult("turn-1");
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public String bridgeDeviceId() { return "device1"; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) { return failure; }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                throw new AssertionError("legacy must not run");
            }
        };

        assertTrue(new ExecutionEngine(
            store, gateway, new ReplyParser(), () -> 100L).runNext());

        assertEquals(Collections.singletonList("canonical-failure"), store.events);
    }

    @Test
    public void storeOwnedV3WithoutAnAvailableBridgeFailsWithoutEnteringLegacyModelsOrWriters()
        throws Exception {
        ChatTurnEntity turn = turn("QUEUED", null);
        turn.bridgeProtocolVersion = 3;
        turn.characterId = "yuqi";
        FakeStore store = new FakeStore(turn, attempt("QUEUED", null));
        int[] legacyCalls = new int[]{0};
        TurnBridgeGateway unavailable = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return false; }
            @Override public String bridgeDeviceId() { throw new AssertionError("bridge identity must not be read"); }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) {
                throw new AssertionError("bridge execution must not start");
            }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                legacyCalls[0] += 1;
                return "legacy must not run";
            }
        };

        assertTrue(new ExecutionEngine(store, unavailable, new ReplyParser(), () -> 1500L).runNext());

        assertEquals(0, legacyCalls[0]);
        assertEquals(Collections.emptyList(), store.events);
        assertTrue(TurnState.FAILED_RETRYABLE.name().equals(store.turn.state)
            || TurnState.FAILED_FINAL.name().equals(store.turn.state));
        assertEquals(0, store.replyParts.size());
    }

    @Test
    public void storeOwnedV3LocalFallbackCommitsThroughTheAuthorityWriterOnly() throws Exception {
        ChatTurnEntity turn = turn("QUEUED", null);
        turn.bridgeProtocolVersion = 3;
        turn.characterId = "yuqi";
        FakeStore store = new FakeStore(turn, attempt("QUEUED", null));
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public String bridgeDeviceId() { return "device1"; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) {
                return BridgeResult.success("fallback", "我在。刚刚去倒了杯水");
            }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                throw new AssertionError("the legacy memory/chat pipeline must not run");
            }
        };

        assertTrue(new ExecutionEngine(
            store, gateway, new ReplyParser(), () -> 1500L).runNext());

        assertEquals(Collections.singletonList("android-fallback"), store.events);
        assertEquals(1, store.replyParts.size());
        assertEquals("我在。刚刚去倒了杯水", store.replyParts.get(0).content);
    }

    @Test
    public void v3LocalFallbackTreatsPendingPaymentAsNonTerminalInformation() throws Exception {
        ChatTurnEntity turn = turn("QUEUED", null);
        turn.bridgeProtocolVersion = 3;
        turn.characterId = "yuqi";
        FakeStore store = new FakeStore(turn, attempt("QUEUED", null));
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public String bridgeDeviceId() { return "device1"; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) {
                return BridgeResult.success("fallback", "我在。刚刚去倒了杯水", "{}", "pending");
            }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                throw new AssertionError("the legacy model path must not run");
            }
        };

        assertTrue(new ExecutionEngine(
            store, gateway, new ReplyParser(), () -> 1500L).runNext());

        assertEquals(Collections.singletonList("android-fallback"), store.events);
        assertEquals(1, store.replyParts.size());
        assertEquals("TEXT", store.replyParts.get(0).type);
        assertEquals("我在。刚刚去倒了杯水", store.replyParts.get(0).content);
    }

    @Test
    public void v3PendingPaymentWithoutVisibleTextDoesNotCommitATerminalReceipt() throws Exception {
        ChatTurnEntity turn = turn("QUEUED", null);
        turn.bridgeProtocolVersion = 3;
        turn.characterId = "yuqi";
        FakeStore store = new FakeStore(turn, attempt("QUEUED", null));
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public String bridgeDeviceId() { return "device1"; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) {
                return BridgeResult.success("fallback", "", "{}", "pending");
            }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                throw new AssertionError("the legacy model path must not run");
            }
        };

        assertTrue(new ExecutionEngine(
            store, gateway, new ReplyParser(), () -> 1500L).runNext());

        assertEquals(Collections.emptyList(), store.events);
        assertEquals(0, store.replyParts.size());
        assertTrue(TurnState.FAILED_RETRYABLE.name().equals(store.turn.state)
            || TurnState.FAILED_FINAL.name().equals(store.turn.state));
    }

    @Test
    public void v3LocalFallbackKeepsVisibleTextButDoesNotInventMissingRelationshipEvidence() throws Exception {
        ChatTurnEntity turn = turn("QUEUED", null);
        turn.bridgeProtocolVersion = 3;
        turn.characterId = "yuqi";
        FakeStore store = new FakeStore(turn, attempt("QUEUED", null));
        String legacyRelationship = new JSONObject()
            .put("baseAction", JSONObject.NULL)
            .put("phaseAction", new JSONObject().put("from", "normal").put("to", "conflict"))
            .toString();
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public String bridgeDeviceId() { return "device1"; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) {
                return BridgeResult.success(
                    "fallback", "我还在生气。", "{}", "", legacyRelationship, "");
            }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                throw new AssertionError("the legacy model path must not run");
            }
        };

        assertTrue(new ExecutionEngine(
            store, gateway, new ReplyParser(), () -> 1500L).runNext());

        assertEquals(Collections.singletonList("android-fallback"), store.events);
        assertEquals(1, store.replyParts.size());
        assertEquals("TEXT", store.replyParts.get(0).type);
        assertEquals("我还在生气。", store.replyParts.get(0).content);
    }

    @Test
    public void storeOwnedV3FallbackDraftMustPassTheLiveQualityGateBeforeCommit() throws Exception {
        ChatTurnEntity turn = turn("QUEUED", null);
        turn.bridgeProtocolVersion = 3;
        turn.characterId = "yuqi";
        FakeStore store = new FakeStore(turn, attempt("QUEUED", null));
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public String bridgeDeviceId() { return "device1"; }
            @Override public BridgeResult executeBridgeTurn(TurnSubmission submission) {
                return BridgeResult.success("fallback", "{\"reply\":\"不该直接显示\"}");
            }
            @Override public String call(String configId, String system, JSONArray messages, int maxTokens) {
                throw new IllegalStateException("rewrite rejected");
            }
        };

        assertTrue(new ExecutionEngine(
            store, gateway, new ReplyParser(), () -> 1500L).runNext());

        assertEquals(Collections.emptyList(), store.events);
        assertEquals(0, store.replyParts.size());
        assertTrue(TurnState.FAILED_RETRYABLE.name().equals(store.turn.state)
            || TurnState.FAILED_FINAL.name().equals(store.turn.state));
    }

    @Test
    public void storeOwnedV3MarkerReplacesCallerValueOnlyForFreshYuqiTurns() throws Exception {
        String supplied = new JSONObject()
            .put("scene", "chat")
            .put("_alBridgeProtocol", new JSONObject()
                .put("version", 99)
                .put("owner", "caller")
                .put("extra", "forged"))
            .toString();

        JSONObject yuqi = new JSONObject(RoomExecutionStore.snapshotForNewTurn(supplied, "yuqi"));
        JSONObject marker = yuqi.getJSONObject("_alBridgeProtocol");
        assertEquals(2, marker.length());
        assertEquals(3, marker.getInt("version"));
        assertEquals("room-v12", marker.getString("owner"));
        assertEquals("chat", yuqi.getString("scene"));

        JSONObject ordinary = new JSONObject(RoomExecutionStore.snapshotForNewTurn(supplied, "other"));
        assertEquals(false, ordinary.has("_alBridgeProtocol"));
        assertEquals("chat", ordinary.getString("scene"));
    }

    @Test
    public void bridgedAutomaticSkipCompletesWithoutCreatingReplyParts() throws Exception {
        ChatTurnEntity value = turn("QUEUED", null);
        value.kind = TurnKind.PROACTIVE_CHAT.name();
        FakeStore store = new FakeStore(value, attempt("QUEUED", null));
        TurnBridgeGateway gateway = new TurnBridgeGateway() {
            @Override public boolean hasBridge() { return true; }
            @Override public String bridgeDeviceId() { return "device1"; }
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
            @Override public String bridgeDeviceId() { return "device1"; }
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
            @Override public String bridgeDeviceId() { return "device1"; }
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
            @Override public String bridgeDeviceId() { return "device1"; }
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

    private static BridgeResult canonicalSkipResult(String turnId) throws Exception {
        String lineageKey = "lin_engine";
        JSONObject result = new JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", turnId)
            .put("roleId", "yuqi")
            .put("authorityOrigin", "pc")
            .put("authorityLineageKey", lineageKey)
            .put("visibleGroupId", AuthorityIdentity.groupId(lineageKey))
            .put("lineageRevision", 2L)
            .put("turnRevision", 4L)
            .put("laneKey", "private_chat")
            .put("laneRevision", 8L)
            .put("inputVisibilitySequence", 1L)
            .put("inputClearEpoch", 0L)
            .put("generationFingerprint", JSONObject.NULL)
            .put("releaseId", "cognition-v3")
            .put("commitPayloadVersion", "pc-visible-commit-v2")
            .put("commitChecksum", String.join("", Collections.nCopies(64, "a")))
            .put("terminalDisposition", "skip")
            .put("replyParts", new JSONArray())
            .put("actions", new JSONArray());
        return BridgeTurnStatus.parseV3(result.toString(), "lan", null);
    }

    private static BridgeResult canonicalFailureResult(String turnId) throws Exception {
        JSONObject failure = new JSONObject()
            .put("protocolVersion", 3)
            .put("type", "BACKLOG_FAILED")
            .put("turnId", turnId)
            .put("roleId", "yuqi")
            .put("authorityLineageKey", "lin_engine")
            .put("lineageRevision", 1L)
            .put("turnRevision", 2L)
            .put("laneKey", "private_chat")
            .put("laneRevision", 3L)
            .put("retryOfTurnId", JSONObject.NULL)
            .put("inputVisibilitySequence", 1L)
            .put("inputClearEpoch", 0L)
            .put("generationFingerprint", JSONObject.NULL)
            .put("releaseId", "cognition-v3")
            .put("state", "failed")
            .put("errorCode", "YUQI_TRANSIENT_EXECUTION_FAILURE")
            .put("failureClass", "transient")
            .put("retryAllowed", true)
            .put("failedAt", 99L);
        failure.put("rawStatusChecksum", BridgeAuthority.sha256CanonicalJson(failure));
        return BridgeTurnStatus.parseV3(
            failure.toString(), "cloud", "relay-engine-failure");
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

        @Override public String bridgeDeviceId() { return "device1"; }

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
        final List<String> bridgePreparationEvents = new ArrayList<>();
        String preparedBridgeDeviceId;
        RuntimeException canonicalApplyFailure;
        boolean rejectPreparedBridge;

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

        @Override public TurnSubmission prepareBridgeSubmission(TurnSubmission submission, String bridgeDeviceId, long now) {
            bridgePreparationEvents.add("prepare");
            preparedBridgeDeviceId = bridgeDeviceId;
            return submission;
        }

        @Override public void assertBridgeSubmissionStillAllowed(TurnSubmission submission) {
            if (rejectPreparedBridge) throw new IllegalStateException("role delete tombstone prevents bridge dispatch");
        }

        @Override public RoomExecutionStore.DeliveryDisposition commitBridgedTerminal(
            String turnId, String attemptId, BridgeResult result, long now) {
            events.add("canonical-terminal");
            if (canonicalApplyFailure != null) throw canonicalApplyFailure;
            return RoomExecutionStore.DeliveryDisposition.APPLY;
        }

        @Override public RoomExecutionStore.DeliveryDisposition commitAndroidFallback(
            String turnId,
            String attemptId,
            List<ReplyPartEntity> parts,
            String terminalDisposition,
            long now
        ) {
            events.add("android-fallback");
            replyParts.addAll(parts);
            turn.state = TurnState.COMPLETED.name();
            attempt.state = TurnState.COMPLETED.name();
            return RoomExecutionStore.DeliveryDisposition.APPLY;
        }

        @Override public void commitVerifiedRemoteFailure(
            String turnId, String attemptId, BridgeResult result, long now) {
            events.add("canonical-failure");
            if (canonicalApplyFailure != null) throw canonicalApplyFailure;
        }

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
