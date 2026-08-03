package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.database.Cursor;
import androidx.room.Room;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ConversationAuthorityEntity;
import com.siyi.al.execution.db.ConversationCursorEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.bridge.BridgeResult;
import com.siyi.al.execution.bridge.BridgeTurnStatus;
import com.siyi.al.execution.bridge.RoomBridgeMirror;
import java.util.Collections;
import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RoomExecutionStoreTest {
    private AlExecutionDatabase database;
    private RoomExecutionStore store;

    @Before
    public void setUp() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        database = Room.inMemoryDatabaseBuilder(context, AlExecutionDatabase.class)
            .allowMainThreadQueries()
            .build();
        store = new RoomExecutionStore(database);
    }

    @After
    public void tearDown() {
        database.close();
    }

    @Test
    public void canonicalVisibleTerminalCommitsReceiptPartsRawMessagesAuthorityAndCursorAtomically()
        throws Exception {
        String localTurnId = "local-v3-terminal";
        store.submitTurn(yuqiThreeBubbleSubmission(localTurnId, "msg-v3-terminal-3", 100L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 101L);
        ExecutionAttemptEntity attempt = store.activeAttempt(localTurnId);
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        BridgeResult result = BridgeTurnStatus.parseV3(
            canonicalTerminal(checkpoint, "visible", 3, new JSONArray()).toString(),
            "lan",
            null
        );

        RoomExecutionStore.DeliveryDisposition disposition = store.commitBridgedTerminal(
            localTurnId, attempt.attemptId, result, 200L);

        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY, disposition);
        ChatTurnEntity committed = store.turn(localTurnId);
        assertEquals(TurnState.COMPLETED.name(), committed.state);
        assertEquals(Long.valueOf(200L), committed.completedAt);
        assertEquals(result.visibleGroupId, committed.visibleGroupId);
        assertEquals(result.authorityLineageKey, committed.authorityLineageKey);
        assertEquals(Long.valueOf(2L), committed.lineageRevision);
        assertEquals(Long.valueOf(4L), committed.turnRevision);
        assertEquals(Long.valueOf(8L), committed.laneRevision);
        assertEquals("pc", committed.authorityOrigin);
        assertEquals(result.commitPayloadVersion, committed.commitPayloadVersion);
        assertEquals(result.generationFingerprint, committed.generationFingerprint);
        assertEquals(result.releaseId, committed.pipelineReleaseId);
        assertEquals(Long.valueOf(result.inputVisibilitySequence),
            committed.inputVisibilitySequence);
        assertEquals(Long.valueOf(result.inputClearEpoch), committed.inputClearEpoch);
        assertEquals(result.commitChecksum, committed.bridgeCommitChecksum);
        assertEquals("visible", committed.terminalDisposition);

        java.util.List<ReplyPartEntity> storedParts = store.replyParts(localTurnId);
        assertEquals(3, storedParts.size());
        for (int ordinal = 0; ordinal < 3; ordinal += 1) {
            JSONObject canonicalItem = new JSONObject(result.replyPartsJson.get(ordinal));
            ReplyPartEntity part = storedParts.get(ordinal);
            assertEquals(canonicalItem.getString("messageId"), part.replyPartId);
            assertEquals(attempt.attemptId, part.attemptId);
            assertEquals(ordinal, part.sequence);
            assertEquals("TEXT", part.type);
            assertEquals(canonicalItem.getString("content"), part.content);
            assertEquals(BridgeAuthority.canonicalJson(new JSONObject()
                .put("version", 1)
                .put("canonicalItem", canonicalItem)), part.payloadJson);
            assertEquals(200L, part.createdAt);

            RawMessageEntity raw = database.executionDao().rawMessage(part.replyPartId);
            assertEquals(canonicalItem.getString("messageId"), raw.messageId);
            assertEquals(result.authoritativeTurnId, raw.turnId);
            assertEquals(result.roleId, raw.characterId);
            assertEquals(canonicalItem.getString("speakerId"), raw.speakerId);
            assertEquals(canonicalItem.getString("speakerType"), raw.speakerType);
            assertEquals(canonicalItem.getString("recipientId"), raw.recipientId);
            assertEquals(canonicalItem.getString("content"), raw.content);
            assertEquals(checkpoint.getJSONObject("normalizedEnvelope").getLong("createdAt") + ordinal,
                raw.sentAt);
            assertEquals("pc", raw.origin);
            assertEquals("pc-group:" + result.visibleGroupId, raw.deviceId);
            assertEquals(ordinal + 1L, raw.deviceSeq);
            assertEquals(0L, raw.syncSeq);
            assertEquals(RoomExecutionStore.canonicalRawMessageChecksum(raw), raw.checksum);
        }

        ConversationAuthorityEntity authority = database.executionDao().conversationAuthority(
            result.authorityLineageKey);
        assertEquals("COMMITTED", authority.state);
        assertEquals(result.authoritativeTurnId, authority.latestTurnId);
        assertEquals(2L, authority.revision);
        ConversationCursorEntity cursor = store.getConversationCursor("yuqi");
        assertEquals(localTurnId, cursor.nativeCompletedTurnId);
        assertEquals(result.visibleGroupId, cursor.nativeCompletedGroupId);
        assertEquals(result.inputVisibilitySequence, cursor.nativeCompletedSequence);
        assertEquals(0L, cursor.uiAppliedSequence);

        JSONObject storedCheckpoint = new JSONObject(
            database.executionDao().attempt(attempt.attemptId).bridgeAuthorityCheckpointJson);
        assertEquals(prepared.authoritativeTurnId,
            storedCheckpoint.getString("authoritativeTurnId"));
        assertEquals("committed", storedCheckpoint.getJSONObject("outcome").getString("type"));
        assertEquals(result.authoritativeTurnId,
            storedCheckpoint.getJSONObject("outcome").getJSONObject("result").getString("turnId"));

        long changes = rowCount("change_events");
        RoomExecutionStore restarted = new RoomExecutionStore(database);
        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            restarted.commitBridgedTerminal(localTurnId, attempt.attemptId, result, 999L));
        assertEquals(3, restarted.replyParts(localTurnId).size());
        assertEquals(changes, rowCount("change_events"));
        assertEquals(Long.valueOf(200L), store.turn(localTurnId).completedAt);
        BridgeResult changedRoute = BridgeTurnStatus.parseV3(
            canonicalTerminal(checkpoint, "visible", 3, new JSONArray()).toString(),
            "cloud", "relay-changed-route");
        assertThrows(IllegalStateException.class, () -> store.commitBridgedTerminal(
            localTurnId, attempt.attemptId, changedRoute, 1000L));
        JSONObject changedReceiptWire = canonicalTerminal(
            checkpoint, "visible", 3, new JSONArray());
        changedReceiptWire.put("commitChecksum",
            "0000000000000000000000000000000000000000000000000000000000000000");
        BridgeResult changedReceipt = BridgeTurnStatus.parseV3(
            changedReceiptWire.toString(), "lan", null);
        assertThrows(IllegalStateException.class, () -> store.commitBridgedTerminal(
            localTurnId, attempt.attemptId, changedReceipt, 1001L));
        assertEquals(3, store.replyParts(localTurnId).size());
        assertEquals(changes, rowCount("change_events"));
    }

    @Test
    public void canonicalActionOnlyAndAutomaticSkipUseDistinctClosedProjectionsAndCursors()
        throws Exception {
        String actionTurnId = "local-v3-action-only";
        store.submitTurn(yuqiThreeBubbleSubmission(actionTurnId, "msg-action-only-3", 220L));
        TurnSubmission actionPrepared = store.prepareBridgeSubmission(
            persistedSubmission(actionTurnId), "device_gateway", 221L);
        JSONObject actionCheckpoint = new JSONObject(actionPrepared.bridgeAuthorityCheckpointJson);
        JSONArray actions = new JSONArray()
            .put(canonicalAction(actionCheckpoint, 0, "payment_accept",
                "payment:msg-payment", "rev-payment", new JSONObject().put("messageId", "msg-payment")))
            .put(canonicalAction(actionCheckpoint, 1, "role_plan_create",
                "role-plan:plan-1", "rev-plan", new JSONObject().put("planId", "plan-1")));
        BridgeResult actionResult = BridgeTurnStatus.parseV3(
            canonicalTerminal(actionCheckpoint, "action_only", 0, actions).toString(), "lan", null);

        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.commitBridgedTerminal(
                actionTurnId, store.activeAttempt(actionTurnId).attemptId, actionResult, 230L));
        java.util.List<ReplyPartEntity> actionParts = store.replyParts(actionTurnId);
        assertEquals(2, actionParts.size());
        assertEquals("PAYMENT_STATUS", actionParts.get(0).type);
        assertEquals("PLAN", actionParts.get(1).type);
        assertEquals("", actionParts.get(0).content);
        assertEquals(0, database.executionDao().canonicalCharacterMessages(
            actionResult.authoritativeTurnId).size());
        ConversationCursorEntity afterAction = store.getConversationCursor("yuqi");
        assertEquals(actionTurnId, afterAction.nativeCompletedTurnId);
        assertEquals(actionResult.visibleGroupId, afterAction.nativeCompletedGroupId);
        assertEquals(0L, afterAction.uiAppliedSequence);

        String rejectedSkipTurnId = "local-v3-direct-skip";
        store.submitTurn(yuqiThreeBubbleSubmission(
            rejectedSkipTurnId, "msg-direct-skip-3", 235L));
        TurnSubmission rejectedSkipPrepared = store.prepareBridgeSubmission(
            persistedSubmission(rejectedSkipTurnId), "device_gateway", 236L);
        JSONObject rejectedSkipCheckpoint = new JSONObject(
            rejectedSkipPrepared.bridgeAuthorityCheckpointJson);
        BridgeResult rejectedSkip = BridgeTurnStatus.parseV3(
            canonicalTerminal(
                rejectedSkipCheckpoint, "skip", 0, new JSONArray()).toString(),
            "lan", null);
        assertThrows(IllegalStateException.class, () -> store.commitBridgedTerminal(
            rejectedSkipTurnId, store.activeAttempt(rejectedSkipTurnId).attemptId,
            rejectedSkip, 237L));
        assertEquals(TurnState.MEMORY_RUNNING.name(), store.turn(rejectedSkipTurnId).state);
        assertEquals(0, store.replyParts(rejectedSkipTurnId).size());

        String skipTurnId = "local-v3-skip";
        store.submitTurn(yuqiAutomaticSubmission(skipTurnId, 240L));
        TurnSubmission skipPrepared = store.prepareBridgeSubmission(
            persistedSubmission(skipTurnId), "device_gateway", 241L);
        JSONObject skipCheckpoint = new JSONObject(skipPrepared.bridgeAuthorityCheckpointJson);
        BridgeResult skipResult = BridgeTurnStatus.parseV3(
            canonicalTerminal(skipCheckpoint, "skip", 0, new JSONArray()).toString(), "lan", null);

        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.commitBridgedTerminal(
                skipTurnId, store.activeAttempt(skipTurnId).attemptId, skipResult, 250L));
        ChatTurnEntity skipped = store.turn(skipTurnId);
        assertEquals(TurnState.COMPLETED.name(), skipped.state);
        assertEquals(Long.valueOf(250L), skipped.uiAppliedAt);
        assertEquals(0, store.replyParts(skipTurnId).size());
        ConversationCursorEntity afterSkip = store.getConversationCursor("yuqi");
        assertEquals(skipTurnId, afterSkip.nativeCompletedTurnId);
        assertEquals(skipTurnId, afterSkip.uiAppliedTurnId);
        assertEquals(skipResult.visibleGroupId, afterSkip.nativeCompletedGroupId);
        assertEquals(skipResult.visibleGroupId, afterSkip.uiAppliedGroupId);
        assertEquals(skipResult.inputVisibilitySequence, afterSkip.nativeCompletedSequence);
        assertEquals(skipResult.inputVisibilitySequence, afterSkip.uiAppliedSequence);
    }

    @Test
    public void oldEpochCanonicalTerminalStoresOnlyMetadataAndNeverMovesCursors()
        throws Exception {
        String localTurnId = "local-v3-redacted";
        store.submitTurn(yuqiThreeBubbleSubmission(localTurnId, "msg-redacted-3", 260L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 261L);
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        BridgeResult result = BridgeTurnStatus.parseV3(
            canonicalTerminal(checkpoint, "visible", 2, new JSONArray()).toString(), "lan", null);
        store.markConversationCleared("yuqi", 0L, 1L, 270L);
        ConversationCursorEntity before = store.getConversationCursor("yuqi");

        assertEquals(RoomExecutionStore.DeliveryDisposition.REDACTED,
            store.commitBridgedTerminal(
                localTurnId, store.activeAttempt(localTurnId).attemptId, result, 280L));
        ChatTurnEntity redacted = store.turn(localTurnId);
        assertEquals(TurnState.COMPLETED.name(), redacted.state);
        assertEquals(Long.valueOf(280L), redacted.deletedAt);
        assertEquals(null, redacted.uiAppliedAt);
        assertEquals("visible", redacted.terminalDisposition);
        assertEquals(0, store.replyParts(localTurnId).size());
        assertEquals(0, database.executionDao().canonicalCharacterMessages(
            result.authoritativeTurnId).size());
        ConversationCursorEntity after = store.getConversationCursor("yuqi");
        assertEquals(before.localSequence, after.localSequence);
        assertEquals(before.nativeCompletedSequence, after.nativeCompletedSequence);
        assertEquals(before.uiAppliedSequence, after.uiAppliedSequence);
        JSONObject storedCheckpoint = new JSONObject(
            database.executionDao().attempt(store.turn(localTurnId).activeAttemptId)
                .bridgeAuthorityCheckpointJson);
        JSONObject outcome = storedCheckpoint.getJSONObject("outcome");
        assertEquals("redacted", outcome.getString("type"));
        assertEquals(17, outcome.getJSONObject("result").length());
        assertEquals(false, outcome.getJSONObject("result").has("replyParts"));
        assertEquals(false, outcome.getJSONObject("result").has("actions"));
        assertEquals(RoomExecutionStore.DeliveryDisposition.REDACTED,
            store.commitBridgedTerminal(
                localTurnId, store.activeAttempt(localTurnId).attemptId, result, 999L));
        JSONObject changedReceiptWire = canonicalTerminal(
            checkpoint, "visible", 2, new JSONArray());
        changedReceiptWire.put("commitChecksum",
            "0000000000000000000000000000000000000000000000000000000000000000");
        BridgeResult changedReceipt = BridgeTurnStatus.parseV3(
            changedReceiptWire.toString(), "lan", null);
        assertThrows(IllegalStateException.class, () -> store.commitBridgedTerminal(
            localTurnId, store.activeAttempt(localTurnId).attemptId, changedReceipt, 1000L));
        assertEquals(0, store.replyParts(localTurnId).size());
    }

    @Test
    public void verifiedRemoteFailureIsMetadataOnlyIdempotentAndNeverAdvancesAuthorityOrCursor()
        throws Exception {
        String localTurnId = "local-v3-verified-failure";
        store.submitTurn(yuqiThreeBubbleSubmission(localTurnId, "msg-failure-3", 300L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 301L);
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        JSONObject failureWire = canonicalFailure(checkpoint, true, 302L);
        BridgeResult result = BridgeTurnStatus.parseV3(
            failureWire.toString(), "cloud", "relay-failure-1");
        ExecutionAttemptEntity attempt = store.activeAttempt(localTurnId);
        ConversationAuthorityEntity beforeAuthority = database.executionDao().conversationAuthority(
            checkpoint.getString("authorityLineageKey"));
        ConversationCursorEntity beforeCursor = store.getConversationCursor("yuqi");

        store.commitVerifiedRemoteFailure(localTurnId, attempt.attemptId, result, 303L);

        ChatTurnEntity failed = store.turn(localTurnId);
        assertEquals(TurnState.FAILED_RETRYABLE.name(), failed.state);
        assertEquals(null, failed.visibleGroupId);
        assertEquals(0, store.replyParts(localTurnId).size());
        ConversationAuthorityEntity afterAuthority = database.executionDao().conversationAuthority(
            checkpoint.getString("authorityLineageKey"));
        assertEquals("OPEN", afterAuthority.state);
        assertEquals(beforeAuthority.revision, afterAuthority.revision);
        ConversationCursorEntity afterCursor = store.getConversationCursor("yuqi");
        assertEquals(beforeCursor.localSequence, afterCursor.localSequence);
        assertEquals(beforeCursor.nativeCompletedSequence, afterCursor.nativeCompletedSequence);
        assertEquals(1L, rowCount("diagnostics") - 1L);
        long changes = rowCount("change_events");
        long diagnostics = rowCount("diagnostics");
        store.commitVerifiedRemoteFailure(localTurnId, attempt.attemptId, result, 999L);
        assertEquals(changes, rowCount("change_events"));
        assertEquals(diagnostics, rowCount("diagnostics"));

        BridgeResult changedRoute = BridgeTurnStatus.parseV3(
            failureWire.toString(), "cloud", "relay-failure-changed");
        assertThrows(IllegalStateException.class, () -> store.commitVerifiedRemoteFailure(
            localTurnId, attempt.attemptId, changedRoute, 1000L));

        JSONObject changedFailure = canonicalFailure(checkpoint, false, 302L);
        BridgeResult changed = BridgeTurnStatus.parseV3(
            changedFailure.toString(), "cloud", "relay-failure-1");
        assertThrows(IllegalStateException.class, () -> store.commitVerifiedRemoteFailure(
            localTurnId, attempt.attemptId, changed, 304L));
    }

    @Test
    public void everyCanonicalTerminalFaultBoundaryRollsBackTheWholeOuterTransaction()
        throws Exception {
        String localTurnId = "local-v3-terminal-faults";
        store.submitTurn(yuqiThreeBubbleSubmission(localTurnId, "msg-faults-3", 330L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 331L);
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        JSONArray actions = new JSONArray().put(canonicalAction(
            checkpoint, 0, "role_plan_create", "role-plan:fault-plan", "rev-fault-plan",
            new JSONObject().put("planId", "fault-plan")));
        BridgeResult result = BridgeTurnStatus.parseV3(
            canonicalTerminal(checkpoint, "visible", 2, actions).toString(), "lan", null);
        ExecutionAttemptEntity attempt = store.activeAttempt(localTurnId);
        long changes = rowCount("change_events");
        long diagnostics = rowCount("diagnostics");
        String[] boundaries = new String[]{
            RoomExecutionStore.FAULT_CHECKPOINT,
            RoomExecutionStore.FAULT_REPLY_PARTS,
            RoomExecutionStore.FAULT_RAW_MESSAGES,
            RoomExecutionStore.FAULT_AUTHORITY,
            RoomExecutionStore.FAULT_TURN,
            RoomExecutionStore.FAULT_ATTEMPT,
            RoomExecutionStore.FAULT_NATIVE_CURSOR,
            RoomExecutionStore.FAULT_CHANGE
        };
        for (String boundary : boundaries) {
            RoomExecutionStore faulted = new RoomExecutionStore(database, reached -> {
                if (boundary.equals(reached)) throw new IllegalStateException("fault:" + reached);
            });
            assertThrows(IllegalStateException.class, () -> faulted.commitBridgedTerminal(
                localTurnId, attempt.attemptId, result, 340L));
            assertOpenCanonicalAttemptAfterRollback(
                localTurnId, attempt.attemptId, checkpoint, changes, diagnostics);
        }

        String actionTurnId = "local-v3-action-fault";
        store.submitTurn(yuqiThreeBubbleSubmission(
            actionTurnId, "msg-action-fault-3", 345L));
        TurnSubmission actionPrepared = store.prepareBridgeSubmission(
            persistedSubmission(actionTurnId), "device_gateway", 346L);
        JSONObject actionCheckpoint = new JSONObject(actionPrepared.bridgeAuthorityCheckpointJson);
        BridgeResult actionOnly = BridgeTurnStatus.parseV3(
            canonicalTerminal(
                actionCheckpoint,
                "action_only",
                0,
                new JSONArray().put(canonicalAction(
                    actionCheckpoint,
                    0,
                    "role_plan_create",
                    "role-plan:action-fault",
                    "rev-action-fault",
                    new JSONObject().put("planId", "action-fault")
                ))
            ).toString(),
            "lan",
            null
        );
        String actionAttemptId = store.activeAttempt(actionTurnId).attemptId;
        long actionChanges = rowCount("change_events");
        long actionDiagnostics = rowCount("diagnostics");
        String[] actionBoundaries = new String[]{
            RoomExecutionStore.FAULT_CHECKPOINT,
            RoomExecutionStore.FAULT_REPLY_PARTS,
            RoomExecutionStore.FAULT_AUTHORITY,
            RoomExecutionStore.FAULT_TURN,
            RoomExecutionStore.FAULT_ATTEMPT,
            RoomExecutionStore.FAULT_NATIVE_CURSOR,
            RoomExecutionStore.FAULT_CHANGE
        };
        for (String boundary : actionBoundaries) {
            RoomExecutionStore faulted = new RoomExecutionStore(database, reached -> {
                if (boundary.equals(reached)) throw new IllegalStateException("fault:" + reached);
            });
            assertThrows(IllegalStateException.class, () -> faulted.commitBridgedTerminal(
                actionTurnId, actionAttemptId, actionOnly, 349L));
            assertOpenCanonicalAttemptAfterRollback(
                actionTurnId, actionAttemptId, actionCheckpoint,
                actionChanges, actionDiagnostics);
        }

        String skipTurnId = "local-v3-skip-fault";
        store.submitTurn(yuqiAutomaticSubmission(skipTurnId, 350L));
        TurnSubmission skipPrepared = store.prepareBridgeSubmission(
            persistedSubmission(skipTurnId), "device_gateway", 351L);
        JSONObject skipCheckpoint = new JSONObject(skipPrepared.bridgeAuthorityCheckpointJson);
        BridgeResult skip = BridgeTurnStatus.parseV3(
            canonicalTerminal(skipCheckpoint, "skip", 0, new JSONArray()).toString(), "lan", null);
        String skipAttemptId = store.activeAttempt(skipTurnId).attemptId;
        long skipChanges = rowCount("change_events");
        long skipDiagnostics = rowCount("diagnostics");
        String[] skipBoundaries = new String[]{
            RoomExecutionStore.FAULT_CHECKPOINT,
            RoomExecutionStore.FAULT_AUTHORITY,
            RoomExecutionStore.FAULT_TURN,
            RoomExecutionStore.FAULT_ATTEMPT,
            RoomExecutionStore.FAULT_NATIVE_CURSOR,
            RoomExecutionStore.FAULT_UI_CURSOR,
            RoomExecutionStore.FAULT_CHANGE
        };
        for (String boundary : skipBoundaries) {
            RoomExecutionStore skipFaulted = new RoomExecutionStore(database, reached -> {
                if (boundary.equals(reached)) throw new IllegalStateException("fault:" + reached);
            });
            assertThrows(IllegalStateException.class, () -> skipFaulted.commitBridgedTerminal(
                skipTurnId, skipAttemptId, skip, 360L));
            assertOpenCanonicalAttemptAfterRollback(
                skipTurnId, skipAttemptId, skipCheckpoint, skipChanges, skipDiagnostics);
        }

        String redactedTurnId = "local-v3-redacted-fault";
        store.submitTurn(yuqiThreeBubbleSubmission(
            redactedTurnId, "msg-redacted-fault-3", 370L));
        TurnSubmission redactedPrepared = store.prepareBridgeSubmission(
            persistedSubmission(redactedTurnId), "device_gateway", 371L);
        JSONObject redactedCheckpoint = new JSONObject(
            redactedPrepared.bridgeAuthorityCheckpointJson);
        BridgeResult redacted = BridgeTurnStatus.parseV3(
            canonicalTerminal(redactedCheckpoint, "visible", 1, new JSONArray()).toString(),
            "lan", null);
        store.markConversationCleared("yuqi", 0L,
            redactedCheckpoint.getLong("inputClearEpoch") + 1L, 372L);
        String redactedAttemptId = store.activeAttempt(redactedTurnId).attemptId;
        long redactedChanges = rowCount("change_events");
        long redactedDiagnostics = rowCount("diagnostics");
        String[] redactedBoundaries = new String[]{
            RoomExecutionStore.FAULT_CHECKPOINT,
            RoomExecutionStore.FAULT_AUTHORITY,
            RoomExecutionStore.FAULT_TURN,
            RoomExecutionStore.FAULT_ATTEMPT,
            RoomExecutionStore.FAULT_CHANGE
        };
        for (String boundary : redactedBoundaries) {
            RoomExecutionStore redactedFaulted = new RoomExecutionStore(database, reached -> {
                if (boundary.equals(reached)) throw new IllegalStateException("fault:" + reached);
            });
            assertThrows(IllegalStateException.class, () -> redactedFaulted.commitBridgedTerminal(
                redactedTurnId, redactedAttemptId, redacted, 380L));
            assertOpenCanonicalAttemptAfterRollback(
                redactedTurnId, redactedAttemptId, redactedCheckpoint,
                redactedChanges, redactedDiagnostics);
        }
    }

    @Test
    public void everyVerifiedFailureFaultBoundaryRollsBackCheckpointTurnAttemptAndAudits()
        throws Exception {
        String localTurnId = "local-v3-failure-faults";
        store.submitTurn(yuqiThreeBubbleSubmission(
            localTurnId, "msg-failure-faults-3", 400L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 401L);
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        BridgeResult result = BridgeTurnStatus.parseV3(
            canonicalFailure(checkpoint, true, 402L).toString(),
            "cloud", "relay-failure-faults");
        String attemptId = store.activeAttempt(localTurnId).attemptId;
        long changes = rowCount("change_events");
        long diagnostics = rowCount("diagnostics");
        String[] boundaries = new String[]{
            RoomExecutionStore.FAULT_FAILURE_CHECKPOINT,
            RoomExecutionStore.FAULT_FAILURE_TURN,
            RoomExecutionStore.FAULT_FAILURE_ATTEMPT,
            RoomExecutionStore.FAULT_FAILURE_CHANGE,
            RoomExecutionStore.FAULT_FAILURE_DIAGNOSTIC
        };
        for (String boundary : boundaries) {
            RoomExecutionStore faulted = new RoomExecutionStore(database, reached -> {
                if (boundary.equals(reached)) throw new IllegalStateException("fault:" + reached);
            });
            assertThrows(IllegalStateException.class, () -> faulted.commitVerifiedRemoteFailure(
                localTurnId, attemptId, result, 410L));
            assertOpenCanonicalAttemptAfterRollback(
                localTurnId, attemptId, checkpoint, changes, diagnostics);
        }
    }

    @Test
    public void activeRemoteChildCanFinishFromAnEarlierReceiptMemberWithoutRewritingItsIdentity()
        throws Exception {
        String localTurnId = "local-v3-earlier-receipt";
        store.submitTurn(yuqiThreeBubbleSubmission(
            localTurnId, "msg-earlier-receipt-3", 430L));
        TurnSubmission parent = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 431L);
        JSONObject parentCheckpoint = new JSONObject(parent.bridgeAuthorityCheckpointJson);
        ExecutionAttemptEntity parentAttempt = store.activeAttempt(localTurnId);
        BridgeResult verifiedFailure = BridgeTurnStatus.parseV3(
            canonicalFailure(parentCheckpoint, true, 432L).toString(),
            "cloud", "relay-earlier-parent-failure");
        store.commitVerifiedRemoteFailure(
            localTurnId, parentAttempt.attemptId, verifiedFailure, 433L);

        ExecutionAttemptEntity childAttempt = store.startRetry(localTurnId, 434L);
        TurnSubmission child = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 435L);
        JSONObject childCheckpoint = new JSONObject(child.bridgeAuthorityCheckpointJson);
        assertNotEquals(parent.authoritativeTurnId, child.authoritativeTurnId);
        assertEquals(parent.authoritativeTurnId, childCheckpoint.getString("retryOfTurnId"));
        assertEquals(2L, childCheckpoint.getLong("claimedLineageRevision"));

        BridgeResult parentReceipt = BridgeTurnStatus.parseV3(
            canonicalTerminal(parentCheckpoint, "visible", 1, new JSONArray()).toString(),
            "lan", null);
        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.commitBridgedTerminal(
                localTurnId, childAttempt.attemptId, parentReceipt, 440L));

        JSONObject storedChildCheckpoint = new JSONObject(
            database.executionDao().attempt(childAttempt.attemptId)
                .bridgeAuthorityCheckpointJson);
        assertEquals(child.authoritativeTurnId,
            storedChildCheckpoint.getString("authoritativeTurnId"));
        assertEquals(parent.authoritativeTurnId,
            storedChildCheckpoint.getJSONObject("outcome")
                .getJSONObject("result").getString("turnId"));
        ConversationAuthorityEntity authority = database.executionDao().conversationAuthority(
            parentReceipt.authorityLineageKey);
        assertEquals(parent.authoritativeTurnId, authority.latestTurnId);
        assertEquals(parentReceipt.lineageRevision, authority.revision);
        ConversationCursorEntity cursor = store.getConversationCursor("yuqi");
        assertEquals(2L, cursor.localSequence);
        assertEquals(1L, cursor.nativeCompletedSequence);
        assertEquals(localTurnId, cursor.nativeCompletedTurnId);
        assertEquals(parentReceipt.visibleGroupId, cursor.nativeCompletedGroupId);
        assertEquals(parent.authoritativeTurnId,
            database.executionDao().canonicalCharacterMessages(
                parent.authoritativeTurnId).get(0).turnId);
        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.commitBridgedTerminal(
                localTurnId, childAttempt.attemptId, parentReceipt, 999L));
    }

    @Test
    public void canonicalCloudTargetResolvesAfterRestartWithoutRecoverableAttemptScanning()
        throws Exception {
        String localTurnId = "local-v3-cloud-resolve";
        store.submitTurn(yuqiThreeBubbleSubmission(
            localTurnId, "msg-cloud-resolve-3", 445L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 446L);
        ExecutionAttemptEntity attempt = store.activeAttempt(localTurnId);
        store.markBridgeWaiting(localTurnId, attempt.attemptId, "cloud", 447L);
        assertEquals(0, database.executionDao().recoverableAttempts().size());
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);

        RoomExecutionStore restarted = new RoomExecutionStore(database);
        RoomExecutionStore.CanonicalCloudTarget target = restarted.resolveCanonicalCloudTarget(
            checkpoint.getString("authorityLineageKey"),
            checkpoint.getString("authoritativeTurnId")
        );

        assertEquals(localTurnId, target.localTurnId);
        assertEquals(attempt.attemptId, target.activeAttemptId);
    }

    @Test
    public void canonicalCloudTargetUsesTheCurrentRetryForAnEarlierRemoteMember()
        throws Exception {
        String localTurnId = "local-v3-cloud-earlier-member";
        store.submitTurn(yuqiThreeBubbleSubmission(
            localTurnId, "msg-cloud-earlier-member-3", 448L));
        TurnSubmission parent = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 449L);
        JSONObject parentCheckpoint = new JSONObject(parent.bridgeAuthorityCheckpointJson);
        ExecutionAttemptEntity parentAttempt = store.activeAttempt(localTurnId);
        store.commitVerifiedRemoteFailure(
            localTurnId,
            parentAttempt.attemptId,
            BridgeTurnStatus.parseV3(
                canonicalFailure(parentCheckpoint, true, 450L).toString(),
                "cloud", "relay-cloud-earlier-failure"),
            451L
        );
        ExecutionAttemptEntity childAttempt = store.startRetry(localTurnId, 452L);
        store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 453L);

        RoomExecutionStore.CanonicalCloudTarget target = store.resolveCanonicalCloudTarget(
            parentCheckpoint.getString("authorityLineageKey"),
            parentCheckpoint.getString("authoritativeTurnId")
        );

        assertEquals(localTurnId, target.localTurnId);
        assertEquals(childAttempt.attemptId, target.activeAttemptId);
    }

    @Test
    public void canonicalBridgeLifecycleRejectsQueuedMismatchedAndFinishedOpenAttempts()
        throws Exception {
        String queuedTurnId = "local-v3-state-queued";
        store.submitTurn(yuqiThreeBubbleSubmission(
            queuedTurnId, "msg-state-queued-3", 453L));
        ChatTurnEntity queued = store.turn(queuedTurnId);
        TurnSubmission queuedSubmission = new TurnSubmission(
            queued.turnId, queued.characterId, queued.sourceMessageId,
            TurnKind.valueOf(queued.kind), queued.inputJson, queued.snapshotJson,
            queued.cloudJobId, queued.createdAt);
        assertThrows(IllegalStateException.class, () -> store.prepareBridgeSubmission(
            queuedSubmission, "device_gateway", 454L));

        String waitingTurnId = "local-v3-state-waiting";
        store.submitTurn(yuqiThreeBubbleSubmission(
            waitingTurnId, "msg-state-waiting-3", 455L));
        TurnSubmission waitingPrepared = store.prepareBridgeSubmission(
            persistedSubmission(waitingTurnId), "device_gateway", 456L);
        ExecutionAttemptEntity waitingAttempt = store.activeAttempt(waitingTurnId);
        store.markBridgeWaiting(waitingTurnId, waitingAttempt.attemptId, "cloud", 457L);
        JSONObject waitingCheckpoint = new JSONObject(waitingPrepared.bridgeAuthorityCheckpointJson);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE execution_attempts SET state='MEMORY_RUNNING' WHERE attemptId=?",
            new Object[]{waitingAttempt.attemptId}
        );
        assertThrows(IllegalStateException.class, () -> store.resolveCanonicalCloudTarget(
            waitingCheckpoint.getString("authorityLineageKey"),
            waitingCheckpoint.getString("authoritativeTurnId")));

        String terminalTurnId = "local-v3-state-terminal";
        store.submitTurn(yuqiThreeBubbleSubmission(
            terminalTurnId, "msg-state-terminal-3", 460L));
        TurnSubmission terminalPrepared = store.prepareBridgeSubmission(
            persistedSubmission(terminalTurnId), "device_gateway", 461L);
        ExecutionAttemptEntity terminalAttempt = store.activeAttempt(terminalTurnId);
        JSONObject terminalCheckpoint = new JSONObject(terminalPrepared.bridgeAuthorityCheckpointJson);
        BridgeResult terminal = BridgeTurnStatus.parseV3(
            canonicalTerminal(terminalCheckpoint, "visible", 1, new JSONArray()).toString(),
            "lan", null);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE execution_attempts SET finishedAt=462 WHERE attemptId=?",
            new Object[]{terminalAttempt.attemptId}
        );
        assertThrows(IllegalStateException.class, () -> store.commitBridgedTerminal(
            terminalTurnId, terminalAttempt.attemptId, terminal, 463L));

        String failureTurnId = "local-v3-state-failure";
        store.submitTurn(yuqiThreeBubbleSubmission(
            failureTurnId, "msg-state-failure-3", 470L));
        TurnSubmission failurePrepared = store.prepareBridgeSubmission(
            persistedSubmission(failureTurnId), "device_gateway", 471L);
        ExecutionAttemptEntity failureAttempt = store.activeAttempt(failureTurnId);
        JSONObject failureCheckpoint = new JSONObject(failurePrepared.bridgeAuthorityCheckpointJson);
        BridgeResult failure = BridgeTurnStatus.parseV3(
            canonicalFailure(failureCheckpoint, true, 472L).toString(),
            "cloud", "relay-state-failure");
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE execution_attempts SET stage='FINISHED' WHERE attemptId=?",
            new Object[]{failureAttempt.attemptId}
        );
        assertThrows(IllegalStateException.class, () -> store.commitVerifiedRemoteFailure(
            failureTurnId, failureAttempt.attemptId, failure, 473L));
    }

    @Test
    public void aLateCanonicalTerminalMayCloseAnExactLocallyFailedPreparedAttempt()
        throws Exception {
        String turnId = "local-v3-state-late-terminal";
        store.submitTurn(yuqiThreeBubbleSubmission(
            turnId, "msg-state-late-terminal-3", 480L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(turnId), "device_gateway", 481L);
        ExecutionAttemptEntity attempt = store.activeAttempt(turnId);
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        BridgeResult terminal = BridgeTurnStatus.parseV3(
            canonicalTerminal(checkpoint, "visible", 1, new JSONArray()).toString(),
            "lan", null);
        store.markFailed(turnId, attempt.attemptId, "NETWORK_UNKNOWN", "unknown", true, 482L);

        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.commitBridgedTerminal(turnId, attempt.attemptId, terminal, 483L));
        assertEquals(TurnState.COMPLETED.name(), store.turn(turnId).state);
    }

    @Test
    public void canonicalCloudRejectionDiagnosticIsIdempotentByRelayAndReason()
        throws Exception {
        long before = rowCount("diagnostics");
        store.recordCanonicalCloudRejectionOnce(
            null, "relay_rejected_once", "protocol_conflict", 484L);
        store.recordCanonicalCloudRejectionOnce(
            null, "relay_rejected_once", "protocol_conflict", 485L);

        assertEquals(before + 1L, rowCount("diagnostics"));
        com.siyi.al.execution.db.DiagnosticEntity row =
            database.executionDao().latestDiagnostics(1).get(0);
        assertEquals("BRIDGE_CLOUD_RESULT_PENDING", row.code);
        assertEquals(
            BridgeAuthority.canonicalJson(new JSONObject()
                .put("reason", "protocol_conflict")
                .put("redacted", true)
                .put("relayMessageId", "relay_rejected_once")),
            row.detail);
    }

    @Test
    public void canonicalCloudTargetRejectsForeignMemberAndEveryDuplicateLocalOwner()
        throws Exception {
        String firstTurnId = "local-v3-cloud-owner-one";
        store.submitTurn(yuqiThreeBubbleSubmission(
            firstTurnId, "msg-cloud-owner-one-3", 454L));
        TurnSubmission first = store.prepareBridgeSubmission(
            persistedSubmission(firstTurnId), "device_gateway", 455L);
        JSONObject firstCheckpoint = new JSONObject(first.bridgeAuthorityCheckpointJson);
        long beforeForeign = rowCount("diagnostics");

        assertThrows(IllegalStateException.class, () -> store.resolveCanonicalCloudTarget(
            firstCheckpoint.getString("authorityLineageKey"), "turn_foreign_member"));
        assertEquals(beforeForeign, rowCount("diagnostics"));
        assertEquals(TurnState.MEMORY_RUNNING.name(), store.turn(firstTurnId).state);

        String secondTurnId = "local-v3-cloud-owner-two";
        store.submitTurn(yuqiThreeBubbleSubmission(
            secondTurnId, "msg-cloud-owner-two-3", 456L));
        persistedSubmission(secondTurnId);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET authorityLineageKey=? WHERE turnId=?",
            new Object[]{firstCheckpoint.getString("authorityLineageKey"), secondTurnId}
        );
        long beforeDuplicate = rowCount("diagnostics");
        assertThrows(IllegalStateException.class, () -> store.resolveCanonicalCloudTarget(
            firstCheckpoint.getString("authorityLineageKey"),
            firstCheckpoint.getString("authoritativeTurnId")));
        assertEquals(beforeDuplicate, rowCount("diagnostics"));
        assertEquals(TurnState.MEMORY_RUNNING.name(), store.turn(firstTurnId).state);
        assertEquals(TurnState.MEMORY_RUNNING.name(), store.turn(secondTurnId).state);

        String thirdTurnId = "local-v3-cloud-owner-three";
        store.submitTurn(yuqiThreeBubbleSubmission(
            thirdTurnId, "msg-cloud-owner-three-3", 458L));
        persistedSubmission(thirdTurnId);
        String thirdAttemptId = store.activeAttempt(thirdTurnId).attemptId;
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET authorityLineageKey=? WHERE turnId=?",
            new Object[]{firstCheckpoint.getString("authorityLineageKey"), thirdTurnId}
        );
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE execution_attempts SET bridgeAuthorityCheckpointJson='{}', "
                + "bridgeAuthorityCheckpointChecksum=NULL WHERE attemptId=?",
            new Object[]{thirdAttemptId}
        );
        assertThrows(IllegalStateException.class, () -> store.resolveCanonicalCloudTarget(
            firstCheckpoint.getString("authorityLineageKey"),
            firstCheckpoint.getString("authoritativeTurnId")));
    }

    @Test
    public void canonicalCursorIsArrivalOrderIndependentAndEqualSequenceIdentityConflicts()
        throws Exception {
        String olderTurnId = "local-v3-arrival-old";
        store.submitTurn(yuqiThreeBubbleSubmission(
            olderTurnId, "msg-arrival-old-3", 460L));
        TurnSubmission olderPrepared = store.prepareBridgeSubmission(
            persistedSubmission(olderTurnId), "device_gateway", 461L);
        JSONObject olderCheckpoint = new JSONObject(olderPrepared.bridgeAuthorityCheckpointJson);
        BridgeResult older = BridgeTurnStatus.parseV3(
            canonicalTerminal(olderCheckpoint, "visible", 1, new JSONArray()).toString(),
            "lan", null);

        String newerTurnId = "local-v3-arrival-new";
        store.submitTurn(yuqiThreeBubbleSubmission(
            newerTurnId, "msg-arrival-new-3", 470L));
        TurnSubmission newerPrepared = store.prepareBridgeSubmission(
            persistedSubmission(newerTurnId), "device_gateway", 471L);
        JSONObject newerCheckpoint = new JSONObject(newerPrepared.bridgeAuthorityCheckpointJson);
        BridgeResult newer = BridgeTurnStatus.parseV3(
            canonicalTerminal(newerCheckpoint, "visible", 1, new JSONArray()).toString(),
            "lan", null);
        assertTrue(newer.inputVisibilitySequence > older.inputVisibilitySequence);

        store.commitBridgedTerminal(
            newerTurnId, store.activeAttempt(newerTurnId).attemptId, newer, 480L);
        store.commitBridgedTerminal(
            olderTurnId, store.activeAttempt(olderTurnId).attemptId, older, 481L);
        ConversationCursorEntity afterOutOfOrder = store.getConversationCursor("yuqi");
        assertEquals(newer.inputVisibilitySequence, afterOutOfOrder.nativeCompletedSequence);
        assertEquals(newerTurnId, afterOutOfOrder.nativeCompletedTurnId);
        assertEquals(newer.visibleGroupId, afterOutOfOrder.nativeCompletedGroupId);

        String conflictTurnId = "local-v3-equal-cursor-conflict";
        store.submitTurn(yuqiThreeBubbleSubmission(
            conflictTurnId, "msg-equal-conflict-3", 490L));
        TurnSubmission conflictPrepared = store.prepareBridgeSubmission(
            persistedSubmission(conflictTurnId), "device_gateway", 491L);
        JSONObject conflictCheckpoint = new JSONObject(
            conflictPrepared.bridgeAuthorityCheckpointJson);
        BridgeResult conflict = BridgeTurnStatus.parseV3(
            canonicalTerminal(conflictCheckpoint, "visible", 1, new JSONArray()).toString(),
            "lan", null);
        store.markNativeCompleted(
            "yuqi", "foreign-local-turn", "grp_foreign",
            conflict.inputVisibilitySequence, 492L);
        long changes = rowCount("change_events");
        assertThrows(IllegalStateException.class, () -> store.commitBridgedTerminal(
            conflictTurnId, store.activeAttempt(conflictTurnId).attemptId, conflict, 493L));
        assertEquals(TurnState.MEMORY_RUNNING.name(), store.turn(conflictTurnId).state);
        assertEquals(0, store.replyParts(conflictTurnId).size());
        assertEquals(changes, rowCount("change_events"));
        ConversationCursorEntity afterConflict = store.getConversationCursor("yuqi");
        assertEquals("foreign-local-turn", afterConflict.nativeCompletedTurnId);
        assertEquals("grp_foreign", afterConflict.nativeCompletedGroupId);
    }

    @Test
    public void canonicalCharacterProjectionRejectsMessageAndDeviceSequenceCollisionsBeforeWrites()
        throws Exception {
        String messageCollisionTurnId = "local-v3-message-collision";
        store.submitTurn(yuqiThreeBubbleSubmission(
            messageCollisionTurnId, "msg-message-collision-3", 510L));
        TurnSubmission messagePrepared = store.prepareBridgeSubmission(
            persistedSubmission(messageCollisionTurnId), "device_gateway", 511L);
        JSONObject messageCheckpoint = new JSONObject(messagePrepared.bridgeAuthorityCheckpointJson);
        BridgeResult messageResult = BridgeTurnStatus.parseV3(
            canonicalTerminal(messageCheckpoint, "visible", 1, new JSONArray()).toString(),
            "lan", null);
        JSONObject canonicalItem = new JSONObject(messageResult.replyPartsJson.get(0));
        RawMessageEntity occupiedMessage = foreignRawMessage(
            canonicalItem.getString("messageId"), "foreign-message-turn",
            "foreign-device", 1L, 500L);
        database.executionDao().insertRawMessage(occupiedMessage);
        long messageChanges = rowCount("change_events");
        assertThrows(IllegalStateException.class, () -> store.commitBridgedTerminal(
            messageCollisionTurnId, store.activeAttempt(messageCollisionTurnId).attemptId,
            messageResult, 512L));
        assertEquals(TurnState.MEMORY_RUNNING.name(), store.turn(messageCollisionTurnId).state);
        assertEquals(0, store.replyParts(messageCollisionTurnId).size());
        assertEquals(messageChanges, rowCount("change_events"));

        String sequenceCollisionTurnId = "local-v3-sequence-collision";
        store.submitTurn(yuqiThreeBubbleSubmission(
            sequenceCollisionTurnId, "msg-sequence-collision-3", 520L));
        TurnSubmission sequencePrepared = store.prepareBridgeSubmission(
            persistedSubmission(sequenceCollisionTurnId), "device_gateway", 521L);
        JSONObject sequenceCheckpoint = new JSONObject(sequencePrepared.bridgeAuthorityCheckpointJson);
        BridgeResult sequenceResult = BridgeTurnStatus.parseV3(
            canonicalTerminal(sequenceCheckpoint, "visible", 1, new JSONArray()).toString(),
            "lan", null);
        RawMessageEntity occupiedSequence = foreignRawMessage(
            "foreign-message-id", "foreign-sequence-turn",
            "pc-group:" + sequenceResult.visibleGroupId, 1L, 501L);
        database.executionDao().insertRawMessage(occupiedSequence);
        long sequenceChanges = rowCount("change_events");
        assertThrows(IllegalStateException.class, () -> store.commitBridgedTerminal(
            sequenceCollisionTurnId, store.activeAttempt(sequenceCollisionTurnId).attemptId,
            sequenceResult, 522L));
        assertEquals(TurnState.MEMORY_RUNNING.name(), store.turn(sequenceCollisionTurnId).state);
        assertEquals(0, store.replyParts(sequenceCollisionTurnId).size());
        assertEquals(sequenceChanges, rowCount("change_events"));
    }

    @Test
    public void everyRegisteredCanonicalActionUsesItsExactCompatibilityProjection()
        throws Exception {
        String[] kinds = new String[]{
            "payment_accept", "payment_decline", "moment_create", "moment_like",
            "moment_comment", "moment_reply", "role_plan_create", "role_plan_update",
            "role_plan_cancel", "role_plan_pause", "role_plan_resume", "role_plan_complete",
            "life_episode_create", "life_episode_update", "life_episode_cancel",
            "relationship_transition"
        };
        String[] types = new String[]{
            "PAYMENT_STATUS", "PAYMENT_STATUS", "MOMENT_CREATE", "MOMENT_ACTION",
            "MOMENT_ACTION", "MOMENT_ACTION", "PLAN", "PLAN", "PLAN", "PLAN", "PLAN",
            "PLAN", "LIFE_EPISODE", "LIFE_ADJUSTMENT", "LIFE_ADJUSTMENT",
            "RELATIONSHIP_STAGE"
        };
        for (int index = 0; index < kinds.length; index += 1) {
            String turnId = "local-v3-action-map-" + index;
            store.submitTurn(yuqiThreeBubbleSubmission(
                turnId, "msg-action-map-" + index + "-3", 600L + index * 10L));
            TurnSubmission prepared = store.prepareBridgeSubmission(
                persistedSubmission(turnId), "device_gateway", 601L + index * 10L);
            JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
            JSONObject payload = actionPayload(kinds[index], index);
            JSONObject canonicalAction = canonicalAction(
                checkpoint, 0, kinds[index], "target:" + index, "revision:" + index, payload);
            BridgeResult result = BridgeTurnStatus.parseV3(
                canonicalTerminal(checkpoint, "action_only", 0,
                    new JSONArray().put(canonicalAction)).toString(), "lan", null);

            store.commitBridgedTerminal(
                turnId, store.activeAttempt(turnId).attemptId, result, 605L + index * 10L);
            ReplyPartEntity row = store.replyParts(turnId).get(0);
            assertEquals(types[index], row.type);
            assertEquals("", row.content);
            JSONObject wrapper = new JSONObject(row.payloadJson);
            assertEquals(3, wrapper.length());
            assertEquals(1, wrapper.getInt("version"));
            assertEquals(
                BridgeAuthority.canonicalJson(canonicalAction),
                BridgeAuthority.canonicalJson(wrapper.getJSONObject("canonicalAction")));
            JSONObject legacy = wrapper.getJSONObject("legacyPayload");
            if (kinds[index].startsWith("payment_")) {
                assertEquals(kinds[index].equals("payment_accept") ? "received" : "refused",
                    legacy.getString("status"));
                assertEquals(1, legacy.length());
            } else if (kinds[index].startsWith("role_plan_")) {
                assertEquals(1, legacy.length());
                assertEquals(BridgeAuthority.canonicalJson(payload),
                    BridgeAuthority.canonicalJson(legacy.getJSONArray("operations").getJSONObject(0)));
            } else {
                assertEquals(BridgeAuthority.canonicalJson(payload),
                    BridgeAuthority.canonicalJson(legacy));
            }
            assertEquals(0, database.executionDao().canonicalCharacterMessages(
                result.authoritativeTurnId).size());
        }

        String duplicateTurnId = "local-v3-action-map-duplicate";
        store.submitTurn(yuqiThreeBubbleSubmission(
            duplicateTurnId, "msg-action-map-duplicate-3", 800L));
        TurnSubmission duplicatePrepared = store.prepareBridgeSubmission(
            persistedSubmission(duplicateTurnId), "device_gateway", 801L);
        JSONObject duplicateCheckpoint = new JSONObject(
            duplicatePrepared.bridgeAuthorityCheckpointJson);
        JSONArray duplicateActions = new JSONArray()
            .put(canonicalAction(duplicateCheckpoint, 0, "payment_accept",
                "payment:first", "revision:first", new JSONObject().put("messageId", "first")))
            .put(canonicalAction(duplicateCheckpoint, 1, "payment_decline",
                "payment:second", "revision:second", new JSONObject().put("messageId", "second")));
        BridgeResult duplicate = BridgeTurnStatus.parseV3(
            canonicalTerminal(
                duplicateCheckpoint, "action_only", 0, duplicateActions).toString(),
            "lan", null);
        long duplicateChanges = rowCount("change_events");
        assertThrows(IllegalStateException.class, () -> store.commitBridgedTerminal(
            duplicateTurnId, store.activeAttempt(duplicateTurnId).attemptId,
            duplicate, 802L));
        assertEquals(TurnState.MEMORY_RUNNING.name(), store.turn(duplicateTurnId).state);
        assertEquals(0, store.replyParts(duplicateTurnId).size());
        assertEquals(duplicateChanges, rowCount("change_events"));
    }

    @Test
    public void storeOwnedV3PreparationPinsOneRemoteMemberAndReusesItAfterUnknownOutcome() throws Exception {
        TurnSubmission original = yuqiThreeBubbleSubmission("local-v3", "msg-v3-3", 100L);
        store.submitTurn(original);

        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission("local-v3"), "device_gateway", 101L
        );
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        JSONObject envelope = checkpoint.getJSONObject("normalizedEnvelope");
        assertEquals("local-v3", prepared.turnId);
        assertEquals("local-v3", prepared.authoritativeTurnId);
        assertEquals(3, envelope.getInt("protocolVersion"));
        assertEquals("device_gateway", envelope.getString("deviceId"));
        assertEquals(3, envelope.getJSONObject("context").getJSONObject("currentBatch")
            .getJSONArray("messages").length());
        assertEquals(1L, envelope.getJSONObject("context").getJSONObject("visibilityCursor")
            .getLong("localSequence"));
        assertEquals(3, store.turn("local-v3").bridgeProtocolVersion.intValue());
        assertEquals(1L, store.turn("local-v3").lineageRevision.longValue());
        assertEquals(1L, store.turn("local-v3").inputVisibilitySequence.longValue());

        String firstAttempt = store.activeAttempt("local-v3").attemptId;
        store.markFailed("local-v3", firstAttempt, "NETWORK_UNKNOWN", "outcome unknown", true, 102L);
        ExecutionAttemptEntity retry = store.startRetry("local-v3", 103L);
        TurnSubmission replay = store.prepareBridgeSubmission(
            persistedSubmission("local-v3"), "device_gateway", 104L
        );
        JSONObject replayCheckpoint = new JSONObject(replay.bridgeAuthorityCheckpointJson);
        assertEquals(firstAttempt.equals(retry.attemptId), false);
        assertEquals(prepared.authoritativeTurnId, replay.authoritativeTurnId);
        assertEquals(
            BridgeAuthority.canonicalJson(envelope),
            BridgeAuthority.canonicalJson(replayCheckpoint.getJSONObject("normalizedEnvelope"))
        );
        assertEquals(1L, store.getConversationCursor("yuqi").localSequence);
        ConversationAuthorityEntity authority = database.executionDao().conversationAuthority(
            checkpoint.getString("authorityLineageKey")
        );
        assertEquals(1L, authority.revision);
        assertEquals(prepared.authoritativeTurnId, authority.latestTurnId);
    }

    @Test
    public void v3RetryRejectsChangedPayloadAndHistoricalExactMarkerRemainsV2() throws Exception {
        store.submitTurn(yuqiThreeBubbleSubmission("local-v3-retry", "msg-v3-retry-3", 200L));
        TurnSubmission stored = persistedSubmission("local-v3-retry");
        store.prepareBridgeSubmission(stored, "device_gateway", 201L);
        String attemptId = store.activeAttempt("local-v3-retry").attemptId;
        store.markFailed("local-v3-retry", attemptId, "NETWORK_UNKNOWN", "unknown", true, 202L);
        assertThrows(IllegalStateException.class, () -> store.startRetry(
            "local-v3-retry", 203L, "{\"changed\":true}", stored.snapshotJson
        ));
        assertEquals(1, database.executionDao().attempts("local-v3-retry").size());
        String pinnedInput = store.turn("local-v3-retry").inputJson;
        String pinnedSnapshot = store.turn("local-v3-retry").snapshotJson;
        store.startRetry("local-v3-retry", 204L, pinnedInput, pinnedSnapshot);
        assertEquals(pinnedInput, store.turn("local-v3-retry").inputJson);
        assertEquals(pinnedSnapshot, store.turn("local-v3-retry").snapshotJson);
        assertEquals(2, database.executionDao().attempts("local-v3-retry").size());

        ChatTurnEntity historical = new ChatTurnEntity();
        historical.turnId = "historical-marker";
        historical.characterId = "yuqi";
        historical.sourceMessageId = "msg-historical";
        historical.kind = TurnKind.DIRECT_REPLY.name();
        historical.state = TurnState.QUEUED.name();
        historical.activeAttemptId = "attempt-historical";
        historical.inputJson = "{\"text\":\"旧消息\"}";
        historical.snapshotJson = "{\"_alBridgeProtocol\":{\"version\":3,\"owner\":\"room-v12\"}}";
        historical.createdAt = 1L;
        historical.updatedAt = 1L;
        database.executionDao().insertTurn(historical);
        ExecutionAttemptEntity historicalAttempt = new ExecutionAttemptEntity();
        historicalAttempt.attemptId = "attempt-historical";
        historicalAttempt.turnId = historical.turnId;
        historicalAttempt.sequence = 1;
        historicalAttempt.startedAt = 1L;
        historicalAttempt.heartbeatAt = 1L;
        database.executionDao().insertAttempt(historicalAttempt);
        TurnSubmission legacy = new TurnSubmission(
            historical.turnId, historical.characterId, historical.sourceMessageId,
            TurnKind.DIRECT_REPLY, historical.inputJson, historical.snapshotJson, null, 1L
        );
        TurnSubmission unchanged = store.prepareBridgeSubmission(legacy, "device_gateway", 205L);
        assertEquals(null, unchanged.bridgeAuthorityCheckpointJson);
        assertEquals(historical.turnId, unchanged.authoritativeTurnId);
        assertEquals(null, store.getConversationCursor("yuqi"));
    }

    @Test
    public void onlyVerifiedRemoteFailureCreatesOneDeterministicRemoteChild() throws Exception {
        store.submitTurn(yuqiThreeBubbleSubmission("local-v3-child", "msg-v3-child-3", 300L));
        TurnSubmission parent = store.prepareBridgeSubmission(
            persistedSubmission("local-v3-child"), "device_gateway", 301L
        );
        ExecutionAttemptEntity parentAttempt = store.activeAttempt("local-v3-child");
        JSONObject parentCheckpoint = new JSONObject(parent.bridgeAuthorityCheckpointJson);
        store.markFailed(
            "local-v3-child", parentAttempt.attemptId,
            "REMOTE_TRANSIENT", "verified by PC", true, 302L
        );
        JSONObject failure = canonicalFailure(parentCheckpoint, true, 302L);
        JSONObject verified = new JSONObject(parentCheckpoint.toString()).put(
            "outcome",
            new JSONObject()
                .put("type", "verified_remote_failure")
                .put("route", "cloud")
                .put("relayMessageId", "relay_verified_parent")
                .put("failure", failure)
                .put("result", JSONObject.NULL)
                .put("redactedAt", JSONObject.NULL)
        );
        overwriteCheckpoint(parentAttempt.attemptId, verified);

        ExecutionAttemptEntity childAttempt = store.startRetry("local-v3-child", 303L);
        TurnSubmission child = store.prepareBridgeSubmission(
            persistedSubmission("local-v3-child"), "device_gateway", 304L
        );
        JSONObject childCheckpoint = new JSONObject(child.bridgeAuthorityCheckpointJson);

        assertEquals(AuthorityIdentity.remoteRetryTurnId(childAttempt.attemptId), child.authoritativeTurnId);
        assertEquals(parent.authoritativeTurnId, childCheckpoint.getString("retryOfTurnId"));
        assertEquals(2L, childCheckpoint.getLong("claimedLineageRevision"));
        assertEquals(2L, childCheckpoint.getLong("inputVisibilitySequence"));
        assertEquals(parent.authoritativeTurnId, childCheckpoint.getJSONObject("normalizedEnvelope")
            .getJSONObject("authority").getString("retryOfTurnId"));
        ConversationAuthorityEntity authority = database.executionDao().conversationAuthority(
            childCheckpoint.getString("authorityLineageKey")
        );
        assertEquals(2L, authority.revision);
        assertEquals(child.authoritativeTurnId, authority.latestTurnId);
        assertEquals(2L, store.getConversationCursor("yuqi").localSequence);

        JSONObject validParent = new JSONObject(verified.toString());
        long turnUpdatedAt = store.turn("local-v3-child").updatedAt;
        int attempts = database.executionDao().attempts("local-v3-child").size();
        long changeCount = rowCount("change_events");
        long diagnosticCount = rowCount("diagnostics");
        JSONObject[] invalidParentOutcomes = new JSONObject[]{
            openOutcome(),
            new JSONObject(validParent.getJSONObject("outcome").toString()).put(
                "failure", canonicalFailure(parentCheckpoint, false, 302L)),
            new JSONObject()
                .put("type", "committed")
                .put("route", "cloud")
                .put("relayMessageId", "relay_parent_committed")
                .put("failure", JSONObject.NULL)
                .put("result", new JSONObject())
                .put("redactedAt", JSONObject.NULL)
        };
        for (JSONObject invalidOutcome : invalidParentOutcomes) {
            JSONObject invalidParent = new JSONObject(validParent.toString())
                .put("outcome", invalidOutcome);
            overwriteCheckpoint(parentAttempt.attemptId, invalidParent);
            assertThrows(IllegalStateException.class, () -> store.prepareBridgeSubmission(
                persistedSubmission("local-v3-child"), "device_gateway", 305L
            ));
            assertEquals(2L, store.getConversationCursor("yuqi").localSequence);
            assertEquals(2L, database.executionDao().conversationAuthority(
                childCheckpoint.getString("authorityLineageKey")).revision);
            assertEquals(attempts, database.executionDao().attempts("local-v3-child").size());
            assertEquals(turnUpdatedAt, store.turn("local-v3-child").updatedAt);
            assertEquals(changeCount, rowCount("change_events"));
            assertEquals(diagnosticCount, rowCount("diagnostics"));
            overwriteCheckpoint(parentAttempt.attemptId, validParent);
        }
    }

    @Test
    public void duplicateRemoteMemberUsesItsUniqueTerminalProofAcrossRetryAndStoreRestart() throws Exception {
        String turnId = "local-v3-duplicate-proof";
        store.submitTurn(yuqiThreeBubbleSubmission(turnId, "msg-v3-duplicate-proof-3", 320L));
        TurnSubmission original = store.prepareBridgeSubmission(
            persistedSubmission(turnId), "device_gateway", 321L);
        ExecutionAttemptEntity firstAttempt = store.activeAttempt(turnId);
        JSONObject firstOpen = new JSONObject(original.bridgeAuthorityCheckpointJson);

        store.markFailed(turnId, firstAttempt.attemptId, "NETWORK_UNKNOWN", "unknown", true, 322L);
        ExecutionAttemptEntity duplicateAttempt = store.startRetry(turnId, 323L);
        TurnSubmission duplicate = store.prepareBridgeSubmission(
            persistedSubmission(turnId), "device_gateway", 324L);
        JSONObject duplicateOpen = new JSONObject(duplicate.bridgeAuthorityCheckpointJson);
        assertEquals(original.authoritativeTurnId, duplicate.authoritativeTurnId);

        store.markFailed(
            turnId, duplicateAttempt.attemptId, "REMOTE_TRANSIENT", "verified by PC", true, 325L);
        JSONObject verified = new JSONObject(duplicateOpen.toString()).put(
            "outcome", verifiedFailureOutcome(duplicateOpen, true, 325L, "relay_duplicate_verified"));
        overwriteCheckpoint(duplicateAttempt.attemptId, verified);

        ExecutionAttemptEntity childAttempt = store.startRetry(turnId, 326L);
        TurnSubmission child = store.prepareBridgeSubmission(
            persistedSubmission(turnId), "device_gateway", 327L);
        assertEquals(AuthorityIdentity.remoteRetryTurnId(childAttempt.attemptId),
            child.authoritativeTurnId);

        RoomExecutionStore restarted = new RoomExecutionStore(database);
        TurnSubmission recovered = restarted.prepareBridgeSubmission(
            persistedSubmission(turnId), "device_gateway", 328L);
        assertEquals(child.authoritativeTurnId, recovered.authoritativeTurnId);
        assertEquals(child.bridgeAuthorityCheckpointJson, recovered.bridgeAuthorityCheckpointJson);

        String lineage = new JSONObject(child.bridgeAuthorityCheckpointJson)
            .getString("authorityLineageKey");
        long updatedAt = store.turn(turnId).updatedAt;
        int attempts = database.executionDao().attempts(turnId).size();
        long changes = rowCount("change_events");
        long diagnostics = rowCount("diagnostics");
        long cursorSequence = store.getConversationCursor("yuqi").localSequence;
        long authorityRevision = database.executionDao().conversationAuthority(lineage).revision;

        JSONObject[] invalidSingleProofs = new JSONObject[]{
            openOutcome(),
            verifiedFailureOutcome(duplicateOpen, false, 325L, "relay_duplicate_verified"),
            new JSONObject()
                .put("type", "committed")
                .put("route", "cloud")
                .put("relayMessageId", "relay_duplicate_committed")
                .put("failure", JSONObject.NULL)
                .put("result", new JSONObject())
                .put("redactedAt", JSONObject.NULL)
        };
        for (JSONObject invalid : invalidSingleProofs) {
            overwriteCheckpoint(duplicateAttempt.attemptId,
                new JSONObject(duplicateOpen.toString()).put("outcome", invalid));
            assertPrepareConflictIsReadOnly(
                turnId, attempts, updatedAt, changes, diagnostics,
                cursorSequence, lineage, authorityRevision, 329L);
            overwriteCheckpoint(duplicateAttempt.attemptId, verified);
        }

        JSONObject exactSameTerminal = new JSONObject(firstOpen.toString())
            .put("outcome", new JSONObject(verified.getJSONObject("outcome").toString()));
        overwriteCheckpoint(firstAttempt.attemptId, exactSameTerminal);
        assertEquals(child.authoritativeTurnId, restarted.prepareBridgeSubmission(
            persistedSubmission(turnId), "device_gateway", 330L).authoritativeTurnId);

        JSONObject changedFailure = canonicalFailure(duplicateOpen, true, 331L);
        JSONObject changedTerminal = new JSONObject(firstOpen.toString()).put(
            "outcome", new JSONObject()
                .put("type", "verified_remote_failure")
                .put("route", "cloud")
                .put("relayMessageId", "relay_duplicate_verified")
                .put("failure", changedFailure)
                .put("result", JSONObject.NULL)
                .put("redactedAt", JSONObject.NULL));
        overwriteCheckpoint(firstAttempt.attemptId, changedTerminal);
        assertPrepareConflictIsReadOnly(
            turnId, attempts, updatedAt, changes, diagnostics,
            cursorSequence, lineage, authorityRevision, 332L);
    }

    @Test
    public void startRetryRejectsMissingForeignAndStaleActiveAttemptBeforeEveryWrite() throws Exception {
        String turnId = "local-v3-active-preflight";
        store.submitTurn(yuqiThreeBubbleSubmission(turnId, "msg-v3-active-preflight-3", 340L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(turnId), "device_gateway", 341L);
        ExecutionAttemptEntity firstAttempt = store.activeAttempt(turnId);
        store.markFailed(turnId, firstAttempt.attemptId, "NETWORK_UNKNOWN", "unknown", true, 342L);
        String lineage = new JSONObject(prepared.bridgeAuthorityCheckpointJson)
            .getString("authorityLineageKey");

        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET activeAttemptId=NULL WHERE turnId=?", new Object[]{turnId});
        assertCurrentRetryPointerConflictIsReadOnly(turnId, lineage, 343L);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET activeAttemptId=? WHERE turnId=?",
            new Object[]{firstAttempt.attemptId, turnId});

        String foreignTurnId = "local-v3-active-foreign";
        store.submitTurn(yuqiThreeBubbleSubmission(
            foreignTurnId, "msg-v3-active-foreign-3", 344L));
        String foreignAttemptId = store.activeAttempt(foreignTurnId).attemptId;
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET activeAttemptId=? WHERE turnId=?",
            new Object[]{foreignAttemptId, turnId});
        assertCurrentRetryPointerConflictIsReadOnly(turnId, lineage, 345L);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET activeAttemptId=? WHERE turnId=?",
            new Object[]{firstAttempt.attemptId, turnId});

        ExecutionAttemptEntity latest = store.startRetry(turnId, 346L);
        store.prepareBridgeSubmission(persistedSubmission(turnId), "device_gateway", 347L);
        store.markFailed(turnId, latest.attemptId, "NETWORK_UNKNOWN", "unknown", true, 348L);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET activeAttemptId=? WHERE turnId=?",
            new Object[]{firstAttempt.attemptId, turnId});
        assertCurrentRetryPointerConflictIsReadOnly(turnId, lineage, 349L);
    }

    @Test
    public void checkpointSetRejectsOneSidedAttemptsAndSelfConsistentForgedMembers() throws Exception {
        store.submitTurn(yuqiThreeBubbleSubmission("local-v3-hidden", "msg-v3-hidden-3", 400L));
        store.prepareBridgeSubmission(persistedSubmission("local-v3-hidden"), "device_gateway", 401L);
        ExecutionAttemptEntity parent = store.activeAttempt("local-v3-hidden");
        store.markFailed("local-v3-hidden", parent.attemptId, "UNKNOWN", "unknown", true, 402L);
        store.startRetry("local-v3-hidden", 403L);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE execution_attempts SET bridgeAuthorityCheckpointChecksum=NULL WHERE attemptId=?",
            new Object[]{parent.attemptId}
        );
        assertThrows(IllegalStateException.class, () -> store.prepareBridgeSubmission(
            persistedSubmission("local-v3-hidden"), "device_gateway", 404L
        ));
        assertEquals(1L, store.getConversationCursor("yuqi").localSequence);

        store.submitTurn(yuqiThreeBubbleSubmission("local-v3-forged", "msg-v3-forged-3", 500L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission("local-v3-forged"), "device_gateway", 501L
        );
        ExecutionAttemptEntity forgedAttempt = store.activeAttempt("local-v3-forged");
        JSONObject forged = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        JSONObject forgedEnvelope = forged.getJSONObject("normalizedEnvelope");
        forged.put("authoritativeTurnId", "turn_forged_but_self_consistent");
        forgedEnvelope.put("turnId", "turn_forged_but_self_consistent");
        forgedEnvelope.getJSONObject("authority").put("rootSourceId", "msg_forged_root");
        forged.put("envelopeChecksum", BridgeAuthority.sha256CanonicalJson(forgedEnvelope));
        overwriteCheckpoint(forgedAttempt.attemptId, forged);
        JSONObject authority = forgedEnvelope.getJSONObject("authority");
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE conversation_authorities SET latestTurnId=? WHERE authorityLineageKey=?",
            new Object[]{"turn_forged_but_self_consistent", authority.getString("lineageKey")}
        );
        assertThrows(IllegalStateException.class, () -> store.prepareBridgeSubmission(
            persistedSubmission("local-v3-forged"), "device_gateway", 502L
        ));
        assertEquals(1L, database.executionDao().conversationAuthority(
            authority.getString("lineageKey")).revision);
    }

    @Test
    public void preflightFailureWithoutCheckpointDoesNotCreateAPhantomRemoteMember() throws Exception {
        store.submitTurn(yuqiThreeBubbleSubmission("local-v3-preflight", "msg-v3-preflight-3", 600L));
        ExecutionAttemptEntity preflight = store.activeAttempt("local-v3-preflight");
        store.markFailed(
            "local-v3-preflight", preflight.attemptId,
            "BRIDGE_CONFIG", "device id unavailable before prepare", true, 601L
        );
        ExecutionAttemptEntity retry = store.startRetry("local-v3-preflight", 602L);

        TurnSubmission firstPrepared = store.prepareBridgeSubmission(
            persistedSubmission("local-v3-preflight"), "device_gateway", 603L
        );
        JSONObject checkpoint = new JSONObject(firstPrepared.bridgeAuthorityCheckpointJson);

        assertEquals("local-v3-preflight", firstPrepared.authoritativeTurnId);
        assertEquals(1L, checkpoint.getLong("claimedLineageRevision"));
        assertEquals(JSONObject.NULL, checkpoint.get("retryOfTurnId"));
        assertEquals(null, database.executionDao().attempt(preflight.attemptId)
            .bridgeAuthorityCheckpointJson);
        assertEquals(retry.attemptId, checkpoint.getString("attemptId"));
        assertEquals(1L, store.getConversationCursor("yuqi").localSequence);
    }

    @Test
    public void checkpointAuthorityIntegersRejectCoercionAndUnsafeValuesWithoutAdvancingState() throws Exception {
        store.submitTurn(yuqiThreeBubbleSubmission("local-v3-integers", "msg-v3-integers-3", 700L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission("local-v3-integers"), "device_gateway", 701L
        );
        ExecutionAttemptEntity attempt = store.activeAttempt("local-v3-integers");
        JSONObject original = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        String lineageKey = original.getString("authorityLineageKey");

        JSONObject stringClaim = new JSONObject(original.toString())
            .put("claimedLineageRevision", "1");
        overwriteCheckpoint(attempt.attemptId, stringClaim);
        assertThrows(IllegalStateException.class, () -> store.prepareBridgeSubmission(
            persistedSubmission("local-v3-integers"), "device_gateway", 702L
        ));

        JSONObject floatingCursor = new JSONObject(original.toString());
        floatingCursor.getJSONObject("normalizedEnvelope").getJSONObject("context")
            .getJSONObject("visibilityCursor").put("localSequence", 1.0d);
        floatingCursor.put("envelopeChecksum", BridgeAuthority.sha256CanonicalJson(
            floatingCursor.getJSONObject("normalizedEnvelope")));
        overwriteCheckpoint(attempt.attemptId, floatingCursor);
        assertThrows(IllegalStateException.class, () -> store.prepareBridgeSubmission(
            persistedSubmission("local-v3-integers"), "device_gateway", 703L
        ));

        JSONObject unsafeEpoch = new JSONObject(original.toString())
            .put("inputClearEpoch", 9007199254740992L);
        overwriteCheckpoint(attempt.attemptId, unsafeEpoch);
        assertThrows(IllegalStateException.class, () -> store.prepareBridgeSubmission(
            persistedSubmission("local-v3-integers"), "device_gateway", 704L
        ));

        assertEquals(1L, store.getConversationCursor("yuqi").localSequence);
        assertEquals(1L, database.executionDao().conversationAuthority(lineageKey).revision);
        assertEquals(1L, store.turn("local-v3-integers").lineageRevision.longValue());
        overwriteCheckpoint(attempt.attemptId, original);
    }

    @Test
    public void liveCheckpointMustExactlyReconstructFromPersistedInputAndPinnedTransport() throws Exception {
        store.submitTurn(yuqiThreeBubbleSubmission("local-v3-rebuild", "msg-v3-rebuild-3", 750L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission("local-v3-rebuild"), "device_gateway", 751L
        );
        ExecutionAttemptEntity attempt = store.activeAttempt("local-v3-rebuild");
        JSONObject original = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        String lineage = original.getString("authorityLineageKey");
        long updatedAt = store.turn("local-v3-rebuild").updatedAt;
        long changes = rowCount("change_events");
        long diagnostics = rowCount("diagnostics");

        JSONObject changedMiddle = new JSONObject(original.toString());
        changedMiddle.getJSONObject("normalizedEnvelope").getJSONObject("context")
            .getJSONObject("currentBatch").getJSONArray("messages")
            .getJSONObject(1).put("content", "伪造过的第二泡");
        rehashEnvelope(changedMiddle);
        assertCorruptReplayIsReadOnly("local-v3-rebuild", attempt.attemptId, changedMiddle,
            lineage, updatedAt, changes, diagnostics);

        JSONObject changedAttachment = new JSONObject(original.toString());
        changedAttachment.getJSONObject("normalizedEnvelope").getJSONObject("context")
            .getJSONObject("currentBatch").getJSONArray("messages")
            .getJSONObject(1).put("attachments", new JSONArray().put(new JSONObject()
                .put("attachmentId", "att_forged")
                .put("messageId", "msg-prior-2-local-v3-rebuild")
                .put("kind", "image")
                .put("mime", "image/png")
                .put("name", "forged.png")
                .put("bytes", 1)
                .put("dataUrl", "data:image/png;base64,AA==")));
        rehashEnvelope(changedAttachment);
        assertCorruptReplayIsReadOnly("local-v3-rebuild", attempt.attemptId, changedAttachment,
            lineage, updatedAt, changes, diagnostics);

        JSONObject changedDeviceType = new JSONObject(original.toString());
        changedDeviceType.getJSONObject("normalizedEnvelope").put("deviceId", 7);
        rehashEnvelope(changedDeviceType);
        assertCorruptReplayIsReadOnly("local-v3-rebuild", attempt.attemptId, changedDeviceType,
            lineage, updatedAt, changes, diagnostics);

        JSONObject extraEnvelopeField = new JSONObject(original.toString());
        extraEnvelopeField.getJSONObject("normalizedEnvelope").put("transportSecret", "leak");
        rehashEnvelope(extraEnvelopeField);
        assertCorruptReplayIsReadOnly("local-v3-rebuild", attempt.attemptId, extraEnvelopeField,
            lineage, updatedAt, changes, diagnostics);
        overwriteCheckpoint(attempt.attemptId, original);

        store.submitTurn(yuqiAutomaticSubmission("cloud-rebuild", 760L));
        TurnSubmission automatic = store.prepareBridgeSubmission(
            persistedSubmission("cloud-rebuild"), "device_gateway", 761L
        );
        ExecutionAttemptEntity automaticAttempt = store.activeAttempt("cloud-rebuild");
        JSONObject automaticOriginal = new JSONObject(automatic.bridgeAuthorityCheckpointJson);
        String automaticLineage = automaticOriginal.getString("authorityLineageKey");
        long automaticUpdatedAt = store.turn("cloud-rebuild").updatedAt;
        long automaticChanges = rowCount("change_events");
        long automaticDiagnostics = rowCount("diagnostics");
        JSONObject changedTrigger = new JSONObject(automaticOriginal.toString());
        changedTrigger.getJSONObject("normalizedEnvelope").getJSONObject("trigger")
            .put("scheduledFor", 999999L)
            .getJSONObject("context").getJSONObject("snapshot")
            .put("semantic", "forged snapshot");
        rehashEnvelope(changedTrigger);
        assertCorruptReplayIsReadOnly("cloud-rebuild", automaticAttempt.attemptId, changedTrigger,
            automaticLineage, automaticUpdatedAt, automaticChanges, automaticDiagnostics);
        overwriteCheckpoint(automaticAttempt.attemptId, automaticOriginal);
    }

    @Test
    public void startRetryValidatesEveryV3AuthorityRowBeforeItsFirstWrite() throws Exception {
        store.submitTurn(yuqiThreeBubbleSubmission("local-v3-pretry", "msg-v3-pretry-3", 780L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission("local-v3-pretry"), "device_gateway", 781L
        );
        ExecutionAttemptEntity attempt = store.activeAttempt("local-v3-pretry");
        JSONObject original = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        store.markFailed("local-v3-pretry", attempt.attemptId, "UNKNOWN", "unknown", true, 782L);
        String activeAttemptId = store.turn("local-v3-pretry").activeAttemptId;
        int attemptCount = database.executionDao().attempts("local-v3-pretry").size();
        long updatedAt = store.turn("local-v3-pretry").updatedAt;
        long changes = rowCount("change_events");
        long diagnostics = rowCount("diagnostics");
        long cursorSequence = store.getConversationCursor("yuqi").localSequence;
        String lineage = original.getString("authorityLineageKey");
        long authorityRevision = database.executionDao().conversationAuthority(lineage).revision;

        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE execution_attempts SET bridgeAuthorityCheckpointChecksum=NULL WHERE attemptId=?",
            new Object[]{attempt.attemptId});
        assertStartRetryConflictIsReadOnly("local-v3-pretry", activeAttemptId, attemptCount,
            updatedAt, changes, diagnostics, cursorSequence, lineage, authorityRevision);

        overwriteCheckpoint(attempt.attemptId, original);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE execution_attempts SET bridgeAuthorityCheckpointChecksum=? WHERE attemptId=?",
            new Object[]{
                "0000000000000000000000000000000000000000000000000000000000000000",
                attempt.attemptId
            });
        assertStartRetryConflictIsReadOnly("local-v3-pretry", activeAttemptId, attemptCount,
            updatedAt, changes, diagnostics, cursorSequence, lineage, authorityRevision);

        JSONObject forged = new JSONObject(original.toString());
        forged.put("authoritativeTurnId", "turn_forged_before_retry");
        forged.getJSONObject("normalizedEnvelope").put("turnId", "turn_forged_before_retry");
        rehashEnvelope(forged);
        overwriteCheckpoint(attempt.attemptId, forged);
        assertStartRetryConflictIsReadOnly("local-v3-pretry", activeAttemptId, attemptCount,
            updatedAt, changes, diagnostics, cursorSequence, lineage, authorityRevision);
        overwriteCheckpoint(attempt.attemptId, original);
    }

    @Test
    public void maxSafeParentRevisionCannotCreateAChildOrAdvanceAnyAuthorityState() throws Exception {
        store.submitTurn(yuqiThreeBubbleSubmission("local-v3-max", "msg-v3-max-3", 790L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission("local-v3-max"), "device_gateway", 791L
        );
        ExecutionAttemptEntity attempt = store.activeAttempt("local-v3-max");
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        store.markFailed("local-v3-max", attempt.attemptId, "REMOTE", "verified", true, 792L);
        JSONObject failure = canonicalFailure(checkpoint, true, 792L)
            .put("lineageRevision", 9007199254740991L);
        failure.put("rawStatusChecksum", JSONObject.NULL);
        failure.put("rawStatusChecksum", checksumWithoutField(failure, "rawStatusChecksum"));
        JSONObject maxParent = new JSONObject(checkpoint.toString()).put(
            "outcome", new JSONObject()
                .put("type", "verified_remote_failure")
                .put("route", "cloud")
                .put("relayMessageId", "relay_max")
                .put("failure", failure)
                .put("result", JSONObject.NULL)
                .put("redactedAt", JSONObject.NULL));
        overwriteCheckpoint(attempt.attemptId, maxParent);
        int attempts = database.executionDao().attempts("local-v3-max").size();
        long updatedAt = store.turn("local-v3-max").updatedAt;
        long changes = rowCount("change_events");
        long diagnostics = rowCount("diagnostics");
        String lineage = checkpoint.getString("authorityLineageKey");
        assertStartRetryConflictIsReadOnly(
            "local-v3-max", attempt.attemptId, attempts, updatedAt, changes, diagnostics,
            1L, lineage, 1L);
    }

    @Test
    public void firstV3BootstrapNormalizesLegacyZeroSequenceAndDoesNotInventPcWatermarks() throws Exception {
        insertHistoricalCompletedAnchor("legacy-zero", null, null);
        store.markNativeCompleted("yuqi", "legacy-zero", "legacy-zero", 0L, 800L);
        store.markUiApplied("yuqi", "legacy-zero", "legacy-zero", 0L, 800L);
        store.submitTurn(yuqiThreeBubbleSubmission("local-after-zero", "msg-after-zero-3", 801L));

        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission("local-after-zero"), "device_gateway", 802L
        );
        JSONObject cursor = new JSONObject(prepared.bridgeAuthorityCheckpointJson)
            .getJSONObject("normalizedEnvelope").getJSONObject("context")
            .getJSONObject("visibilityCursor");

        assertEquals("turn_legacy-zero", cursor.getString("nativeCompletedTurnId"));
        assertEquals("turn_legacy-zero", cursor.getString("nativeCompletedGroupId"));
        assertEquals(0L, cursor.getLong("nativeCompletedSequence"));
        assertEquals(1L, cursor.getLong("localSequence"));
    }

    @Test
    public void canonicalV2PositiveAnchorUsesAndroidCursorWithoutFakePcSequenceEquality() throws Exception {
        insertHistoricalCompletedAnchor("legacy-positive", "group-v2-positive", null);
        store.markNativeCompleted("yuqi", "legacy-positive", "group-v2-positive", 7L, 900L);
        store.markUiApplied("yuqi", "legacy-positive", "group-v2-positive", 7L, 900L);
        store.submitTurn(yuqiThreeBubbleSubmission("local-after-v2", "msg-after-v2-3", 901L));

        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission("local-after-v2"), "device_gateway", 902L
        );
        JSONObject cursor = new JSONObject(prepared.bridgeAuthorityCheckpointJson)
            .getJSONObject("normalizedEnvelope").getJSONObject("context")
            .getJSONObject("visibilityCursor");

        assertEquals("turn_legacy-positive", cursor.getString("nativeCompletedTurnId"));
        assertEquals("group-v2-positive", cursor.getString("nativeCompletedGroupId"));
        assertEquals(7L, cursor.getLong("nativeCompletedSequence"));
        assertEquals(8L, cursor.getLong("localSequence"));
    }

    @Test
    public void preparationFaultRollsBackCursorAuthorityTurnPinsAndCheckpointTogether() throws Exception {
        store.submitTurn(yuqiThreeBubbleSubmission("local-v3-fault", "msg-v3-fault-3", 1000L));
        database.getOpenHelper().getWritableDatabase().execSQL(
            "CREATE TEMP TRIGGER fail_bridge_checkpoint BEFORE UPDATE OF "
                + "bridgeAuthorityCheckpointJson ON execution_attempts "
                + "WHEN NEW.bridgeAuthorityCheckpointJson IS NOT NULL "
                + "BEGIN SELECT RAISE(ABORT, 'forced checkpoint fault'); END"
        );
        try {
            assertThrows(RuntimeException.class, () -> store.prepareBridgeSubmission(
                persistedSubmission("local-v3-fault"), "device_gateway", 1001L
            ));
        } finally {
            database.getOpenHelper().getWritableDatabase().execSQL(
                "DROP TRIGGER IF EXISTS fail_bridge_checkpoint"
            );
        }

        ChatTurnEntity turn = store.turn("local-v3-fault");
        assertEquals(null, turn.authorityLineageKey);
        assertEquals(null, turn.lineageRevision);
        assertEquals(null, turn.inputVisibilitySequence);
        assertEquals(null, store.getConversationCursor("yuqi"));
        assertEquals(null, database.executionDao().conversationAuthority(
            AuthorityIdentity.lineageKey(
                "yuqi", "private_chat", "msg-prior-1-local-v3-fault"
            )
        ));
        ExecutionAttemptEntity attempt = store.activeAttempt("local-v3-fault");
        assertEquals(null, attempt.bridgeAuthorityCheckpointJson);
        assertEquals(null, attempt.bridgeAuthorityCheckpointChecksum);
    }

    @Test
    public void retryUsesFreshAttemptAndCommitClearsFailure() {
        store.submitTurn(submission("turn-1", "msg-1"));
        String firstAttempt = store.activeAttempt("turn-1").attemptId;
        store.markFailed("turn-1", firstAttempt, "TIMEOUT", "read timeout", true, 2L);

        ExecutionAttemptEntity retry = store.startRetry("turn-1", 3L);
        assertNotEquals(firstAttempt, retry.attemptId);
        prepareChatDone("turn-1", retry.attemptId);

        store.commitReply(
            "turn-1",
            retry.attemptId,
            Collections.singletonList(textPart("turn-1", retry.attemptId, "收到")),
            4L
        );

        assertEquals(TurnState.COMPLETED, store.displayState("turn-1"));
        assertEquals(1, store.replyParts("turn-1").size());
    }

    @Test
    public void retryCanReplaceCorruptInputAndSnapshotBeforeNewAttempt() {
        TurnSubmission broken = new TurnSubmission(
            "turn-repair",
            "char-1",
            "msg-repair",
            TurnKind.DIRECT_REPLY,
            "{}",
            "{\"messages\":[]}",
            null,
            1L
        );
        store.submitTurn(broken);
        String firstAttempt = store.activeAttempt("turn-repair").attemptId;
        store.markFailed("turn-repair", firstAttempt, "INVALID_INPUT", "raw user message is empty", true, 2L);
        String repairedInput = "{\"message\":{\"speakerId\":\"user\",\"content\":\"hello\"}}";
        String repairedSnapshot = "{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}";

        store.startRetry("turn-repair", 3L, repairedInput, repairedSnapshot);

        assertEquals(repairedInput, store.turn("turn-repair").inputJson);
        assertEquals(repairedSnapshot, store.turn("turn-repair").snapshotJson);
    }

    @Test
    public void legacyRetryPreservesSnapshotBytesUnlessItRemovesACallerMarker() throws Exception {
        TurnSubmission broken = new TurnSubmission(
            "turn-legacy-marker", "char-1", "msg-legacy-marker", TurnKind.DIRECT_REPLY,
            "{}", "{ \"messages\" : [] }", null, 1L
        );
        store.submitTurn(broken);
        String attemptId = store.activeAttempt("turn-legacy-marker").attemptId;
        store.markFailed("turn-legacy-marker", attemptId, "INVALID_INPUT", "broken", true, 2L);
        String exactInput = "{\"text\":\"fixed\"}";
        String exactSnapshot = "{ \"messages\" : [ { \"role\" : \"user\" } ] }";
        store.startRetry("turn-legacy-marker", 3L, exactInput, exactSnapshot);
        assertEquals(exactSnapshot, store.turn("turn-legacy-marker").snapshotJson);

        String retryAttempt = store.activeAttempt("turn-legacy-marker").attemptId;
        store.markFailed("turn-legacy-marker", retryAttempt, "INVALID_INPUT", "again", true, 4L);
        String forged = new JSONObject()
            .put("messages", new JSONArray())
            .put("_alBridgeProtocol", new JSONObject()
                .put("version", 3)
                .put("owner", "room-v12"))
            .toString();
        store.startRetry("turn-legacy-marker", 5L, exactInput, forged);
        assertEquals(false, new JSONObject(store.turn("turn-legacy-marker").snapshotJson)
            .has("_alBridgeProtocol"));
        assertEquals(null, store.turn("turn-legacy-marker").bridgeProtocolVersion);
    }

    @Test
    public void legacyRetryPersistsExactlyOneCanonicalUserMessage() throws Exception {
        TurnSubmission broken = new TurnSubmission(
            "turn-legacy", "char-1", "msg-legacy", TurnKind.DIRECT_REPLY,
            "{}", "{\"messages\":[]}", null, 1L
        );
        store.submitTurn(broken);
        String firstAttempt = store.activeAttempt("turn-legacy").attemptId;
        store.markFailed("turn-legacy", firstAttempt, "INVALID_INPUT", "raw user message is empty", true, 2L);
        String input = "{\"message\":{\"messageId\":\"msg-legacy\",\"content\":\"你好\",\"sentAt\":1},\"deviceSeq\":1}";
        String snapshot = "{\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}";

        store.startRetry("turn-legacy", 3L, input, snapshot);
        TurnSubmission repaired = new TurnSubmission(
            "turn-legacy", "char-1", "msg-legacy", TurnKind.DIRECT_REPLY,
            input, snapshot, null, 1L
        );
        RoomBridgeMirror mirror = new RoomBridgeMirror(database.executionDao(), "phone_test");
        mirror.persistSubmission(repaired);
        mirror.persistSubmission(repaired);

        assertEquals("你好", new JSONObject(store.turn("turn-legacy").inputJson)
            .getJSONObject("message").getString("content"));
        int userRows = 0;
        for (RawMessageEntity row : database.executionDao().recentRawMessages("char-1", 20)) {
            if ("turn-legacy".equals(row.turnId) && "user".equals(row.speakerId)) userRows += 1;
        }
        assertEquals(1, userRows);
    }

    @Test
    public void lateOldAttemptCannotCommitAfterRetry() {
        store.submitTurn(submission("turn-2", "msg-2"));
        String oldAttempt = store.activeAttempt("turn-2").attemptId;
        store.markFailed("turn-2", oldAttempt, "TIMEOUT", "read timeout", true, 2L);
        String activeAttempt = store.startRetry("turn-2", 3L).attemptId;

        assertThrows(
            StaleAttemptException.class,
            () -> store.commitReply(
                "turn-2",
                oldAttempt,
                Collections.singletonList(textPart("turn-2", oldAttempt, "旧回复")),
                4L
            )
        );

        prepareChatDone("turn-2", activeAttempt);
        store.commitReply(
            "turn-2",
            activeAttempt,
            Collections.singletonList(textPart("turn-2", activeAttempt, "新回复")),
            5L
        );
        assertEquals("新回复", store.replyParts("turn-2").get(0).content);
    }

    @Test
    public void duplicateSubmissionKeepsOneAttempt() {
        store.submitTurn(submission("turn-3", "msg-3"));
        store.submitTurn(submission("turn-3", "msg-3"));
        assertEquals(1, database.executionDao().attempts("turn-3").size());
    }

    @Test
    public void freshRetryTurnCanShareCanonicalSourceMessage() {
        store.submitTurn(submission("turn-original", "msg-shared"));
        store.submitTurn(submission("turn-retry", "msg-shared"));

        assertEquals("turn-original", store.turn("turn-original").turnId);
        assertEquals("turn-retry", store.turn("turn-retry").turnId);
        assertEquals(1, database.executionDao().attempts("turn-original").size());
        assertEquals(1, database.executionDao().attempts("turn-retry").size());
    }

    @Test
    public void cancelledTurnRejectsLateReplyCommit() {
        store.submitTurn(submission("turn-4", "msg-4"));
        String cancelledAttempt = store.activeAttempt("turn-4").attemptId;

        store.cancelTurn("turn-4", 2L, false);

        assertThrows(
            StaleAttemptException.class,
            () -> store.commitReply(
                "turn-4",
                cancelledAttempt,
                Collections.singletonList(textPart("turn-4", cancelledAttempt, "迟到回复")),
                3L
            )
        );
        assertEquals(TurnState.CANCELLED, store.displayState("turn-4"));
    }

    @Test
    public void completedTurnRemainsInUiInboxUntilAcknowledged() {
        store.submitTurn(submission("turn-ui-inbox", "msg-ui-inbox"));
        String attemptId = store.activeAttempt("turn-ui-inbox").attemptId;
        prepareChatDone("turn-ui-inbox", attemptId);
        store.commitReply(
            "turn-ui-inbox",
            attemptId,
            Collections.singletonList(textPart("turn-ui-inbox", attemptId, "通知已经收到的正文")),
            10L
        );

        assertEquals(1, store.unappliedCompletedTurns(10).size());
        store.acknowledgeUiApplied("turn-ui-inbox", 11L);
        assertEquals(0, store.unappliedCompletedTurns(10).size());
    }

    @Test
    public void notificationUiAndCloudStagesRemainIndependent() {
        store.submitTurn(submission("turn-delivery-stages", "msg-delivery-stages"));
        String attemptId = store.activeAttempt("turn-delivery-stages").attemptId;
        prepareChatDone("turn-delivery-stages", attemptId);
        store.commitReply(
            "turn-delivery-stages",
            attemptId,
            Collections.singletonList(textPart("turn-delivery-stages", attemptId, "通知先显示")),
            10L
        );

        store.markNotificationShown("turn-delivery-stages", 11L);
        assertEquals(Long.valueOf(10L), store.turn("turn-delivery-stages").completedAt);
        assertEquals(Long.valueOf(11L), store.turn("turn-delivery-stages").notificationShownAt);
        assertEquals(null, store.turn("turn-delivery-stages").uiAppliedAt);
        assertEquals(null, store.turn("turn-delivery-stages").cloudConfirmedAt);
        assertEquals(1, store.unappliedCompletedTurns(10).size());

        store.acknowledgeUiApplied("turn-delivery-stages", 12L);
        store.markCloudConfirmed("turn-delivery-stages", 13L);

        assertEquals(Long.valueOf(12L), store.turn("turn-delivery-stages").uiAppliedAt);
        assertEquals(Long.valueOf(13L), store.turn("turn-delivery-stages").cloudConfirmedAt);
        assertEquals(0, store.unappliedCompletedTurns(10).size());
    }

    @Test
    public void exactTerminalReceiptReplayIsIdempotentButChangedReceiptIsRejected() {
        store.submitTurn(submission("turn-receipt", "message-receipt"));

        store.recordTerminalReceipt(
            "turn-receipt", "lineage-1", "lane-1", "message-receipt", "group-1",
            2L, "pc", "v3", "checksum-1", "visible", 7L, 1L, 10L
        );
        store.recordTerminalReceipt(
            "turn-receipt", "lineage-1", "lane-1", "message-receipt", "group-1",
            2L, "pc", "v3", "checksum-1", "visible", 7L, 1L, 11L
        );

        assertEquals("group-1", store.turn("turn-receipt").visibleGroupId);
        IllegalStateException conflict = assertThrows(IllegalStateException.class, () -> store.recordTerminalReceipt(
            "turn-receipt", "lineage-1", "lane-1", "message-receipt", "group-2",
            2L, "pc", "v3", "checksum-1", "visible", 7L, 1L, 12L
        ));
        assertTrue(conflict.getMessage().contains("BRIDGE_AUTHORITY_CONFLICT"));
    }

    @Test
    public void clearAutomaticTasksCancelsOnlyProactiveWork() {
        store.submitTurn(submission("direct", "direct-msg", TurnKind.DIRECT_REPLY));
        store.submitTurn(submission("chat-auto", "chat-auto-msg", TurnKind.PROACTIVE_CHAT));
        store.submitTurn(submission("moment-auto", "moment-auto-msg", TurnKind.PROACTIVE_MOMENT));

        AutomaticTaskCleanupResult result = store.clearAutomaticTasks(20L);

        assertEquals(2, result.cancelledTurns);
        assertEquals(2, result.cancelledAttempts);
        assertEquals(TurnState.QUEUED, store.displayState("direct"));
        assertEquals(TurnState.CANCELLED, store.displayState("chat-auto"));
        assertEquals(TurnState.CANCELLED, store.displayState("moment-auto"));
    }

    @Test
    public void clearAutomaticTasksSuppressesCompletedInboxAndDeletesSnapshots() {
        store.submitTurn(submission("completed-auto", "completed-auto-msg", TurnKind.PROACTIVE_MOMENT));
        String attemptId = store.activeAttempt("completed-auto").attemptId;
        prepareChatDone("completed-auto", attemptId);
        store.commitReply(
            "completed-auto",
            attemptId,
            Collections.singletonList(textPart("completed-auto", attemptId, "旧朋友圈")),
            12L
        );
        CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
        snapshot.snapshotId = "char-1:moment";
        snapshot.characterId = "char-1";
        snapshot.characterName = "角色";
        snapshot.playerName = "我";
        snapshot.systemPrompt = "";
        snapshot.momentSystemPrompt = "";
        snapshot.contextJson = "{\"cloudJobId\":\"old\"}";
        snapshot.chatConfigId = "chat-v1";
        snapshot.memoryConfigId = "memory-v1";
        snapshot.createdAt = 1L;
        database.executionDao().upsertSnapshot(snapshot);

        AutomaticTaskCleanupResult result = store.clearAutomaticTasks(20L);

        assertEquals(1, result.acknowledgedCompletedTurns);
        assertEquals(1, result.deletedSnapshots);
        assertEquals(0, store.unappliedCompletedTurns(10).size());
        assertEquals(null, database.executionDao().latestSnapshot("char-1:moment"));
    }

    private void prepareChatDone(String turnId, String attemptId) {
        store.markStage(turnId, attemptId, TurnState.MEMORY_RUNNING, AttemptStage.MEMORY, 3L);
        store.saveMemoryResult(turnId, attemptId, "无相关记忆", 3L);
        store.markStage(turnId, attemptId, TurnState.CHAT_RUNNING, AttemptStage.CHAT, 3L);
        store.saveRawReply(turnId, attemptId, "模型原始回复", 3L);
    }

    private static TurnSubmission submission(String turnId, String messageId) {
        return submission(turnId, messageId, TurnKind.DIRECT_REPLY);
    }

    private static TurnSubmission submission(String turnId, String messageId, TurnKind kind) {
        return new TurnSubmission(
            turnId,
            "char-1",
            messageId,
            kind,
            "{\"text\":\"你好\"}",
            "{\"messages\":[]}",
            null,
            1L
        );
    }

    private TurnSubmission persistedSubmission(String turnId) {
        ChatTurnEntity turn = store.turn(turnId);
        if (TurnState.QUEUED.name().equals(turn.state)) {
            store.markStage(
                turnId, turn.activeAttemptId, TurnState.MEMORY_RUNNING,
                AttemptStage.MEMORY, Math.max(1L, turn.updatedAt + 1L));
            turn = store.turn(turnId);
        }
        return new TurnSubmission(
            turn.turnId, turn.characterId, turn.sourceMessageId, TurnKind.valueOf(turn.kind),
            turn.inputJson, turn.snapshotJson, turn.cloudJobId, turn.createdAt
        );
    }

    private static TurnSubmission yuqiThreeBubbleSubmission(
        String turnId,
        String lastMessageId,
        long createdAt
    ) throws Exception {
        JSONArray messages = new JSONArray()
            .put(userMessage("msg-prior-1-" + turnId, "第一泡", createdAt - 2L))
            .put(userMessage("msg-prior-2-" + turnId, "第二泡", createdAt - 1L))
            .put(userMessage(lastMessageId, "第三泡", createdAt));
        JSONArray ids = new JSONArray();
        for (int index = 0; index < messages.length(); index += 1) {
            ids.put(messages.getJSONObject(index).getString("messageId"));
        }
        JSONObject input = new JSONObject()
            .put("message", messages.getJSONObject(2))
            .put("options", new JSONObject()
                .put("batchId", "batch-" + turnId)
                .put("batchMessageIds", ids)
                .put("batchMessages", messages)
                .put("batchStartedAt", createdAt - 2L)
                .put("batchCommittedAt", createdAt));
        return new TurnSubmission(
            turnId, "yuqi", lastMessageId, TurnKind.DIRECT_REPLY,
            input.toString(), new JSONObject().put("scene", "chat").toString(), null, createdAt
        );
    }

    private static TurnSubmission yuqiAutomaticSubmission(String turnId, long createdAt)
        throws Exception {
        return new TurnSubmission(
            turnId,
            "yuqi",
            "source-" + turnId,
            TurnKind.PROACTIVE_CHAT,
            new JSONObject().put("scheduledFor", createdAt).toString(),
            new JSONObject().put("semantic", "original snapshot").toString(),
            "job-" + turnId,
            createdAt
        );
    }

    private static JSONObject userMessage(String messageId, String content, long sentAt) throws Exception {
        return new JSONObject()
            .put("messageId", messageId)
            .put("speakerId", "user")
            .put("speakerType", "user")
            .put("recipientId", "yuqi")
            .put("content", content)
            .put("sentAt", sentAt);
    }

    private static JSONObject canonicalTerminal(
        JSONObject checkpoint,
        String disposition,
        int itemCount,
        JSONArray actions
    ) throws Exception {
        String lineageKey = checkpoint.getString("authorityLineageKey");
        String groupId = AuthorityIdentity.groupId(lineageKey);
        JSONArray parts = new JSONArray();
        for (int ordinal = 0; ordinal < itemCount; ordinal += 1) {
            JSONObject semantic = new JSONObject()
                .put("content", "虞栖回复第" + (ordinal + 1) + "泡")
                .put("speakerId", "yuqi")
                .put("speakerType", "character")
                .put("recipientId", "user");
            parts.put(new JSONObject(semantic.toString())
                .put("messageId", AuthorityIdentity.messageId(groupId, ordinal))
                .put("ordinal", ordinal)
                .put("itemChecksum", BridgeAuthority.sha256CanonicalJson(semantic)));
        }
        return new JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", checkpoint.getString("authoritativeTurnId"))
            .put("roleId", "yuqi")
            .put("authorityOrigin", "pc")
            .put("authorityLineageKey", lineageKey)
            .put("visibleGroupId", groupId)
            .put("lineageRevision", checkpoint.getLong("claimedLineageRevision") + 1L)
            .put("turnRevision", 4L)
            .put("laneKey", checkpoint.getString("laneKey"))
            .put("laneRevision", 8L)
            .put("inputVisibilitySequence", checkpoint.getLong("inputVisibilitySequence"))
            .put("inputClearEpoch", checkpoint.getLong("inputClearEpoch"))
            .put("generationFingerprint", "fp_v3_terminal")
            .put("releaseId", "cognition-v3")
            .put("commitPayloadVersion", "pc-visible-commit-v2")
            .put("commitChecksum", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .put("terminalDisposition", disposition)
            .put("replyParts", parts)
            .put("actions", actions);
    }

    private static JSONObject canonicalAction(
        JSONObject checkpoint,
        int ordinal,
        String kind,
        String targetKey,
        String targetRevision,
        JSONObject payload
    ) throws Exception {
        String groupId = AuthorityIdentity.groupId(
            checkpoint.getString("authorityLineageKey"));
        JSONObject semantic = new JSONObject()
            .put("kind", kind)
            .put("targetKey", targetKey)
            .put("targetRevision", targetRevision)
            .put("payload", payload);
        return new JSONObject(semantic.toString())
            .put("actionId", AuthorityIdentity.actionId(groupId, ordinal))
            .put("ordinal", ordinal)
            .put("actionChecksum", BridgeAuthority.sha256CanonicalJson(semantic));
    }

    private static JSONObject actionPayload(String kind, int index) throws Exception {
        if (kind.startsWith("payment_")) {
            return new JSONObject().put("messageId", "payment-message-" + index);
        }
        if (kind.startsWith("moment_")) {
            JSONObject payload = new JSONObject().put("momentId", "moment-" + index);
            if ("moment_reply".equals(kind)) {
                payload.put("replyToCommentId", "comment-" + index);
            }
            return payload;
        }
        if (kind.startsWith("role_plan_")) {
            return new JSONObject().put("planId", "plan-" + index);
        }
        if (kind.startsWith("life_episode_")) {
            return "life_episode_create".equals(kind)
                ? new JSONObject().put("title", "episode-" + index)
                : new JSONObject().put("targetEpisodeId", "episode-" + index);
        }
        return new JSONObject().put("stageId", "stage-" + index);
    }

    private static JSONObject canonicalFailure(
        JSONObject checkpoint,
        boolean retryAllowed,
        long failedAt
    ) throws Exception {
        JSONObject failure = new JSONObject()
            .put("protocolVersion", 3)
            .put("type", "BACKLOG_FAILED")
            .put("turnId", checkpoint.getString("authoritativeTurnId"))
            .put("roleId", "yuqi")
            .put("authorityLineageKey", checkpoint.getString("authorityLineageKey"))
            .put("lineageRevision", checkpoint.getLong("claimedLineageRevision"))
            .put("turnRevision", 1L)
            .put("laneKey", checkpoint.getString("laneKey"))
            .put("laneRevision", 1L)
            .put("retryOfTurnId", checkpoint.get("retryOfTurnId"))
            .put("inputVisibilitySequence", checkpoint.getLong("inputVisibilitySequence"))
            .put("inputClearEpoch", checkpoint.getLong("inputClearEpoch"))
            .put("generationFingerprint", JSONObject.NULL)
            .put("releaseId", "cognition-v3")
            .put("state", "failed")
            .put("errorCode", "YUQI_TRANSIENT_EXECUTION_FAILURE")
            .put("failureClass", "transient")
            .put("retryAllowed", retryAllowed)
            .put("failedAt", failedAt);
        failure.put("rawStatusChecksum", BridgeAuthority.sha256CanonicalJson(failure));
        return failure;
    }

    private static JSONObject verifiedFailureOutcome(
        JSONObject checkpoint,
        boolean retryAllowed,
        long failedAt,
        String relayMessageId
    ) throws Exception {
        return new JSONObject()
            .put("type", "verified_remote_failure")
            .put("route", "cloud")
            .put("relayMessageId", relayMessageId)
            .put("failure", canonicalFailure(checkpoint, retryAllowed, failedAt))
            .put("result", JSONObject.NULL)
            .put("redactedAt", JSONObject.NULL);
    }

    private static JSONObject openOutcome() throws Exception {
        return new JSONObject()
            .put("type", "open")
            .put("route", JSONObject.NULL)
            .put("relayMessageId", JSONObject.NULL)
            .put("failure", JSONObject.NULL)
            .put("result", JSONObject.NULL)
            .put("redactedAt", JSONObject.NULL);
    }

    private static void rehashEnvelope(JSONObject checkpoint) throws Exception {
        checkpoint.put("envelopeChecksum", BridgeAuthority.sha256CanonicalJson(
            checkpoint.getJSONObject("normalizedEnvelope")));
    }

    private void assertCorruptReplayIsReadOnly(
        String turnId,
        String attemptId,
        JSONObject corrupt,
        String lineage,
        long updatedAt,
        long changeCount,
        long diagnosticCount
    ) {
        overwriteCheckpoint(attemptId, corrupt);
        long cursorSequence = store.getConversationCursor("yuqi").localSequence;
        long authorityRevision = database.executionDao().conversationAuthority(lineage).revision;
        int attempts = database.executionDao().attempts(turnId).size();
        assertThrows(IllegalStateException.class, () -> store.prepareBridgeSubmission(
            persistedSubmission(turnId), "device_gateway", updatedAt + 100L
        ));
        assertEquals(cursorSequence, store.getConversationCursor("yuqi").localSequence);
        assertEquals(authorityRevision,
            database.executionDao().conversationAuthority(lineage).revision);
        assertEquals(attempts, database.executionDao().attempts(turnId).size());
        assertEquals(updatedAt, store.turn(turnId).updatedAt);
        assertEquals(changeCount, rowCount("change_events"));
        assertEquals(diagnosticCount, rowCount("diagnostics"));
    }

    private void assertStartRetryConflictIsReadOnly(
        String turnId,
        String activeAttemptId,
        int attemptCount,
        long updatedAt,
        long changeCount,
        long diagnosticCount,
        long cursorSequence,
        String lineage,
        long authorityRevision
    ) {
        assertThrows(IllegalStateException.class, () -> store.startRetry(turnId, updatedAt + 100L));
        assertEquals(activeAttemptId, store.turn(turnId).activeAttemptId);
        assertEquals(attemptCount, database.executionDao().attempts(turnId).size());
        assertEquals(updatedAt, store.turn(turnId).updatedAt);
        assertEquals(changeCount, rowCount("change_events"));
        assertEquals(diagnosticCount, rowCount("diagnostics"));
        assertEquals(cursorSequence, store.getConversationCursor("yuqi").localSequence);
        assertEquals(authorityRevision,
            database.executionDao().conversationAuthority(lineage).revision);
    }

    private void assertPrepareConflictIsReadOnly(
        String turnId,
        int attemptCount,
        long updatedAt,
        long changeCount,
        long diagnosticCount,
        long cursorSequence,
        String lineage,
        long authorityRevision,
        long now
    ) {
        assertThrows(IllegalStateException.class, () -> store.prepareBridgeSubmission(
            persistedSubmission(turnId), "device_gateway", now));
        assertEquals(attemptCount, database.executionDao().attempts(turnId).size());
        assertEquals(updatedAt, store.turn(turnId).updatedAt);
        assertEquals(changeCount, rowCount("change_events"));
        assertEquals(diagnosticCount, rowCount("diagnostics"));
        assertEquals(cursorSequence, store.getConversationCursor("yuqi").localSequence);
        assertEquals(authorityRevision,
            database.executionDao().conversationAuthority(lineage).revision);
    }

    private void assertOpenCanonicalAttemptAfterRollback(
        String turnId,
        String attemptId,
        JSONObject checkpoint,
        long changeCount,
        long diagnosticCount
    ) throws Exception {
        ChatTurnEntity turn = store.turn(turnId);
        ExecutionAttemptEntity attempt = database.executionDao().attempt(attemptId);
        assertEquals(TurnState.MEMORY_RUNNING.name(), turn.state);
        assertEquals(null, turn.completedAt);
        assertEquals(null, turn.visibleGroupId);
        assertEquals(null, turn.bridgeCommitChecksum);
        assertEquals(null, turn.deletedAt);
        assertEquals(TurnState.MEMORY_RUNNING.name(), attempt.state);
        assertEquals(AttemptStage.MEMORY.name(), attempt.stage);
        assertEquals(null, attempt.finishedAt);
        assertEquals(
            BridgeAuthority.canonicalJson(checkpoint),
            attempt.bridgeAuthorityCheckpointJson);
        assertEquals("open", new JSONObject(attempt.bridgeAuthorityCheckpointJson)
            .getJSONObject("outcome").getString("type"));
        ConversationAuthorityEntity authority = database.executionDao().conversationAuthority(
            checkpoint.getString("authorityLineageKey"));
        assertEquals("OPEN", authority.state);
        assertEquals(checkpoint.getString("authoritativeTurnId"), authority.latestTurnId);
        assertEquals(checkpoint.getLong("claimedLineageRevision"), authority.revision);
        assertEquals(0, store.replyParts(turnId).size());
        assertEquals(0, database.executionDao().canonicalCharacterMessages(
            checkpoint.getString("authoritativeTurnId")).size());
        ConversationCursorEntity cursor = store.getConversationCursor(turn.characterId);
        assertEquals(checkpoint.getLong("inputVisibilitySequence"), cursor.localSequence);
        assertEquals(0L, cursor.nativeCompletedSequence);
        assertEquals(0L, cursor.uiAppliedSequence);
        assertEquals(changeCount, rowCount("change_events"));
        assertEquals(diagnosticCount, rowCount("diagnostics"));
    }

    private void assertCurrentRetryPointerConflictIsReadOnly(
        String turnId,
        String lineage,
        long now
    ) {
        ChatTurnEntity before = store.turn(turnId);
        String activeAttemptId = before.activeAttemptId;
        int attemptCount = database.executionDao().attempts(turnId).size();
        long changeCount = rowCount("change_events");
        long diagnosticCount = rowCount("diagnostics");
        long cursorSequence = store.getConversationCursor("yuqi").localSequence;
        long authorityRevision = database.executionDao().conversationAuthority(lineage).revision;
        assertThrows(IllegalStateException.class, () -> store.startRetry(turnId, now));
        ChatTurnEntity after = store.turn(turnId);
        assertEquals(activeAttemptId, after.activeAttemptId);
        assertEquals(before.state, after.state);
        assertEquals(before.inputJson, after.inputJson);
        assertEquals(before.snapshotJson, after.snapshotJson);
        assertEquals(before.updatedAt, after.updatedAt);
        assertEquals(attemptCount, database.executionDao().attempts(turnId).size());
        assertEquals(changeCount, rowCount("change_events"));
        assertEquals(diagnosticCount, rowCount("diagnostics"));
        assertEquals(cursorSequence, store.getConversationCursor("yuqi").localSequence);
        assertEquals(authorityRevision,
            database.executionDao().conversationAuthority(lineage).revision);
    }

    private long rowCount(String table) {
        Cursor cursor = database.getOpenHelper().getReadableDatabase().query(
            "SELECT COUNT(*) FROM " + table);
        try {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        } finally {
            cursor.close();
        }
    }

    private static String checksumWithoutField(JSONObject source, String field) throws Exception {
        JSONObject basis = new JSONObject(source.toString());
        basis.remove(field);
        return BridgeAuthority.sha256CanonicalJson(basis);
    }

    private void overwriteCheckpoint(String attemptId, JSONObject checkpoint) {
        String json = BridgeAuthority.canonicalJson(checkpoint);
        String checksum = BridgeAuthority.sha256CanonicalJson(checkpoint);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE execution_attempts SET bridgeAuthorityCheckpointJson=?, "
                + "bridgeAuthorityCheckpointChecksum=? WHERE attemptId=?",
            new Object[]{json, checksum, attemptId}
        );
    }

    private void insertHistoricalCompletedAnchor(
        String turnId,
        String visibleGroupId,
        Long pcInputVisibilitySequence
    ) {
        ChatTurnEntity anchor = new ChatTurnEntity();
        anchor.turnId = turnId;
        anchor.characterId = "yuqi";
        anchor.sourceMessageId = "msg-" + turnId;
        anchor.kind = TurnKind.PROACTIVE_CHAT.name();
        anchor.state = TurnState.COMPLETED.name();
        anchor.inputJson = "{}";
        anchor.snapshotJson = "{\"historical\":true}";
        anchor.createdAt = 1L;
        anchor.updatedAt = 1L;
        anchor.completedAt = 1L;
        anchor.visibleGroupId = visibleGroupId;
        anchor.inputVisibilitySequence = pcInputVisibilitySequence;
        database.executionDao().insertTurn(anchor);
    }

    private static ReplyPartEntity textPart(String turnId, String attemptId, String text) {
        ReplyPartEntity part = new ReplyPartEntity();
        part.replyPartId = "part_" + turnId + "_0";
        part.turnId = turnId;
        part.attemptId = attemptId;
        part.sequence = 0;
        part.type = "TEXT";
        part.content = text;
        part.payloadJson = "{}";
        part.createdAt = 4L;
        return part;
    }

    private static RawMessageEntity foreignRawMessage(
        String messageId,
        String turnId,
        String deviceId,
        long deviceSeq,
        long sentAt
    ) {
        RawMessageEntity row = new RawMessageEntity();
        row.messageId = messageId;
        row.turnId = turnId;
        row.characterId = "yuqi";
        row.speakerId = "yuqi";
        row.speakerType = "character";
        row.recipientId = "user";
        row.content = "foreign";
        row.sentAt = sentAt;
        row.origin = "pc";
        row.deviceId = deviceId;
        row.deviceSeq = deviceSeq;
        row.syncSeq = 0L;
        row.checksum = RoomExecutionStore.canonicalRawMessageChecksum(row);
        return row;
    }
}
