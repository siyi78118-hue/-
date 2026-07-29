package com.siyi.al.execution;

import com.siyi.al.execution.api.ApiProtocolException;
import com.siyi.al.execution.api.ParsedReply;
import com.siyi.al.execution.api.ParsedReplyPart;
import com.siyi.al.execution.api.ReplyParser;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.bridge.BridgeResult;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Locale;
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
            if ((state == TurnState.QUEUED || state == TurnState.MEMORY_RUNNING) && models instanceof TurnBridgeGateway
                && ((TurnBridgeGateway) models).hasBridge()) {
                processBridgedTurn(turn, attempt, (TurnBridgeGateway) models);
                return;
            }
            if (state == TurnState.QUEUED) {
                store.markStage(turn.turnId, attempt.attemptId, TurnState.MEMORY_RUNNING, AttemptStage.MEMORY, clock.now());
                state = TurnState.MEMORY_RUNNING;
            }
            if (state == TurnState.MEMORY_RUNNING) {
                String memory = models.call(
                    snapshot.getString("memoryConfigId"),
                    withExecutionTime(snapshot.getString("memorySystem"), clock.now()),
                    snapshot.optJSONArray("memoryMessages") == null ? new JSONArray() : snapshot.getJSONArray("memoryMessages"),
                    snapshot.optInt("memoryMaxTokens", 1400)
                );
                store.saveMemoryResult(turn.turnId, attempt.attemptId, memory, clock.now());
                attempt.memoryResult = memory;
                state = TurnState.MEMORY_DONE;
            }
            if (state == TurnState.MEMORY_DONE) {
                store.markStage(turn.turnId, attempt.attemptId, TurnState.CHAT_RUNNING, AttemptStage.CHAT, clock.now());
                String chatSystem = withExecutionTime(
                    withMemory(snapshot, snapshot.getString("chatSystem"), attempt.memoryResult),
                    clock.now()
                );
                String primaryReply = models.call(
                    snapshot.getString("chatConfigId"),
                    chatSystem,
                    exactChatMessages(snapshot),
                    snapshot.optInt("chatMaxTokens", 1000)
                );
                LiveReplyQualityGate qualityGate = new LiveReplyQualityGate();
                LiveReplyQualityGate.Context qualityContext =
                    LiveReplyQualityGate.Context.fromSnapshot(snapshot, attempt.memoryResult);
                LiveReplyQualityGate.Report qualityReport = qualityGate.inspect(primaryReply, qualityContext);
                String finalReply = primaryReply;
                if (qualityGate.shouldRewrite(qualityReport) && !"payment".equals(qualityContext.scene)) {
                    List<String> directives = LiveReplyQualityGate.hiddenDirectives(primaryReply);
                    JSONArray rewriteMessages = new JSONArray().put(new JSONObject()
                        .put("role", "user")
                        .put("content", qualityGate.buildRewriteInstruction(
                            primaryReply,
                            qualityReport,
                            DirectorCardCodec.directorText(attempt.memoryResult, snapshot),
                            qualityContext
                        )));
                    String rewritten = models.call(
                        snapshot.getString("chatConfigId"),
                        chatSystem,
                        rewriteMessages,
                        snapshot.optInt("chatMaxTokens", 1000)
                    );
                    finalReply = LiveReplyQualityGate.reattachDirectives(rewritten, directives);
                }
                store.saveRawReply(turn.turnId, attempt.attemptId, finalReply, clock.now());
                attempt.rawReply = finalReply;
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

    private void processBridgedTurn(ChatTurnEntity turn, ExecutionAttemptEntity attempt, TurnBridgeGateway gateway) throws Exception {
        if (TurnState.valueOf(turn.state) == TurnState.QUEUED) {
            store.markStage(turn.turnId, attempt.attemptId, TurnState.MEMORY_RUNNING, AttemptStage.MEMORY, clock.now());
        }
        long deadlineAnchor = Math.max(turn.createdAt, attempt.startedAt);
        TurnSubmission submission = new TurnSubmission(
            turn.turnId,
            turn.characterId,
            turn.sourceMessageId,
            TurnKind.valueOf(turn.kind),
            turn.inputJson,
            turn.snapshotJson,
            turn.cloudJobId,
            deadlineAnchor
        );
        BridgeResult result = gateway.executeBridgeTurn(submission);
        JSONObject checkpoint = new JSONObject()
            .put("origin", result.origin)
            .put("fallback", result.fallback)
            .put("attemptedRoutes", new JSONArray(result.attemptedRoutes));
        JSONObject bridgeResponse = new JSONObject(result.responseJson == null ? "{}" : result.responseJson);
        if (bridgeResponse.has("_relayMessageId") || bridgeResponse.has("deliveryItems")) {
            checkpoint.put("bridgeResponse", bridgeResponse);
        }
        store.saveMemoryResult(turn.turnId, attempt.attemptId, checkpoint.toString(), clock.now());
        store.markStage(turn.turnId, attempt.attemptId, TurnState.CHAT_RUNNING, AttemptStage.CHAT, clock.now());
        if (result.skipped) {
            store.commitSkip(turn.turnId, attempt.attemptId, clock.now());
            return;
        }
        String bridgedReply = result.replyText;
        if ("received".equals(result.paymentStatus) || "refused".equals(result.paymentStatus) || "pending".equals(result.paymentStatus)) {
            bridgedReply += "\n<al_payment>" + new JSONObject().put("status", result.paymentStatus).toString() + "</al_payment>";
        }
        if (!result.relationshipStageActionJson.isEmpty()) {
            bridgedReply += "\n<al_relationship_stage>" + result.relationshipStageActionJson + "</al_relationship_stage>";
        }
        if (!result.momentActionJson.isEmpty()) {
            bridgedReply += "\n<al_moment_action>" + result.momentActionJson + "</al_moment_action>";
        }
        if (!result.rolePlanOperationsJson.isEmpty()) {
            bridgedReply += "\n<al_plan>" + new JSONObject()
                .put("operations", new JSONArray(result.rolePlanOperationsJson)).toString() + "</al_plan>";
        }
        store.saveRawReply(turn.turnId, attempt.attemptId, bridgedReply, clock.now());
        attempt.rawReply = bridgedReply;
        commitStoredReply(turn, attempt);
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
        int start = Math.max(0, source.length() - 30);
        JSONArray selected = new JSONArray();
        for (int index = start; index < source.length(); index++) selected.put(source.opt(index));
        return selected;
    }

    private static String withMemory(JSONObject snapshot, String fullSystemPrompt, String rawMemory) {
        DirectorCardCodec.Context context = DirectorCardCodec.Context.fromSnapshot(snapshot);
        DirectorCardCodec.Result result = new DirectorCardCodec().parse(rawMemory, context);
        return fullSystemPrompt + "\n\n" + result.formatPrompt(
            snapshot.optString("playerName", "我"),
            snapshot.optString("characterName", "AL")
        );
    }

    private static String withExecutionTime(String system, long now) {
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(now);
        int hour = calendar.get(Calendar.HOUR_OF_DAY);
        String period = hour < 5 ? "凌晨" : hour < 9 ? "早上" : hour < 12 ? "上午" : hour < 14 ? "中午" : hour < 18 ? "下午" : hour < 23 ? "晚上" : "深夜";
        String formatted = new SimpleDateFormat("yyyy-MM-dd HH:mm EEEE", Locale.SIMPLIFIED_CHINESE).format(calendar.getTime());
        return system
            + "\n\n【原生执行时钟｜最高时间优先级】\n"
            + "当前设备时间：" + formatted + "（" + period + "）。\n"
            + "这是模型真正执行本轮任务的时间。若快照、历史消息或旧话题中的时间与这里冲突，必须以这里为当前时间；历史内容仍按其原日期理解，禁止把昨天说成今天、把下午说成半夜。";
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
