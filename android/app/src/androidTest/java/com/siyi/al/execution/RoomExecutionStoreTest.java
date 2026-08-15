package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.database.Cursor;
import androidx.room.Room;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.AutomaticScheduleOutboxEntity;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ChangeEventEntity;
import com.siyi.al.execution.db.DiagnosticEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.EvidenceFactEntity;
import com.siyi.al.execution.db.LifecycleControlEntity;
import com.siyi.al.execution.db.MemoryRecordEntity;
import com.siyi.al.execution.db.ConversationAuthorityEntity;
import com.siyi.al.execution.db.ConversationCursorEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.db.RolePlanEntity;
import com.siyi.al.execution.db.RolePlanHistoryEntity;
import com.siyi.al.execution.db.RolePlanOccurrenceEntity;
import com.siyi.al.execution.db.YuqiAnnotationEntity;
import com.siyi.al.execution.bridge.BridgeResult;
import com.siyi.al.execution.bridge.BridgeTurnStatus;
import com.siyi.al.execution.bridge.BridgeClient;
import com.siyi.al.execution.bridge.FallbackJournal;
import com.siyi.al.execution.bridge.RoomBridgeMirror;
import com.siyi.al.execution.api.HttpResponse;
import com.siyi.al.execution.api.HttpTransport;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.UUID;
import java.lang.reflect.Method;
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
        store = new RoomExecutionStore(database, "device_gateway");
    }

    @After
    public void tearDown() {
        database.close();
    }

    @Test
    public void automaticScheduleTransitionIsAtomicReplaySafeAndSequenceGuarded() {
        AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
        AutomaticScheduleContract.Policy policy = automaticPolicy();
        AutomaticScheduleContract.Source bootstrap = automaticSource(
            "bootstrap", "bootstrap-yuqi-chat", 'b', 0L, 1_000L);

        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity first = schedules.configure(
            "yuqi", "chat", "00112233445566778899aabbccddeeff", bootstrap, policy, 1_000L);
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity replay = schedules.configure(
            "yuqi", "chat", "00112233445566778899aabbccddeeff", bootstrap, policy, 9_999_999L);

        assertEquals(first.generation, replay.generation);
        assertEquals(first.activeJobId, replay.activeJobId);
        assertEquals(first.dueAt, replay.dueAt);
        assertEquals(first.semanticChecksum, replay.semanticChecksum);
        assertEquals(1L, rowCount("automatic_schedule_authorities"));
        assertEquals(1L, rowCount("automatic_schedule_outbox"));
        assertEquals(1L, rowCount("automatic_schedule_events"));

        assertThrows(IllegalStateException.class, () -> schedules.configure(
            "yuqi", "chat", "00112233445566778899aabbccddeeff",
            automaticSource("bootstrap", "bootstrap-yuqi-chat", 'c', 0L, 1_000L),
            policy, 2_000L));
        assertEquals(1L, rowCount("automatic_schedule_outbox"));

        schedules.pauseForConversationInternal(
            "yuqi", "chat", "00112233445566778899aabbccddeeff",
            automaticSource("direct_input", "message-new", 'd', 10L, 2_000L), 2_000L);
        assertThrows(IllegalStateException.class, () -> schedules.finalizeDirectInternal(
            "yuqi", "chat", "00112233445566778899aabbccddeeff",
            automaticSource("direct_terminal", "turn-old", 'e', 9L, 2_100L), policy,
            AutomaticScheduleContract.TerminalDisposition.VISIBLE, 2_100L));
        assertEquals(2L, rowCount("automatic_schedule_outbox"));
    }

    @Test
    public void automaticScheduleFaultsRollBackAuthorityOutboxAndEventTogether() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        for (AutomaticScheduleContract.Operation operation : AutomaticScheduleContract.Operation.values()) {
            for (int fault = 1; fault <= 3; fault += 1) {
                AlExecutionDatabase faultDb = Room.inMemoryDatabaseBuilder(context, AlExecutionDatabase.class)
                    .allowMainThreadQueries().build();
                try {
                    AutomaticScheduleStore baseline = new AutomaticScheduleStore(faultDb, "device_gateway");
                    if (operation != AutomaticScheduleContract.Operation.SCHEDULE) {
                        baseline.configure("yuqi", "chat", "00112233445566778899aabbccddeeff",
                            automaticSource("bootstrap", "baseline-" + operation, 'a', 0L, 1_000L),
                            automaticPolicy(), 1_000L);
                    }
                    long authorities = countRows(faultDb, "automatic_schedule_authorities");
                    long outbox = countRows(faultDb, "automatic_schedule_outbox");
                    long events = countRows(faultDb, "automatic_schedule_events");
                    AutomaticScheduleStore injected = new AutomaticScheduleStore(
                        faultDb, "device_gateway", fault);
                    AutomaticScheduleContract.Source source = automaticSource(
                        operation == AutomaticScheduleContract.Operation.SCHEDULE
                            ? "bootstrap" : (operation == AutomaticScheduleContract.Operation.PAUSE
                                ? "direct_input" : "lifecycle"),
                        "fault-" + operation + "-" + fault, (char) ('b' + fault), 1L, 2_000L);
                    assertThrows(IllegalStateException.class, () -> injected.transitionAutomaticSchedule(
                        "yuqi", "chat", "00112233445566778899aabbccddeeff", operation,
                        source, operation == AutomaticScheduleContract.Operation.SCHEDULE
                            ? automaticPolicy() : null, 2_000L));
                    assertEquals(authorities, countRows(faultDb, "automatic_schedule_authorities"));
                    assertEquals(outbox, countRows(faultDb, "automatic_schedule_outbox"));
                    assertEquals(events, countRows(faultDb, "automatic_schedule_events"));
                } finally {
                    faultDb.close();
                }
            }
        }
    }

    @Test
    public void automaticDeliveryMetadataIsIdempotentAndContainsNoPayload() {
        AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
        String epoch = "00112233445566778899aabbccddeeff";
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority = schedules.configure(
            "yuqi", "chat", epoch,
            automaticSource("bootstrap", "delivery-metadata", 'a', 0L, 1_000L),
            automaticPolicy(), 1_000L);
        java.util.HashMap<String, String> raw = new java.util.HashMap<>();
        raw.put("charId", "yuqi");
        raw.put("kind", "chat");
        raw.put("jobId", authority.activeJobId);
        raw.put("authorityEpoch", epoch);
        raw.put("generation", String.valueOf(authority.generation));
        AutomaticTaskCoordinator.ClaimToken token = AutomaticTaskCoordinator.ClaimToken.from(raw);
        assertTrue(store.recordAutomaticDeliveryOutcome(token, "push_replay_wake", 2_000L));
        assertFalse(store.recordAutomaticDeliveryOutcome(token, "push_replay_wake", 2_001L));
        assertEquals(1L, rowCount("automatic_schedule_events"));
        Cursor cursor = database.getOpenHelper().getReadableDatabase().query(
            "SELECT sourceType,sourceId,resultCode,nextJobId FROM automatic_schedule_events");
        try {
            assertTrue(cursor.moveToFirst());
            assertEquals("fcm", cursor.getString(0));
            assertEquals(authority.activeJobId, cursor.getString(1));
            assertEquals("push_replay_wake", cursor.getString(2));
            assertEquals(authority.activeJobId, cursor.getString(3));
        } finally {
            cursor.close();
        }
        assertEquals(0L, rowCount("chat_turns"));
        assertEquals("push_replay_wake", database.executionDao()
            .latestAutomaticScheduleEvent(authority.streamKey).resultCode);
        assertEquals(1, database.executionDao().pendingAutomaticDeliveryRecoveryEvents().size());
    }

    @Test
    public void claimAndRoleDeleteUseOneDurableTombstoneBoundary() throws Exception {
        String epoch = "00112233445566778899aabbccddeeff";
        store.getConversationCursor("yuqi");
        AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority = schedules.configure(
            "yuqi", "chat", epoch,
            automaticSource("bootstrap", "role-delete-claim", 'a', 0L, 1_000L),
            automaticPolicy(), 1_000L);
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity momentAuthority = schedules.configure(
            "yuqi", "moment", epoch,
            automaticSource("bootstrap", "role-delete-claim-moment", 'b', 0L, 1_001L),
            automaticPolicy(), 1_001L);
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi"));
        LifecycleControl control = store.createRoleDelete(
            "yuqi", "device_gateway", cursorChecksum, backupReceipt("yuqi", 1_100L), 1_101L, null);
        assertNotNull(control);
        assertEquals("disabled", database.executionDao()
            .automaticScheduleAuthority(authority.streamKey).state);
        assertNull(database.executionDao().automaticScheduleAuthority(authority.streamKey).activeJobId);
        com.siyi.al.execution.db.AutomaticScheduleOutboxEntity disabledChatOutbox =
            database.executionDao().automaticScheduleOutbox(
                authority.streamKey + ":" + (authority.generation + 1L));
        assertEquals("disable", disabledChatOutbox.operation);
        assertEquals(authority.streamKey, disabledChatOutbox.streamKey);
        JSONObject disabledChatSemantic = new JSONObject(disabledChatOutbox.payloadJson);
        assertEquals("lifecycle", disabledChatSemantic.getString("sourceType"));
        assertTrue(disabledChatSemantic.getString("sourceId").contains(control.controlId));
        assertEquals(control.semanticChecksum.length(),
            disabledChatSemantic.getString("sourceChecksum").length());
        JSONObject chatSourceBasis = new JSONObject()
            .put("characterId", "yuqi")
            .put("controlId", control.controlId)
            .put("controlChecksum", control.semanticChecksum)
            .put("kind", "chat");
        assertEquals(BridgeAuthority.sha256CanonicalJson(chatSourceBasis),
            disabledChatSemantic.getString("sourceChecksum"));
        AutomaticScheduleContract.ValidatedTransition chatTransition =
            AutomaticScheduleContract.validateTransition(disabledChatSemantic);
        assertEquals("disable", disabledChatSemantic.getString("operation"));
        assertEquals(authority.activeJobId, disabledChatSemantic.getString("expectedPreviousJobId"));
        assertTrue(disabledChatSemantic.isNull("jobId"));
        assertTrue(disabledChatSemantic.isNull("dueAt"));
        assertTrue(disabledChatSemantic.isNull("mode"));
        assertEquals(disabledChatOutbox.payloadChecksum, chatTransition.scheduleChecksum);
        assertEquals(BridgeAuthority.canonicalJson(disabledChatSemantic),
            BridgeAuthority.canonicalJson(chatTransition.value));
        assertEquals("disabled", database.executionDao()
            .automaticScheduleAuthority(momentAuthority.streamKey).state);
        assertEquals("disable", database.executionDao().automaticScheduleOutbox(
            momentAuthority.streamKey + ":" + (momentAuthority.generation + 1L)).operation);
        assertEquals(0L, rowCount("chat_turns"));
        java.util.HashMap<String, String> raw = new java.util.HashMap<>();
        raw.put("charId", "yuqi");
        raw.put("kind", "chat");
        raw.put("jobId", authority.activeJobId);
        raw.put("authorityEpoch", epoch);
        raw.put("generation", String.valueOf(authority.generation));
        assertEquals(AutomaticTaskCoordinator.DispatchOutcome.STALE,
            store.claimAutomaticTurn(AutomaticTaskCoordinator.ClaimToken.from(raw), "{}", 1_200L));
        assertEquals(0L, rowCount("chat_turns"));
    }

    @Test
    public void roleDeleteDisableWriteFaultsRollBackBothStreamsAndTombstone() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String epoch = "00112233445566778899aabbccddeeff";
        for (int fault = 1; fault <= 6; fault += 1) {
            final int faultIndex = fault;
            AlExecutionDatabase faultDb = Room.inMemoryDatabaseBuilder(
                context, AlExecutionDatabase.class).allowMainThreadQueries().build();
            try {
                RoomExecutionStore baseline = new RoomExecutionStore(faultDb, "device_gateway");
                baseline.getConversationCursor("yuqi");
                AutomaticScheduleStore schedules = new AutomaticScheduleStore(faultDb, "device_gateway");
                com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity chat = schedules.configure(
                    "yuqi", "chat", epoch,
                    automaticSource("bootstrap", "role-delete-fault-chat-" + fault, 'a', 0L, 1_000L),
                    automaticPolicy(), 1_000L);
                com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity moment = schedules.configure(
                    "yuqi", "moment", epoch,
                    automaticSource("bootstrap", "role-delete-fault-moment-" + fault, 'b', 0L, 1_001L),
                    automaticPolicy(), 1_001L);
                String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
                    "yuqi", faultDb.executionDao().conversationCursor("yuqi"));
                RoomExecutionStore injected = new RoomExecutionStore(
                    faultDb, "device_gateway", boundary -> {}, fault);
                assertThrows(IllegalStateException.class, () -> injected.createRoleDelete(
                    "yuqi", "device_gateway", cursorChecksum,
                    backupReceipt("yuqi", 1_900L + faultIndex), 2_000L + faultIndex, null));
                assertEquals(0L, countRows(faultDb, "lifecycle_controls"));
                assertEquals(2L, countRows(faultDb, "automatic_schedule_authorities"));
                assertEquals(2L, countRows(faultDb, "automatic_schedule_outbox"));
                assertEquals(2L, countRows(faultDb, "automatic_schedule_events"));
                assertEquals("scheduled", faultDb.executionDao()
                    .automaticScheduleAuthority(chat.streamKey).state);
                assertEquals("scheduled", faultDb.executionDao()
                    .automaticScheduleAuthority(moment.streamKey).state);
                assertEquals("waiting", faultDb.executionDao()
                    .automaticScheduleOutbox(chat.streamKey + ":1").state);
                assertEquals("waiting", faultDb.executionDao()
                    .automaticScheduleOutbox(moment.streamKey + ":1").state);
            } finally {
                faultDb.close();
            }
        }
    }

    @Test
    public void roleDeleteRestoresExactQuarantinedPredecessorsBeforeOrderedDisableAndReopen()
        throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String dbName = "task25-role-delete-quarantine-" + UUID.randomUUID().toString().replace("-", "");
        AlExecutionDatabase fileDb = Room.databaseBuilder(context, AlExecutionDatabase.class, dbName)
            .allowMainThreadQueries().build();
        AlExecutionDatabase reopened = null;
        try {
            RoomExecutionStore first = new RoomExecutionStore(fileDb, "device_gateway");
            first.getConversationCursor("yuqi");
            AutomaticScheduleStore schedules = new AutomaticScheduleStore(fileDb, "device_gateway");
            com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity chat = schedules.configure(
                "yuqi", "chat", "00112233445566778899aabbccddeeff",
                automaticSource("bootstrap", "role-delete-quarantine-chat", 'a', 0L, 1_000L),
                automaticPolicy(), 1_000L);
            com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity moment = schedules.configure(
                "yuqi", "moment", "00112233445566778899aabbccddeeff",
                automaticSource("bootstrap", "role-delete-quarantine-moment", 'b', 0L, 1_001L),
                automaticPolicy(), 1_001L);
            fileDb.getOpenHelper().getWritableDatabase().execSQL(
                "UPDATE automatic_schedule_outbox SET state='quarantined', leaseId=?, leasedAt=?, "
                    + "lastErrorCode=? WHERE outboxId=?",
                new Object[] {"old-lease", 1_500L, "SCHEDULE_AUTHORITY_CONFLICT",
                    chat.streamKey + ":1"});
            fileDb.getOpenHelper().getWritableDatabase().execSQL(
                "UPDATE automatic_schedule_authorities SET cloudSyncState='quarantined' WHERE streamKey=?",
                new Object[] {chat.streamKey});
            String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
                "yuqi", fileDb.executionDao().conversationCursor("yuqi"));
            LifecycleControl control = first.createRoleDelete(
                "yuqi", "device_gateway", cursorChecksum, backupReceipt("yuqi", 2_000L), 2_001L, null);

            for (String kind : new String[] {"chat", "moment"}) {
                com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority =
                    "chat".equals(kind) ? chat : moment;
                AutomaticScheduleOutboxEntity predecessor = fileDb.executionDao()
                    .automaticScheduleOutbox(authority.streamKey + ":1");
                assertEquals("waiting", predecessor.state);
                assertNull(predecessor.leaseId);
                assertNull(predecessor.leasedAt);
                assertEquals("", predecessor.lastErrorCode);
                AutomaticScheduleOutboxEntity disable = fileDb.executionDao()
                    .automaticScheduleOutbox(authority.streamKey + ":2");
                JSONObject wire = new JSONObject(disable.payloadJson);
                AutomaticScheduleContract.ValidatedTransition validated =
                    AutomaticScheduleContract.validateTransition(wire);
                JSONObject sourceBasis = new JSONObject()
                    .put("characterId", "yuqi")
                    .put("controlId", control.controlId)
                    .put("controlChecksum", control.semanticChecksum)
                    .put("kind", kind);
                assertEquals("disable", wire.getString("operation"));
                assertEquals(authority.activeJobId, wire.getString("expectedPreviousJobId"));
                assertTrue(wire.isNull("jobId"));
                assertTrue(wire.isNull("dueAt"));
                assertTrue(wire.isNull("mode"));
                assertEquals("lifecycle", wire.getString("sourceType"));
                assertEquals("role_delete_" + control.controlId + "_" + kind,
                    wire.getString("sourceId"));
                assertEquals(BridgeAuthority.sha256CanonicalJson(sourceBasis),
                    wire.getString("sourceChecksum"));
                assertEquals(disable.payloadChecksum, validated.scheduleChecksum);
                assertEquals(BridgeAuthority.canonicalJson(wire),
                    BridgeAuthority.canonicalJson(validated.value));
            }
            fileDb.close();
            fileDb = null;
            reopened = Room.databaseBuilder(context, AlExecutionDatabase.class, dbName)
                .allowMainThreadQueries().build();
            RoomExecutionStore reopenedStore = new RoomExecutionStore(reopened, "device_gateway");
            LifecycleControl replay = reopenedStore.createRoleDelete(
                "yuqi", "device_gateway", cursorChecksum,
                backupReceipt("yuqi", 2_000L), 2_002L, null);
            assertEquals(control.controlId, replay.controlId);
            assertEquals(1L, countRows(reopened, "lifecycle_controls"));
            assertEquals("waiting", reopened.executionDao()
                .automaticScheduleOutbox(chat.streamKey + ":1").state);
            assertEquals("waiting", reopened.executionDao()
                .automaticScheduleOutbox(chat.streamKey + ":2").state);
            final List<String> sentOperations = new ArrayList<>();
            HttpTransport transport = (url, headers, body) -> {
                try {
                    sentOperations.add(new JSONObject(body).getString("operation"));
                } catch (Exception error) {
                    throw new IllegalStateException("invalid sender test body", error);
                }
                return new HttpResponse(200, "application/json", "{\"ok\":true}");
            };
            AutomaticScheduleSender sender = new AutomaticScheduleSender(
                reopened, transport, "https://timer.example/v2/schedule-transitions", () -> 5_000L);
            assertEquals(AutomaticScheduleSender.Outcome.SYNCED, sender.flushOne(5_000L));
            assertEquals(AutomaticScheduleSender.Outcome.SYNCED, sender.flushOne(5_001L));
            assertEquals(Arrays.asList("schedule", "disable"), sentOperations);
        } finally {
            if (fileDb != null) fileDb.close();
            if (reopened != null) reopened.close();
            context.deleteDatabase(dbName);
        }
    }

    @Test
    public void roleDeleteRejectsMissingForeignOrChangedPredecessorWithoutAnyDisableWrite()
        throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String epoch = "00112233445566778899aabbccddeeff";
        for (String mutation : new String[] {"missing", "checksum", "stream", "payload", "state"}) {
            AlExecutionDatabase caseDb = Room.inMemoryDatabaseBuilder(
                context, AlExecutionDatabase.class).allowMainThreadQueries().build();
            try {
                RoomExecutionStore baseline = new RoomExecutionStore(caseDb, "device_gateway");
                baseline.getConversationCursor("yuqi");
                AutomaticScheduleStore schedules = new AutomaticScheduleStore(caseDb, "device_gateway");
                com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity chat = schedules.configure(
                    "yuqi", "chat", epoch,
                    automaticSource("bootstrap", "role-delete-predecessor-" + mutation, 'a', 0L, 1_000L),
                    automaticPolicy(), 1_000L);
                schedules.configure("yuqi", "moment", epoch,
                    automaticSource("bootstrap", "role-delete-predecessor-moment-" + mutation, 'b', 0L, 1_001L),
                    automaticPolicy(), 1_001L);
                String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
                    "yuqi", caseDb.executionDao().conversationCursor("yuqi"));
                if ("missing".equals(mutation)) {
                    caseDb.getOpenHelper().getWritableDatabase().execSQL(
                        "DELETE FROM automatic_schedule_outbox WHERE outboxId=?",
                        new Object[] {chat.streamKey + ":1"});
                } else if ("checksum".equals(mutation)) {
                    caseDb.getOpenHelper().getWritableDatabase().execSQL(
                        "UPDATE automatic_schedule_outbox SET payloadChecksum=? WHERE outboxId=?",
                        new Object[] {repeat('f', 64), chat.streamKey + ":1"});
                } else if ("stream".equals(mutation)) {
                    caseDb.getOpenHelper().getWritableDatabase().execSQL(
                        "UPDATE automatic_schedule_outbox SET streamKey=? WHERE outboxId=?",
                        new Object[] {"active:device_gateway:foreign:chat", chat.streamKey + ":1"});
                } else if ("payload".equals(mutation)) {
                    caseDb.getOpenHelper().getWritableDatabase().execSQL(
                        "UPDATE automatic_schedule_outbox SET payloadJson=? WHERE outboxId=?",
                        new Object[] {"{}", chat.streamKey + ":1"});
                } else {
                    caseDb.getOpenHelper().getWritableDatabase().execSQL(
                        "UPDATE automatic_schedule_outbox SET state='quarantined' WHERE outboxId=?",
                        new Object[] {chat.streamKey + ":1"});
                }
                assertThrows(IllegalStateException.class, () -> baseline.createRoleDelete(
                    "yuqi", "device_gateway", cursorChecksum,
                    backupReceipt("yuqi", 2_100L), 2_101L, null));
                assertEquals(0L, countRows(caseDb, "lifecycle_controls"));
                assertEquals(2L, countRows(caseDb, "automatic_schedule_authorities"));
                assertEquals("scheduled", caseDb.executionDao()
                    .automaticScheduleAuthority(chat.streamKey).state);
            } finally {
                caseDb.close();
            }
        }
    }

    @Test
    public void exactRemotePausedShellWithAutomaticTurnRecordsConflictWithoutRepair() {
        AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
        String epoch = "00112233445566778899aabbccddeeff";
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority = schedules.configure(
            "yuqi", "chat", epoch,
            automaticSource("bootstrap", "remote-turn-conflict", 'a', 0L, 1_000L),
            automaticPolicy(), 1_000L);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE automatic_schedule_outbox SET state='synced' WHERE streamKey=?",
            new Object[] { authority.streamKey });
        store.submitTurn(new TurnSubmission(
            RoomExecutionStore.automaticTurnId(authority.activeJobId), "yuqi",
            "automatic-conflict-message", TurnKind.PROACTIVE_CHAT, "{}", "{}",
            authority.activeJobId, 1_500L));
        AutomaticScheduleSender.RemoteScheduleStatus remote =
            new AutomaticScheduleSender.RemoteScheduleStatus(
                "device_gateway", "yuqi", "chat", true, authority.owner, "paused",
                authority.generation, null, null, null, authority.semanticChecksum,
                epoch.substring(0, 8), 0L, 2_000L);
        assertEquals(RoomExecutionStore.RemoteReconcileResult.CONFLICT,
            store.reconcileRemotePausedScheduleIfExact(remote, 2_000L));
        assertEquals("scheduled", database.executionDao()
            .automaticScheduleAuthority(authority.streamKey).state);
        assertEquals("synced", database.executionDao()
            .automaticScheduleAuthority(authority.streamKey).cloudSyncState);
        assertEquals(1L, countResultRows(database, "remote_conflict"));
        assertEquals(0L, countResultRows(database, "remote_paused_requeued"));
    }

    @Test
    public void exactRemotePausedShellRequeuesTheSameOutboxAtomically() {
        AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
        String epoch = "00112233445566778899aabbccddeeff";
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority = schedules.configure(
            "yuqi", "chat", epoch,
            automaticSource("bootstrap", "paused-shell", 'a', 0L, 1_000L),
            automaticPolicy(), 1_000L);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE automatic_schedule_outbox SET state='synced' WHERE streamKey=?",
            new Object[] { authority.streamKey });
        AutomaticScheduleSender.RemoteScheduleStatus remote =
            new AutomaticScheduleSender.RemoteScheduleStatus(
                "device_gateway", "yuqi", "chat", true, "android-v1", "paused",
                authority.generation, null, null, null, authority.semanticChecksum,
                epoch.substring(0, 8), 0L, 2_000L);
        assertTrue(store.requeueRemotePausedScheduleIfExact(remote, 2_000L));
        assertEquals("waiting", database.executionDao()
            .automaticScheduleOutbox(authority.streamKey + ":" + authority.generation).state);
        assertEquals("waiting", database.executionDao()
            .automaticScheduleAuthority(authority.streamKey).cloudSyncState);
        assertEquals(2L, rowCount("automatic_schedule_events"));
        assertFalse(store.requeueRemotePausedScheduleIfExact(
            new AutomaticScheduleSender.RemoteScheduleStatus(
                "device_gateway", "yuqi", "chat", true, "android-v1", "paused",
                authority.generation, null, null, null, authority.semanticChecksum,
                epoch.substring(0, 8), 1L, 2_001L), 2_001L));
    }

    @Test
    public void remoteOwnerMismatchIsMetadataConflictAndGenerationZeroIsRejected() {
        AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
        String epoch = "00112233445566778899aabbccddeeff";
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority = schedules.configure(
            "yuqi", "chat", epoch,
            automaticSource("bootstrap", "remote-conflict", 'a', 0L, 1_000L),
            automaticPolicy(), 1_000L);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE automatic_schedule_outbox SET state='synced' WHERE streamKey=?",
            new Object[] { authority.streamKey });
        AutomaticScheduleSender.RemoteScheduleStatus foreignOwner =
            new AutomaticScheduleSender.RemoteScheduleStatus(
                "device_gateway", "yuqi", "chat", true, "foreign-owner", "paused",
                authority.generation, null, null, null, authority.semanticChecksum,
                epoch.substring(0, 8), 0L, 2_000L);
        assertFalse(store.requeueRemotePausedScheduleIfExact(foreignOwner, 2_000L));
        assertEquals(2L, rowCount("automatic_schedule_events"));
        Cursor conflict = database.getOpenHelper().getReadableDatabase().query(
            "SELECT resultCode FROM automatic_schedule_events WHERE resultCode='remote_conflict'");
        try {
            assertTrue(conflict.moveToFirst());
        } finally {
            conflict.close();
        }
        AutomaticScheduleSender.RemoteScheduleStatus zeroGeneration =
            new AutomaticScheduleSender.RemoteScheduleStatus(
                "device_gateway", "yuqi", "chat", true, authority.owner, "paused",
                0L, null, null, null, authority.semanticChecksum,
                epoch.substring(0, 8), 0L, 3_000L);
        assertFalse(store.requeueRemotePausedScheduleIfExact(zeroGeneration, 3_000L));
    }

    @Test
    public void exactPausedRemoteWithMissingOrCorruptOutboxRecordsOneConflictWithoutRepair() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String[] mutations = {
            "missing", "state", "outboxId", "streamKey", "generation",
            "payloadChecksum", "payloadJson"
        };
        for (int index = 0; index < mutations.length; index += 1) {
            AlExecutionDatabase caseDb = Room.inMemoryDatabaseBuilder(
                context, AlExecutionDatabase.class).allowMainThreadQueries().build();
            try {
                String characterId = "remote-conflict-" + index;
                String epoch = "00112233445566778899aabbccddeeff";
                AutomaticScheduleStore schedules = new AutomaticScheduleStore(caseDb, "device_gateway");
                com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority = schedules.configure(
                    characterId, "chat", epoch,
                    automaticSource("bootstrap", "remote-conflict-" + mutations[index], 'a', 0L, 1_000L),
                    automaticPolicy(), 1_000L);
                String outboxId = authority.streamKey + ":" + authority.generation;
                caseDb.getOpenHelper().getWritableDatabase().execSQL(
                    "UPDATE automatic_schedule_outbox SET state='synced' WHERE outboxId=?",
                    new Object[] { outboxId });
                if ("missing".equals(mutations[index])) {
                    caseDb.getOpenHelper().getWritableDatabase().execSQL(
                        "DELETE FROM automatic_schedule_outbox WHERE outboxId=?",
                        new Object[] { outboxId });
                } else if ("state".equals(mutations[index])) {
                    caseDb.getOpenHelper().getWritableDatabase().execSQL(
                        "UPDATE automatic_schedule_outbox SET state='waiting' WHERE outboxId=?",
                        new Object[] { outboxId });
                } else if ("outboxId".equals(mutations[index])) {
                    caseDb.getOpenHelper().getWritableDatabase().execSQL(
                        "UPDATE automatic_schedule_outbox SET outboxId=? WHERE outboxId=?",
                        new Object[] { "foreign-outbox-" + index, outboxId });
                } else if ("streamKey".equals(mutations[index])) {
                    caseDb.getOpenHelper().getWritableDatabase().execSQL(
                        "UPDATE automatic_schedule_outbox SET streamKey=? WHERE outboxId=?",
                        new Object[] { "foreign-stream-" + index, outboxId });
                } else if ("generation".equals(mutations[index])) {
                    caseDb.getOpenHelper().getWritableDatabase().execSQL(
                        "UPDATE automatic_schedule_outbox SET generation=? WHERE outboxId=?",
                        new Object[] { authority.generation + 1L, outboxId });
                } else if ("payloadChecksum".equals(mutations[index])) {
                    caseDb.getOpenHelper().getWritableDatabase().execSQL(
                        "UPDATE automatic_schedule_outbox SET payloadChecksum=? WHERE outboxId=?",
                        new Object[] { repeat('b', 64), outboxId });
                } else {
                    caseDb.getOpenHelper().getWritableDatabase().execSQL(
                        "UPDATE automatic_schedule_outbox SET payloadJson=? WHERE outboxId=?",
                        new Object[] { "{}", outboxId });
                }
                com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity beforeAuthority =
                    caseDb.executionDao().automaticScheduleAuthority(authority.streamKey);
                String beforeOutboxSnapshot = outboxSnapshot(caseDb);
                com.siyi.al.execution.db.AutomaticScheduleOutboxEntity beforeOutbox =
                    caseDb.executionDao().automaticScheduleOutbox(outboxId);
                AutomaticScheduleSender.RemoteScheduleStatus remote =
                    new AutomaticScheduleSender.RemoteScheduleStatus(
                        "device_gateway", characterId, "chat", true, authority.owner, "paused",
                        authority.generation, null, null, null, authority.semanticChecksum,
                        epoch.substring(0, 8), 0L, 2_000L);
                RoomExecutionStore caseStore = new RoomExecutionStore(caseDb, "device_gateway");
                assertEquals(RoomExecutionStore.RemoteReconcileResult.CONFLICT,
                    caseStore.reconcileRemotePausedScheduleIfExact(remote, 2_000L));
                com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity afterAuthority =
                    caseDb.executionDao().automaticScheduleAuthority(authority.streamKey);
                com.siyi.al.execution.db.AutomaticScheduleOutboxEntity afterOutbox =
                    caseDb.executionDao().automaticScheduleOutbox(outboxId);
                assertEquals(beforeAuthority.state, afterAuthority.state);
                assertEquals(beforeAuthority.cloudSyncState, afterAuthority.cloudSyncState);
                assertEquals(beforeAuthority.semanticJson, afterAuthority.semanticJson);
                if (beforeOutbox == null) {
                    assertNull(afterOutbox);
                } else {
                    assertNotNull(afterOutbox);
                    assertEquals(beforeOutbox.outboxId, afterOutbox.outboxId);
                    assertEquals(beforeOutbox.streamKey, afterOutbox.streamKey);
                    assertEquals(beforeOutbox.generation, afterOutbox.generation);
                    assertEquals(beforeOutbox.state, afterOutbox.state);
                    assertEquals(beforeOutbox.payloadJson, afterOutbox.payloadJson);
                    assertEquals(beforeOutbox.payloadChecksum, afterOutbox.payloadChecksum);
                }
                assertEquals(beforeOutboxSnapshot, outboxSnapshot(caseDb));
                assertEquals(0L, countResultRows(caseDb, "remote_paused_requeued"));
                assertEquals(1L, countResultRows(caseDb, "remote_conflict"));
                assertEquals(RoomExecutionStore.RemoteReconcileResult.CONFLICT,
                    caseStore.reconcileRemotePausedScheduleIfExact(remote, 2_001L));
                assertEquals(1L, countResultRows(caseDb, "remote_conflict"));
            } finally {
                caseDb.close();
            }
        }
    }

    @Test
    public void remoteConflictRemainsSingleAcrossCloseAndReopen() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "remote-conflict-reopen-" + System.nanoTime();
        String characterId = "remote-conflict-reopen";
        String epoch = "00112233445566778899aabbccddeeff";
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority;
        AlExecutionDatabase first = Room.databaseBuilder(
            context, AlExecutionDatabase.class, databaseName).allowMainThreadQueries().build();
        try {
            authority = new AutomaticScheduleStore(first, "device_gateway").configure(
                characterId, "chat", epoch,
                automaticSource("bootstrap", "remote-conflict-reopen", 'a', 0L, 1_000L),
                automaticPolicy(), 1_000L);
            first.getOpenHelper().getWritableDatabase().execSQL(
                "DELETE FROM automatic_schedule_outbox WHERE outboxId=?",
                new Object[] { authority.streamKey + ":" + authority.generation });
            AutomaticScheduleSender.RemoteScheduleStatus remote =
                new AutomaticScheduleSender.RemoteScheduleStatus(
                    "device_gateway", characterId, "chat", true, authority.owner, "paused",
                    authority.generation, null, null, null, authority.semanticChecksum,
                    epoch.substring(0, 8), 0L, 2_000L);
            assertEquals(RoomExecutionStore.RemoteReconcileResult.CONFLICT,
                new RoomExecutionStore(first, "device_gateway")
                    .reconcileRemotePausedScheduleIfExact(remote, 2_000L));
            assertEquals(1L, countResultRows(first, "remote_conflict"));
        } finally {
            first.close();
        }
        AlExecutionDatabase reopened = Room.databaseBuilder(
            context, AlExecutionDatabase.class, databaseName).allowMainThreadQueries().build();
        try {
            AutomaticScheduleSender.RemoteScheduleStatus remote =
                new AutomaticScheduleSender.RemoteScheduleStatus(
                    "device_gateway", characterId, "chat", true, authority.owner, "paused",
                    authority.generation, null, null, null, authority.semanticChecksum,
                    epoch.substring(0, 8), 1L, 2_001L);
            assertEquals(RoomExecutionStore.RemoteReconcileResult.CONFLICT,
                new RoomExecutionStore(reopened, "device_gateway")
                    .reconcileRemotePausedScheduleIfExact(remote, 2_001L));
            assertEquals(1L, countResultRows(reopened, "remote_conflict"));
            assertEquals("scheduled", reopened.executionDao()
                .automaticScheduleAuthority(authority.streamKey).state);
            assertEquals("synced", reopened.executionDao()
                .automaticScheduleAuthority(authority.streamKey).cloudSyncState);
            assertNull(reopened.executionDao().automaticScheduleOutbox(
                authority.streamKey + ":" + authority.generation));
        } finally {
            reopened.close();
            context.deleteDatabase(databaseName);
        }
    }

    @Test
    public void concurrentRemoteReconcilersHaveOneRequeueAndNoConflictEvent() throws Exception {
        AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
        String epoch = "00112233445566778899aabbccddeeff";
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority = schedules.configure(
            "yuqi", "chat", epoch,
            automaticSource("bootstrap", "remote-concurrent", 'a', 0L, 1_000L),
            automaticPolicy(), 1_000L);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE automatic_schedule_outbox SET state='synced' WHERE streamKey=?",
            new Object[] { authority.streamKey });
        AutomaticScheduleSender.RemoteScheduleStatus remote =
            new AutomaticScheduleSender.RemoteScheduleStatus(
                "device_gateway", "yuqi", "chat", true, authority.owner, "paused",
                authority.generation, null, null, null, authority.semanticChecksum,
                epoch.substring(0, 8), 0L, 2_000L);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<RoomExecutionStore.RemoteReconcileResult> first = workers.submit(
                () -> store.reconcileRemotePausedScheduleIfExact(remote, 2_000L));
            Future<RoomExecutionStore.RemoteReconcileResult> second = workers.submit(
                () -> store.reconcileRemotePausedScheduleIfExact(remote, 2_001L));
            RoomExecutionStore.RemoteReconcileResult a = first.get(5, TimeUnit.SECONDS);
            RoomExecutionStore.RemoteReconcileResult b = second.get(5, TimeUnit.SECONDS);
            assertTrue((a == RoomExecutionStore.RemoteReconcileResult.RECOVERED
                && b == RoomExecutionStore.RemoteReconcileResult.NOOP)
                || (b == RoomExecutionStore.RemoteReconcileResult.RECOVERED
                && a == RoomExecutionStore.RemoteReconcileResult.NOOP));
            assertEquals(2L, rowCount("automatic_schedule_events"));
        } finally {
            workers.shutdownNow();
        }
    }

    @Test
    public void automaticTerminalDispositionsReplayOnceAndSurviveRestart() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "automatic-terminal-restart-" + System.nanoTime();
        AlExecutionDatabase fileDb = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .allowMainThreadQueries().build();
        try {
            AutomaticScheduleStore schedules = new AutomaticScheduleStore(fileDb, "device_gateway");
            String epoch = "00112233445566778899aabbccddeeff";
            com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity current = schedules.configure(
                "yuqi", "chat", epoch,
                automaticSource("bootstrap", "terminal-bootstrap", 'a', 0L, 1_000L),
                automaticPolicy(), 1_000L);
            for (AutomaticScheduleContract.TerminalDisposition disposition
                    : AutomaticScheduleContract.TerminalDisposition.values()) {
                assertTrue(schedules.claim(current.streamKey, epoch, current.generation,
                    current.activeJobId, current.updatedAt + 1L));
                AutomaticScheduleContract.Source terminal = automaticSource(
                    disposition == AutomaticScheduleContract.TerminalDisposition.FAILED
                        ? "failure_retry" : "proactive_terminal",
                    "terminal-" + disposition.name().toLowerCase(java.util.Locale.ROOT),
                    (char) ('b' + disposition.ordinal()), current.conversationSequence,
                    current.updatedAt + 2L);
                com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity next =
                    schedules.finalizeAutomatic("yuqi", "chat", epoch, current.generation,
                        current.activeJobId, terminal, automaticPolicy(), disposition,
                        current.updatedAt + 2L);
                com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity replay =
                    schedules.finalizeAutomatic("yuqi", "chat", epoch, current.generation,
                        current.activeJobId, terminal, automaticPolicy(), disposition,
                        current.updatedAt + 50_000L);
                assertEquals(next.semanticChecksum, replay.semanticChecksum);
                assertEquals(next.activeJobId, replay.activeJobId);
                current = next;
            }
            assertEquals(5L, current.generation);
        } finally {
            fileDb.close();
        }

        AlExecutionDatabase reopened = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .allowMainThreadQueries().build();
        try {
            AutomaticScheduleStore.Status status =
                new AutomaticScheduleStore(reopened, "device_gateway").status("yuqi", "chat");
            assertNotNull(status);
            assertEquals(5L, status.generation);
            assertEquals("scheduled", status.state);
            assertEquals(5L, countRows(reopened, "automatic_schedule_outbox"));
        } finally {
            reopened.close();
            context.deleteDatabase(databaseName);
        }
    }

    @Test
    public void automaticScheduleOutboxReplaysTheExactBodyAfterCrashAndLeaseExpiry()
        throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "automatic-outbox-restart-" + System.nanoTime();
        List<String> postedBodies = new ArrayList<>();
        AlExecutionDatabase firstOpen = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .allowMainThreadQueries().build();
        try {
            new AutomaticScheduleStore(firstOpen, "device_gateway").configure(
                "yuqi", "chat", "00112233445566778899aabbccddeeff",
                automaticSource("bootstrap", "outbox-bootstrap", 'a', 0L, 1_000L),
                automaticPolicy(), 1_000L);
            AutomaticScheduleSender crashedSender = new AutomaticScheduleSender(
                firstOpen,
                (url, headers, body) -> {
                    postedBodies.add(body);
                    throw new AssertionError("process crashed after request left the device");
                },
                "https://timer.example/v2/schedule-transitions",
                () -> 1_000L);
            assertThrows(AssertionError.class, () -> crashedSender.flushOne(1_000L));
            assertEquals("pending", firstOpen.executionDao()
                .automaticScheduleOutbox("active:device_gateway:yuqi:chat:1").state);
        } finally {
            firstOpen.close();
        }

        AlExecutionDatabase reopened = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .allowMainThreadQueries().build();
        try {
            AutomaticScheduleSender replay = new AutomaticScheduleSender(
                reopened,
                (url, headers, body) -> {
                    postedBodies.add(body);
                    return new com.siyi.al.execution.api.HttpResponse(
                        200, "application/json", "{\"ok\":true,\"idempotent\":true}");
                },
                "https://timer.example/v2/schedule-transitions",
                () -> 61_000L);
            assertEquals(AutomaticScheduleSender.Outcome.NONE, replay.flushOne(60_999L));
            assertEquals(AutomaticScheduleSender.Outcome.SYNCED, replay.flushOne(61_000L));
            assertEquals(2, postedBodies.size());
            assertEquals(postedBodies.get(0), postedBodies.get(1));
            assertEquals("synced", reopened.executionDao()
                .automaticScheduleOutbox("active:device_gateway:yuqi:chat:1").state);
            assertEquals("synced", new AutomaticScheduleStore(reopened, "device_gateway")
                .status("yuqi", "chat").cloudSyncState);
            assertEquals(1L, countRows(reopened, "automatic_schedule_outbox"));
        } finally {
            reopened.close();
            context.deleteDatabase(databaseName);
        }
    }

    @Test
    public void twoAutomaticScheduleSendersShareOneRoomLeaseAndPostOnce() throws Exception {
        new AutomaticScheduleStore(database, "device_gateway").configure(
            "yuqi", "moment", "00112233445566778899aabbccddeeff",
            automaticSource("bootstrap", "two-sender-bootstrap", 'a', 0L, 1_000L),
            automaticPolicy(), 1_000L);
        java.util.concurrent.atomic.AtomicInteger posts = new java.util.concurrent.atomic.AtomicInteger();
        com.siyi.al.execution.api.HttpTransport transport = (url, headers, body) -> {
            posts.incrementAndGet();
            return new com.siyi.al.execution.api.HttpResponse(200, "application/json", "{\"ok\":true}");
        };
        AutomaticScheduleSender first = new AutomaticScheduleSender(
            database, transport, "https://timer.example/v2/schedule-transitions", () -> 2_000L);
        AutomaticScheduleSender second = new AutomaticScheduleSender(
            database, transport, "https://timer.example/v2/schedule-transitions", () -> 2_000L);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            Future<AutomaticScheduleSender.Outcome> left = workers.submit(() -> {
                start.await();
                return first.flushOne(2_000L);
            });
            Future<AutomaticScheduleSender.Outcome> right = workers.submit(() -> {
                start.await();
                return second.flushOne(2_000L);
            });
            start.countDown();
            AutomaticScheduleSender.Outcome leftOutcome = left.get(5L, TimeUnit.SECONDS);
            AutomaticScheduleSender.Outcome rightOutcome = right.get(5L, TimeUnit.SECONDS);
            assertEquals(1, posts.get());
            assertTrue(leftOutcome == AutomaticScheduleSender.Outcome.SYNCED
                || rightOutcome == AutomaticScheduleSender.Outcome.SYNCED);
            assertEquals("synced", database.executionDao()
                .automaticScheduleOutbox("active:device_gateway:yuqi:moment:1").state);
        } finally {
            workers.shutdownNow();
        }
    }

    @Test
    public void expiredAutomaticScheduleLeaseRecoversOutboxAndAuthorityTogether() throws Exception {
        new AutomaticScheduleStore(database, "device_gateway").configure(
            "yuqi", "chat", "00112233445566778899aabbccddeeff",
            automaticSource("bootstrap", "lease-recovery-bootstrap", 'a', 0L, 1_000L),
            automaticPolicy(), 1_000L);
        com.siyi.al.execution.db.AutomaticScheduleOutboxEntity waiting =
            database.executionDao().automaticScheduleOutbox("active:device_gateway:yuqi:chat:1");
        assertEquals(1, database.executionDao().claimAutomaticScheduleOutboxExact(
            waiting.outboxId, waiting.payloadChecksum, Long.MIN_VALUE,
            "lease-before-crash", 1_000L, 1_000L));
        assertEquals(1, database.executionDao().updateAutomaticScheduleCloudSyncExact(
            waiting.streamKey, waiting.generation, waiting.payloadChecksum,
            "waiting", "pending", 1_000L));

        AutomaticScheduleSender sender = new AutomaticScheduleSender(
            database,
            (url, headers, body) -> new com.siyi.al.execution.api.HttpResponse(
                200, "application/json", "{\"ok\":true}"),
            "https://timer.example/v2/schedule-transitions",
            () -> 61_000L);
        assertEquals(1, sender.recoverExpiredLeases(61_000L));

        com.siyi.al.execution.db.AutomaticScheduleOutboxEntity recovered =
            database.executionDao().automaticScheduleOutbox(waiting.outboxId);
        assertEquals("waiting", recovered.state);
        assertNull(recovered.leaseId);
        assertNull(recovered.leasedAt);
        assertEquals("LEASE_EXPIRED", recovered.lastErrorCode);
        assertEquals("waiting", new AutomaticScheduleStore(database, "device_gateway")
            .status("yuqi", "chat").cloudSyncState);
    }

    @Test
    public void automaticScheduleOutboxPreservesGenerationOrderAndRejectsTheExpiredLease() {
        AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
        String epoch = "00112233445566778899aabbccddeeff";
        schedules.configure("yuqi", "chat", epoch,
            automaticSource("bootstrap", "ordered-generation-one", 'a', 0L, 1_000L),
            automaticPolicy(), 1_000L);
        schedules.pauseForConversationInternal("yuqi", "chat", epoch,
            automaticSource("direct_input", "ordered-generation-two", 'b', 1L, 2_000L),
            2_000L);

        com.siyi.al.execution.db.AutomaticScheduleOutboxEntity first =
            database.executionDao().nextAutomaticScheduleOutboxForSend(2_000L, Long.MIN_VALUE);
        assertNotNull(first);
        assertEquals(1L, first.generation);
        assertEquals(1, database.executionDao().claimAutomaticScheduleOutboxExact(
            first.outboxId, first.payloadChecksum, Long.MIN_VALUE,
            "generation-one-old-lease", 2_000L, 2_000L));
        com.siyi.al.execution.db.AutomaticScheduleOutboxEntity claimed =
            database.executionDao().automaticScheduleOutbox(first.outboxId);

        assertNull(database.executionDao().nextAutomaticScheduleOutboxForSend(60_000L, 0L));
        AutomaticScheduleSender sender = new AutomaticScheduleSender(
            database,
            (url, headers, body) -> new com.siyi.al.execution.api.HttpResponse(
                200, "application/json", "{\"ok\":true}"),
            "https://timer.example/v2/schedule-transitions",
            () -> 62_000L);
        assertEquals(1, sender.recoverExpiredLeases(62_000L));
        assertEquals(0, database.executionDao().syncAutomaticScheduleOutboxExact(
            claimed.outboxId, claimed.payloadChecksum, claimed.leaseId,
            claimed.leaseAttempt, claimed.leasedAt, 62_001L));
        assertEquals(AutomaticScheduleSender.Outcome.SYNCED, sender.flushOne(62_000L));

        com.siyi.al.execution.db.AutomaticScheduleOutboxEntity second =
            database.executionDao().nextAutomaticScheduleOutboxForSend(62_001L, 2_001L);
        assertNotNull(second);
        assertEquals(2L, second.generation);
    }

    @Test
    public void alarmAndFcmClaimTheSameAutomaticGenerationOnlyOnce() throws Exception {
        String epoch = "00112233445566778899aabbccddeeff";
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority =
            new AutomaticScheduleStore(database, "device_gateway").configure(
                "yuqi", "chat", epoch,
                automaticSource("bootstrap", "dual-entry-bootstrap", 'a', 0L, 1_000L),
                automaticPolicy(), 1_000L);
        CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
        snapshot.snapshotId = "yuqi:chat";
        snapshot.characterId = "yuqi";
        snapshot.characterName = "虞栖";
        snapshot.playerName = "我";
        snapshot.contextJson = new JSONObject()
            .put("automaticTasksEnabled", true)
            .put("automaticPolicyRevision", 1L)
            .put("automaticPolicyChecksum", repeat('9', 64))
            .put("automaticPolicyMode", "planned")
            .put("automaticPolicyMinDelayMs", 60_000L)
            .put("automaticPolicyMaxDelayMs", 600_000L)
            .put("cloudJobId", authority.activeJobId)
            .toString();
        snapshot.automaticTasksEnabled = true;
        snapshot.cloudJobId = authority.activeJobId;
        snapshot.scheduledFor = authority.dueAt;
        snapshot.automaticKind = "chat";
        snapshot.jobSnapshot = true;
        database.executionDao().upsertSnapshot(snapshot);

        java.util.Map<String, String> rawToken = new java.util.HashMap<>();
        rawToken.put("charId", "yuqi");
        rawToken.put("kind", "chat");
        rawToken.put("jobId", authority.activeJobId);
        rawToken.put("authorityEpoch", epoch);
        rawToken.put("generation", String.valueOf(authority.generation));
        AutomaticTaskCoordinator.ClaimToken token =
            AutomaticTaskCoordinator.ClaimToken.from(rawToken);
        AutomaticTaskCoordinator coordinator = new AutomaticTaskCoordinator(database);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            Future<AutomaticTaskCoordinator.DispatchOutcome> alarm = workers.submit(() -> {
                start.await();
                return coordinator.dispatch(token, authority.dueAt);
            });
            Future<AutomaticTaskCoordinator.DispatchOutcome> fcm = workers.submit(() -> {
                start.await();
                return coordinator.dispatch(token, authority.dueAt);
            });
            start.countDown();
            AutomaticTaskCoordinator.DispatchOutcome first = alarm.get(5L, TimeUnit.SECONDS);
            AutomaticTaskCoordinator.DispatchOutcome second = fcm.get(5L, TimeUnit.SECONDS);
            assertTrue(first == AutomaticTaskCoordinator.DispatchOutcome.CLAIMED
                || second == AutomaticTaskCoordinator.DispatchOutcome.CLAIMED);
            assertTrue(first == AutomaticTaskCoordinator.DispatchOutcome.REPLAY
                || second == AutomaticTaskCoordinator.DispatchOutcome.REPLAY);
        } finally {
            workers.shutdownNow();
        }
        assertEquals(1L, rowCount("chat_turns"));
        assertEquals(1L, rowCount("execution_attempts"));
        assertNotNull(database.executionDao().turn(
            "cloud_" + authority.activeJobId.replaceAll("[^a-zA-Z0-9_-]", "_")));
        assertEquals("claimed", new AutomaticScheduleStore(database, "device_gateway")
            .status("yuqi", "chat").state);
    }

    @Test
    public void directSubmissionAtomicallyPausesTheCurrentChatScheduleOnce() {
        String epoch = "00112233445566778899aabbccddeeff";
        AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity scheduled = schedules.configure(
            "yuqi", "chat", epoch,
            automaticSource("bootstrap", "direct-pause-bootstrap", 'a', 0L, 1_000L),
            automaticPolicy(), 1_000L);

        TurnSubmission first = submission("direct-pause-one", "direct-source-one", TurnKind.DIRECT_REPLY);
        store.submitTurn(first);
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity paused =
            database.executionDao().automaticScheduleAuthority(scheduled.streamKey);
        assertEquals("paused_for_conversation", paused.state);
        assertEquals(scheduled.generation + 1L, paused.generation);
        assertEquals(scheduled.conversationSequence + 1L, paused.conversationSequence);
        assertNull(paused.activeJobId);
        assertEquals(2L, rowCount("automatic_schedule_outbox"));

        store.submitTurn(first);
        assertEquals(paused.semanticChecksum,
            database.executionDao().automaticScheduleAuthority(scheduled.streamKey).semanticChecksum);
        assertEquals(2L, rowCount("automatic_schedule_outbox"));

        store.submitTurn(submission(
            "direct-pause-two", "direct-source-two", TurnKind.DIRECT_REPLY));
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity newer =
            database.executionDao().automaticScheduleAuthority(scheduled.streamKey);
        assertEquals(paused.generation + 1L, newer.generation);
        assertEquals(paused.conversationSequence + 1L, newer.conversationSequence);
        assertEquals(3L, rowCount("automatic_schedule_outbox"));

        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET state='COMPLETED', terminalDisposition='visible', "
                + "bridgeCommitChecksum=?, completedAt=3000, updatedAt=3000 WHERE turnId=?",
            new Object[]{repeat('f', 64), first.turnId});
        RoomExecutionStore.AutomaticFinalization stale =
            store.finalizeAutomaticScheduleForTurn(first.turnId, 3_001L);
        assertNull(stale.authority);
        assertEquals(newer.semanticChecksum,
            database.executionDao().automaticScheduleAuthority(scheduled.streamKey).semanticChecksum);
        assertEquals(3L, rowCount("automatic_schedule_outbox"));
    }

    @Test
    public void fourAutomaticTerminalDispositionsAdvanceOnceAndRejectChangedResults()
        throws Exception {
        String[] dispositions = {"visible", "action_only", "skip", "failed"};
        for (int index = 0; index < dispositions.length; index += 1) {
            String disposition = dispositions[index];
            String characterId = "automatic-terminal-" + disposition.replace('_', '-');
            String epoch = String.format(java.util.Locale.ROOT, "%032x", index + 1L);
            AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
            com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority = schedules.configure(
                characterId, "chat", epoch,
                automaticSource("bootstrap", "terminal-" + disposition, (char) ('a' + index),
                    0L, 1_000L + index),
                automaticPolicy(), 1_000L + index);
            CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
            snapshot.snapshotId = characterId + ":chat";
            snapshot.characterId = characterId;
            snapshot.characterName = "虞栖";
            snapshot.playerName = "我";
            snapshot.contextJson = new JSONObject()
                .put("automaticPolicyRevision", 1L)
                .put("automaticPolicyChecksum", repeat('9', 64))
                .put("automaticPolicyMode", "planned")
                .put("automaticPolicyMinDelayMs", 60_000L)
                .put("automaticPolicyMaxDelayMs", 600_000L)
                .toString();
            snapshot.automaticTasksEnabled = true;
            snapshot.automaticKind = "chat";
            snapshot.cloudJobId = authority.activeJobId;
            snapshot.scheduledFor = authority.dueAt;
            database.executionDao().upsertSnapshot(snapshot);

            AutomaticTaskCoordinator.ClaimToken token =
                AutomaticTaskCoordinator.ClaimToken.from(authority);
            assertEquals(AutomaticTaskCoordinator.DispatchOutcome.CLAIMED,
                new AutomaticTaskCoordinator(database).dispatch(token, authority.dueAt));
            String turnId = RoomExecutionStore.automaticTurnId(authority.activeJobId);
            long terminalAt = authority.dueAt + 10L;
            if ("failed".equals(disposition)) {
                database.getOpenHelper().getWritableDatabase().execSQL(
                    "UPDATE chat_turns SET state='FAILED_FINAL', updatedAt=? WHERE turnId=?",
                    new Object[]{terminalAt, turnId});
            } else {
                database.getOpenHelper().getWritableDatabase().execSQL(
                    "UPDATE chat_turns SET state='COMPLETED', terminalDisposition=?, "
                        + "bridgeCommitChecksum=?, completedAt=?, updatedAt=? WHERE turnId=?",
                    new Object[]{disposition, repeat((char) ('e' + index), 64),
                        terminalAt, terminalAt, turnId});
            }

            RoomExecutionStore.AutomaticFinalization first =
                store.finalizeAutomaticScheduleForTurn(turnId, terminalAt + 1L);
            RoomExecutionStore.AutomaticFinalization replay =
                store.finalizeAutomaticScheduleForTurn(turnId, terminalAt + 9_999L);
            assertTrue(first.advanced);
            assertFalse(replay.advanced);
            assertEquals(first.authority.semanticChecksum, replay.authority.semanticChecksum);
            assertEquals(authority.generation + 1L, first.authority.generation);
            assertNotNull(database.executionDao().automaticScheduleOutbox(
                first.authority.streamKey + ":" + first.authority.generation));

            database.getOpenHelper().getWritableDatabase().execSQL(
                "UPDATE chat_turns SET bridgeCommitChecksum=? WHERE turnId=?",
                new Object[]{repeat((char) ('1' + index), 64), turnId});
            assertThrows(IllegalStateException.class,
                () -> store.finalizeAutomaticScheduleForTurn(turnId, terminalAt + 10_000L));
        }
    }

    @Test
    public void directInputCancelsAJustClaimedAutomaticTurnBeforeItCanCommit() throws Exception {
        String epoch = "11112222333344445555666677778888";
        AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority = schedules.configure(
            "claim-race", "chat", epoch,
            automaticSource("bootstrap", "claim-race-bootstrap", 'a', 0L, 1_000L),
            automaticPolicy(), 1_000L);
        CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
        snapshot.snapshotId = "claim-race:chat";
        snapshot.characterId = "claim-race";
        snapshot.characterName = "虞栖";
        snapshot.playerName = "我";
        snapshot.contextJson = new JSONObject()
            .put("automaticPolicyRevision", 1L)
            .put("automaticPolicyChecksum", repeat('9', 64))
            .put("automaticPolicyMode", "planned")
            .put("automaticPolicyMinDelayMs", 60_000L)
            .put("automaticPolicyMaxDelayMs", 600_000L)
            .toString();
        database.executionDao().upsertSnapshot(snapshot);
        AutomaticTaskCoordinator.ClaimToken token =
            AutomaticTaskCoordinator.ClaimToken.from(authority);
        assertEquals(AutomaticTaskCoordinator.DispatchOutcome.CLAIMED,
            new AutomaticTaskCoordinator(database).dispatch(token, authority.dueAt));
        String automaticTurnId = RoomExecutionStore.automaticTurnId(authority.activeJobId);

        store.submitTurn(new TurnSubmission(
            "claim-race-direct", "claim-race", "claim-race-message",
            TurnKind.DIRECT_REPLY, "{}", snapshot.contextJson, null, authority.dueAt + 1L));

        assertEquals(TurnState.CANCELLED.name(),
            database.executionDao().turn(automaticTurnId).state);
        assertEquals("paused_for_conversation",
            database.executionDao().automaticScheduleAuthority(authority.streamKey).state);
        assertNull(store.finalizeAutomaticScheduleForTurn(
            automaticTurnId, authority.dueAt + 2L).authority);
    }

    @Test
    public void directTurnRollsBackWhenItsSchedulePauseCannotValidate() {
        AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity authority = schedules.configure(
            "atomic-pause", "chat", "99990000111122223333444455556666",
            automaticSource("bootstrap", "atomic-pause-bootstrap", 'a', 0L, 1_000L),
            automaticPolicy(), 1_000L);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE automatic_schedule_authorities SET semanticJson='{}' WHERE streamKey=?",
            new Object[]{authority.streamKey});

        assertThrows(IllegalStateException.class, () -> store.submitTurn(new TurnSubmission(
            "atomic-pause-direct", "atomic-pause", "atomic-pause-source",
            TurnKind.DIRECT_REPLY, "{}", "{}", null, 2_000L)));
        assertNull(database.executionDao().turn("atomic-pause-direct"));
        assertEquals(0L, database.executionDao().attempts("atomic-pause-direct").size());
    }

    @Test
    public void androidRoomBackupHeadIsReadOnlyAndProjectsTheLatestValidatedLifecycle()
        throws Exception {
        JSONObject emptyHead = store.androidRoomBackupHead("yuqi", 100L);
        assertEquals(AlExecutionDatabase.SCHEMA_VERSION, emptyHead.getLong("roomSchemaVersion"));
        assertEquals("yuqi", emptyHead.getString("roleId"));
        assertTrue(emptyHead.isNull("lifecycleHead"));
        assertEquals(0L, rowCount("conversation_cursors"));
        assertEquals(0L, rowCount("lifecycle_controls"));
        assertEquals(
            BridgeAuthority.canonicalJson(emptyHead),
            BridgeAuthority.canonicalJson(AndroidRoomBackupHead.validate(emptyHead, "yuqi"))
        );

        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        LifecycleControl control = configured.createConversationClear(
            "yuqi",
            "device_gateway",
            RoomExecutionStore.conversationCursorChecksum("yuqi", new ConversationCursorEntity()),
            200L
        );
        JSONObject liveHead = configured.androidRoomBackupHead("yuqi", 201L);
        JSONObject lifecycle = liveHead.getJSONObject("lifecycleHead");
        assertEquals(control.controlId, lifecycle.getString("controlId"));
        assertEquals(LifecycleControl.CLEAR_KIND, lifecycle.getString("controlKind"));
        assertEquals(LifecycleControl.WAITING, lifecycle.getString("state"));
        assertEquals(1L, lifecycle.getLong("clearEpoch"));
        assertEquals(0L, lifecycle.getLong("clearedThroughSequence"));
        assertEquals(200L, lifecycle.getLong("requestedAt"));
        assertEquals(200L, lifecycle.getLong("updatedAt"));
        assertEquals(control.controlId,
            database.executionDao().latestLifecycleControlForCharacter("yuqi").controlId);
        assertEquals(
            BridgeAuthority.canonicalJson(liveHead),
            BridgeAuthority.canonicalJson(AndroidRoomBackupHead.validate(liveHead, "yuqi"))
        );
        assertThrows(IllegalArgumentException.class,
            () -> configured.androidRoomBackupHead("yuqi", 199L));
    }

    @Test
    public void roleDeletePersistsTheVerifiedReceiptBeforeRemovingEveryRoomRoleRow()
        throws Exception {
        CanonicalFixture fixture = commitCanonicalFixture("task20e-role-delete", "visible", 300L);
        ConversationCursorEntity cursor = database.executionDao().conversationCursor("yuqi");
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum("yuqi", cursor);
        JSONObject receipt = backupReceipt("yuqi", 400L);
        seedRoleOwnedRows(fixture.localTurnId);
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        boolean[] wakeSawDurableDeletion = {false};

        LifecycleControl control = configured.createRoleDelete(
            "yuqi", "device_gateway", cursorChecksum, receipt, 401L,
            () -> wakeSawDurableDeletion[0] = rowCount("lifecycle_controls") == 1L
                && rowCount("chat_turns") == 0L
        );

        assertTrue(wakeSawDurableDeletion[0]);
        assertEquals(LifecycleControl.ROLE_DELETE_KIND, control.controlKind);
        assertNull(control.clearEpoch);
        assertNull(control.clearedThroughSequence);
        JSONObject semantic = new JSONObject(control.semanticJson);
        assertEquals(receipt.toString(), semantic.getJSONObject("backupReceipt").toString());
        assertNull(configured.turn(fixture.localTurnId));
        assertNull(database.executionDao().conversationCursor("yuqi"));
        assertNull(database.executionDao().conversationAuthority(fixture.result.authorityLineageKey));
        for (String table : new String[] {
            "chat_turns", "execution_attempts", "reply_parts", "yuqi_raw_messages",
            "diagnostics", "change_events", "conversation_authorities", "conversation_cursors",
            "yuqi_annotations", "memory_records", "yuqi_evidence_facts", "character_snapshots",
            "role_plan_occurrences", "role_plan_history", "role_plans"
        }) assertEquals(table, 0L, rowCount(table));
        assertEquals(1L, rowCount("lifecycle_controls"));

        LifecycleControl replay = configured.createRoleDelete(
            "yuqi", "device_gateway", cursorChecksum, receipt, 402L, null);
        assertEquals(control.controlId, replay.controlId);
        assertEquals(1L, rowCount("lifecycle_controls"));
        JSONObject changedReceipt = backupReceipt("yuqi", 403L);
        assertThrows(IllegalStateException.class, () -> configured.createRoleDelete(
            "yuqi", "device_gateway", cursorChecksum, changedReceipt, 404L, null));
        assertEquals(1L, rowCount("lifecycle_controls"));
        assertThrows(IllegalStateException.class, () -> configured.createRoleDelete(
            "yuqi", "foreign-peer", cursorChecksum, receipt, 405L, null));
        assertThrows(IllegalStateException.class, () -> configured.submitTurn(
            yuqiThreeBubbleSubmission("late-after-role-delete", "msg-late-role-delete", 406L)));
        assertEquals(0L, rowCount("chat_turns"));
    }

    @Test
    public void roleDeleteCancelsEveryDeterministicMessageNotificationOnlyAfterTurnRowsAreRemoved()
        throws Exception {
        String firstTurnId = "task20e-role-delete-notification-first";
        String secondTurnId = "task20e-role-delete-notification-second";
        store.submitTurn(new TurnSubmission(
            firstTurnId, "yuqi", "task20e-role-delete-notification-first-message",
            TurnKind.DIRECT_REPLY, "{\"text\":\"你好\"}", "{\"messages\":[]}", null, 1L));
        store.submitTurn(new TurnSubmission(
            secondTurnId, "yuqi", "task20e-role-delete-notification-second-message",
            TurnKind.DIRECT_REPLY, "{\"text\":\"你好\"}", "{\"messages\":[]}", null, 2L));
        ConversationCursorEntity cursor = database.executionDao().conversationCursor("yuqi");
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum("yuqi", cursor);
        JSONObject receipt = backupReceipt("yuqi", 410L);
        List<Integer> cancelled = new ArrayList<>();
        boolean[] sawRowsAfterRemoval = {false};

        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        LifecycleControl control = configured.createRoleDelete(
            "yuqi", "device_gateway", cursorChecksum, receipt, 411L,
            null,
            notificationId -> {
                sawRowsAfterRemoval[0] = sawRowsAfterRemoval[0]
                    || database.executionDao().turnIdsForCharacter("yuqi").isEmpty();
                cancelled.add(notificationId);
            }
        );

        assertNotNull(control);
        assertTrue(sawRowsAfterRemoval[0]);
        assertEquals(
            Arrays.asList(
                AlNotificationFactory.messageNotificationId(firstTurnId),
                AlNotificationFactory.messageNotificationId(secondTurnId)
            ),
            cancelled
        );
        assertEquals(0, database.executionDao().turnIdsForCharacter("yuqi").size());
    }

    @Test
    public void collidingNotificationIdsProduceOneDurableCancellationIntent() throws Exception {
        String firstTurnId = "task20e-role-delete-collision-Aa";
        String secondTurnId = "task20e-role-delete-collision-BB";
        assertEquals(
            AlNotificationFactory.messageNotificationId(firstTurnId),
            AlNotificationFactory.messageNotificationId(secondTurnId));
        store.submitTurn(new TurnSubmission(
            firstTurnId, "yuqi", "task20e-role-delete-collision-first-message",
            TurnKind.DIRECT_REPLY, "{\"text\":\"一\"}", "{\"messages\":[]}", null, 1L));
        store.submitTurn(new TurnSubmission(
            secondTurnId, "yuqi", "task20e-role-delete-collision-second-message",
            TurnKind.DIRECT_REPLY, "{\"text\":\"二\"}", "{\"messages\":[]}", null, 2L));
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi"));

        LifecycleControl control = store.createRoleDelete(
            "yuqi", "device_gateway", cursorChecksum, backupReceipt("yuqi", 415L), 416L, null);

        assertNotNull(control);
        assertEquals(1L, database.executionDao().roleNotificationCancellationCount());
        assertEquals(0, database.executionDao().turnIdsForCharacter("yuqi").size());
    }

    @Test
    public void roleDeleteDurablyQueuesNotificationsAndDrainsOnlyAfterCommit() throws Exception {
        String firstTurnId = "task20e-role-delete-queue-first";
        String secondTurnId = "task20e-role-delete-queue-second";
        store.submitTurn(new TurnSubmission(
            firstTurnId, "yuqi", "task20e-role-delete-queue-first-message",
            TurnKind.DIRECT_REPLY, "{\"text\":\"一\"}", "{\"messages\":[]}", null, 1L));
        store.submitTurn(new TurnSubmission(
            secondTurnId, "yuqi", "task20e-role-delete-queue-second-message",
            TurnKind.DIRECT_REPLY, "{\"text\":\"二\"}", "{\"messages\":[]}", null, 2L));
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi"));
        LifecycleControl control = store.createRoleDelete(
            "yuqi", "device_gateway", cursorChecksum, backupReceipt("yuqi", 420L), 421L, null);

        assertNotNull(control);
        assertEquals(2L, database.executionDao().roleNotificationCancellationCount());
        assertEquals(
            2,
            store.drainPendingRoleNotificationCancellations(notificationId -> {
                assertEquals(0, database.executionDao().turnIdsForCharacter("yuqi").size());
            })
        );
        assertEquals(0L, database.executionDao().roleNotificationCancellationCount());
    }

    @Test
    public void notificationCancellationFailureLeavesWaitingIntentForIdempotentRetry() throws Exception {
        String turnId = "task20e-role-delete-queue-retry";
        store.submitTurn(new TurnSubmission(
            turnId, "yuqi", "task20e-role-delete-queue-retry-message",
            TurnKind.DIRECT_REPLY, "{\"text\":\"重试\"}", "{\"messages\":[]}", null, 1L));
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi"));
        store.createRoleDelete(
            "yuqi", "device_gateway", cursorChecksum, backupReceipt("yuqi", 430L), 431L, null);

        assertThrows(RuntimeException.class, () ->
            store.drainPendingRoleNotificationCancellations(notificationId -> {
                throw new IllegalStateException("notification manager unavailable");
            }));
        assertEquals(1L, database.executionDao().roleNotificationCancellationCount());
        assertEquals(1, store.drainPendingRoleNotificationCancellations(notificationId -> {}));
        assertEquals(0L, database.executionDao().roleNotificationCancellationCount());
    }

    @Test
    public void roleDeleteFaultRollsBackCancellationIntentsAndDoesNotCallCanceller() throws Exception {
        String turnId = "task20e-role-delete-queue-fault";
        store.submitTurn(new TurnSubmission(
            turnId, "yuqi", "task20e-role-delete-queue-fault-message",
            TurnKind.DIRECT_REPLY, "{\"text\":\"故障\"}", "{\"messages\":[]}", null, 1L));
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi"));
        RoomExecutionStore faulted = new RoomExecutionStore(database, "device_gateway", boundary -> {
            if ("role_delete_control".equals(boundary)) {
                throw new IllegalStateException("fault after cancellation intents");
            }
        });
        int[] cancellerCalls = {0};
        assertThrows(IllegalStateException.class, () -> faulted.createRoleDelete(
            "yuqi", "device_gateway", cursorChecksum, backupReceipt("yuqi", 440L), 441L,
            null, notificationId -> cancellerCalls[0]++));
        assertEquals(0, cancellerCalls[0]);
        assertEquals(0L, database.executionDao().roleNotificationCancellationCount());
        assertEquals(0L, rowCount("lifecycle_controls"));
        assertEquals(1, database.executionDao().turnIdsForCharacter("yuqi").size());
    }

    @Test
    public void rolePlanAndAutomaticDispatchWaitForRoleDeleteGateBeforeCreatingRows() throws Exception {
        final String characterId = "yuqi";
        final long now = 900L;
        RolePlanEntity plan = new RolePlanEntity();
        plan.planId = "task20e-gated-role-plan";
        plan.characterId = characterId;
        plan.status = "active";
        plan.planJson = "{\"type\":\"private_message\",\"source\":\"spoken\"}";
        plan.nextRunAt = 899L;
        plan.updatedAt = 899L;
        database.executionDao().upsertRolePlans(Collections.singletonList(plan));
        CharacterSnapshotEntity rolePlanSnapshot = new CharacterSnapshotEntity();
        rolePlanSnapshot.snapshotId = characterId + ":role-plan:" + plan.planId;
        rolePlanSnapshot.characterId = characterId;
        rolePlanSnapshot.characterName = "虞栖";
        rolePlanSnapshot.playerName = "姜隽倚";
        rolePlanSnapshot.systemPrompt = "{}";
        rolePlanSnapshot.momentSystemPrompt = "{}";
        rolePlanSnapshot.chatConfigId = "chat";
        rolePlanSnapshot.memoryConfigId = "memory";
        rolePlanSnapshot.createdAt = 898L;
        rolePlanSnapshot.contextJson = "{}";
        database.executionDao().upsertSnapshot(rolePlanSnapshot);

        CharacterSnapshotEntity automaticSnapshot = new CharacterSnapshotEntity();
        automaticSnapshot.snapshotId = characterId + ":chat";
        automaticSnapshot.characterId = characterId;
        automaticSnapshot.characterName = "虞栖";
        automaticSnapshot.playerName = "姜隽倚";
        automaticSnapshot.systemPrompt = "{}";
        automaticSnapshot.momentSystemPrompt = "{}";
        automaticSnapshot.chatConfigId = "chat";
        automaticSnapshot.memoryConfigId = "memory";
        automaticSnapshot.createdAt = 897L;
        automaticSnapshot.jobSnapshot = true;
        automaticSnapshot.automaticTasksEnabled = true;
        automaticSnapshot.automaticKind = "chat";
        automaticSnapshot.cloudJobId = "task20e-gated-automatic";
        automaticSnapshot.scheduledFor = 899L;
        automaticSnapshot.contextJson = "{}";
        database.executionDao().upsertSnapshot(automaticSnapshot);

        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
            characterId, database.executionDao().conversationCursor(characterId));
        JSONObject receipt = backupReceipt(characterId, 901L);
        CountDownLatch gateEntered = new CountDownLatch(1);
        CountDownLatch dispatchesStarted = new CountDownLatch(1);
        CountDownLatch releaseGate = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(3);
        try {
            Future<Boolean> held = workers.submit(() -> store.runRoleSideEffectIfNotDeleted(
                characterId,
                () -> {
                    gateEntered.countDown();
                    try {
                        if (!dispatchesStarted.await(2, TimeUnit.SECONDS)) {
                            throw new AssertionError("dispatch start timed out");
                        }
                        store.createRoleDelete(
                            characterId, "device_gateway", cursorChecksum, receipt, 902L, null);
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new AssertionError(error);
                    }
                }
            ));
            assertTrue(gateEntered.await(2, TimeUnit.SECONDS));
            Future<Integer> rolePlanDispatch = workers.submit(
                () -> new RolePlanCoordinator(database).dispatchDue(now));
            Future<Integer> automaticDispatch = workers.submit(
                () -> new AutomaticTaskCoordinator(database).dispatchDue(now));
            Thread.sleep(100L);
            assertFalse(rolePlanDispatch.isDone());
            assertFalse(automaticDispatch.isDone());
            assertEquals(0L, rowCount("chat_turns"));
            assertEquals(0L, rowCount("role_plan_occurrences"));
            dispatchesStarted.countDown();
            releaseGate.countDown();
            assertFalse(held.get(2, TimeUnit.SECONDS));
            assertEquals(0, rolePlanDispatch.get(2, TimeUnit.SECONDS).intValue());
            assertEquals(0, automaticDispatch.get(2, TimeUnit.SECONDS).intValue());
            assertTrue(store.isRoleDeleteTombstoned(characterId));
            assertEquals(0L, rowCount("chat_turns"));
            assertEquals(0L, rowCount("role_plan_occurrences"));
            assertEquals(0L, rowCount("diagnostics"));
        } finally {
            releaseGate.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    public void retainedRoleDeleteTombstoneBlocksLateSemanticFinalizersAndDirectGate()
        throws Exception {
        String turnId = "task20e-gate-turn";
        store.submitTurn(submission(turnId, "task20e-gate-message"));
        String attemptId = store.activeAttempt(turnId).attemptId;
        insertRoleDeleteTombstone("char-1", 100L);

        ReplyPartEntity part = new ReplyPartEntity();
        part.replyPartId = "task20e-gate-part";
        part.turnId = turnId;
        part.attemptId = attemptId;
        part.sequence = 0;
        part.type = "TEXT";
        part.content = "迟到语义";
        part.payloadJson = "{}";
        part.createdAt = 101L;

        assertThrows(IllegalStateException.class,
            () -> store.commitReply(turnId, attemptId, Collections.singletonList(part), 102L));
        assertThrows(IllegalStateException.class,
            () -> store.commitSkip(turnId, attemptId, 103L));
        assertThrows(IllegalStateException.class,
            () -> store.markNotificationShown(turnId, 104L));
        assertThrows(IllegalStateException.class,
            () -> store.acknowledgeUiApplied(turnId, 105L));
        assertThrows(IllegalStateException.class,
            () -> store.markCloudConfirmed(turnId, 106L));
        assertThrows(IllegalStateException.class,
            () -> store.assertRoleAcceptsSemanticWrite("char-1"));

        assertEquals(TurnState.QUEUED.name(), store.turn(turnId).state);
        assertEquals(0L, rowCount("reply_parts"));
    }

    @Test
    public void roleDeleteCompetesWithStoreOwnedSideEffectGateWithoutCheckToRunRace()
        throws Exception {
        String characterId = "yuqi";
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
            characterId, database.executionDao().conversationCursor(characterId));
        JSONObject receipt = backupReceipt(characterId, 130L);
        CountDownLatch effectStarted = new CountDownLatch(1);
        CountDownLatch releaseEffect = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<Boolean> sideEffect = workers.submit(() -> store.runRoleSideEffectIfNotDeleted(
                characterId,
                () -> {
                    effectStarted.countDown();
                    try {
                        if (!releaseEffect.await(2, TimeUnit.SECONDS)) {
                            throw new AssertionError("effect release timed out");
                        }
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new AssertionError(error);
                    }
                }
            ));
            assertTrue(effectStarted.await(2, TimeUnit.SECONDS));
            Future<LifecycleControl> delete = workers.submit(() -> store.createRoleDelete(
                characterId, "device_gateway", cursorChecksum, receipt, 131L, null));
            Thread.sleep(100L);
            assertFalse(delete.isDone());
            releaseEffect.countDown();
            assertTrue(sideEffect.get(2, TimeUnit.SECONDS));
            assertNotNull(delete.get(2, TimeUnit.SECONDS));
            assertTrue(store.isRoleDeleteTombstoned(characterId));
        } finally {
            releaseEffect.countDown();
            workers.shutdownNow();
        }
    }

    @Test
    public void suppressRoleDeletedCompletedTurnHidesItAcrossRestartWithoutSemanticWrites()
        throws Exception {
        String turnId = "task20e-suppress-completed";
        store.submitTurn(submission(turnId, "task20e-suppress-message"));
        store.commitSkip(turnId, store.activeAttempt(turnId).attemptId, 120L);
        int diagnosticsBefore = database.executionDao().latestDiagnostics(100).size();
        insertRoleDeleteTombstone("char-1", 121L);

        assertTrue(store.suppressRoleDeletedTurn(turnId, "char-1", 122L));
        ChatTurnEntity suppressed = store.turn(turnId);
        assertEquals(TurnState.COMPLETED.name(), suppressed.state);
        assertEquals(Long.valueOf(122L), suppressed.deletedAt);
        assertEquals(0, store.recentCompletedTurns(50).size());
        assertEquals(0, store.unappliedCompletedTurns(50).size());
        assertEquals(diagnosticsBefore, database.executionDao().latestDiagnostics(100).size());

        RoomExecutionStore restarted = new RoomExecutionStore(database, "device_gateway");
        assertEquals(0, restarted.recentCompletedTurns(50).size());
        assertTrue(restarted.suppressRoleDeletedTurn(turnId, "char-1", 123L));
        assertEquals(Long.valueOf(122L), restarted.turn(turnId).deletedAt);
    }

    @Test
    public void suppressRoleDeletedTurnAllowsAppliedOrMissingReplayButRejectsForeignAndUntombstoned()
        throws Exception {
        String appliedTurnId = "task20e-suppress-applied";
        store.submitTurn(submission(appliedTurnId, "task20e-applied-message"));
        store.commitSkip(appliedTurnId, store.activeAttempt(appliedTurnId).attemptId, 130L);
        insertRoleDeleteTombstone("char-1", 131L);
        assertTrue(store.suppressRoleDeletedTurn(appliedTurnId, "char-1", 132L));
        database.executionDao().deleteTurnsForRole("char-1");
        assertTrue(store.suppressRoleDeletedTurn(appliedTurnId, "char-1", 133L));

        String liveTurnId = "task20e-suppress-foreign";
        store.submitTurn(new TurnSubmission(
            liveTurnId, "char-2", "task20e-foreign-message", TurnKind.DIRECT_REPLY,
            "{}", "{}", null, 134L));
        assertThrows(IllegalStateException.class,
            () -> store.suppressRoleDeletedTurn(liveTurnId, "char-1", 134L));
        assertNull(store.turn(liveTurnId).deletedAt);

        assertThrows(IllegalStateException.class,
            () -> store.suppressRoleDeletedTurn(liveTurnId, "char-2", 135L));
        assertNull(store.turn(liveTurnId).deletedAt);
    }

    @Test
    public void rolePlanQueueCreatesOccurrenceAndTurnInOneStoreTransaction() throws Exception {
        RolePlanOccurrenceEntity occurrence = new RolePlanOccurrenceEntity();
        occurrence.occurrenceId = "task20e-atomic-occurrence";
        occurrence.planId = "task20e-atomic-plan";
        occurrence.characterId = "char-1";
        occurrence.state = "CLAIMED";
        occurrence.turnId = "task20e-atomic-turn";
        occurrence.jobId = "job-atomic";
        occurrence.scheduledFor = 200L;
        occurrence.claimedAt = 201L;
        occurrence.updatedAt = 201L;
        TurnSubmission turn = new TurnSubmission(
            occurrence.turnId, "char-1", occurrence.occurrenceId, TurnKind.ROLE_PLAN_CHAT,
            "{\"planId\":\"task20e-atomic-plan\"}", "{}", occurrence.jobId, 201L);

        insertRoleDeleteTombstone("char-1", 199L);
        assertThrows(IllegalStateException.class,
            () -> store.submitRolePlanOccurrence(occurrence, turn));
        assertEquals(0L, rowCount("role_plan_occurrences"));
        assertEquals(0L, rowCount("chat_turns"));
        assertEquals(0L, rowCount("diagnostics"));
    }

    @Test
    public void rolePlanQueueAtomicallyPersistsOccurrenceTurnAttemptAndClaimDiagnostic() {
        RolePlanOccurrenceEntity occurrence = new RolePlanOccurrenceEntity();
        occurrence.occurrenceId = "task20e-atomic-positive-occurrence";
        occurrence.planId = "task20e-atomic-positive-plan";
        occurrence.characterId = "char-1";
        occurrence.state = "CLAIMED";
        occurrence.turnId = "task20e-atomic-positive-turn";
        occurrence.jobId = "job-atomic-positive";
        occurrence.scheduledFor = 210L;
        occurrence.claimedAt = 211L;
        occurrence.updatedAt = 211L;
        TurnSubmission turnSubmission = new TurnSubmission(
            occurrence.turnId, occurrence.characterId, occurrence.occurrenceId,
            TurnKind.ROLE_PLAN_CHAT, "{\"planId\":\"task20e-atomic-positive-plan\"}",
            "{}", occurrence.jobId, 211L);

        ChatTurnEntity turn = store.submitRolePlanOccurrence(occurrence, turnSubmission);

        assertNotNull(turn);
        assertNotNull(store.turn(occurrence.turnId));
        assertNotNull(store.activeAttempt(occurrence.turnId));
        assertNotNull(database.executionDao().rolePlanOccurrence(occurrence.occurrenceId));
        assertEquals(1L, database.executionDao().diagnosticCountByCodeAndDetail(
            "ROLE_PLAN_CLAIMED", "role-plan occurrence claimed"));
    }

    @Test
    public void rolePlanAtomicFaultRollsBackOccurrenceTurnAttemptAndDiagnostic() {
        RolePlanOccurrenceEntity occurrence = new RolePlanOccurrenceEntity();
        occurrence.occurrenceId = "task20e-atomic-fault-occurrence";
        occurrence.planId = "task20e-atomic-fault-plan";
        occurrence.characterId = "char-1";
        occurrence.state = "CLAIMED";
        occurrence.turnId = "task20e-atomic-fault-turn";
        occurrence.jobId = "job-atomic-fault";
        occurrence.scheduledFor = 220L;
        occurrence.claimedAt = 221L;
        occurrence.updatedAt = 221L;
        TurnSubmission malformed = new TurnSubmission(
            occurrence.turnId, occurrence.characterId, occurrence.occurrenceId,
            null, "{}", "{}", occurrence.jobId, 221L);
        long occurrences = rowCount("role_plan_occurrences");
        long turns = rowCount("chat_turns");
        long attempts = rowCount("execution_attempts");
        long diagnostics = rowCount("diagnostics");

        assertThrows(IllegalStateException.class,
            () -> store.submitRolePlanOccurrence(occurrence, malformed));
        assertEquals(occurrences, rowCount("role_plan_occurrences"));
        assertEquals(turns, rowCount("chat_turns"));
        assertEquals(attempts, rowCount("execution_attempts"));
        assertEquals(diagnostics, rowCount("diagnostics"));
    }

    @Test
    public void rolePlanAtomicFaultsAtEveryWriteBoundaryLeaveNoOrphanRows() {
        String[] boundaries = {
            "role_plan_occurrence_insert", "role_plan_turn_attempt", "role_plan_diagnostic"
        };
        for (String boundary : boundaries) {
            RolePlanOccurrenceEntity occurrence = new RolePlanOccurrenceEntity();
            occurrence.occurrenceId = "task20e-boundary-" + boundary;
            occurrence.planId = "task20e-boundary-plan-" + boundary;
            occurrence.characterId = "char-1";
            occurrence.state = "CLAIMED";
            occurrence.turnId = "task20e-boundary-turn-" + boundary;
            occurrence.jobId = "job-boundary-" + boundary;
            occurrence.scheduledFor = 230L;
            occurrence.claimedAt = 231L;
            occurrence.updatedAt = 231L;
            TurnSubmission submission = new TurnSubmission(
                occurrence.turnId, occurrence.characterId, occurrence.occurrenceId,
                TurnKind.ROLE_PLAN_CHAT, "{\"planId\":\"" + occurrence.planId + "\"}",
                "{}", occurrence.jobId, 231L);
            long occurrences = rowCount("role_plan_occurrences");
            long turns = rowCount("chat_turns");
            long attempts = rowCount("execution_attempts");
            long diagnostics = rowCount("diagnostics");
            RoomExecutionStore faulted = new RoomExecutionStore(database, reached -> {
                if (boundary.equals(reached)) throw new IllegalStateException("fault:" + reached);
            });

            assertThrows(IllegalStateException.class,
                () -> faulted.submitRolePlanOccurrence(occurrence, submission));
            assertEquals(occurrences, rowCount("role_plan_occurrences"));
            assertEquals(turns, rowCount("chat_turns"));
            assertEquals(attempts, rowCount("execution_attempts"));
            assertEquals(diagnostics, rowCount("diagnostics"));
        }
    }

    @Test
    public void roleScopedDispatchDiagnosticsAreAtomicWithTheRoleDeleteFence() throws Exception {
        assertTrue(store.recordRolePreflightDiagnosticIfActive(
            "task20e-role-preflight", "char-1", "WARN", "SNAPSHOT_MISSING", "job-preflight", 299L));
        assertEquals(1L, database.executionDao().diagnosticCountByCodeAndDetail(
            "SNAPSHOT_MISSING", "job-preflight"));
        String turnId = "task20e-role-diagnostic-fence";
        store.submitTurn(submission(turnId, "task20e-role-diagnostic-message"));
        String attemptId = store.activeAttempt(turnId).attemptId;
        assertTrue(store.recordRoleDispatchDiagnosticsIfActive(
            turnId, "char-1", attemptId, 300L,
            "FCM_RECEIVED", "chat:job-fence",
            "FCM_PRIORITY", "original=1;delivered=1"));
        assertEquals(1L, database.executionDao().diagnosticCountByCodeAndDetail(
            "FCM_RECEIVED", "chat:job-fence"));
        insertRoleDeleteTombstone("char-1", 301L);
        assertFalse(store.recordRolePreflightDiagnosticIfActive(
            "task20e-role-preflight-after-delete", "char-1",
            "WARN", "SNAPSHOT_MISSING", "job-preflight-after-delete", 302L));
        assertFalse(store.recordRoleDispatchDiagnosticsIfActive(
            turnId, "char-1", attemptId, 303L,
            "FCM_RECEIVED", "chat:job-fence-2",
            "FCM_PRIORITY", "original=1;delivered=1"));
        assertEquals(0L, database.executionDao().diagnosticCountByCodeAndDetail(
            "FCM_RECEIVED", "chat:job-fence-2"));
    }

    @Test
    public void everyRoleDeleteBoundaryRollsBackTheControlReceiptAndRoleRows()
        throws Exception {
        CanonicalFixture fixture = commitCanonicalFixture("task20e-role-delete-fault", "visible", 500L);
        AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
        String scheduleEpoch = "00112233445566778899aabbccddeeff";
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity protectedChat = schedules.configure(
            "yuqi", "chat", scheduleEpoch,
            automaticSource("bootstrap", "outer-boundary-chat", 'a', 0L, 501L),
            automaticPolicy(), 501L);
        com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity protectedMoment = schedules.configure(
            "yuqi", "moment", scheduleEpoch,
            automaticSource("bootstrap", "outer-boundary-moment", 'b', 0L, 502L),
            automaticPolicy(), 502L);
        ConversationCursorEntity cursor = database.executionDao().conversationCursor("yuqi");
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum("yuqi", cursor);
        JSONObject receipt = backupReceipt("yuqi", 600L);
        String[] roleTables = {
            "chat_turns", "execution_attempts", "reply_parts", "yuqi_raw_messages",
            "diagnostics", "change_events", "conversation_authorities", "conversation_cursors",
            "yuqi_annotations", "memory_records", "yuqi_evidence_facts", "character_snapshots",
            "role_plan_occurrences", "role_plan_history", "role_plans",
            "role_notification_cancellations"
        };
        long[] roleCounts = new long[roleTables.length];
        for (int index = 0; index < roleTables.length; index += 1) {
            roleCounts[index] = rowCount(roleTables[index]);
        }
        String[] boundaries = {
            "role_delete_control", "role_delete_turn_children", "role_delete_role_data",
            "role_delete_authority", "role_delete_lifecycle"
        };
        for (int index = 0; index < boundaries.length; index += 1) {
            String boundary = boundaries[index];
            RoomExecutionStore faulted = new RoomExecutionStore(database, "device_gateway", reached -> {
                if (boundary.equals(reached)) throw new IllegalStateException("fault:" + reached);
            });
            long requestedAt = 601L + index;
            assertThrows(IllegalStateException.class, () -> faulted.createRoleDelete(
                "yuqi", "device_gateway", cursorChecksum, receipt, requestedAt, null));
            assertNotNull(faulted.turn(fixture.localTurnId));
            assertNotNull(database.executionDao().conversationCursor("yuqi"));
            assertNotNull(database.executionDao().conversationAuthority(fixture.result.authorityLineageKey));
            assertEquals(0L, rowCount("lifecycle_controls"));
            assertEquals(2L, rowCount("automatic_schedule_authorities"));
            assertEquals(2L, rowCount("automatic_schedule_outbox"));
            assertEquals(2L, rowCount("automatic_schedule_events"));
            assertEquals("scheduled", database.executionDao()
                .automaticScheduleAuthority(protectedChat.streamKey).state);
            assertEquals("scheduled", database.executionDao()
                .automaticScheduleAuthority(protectedMoment.streamKey).state);
            for (int tableIndex = 0; tableIndex < roleTables.length; tableIndex += 1) {
                assertEquals(roleTables[tableIndex], roleCounts[tableIndex],
                    rowCount(roleTables[tableIndex]));
            }
            assertEquals(cursorChecksum, RoomExecutionStore.conversationCursorChecksum(
                "yuqi", database.executionDao().conversationCursor("yuqi")));
        }
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
    public void peerAwareTerminalCommitRejectsForeignAuthenticatedPeerBeforeAnyWrite() throws Exception {
        String turnId = "local-v3-peer-aware-terminal";
        store.submitTurn(yuqiThreeBubbleSubmission(turnId, "msg-peer-aware-terminal-3", 205L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(turnId), "device_gateway", 206L);
        ExecutionAttemptEntity attempt = store.activeAttempt(turnId);
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        BridgeResult result = BridgeTurnStatus.parseV3(
            canonicalTerminal(checkpoint, "visible", 3, new JSONArray()).toString(),
            "lan", null);
        long changes = rowCount("change_events");
        assertThrows(IllegalStateException.class, () -> store.commitBridgedTerminalWithPeer(
            turnId, attempt.attemptId, result, "foreign-peer", 207L));
        assertEquals(TurnState.MEMORY_RUNNING.name(), store.turn(turnId).state);
        assertEquals(0, store.replyParts(turnId).size());
        assertEquals(changes, rowCount("change_events"));

        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.commitBridgedTerminalWithPeer(
                turnId, attempt.attemptId, result, "device_gateway", 208L));
    }

    @Test
    public void unknownAppliedAckTombstoneIsExactReplayAndChangedRelayConflicts() throws Exception {
        JSONObject ack = new JSONObject()
            .put("protocolVersion", 3)
            .put("type", "CONVERSATION_CLEAR_APPLIED")
            .put("controlId", "ctl_unknown_" + repeat('a', 64))
            .put("controlChecksum", repeat('b', 64))
            .put("roleId", "yuqi")
            .put("peerId", "device_gateway")
            .put("clearEpoch", 1L)
            .put("clearedThroughSequence", 0L)
            .put("appliedAt", 500L);
        ack.put("checksum", BridgeAuthority.sha256CanonicalJson(without(ack, "checksum")));
        LifecycleControlSender.validateAppliedAckShape(ack);

        assertTrue(store.recordUnknownLifecycleAckTerminal(
            "device_gateway", "relay-inbound-1", 1_000L,
            ack.getString("controlId"), ack.getString("controlChecksum"),
            ack.getString("checksum"), 500L));
        assertTrue(store.recordUnknownLifecycleAckTerminal(
            "device_gateway", "relay-inbound-1", 1_000L,
            ack.getString("controlId"), ack.getString("controlChecksum"),
            ack.getString("checksum"), 501L));
        assertThrows(IllegalArgumentException.class, () -> store.recordUnknownLifecycleAckTerminal(
            "device_gateway", "relay-inbound-1", 1_000L,
            ack.getString("controlId"), repeat('c', 64), ack.getString("checksum"), 502L));
        assertThrows(IllegalArgumentException.class, () -> store.recordUnknownLifecycleAckTerminal(
            "device_gateway", "relay-inbound-1", 1_001L,
            ack.getString("controlId"), ack.getString("controlChecksum"),
            ack.getString("checksum"), 503L));
        RoomExecutionStore otherPeerStore = new RoomExecutionStore(database, "device-other");
        assertTrue(otherPeerStore.recordUnknownLifecycleAckTerminal(
            "device-other", "relay-inbound-1", 1_000L,
            ack.getString("controlId"), ack.getString("controlChecksum"),
            ack.getString("checksum"), 504L));
        assertEquals(2L, count("lifecycle_inbound_ack_tombstones"));
    }

    @Test
    public void twoRoomConnectionsConvergeUnknownAckToOneDurableRow() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String databaseName = "unknown-ack-race-" + System.nanoTime();
        AlExecutionDatabase firstDb = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .allowMainThreadQueries().build();
        AlExecutionDatabase secondDb = Room.databaseBuilder(context, AlExecutionDatabase.class, databaseName)
            .allowMainThreadQueries().build();
        RoomExecutionStore first = new RoomExecutionStore(firstDb, "device_gateway");
        RoomExecutionStore second = new RoomExecutionStore(secondDb, "device_gateway");
        String controlId = "ctl_race_" + repeat('d', 64);
        String controlChecksum = repeat('e', 64);
        String ackChecksum = repeat('f', 64);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<Boolean> one = executor.submit(() -> first.recordUnknownLifecycleAckTerminal(
                "device_gateway", "relay-race", 1_000L,
                controlId, controlChecksum, ackChecksum, 500L));
            Future<Boolean> two = executor.submit(() -> second.recordUnknownLifecycleAckTerminal(
                "device_gateway", "relay-race", 1_000L,
                controlId, controlChecksum, ackChecksum, 501L));
            assertTrue(one.get());
            assertTrue(two.get());
            assertEquals(1L, countFrom(firstDb, "lifecycle_inbound_ack_tombstones"));
        } finally {
            executor.shutdownNow();
            firstDb.close();
            secondDb.close();
            context.deleteDatabase(databaseName);
        }
    }

    @Test
    public void lifecycleSelectorIncludesRoleDeleteInTheSharedDurableOutbox() {
        String[] states = {"waiting", "pending", "relay_accepted"};
        for (int index = 0; index < states.length; index += 1) {
            LifecycleControlEntity roleDelete = new LifecycleControlEntity();
            roleDelete.controlId = "role-delete-selector-" + index;
            roleDelete.controlKind = LifecycleControl.ROLE_DELETE_KIND;
            roleDelete.characterId = "yuqi";
            roleDelete.peerId = "device-1";
            roleDelete.clearEpoch = null;
            roleDelete.clearedThroughSequence = null;
            roleDelete.requestedAt = 100L + index;
            roleDelete.semanticJson = "{}";
            roleDelete.semanticChecksum = repeat('b', 64);
            roleDelete.state = states[index];
            roleDelete.leaseId = "pending".equals(states[index]) ? "lease" : null;
            roleDelete.leaseAttempt = "waiting".equals(states[index]) ? 0L : 1L;
            roleDelete.leasedAt = "pending".equals(states[index]) ? 100L : null;
            roleDelete.relayMessageId = "relay_accepted".equals(states[index]) ? "relay" : null;
            roleDelete.relayExpiresAt = "relay_accepted".equals(states[index]) ? 100L : null;
            roleDelete.appliedAt = null;
            roleDelete.updatedAt = 100L;
            database.executionDao().insertLifecycleControl(roleDelete);
        }

        LifecycleControlEntity next = database.executionDao().nextLifecycleControl(1_000L, 1_000L);
        assertNotNull(next);
        assertEquals(LifecycleControl.ROLE_DELETE_KIND, next.controlKind);
        assertEquals("role-delete-selector-0", next.controlId);
    }

    @Test
    public void androidFallbackCommitsOneV2CheckpointReceiptAndDeterministicVisibleGroup()
        throws Exception {
        String localTurnId = "local-v3-android-fallback";
        store.submitTurn(yuqiFallbackSubmission(
            localTurnId, "msg-android-fallback-3", 180L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 181L);
        ExecutionAttemptEntity attempt = store.activeAttempt(localTurnId);
        ReplyPartEntity draft = textPart(
            localTurnId, attempt.attemptId, "我在。刚刚去倒了杯水");
        JSONObject openCheckpoint = new JSONObject(
            prepared.bridgeAuthorityCheckpointJson);

        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.commitAndroidFallback(
                localTurnId,
                attempt.attemptId,
                Collections.singletonList(draft),
                "visible",
                182L
            ));

        ChatTurnEntity committed = store.turn(localTurnId);
        String expectedGroup = AuthorityIdentity.groupId(
            openCheckpoint.getString("authorityLineageKey"));
        assertEquals("android_fallback", committed.authorityOrigin);
        assertEquals("android-fallback-commit-v2", committed.commitPayloadVersion);
        assertEquals(expectedGroup, committed.visibleGroupId);
        assertEquals("visible", committed.terminalDisposition);
        assertEquals(AuthorityIdentity.messageId(expectedGroup, 0L),
            store.replyParts(localTurnId).get(0).replyPartId);

        ExecutionAttemptEntity persisted = store.activeAttempt(localTurnId);
        JSONObject checkpoint = new JSONObject(
            persisted.bridgeAuthorityCheckpointJson);
        assertEquals(2, checkpoint.getInt("version"));
        assertTrue(checkpoint.getLong("journalSyncSeq") > 0L);
        assertEquals("cognition-v3-fallback-v1",
            checkpoint.getJSONObject("fallbackExecution").getString("contract"));
        JSONObject receipt = checkpoint.getJSONObject("outcome")
            .getJSONObject("result");
        JSONObject semanticReceipt = receipt.getJSONObject("semantic");
        assertEquals("android-fallback-authority-v2",
            semanticReceipt.getString("contract"));
        assertTrue(semanticReceipt.isNull("retryOfTurnId"));
        assertEquals(expectedGroup, semanticReceipt.getString("visibleGroupId"));
        assertEquals(checkpoint.getLong("journalSyncSeq"),
            semanticReceipt.getLong("journalSyncSeq"));
        assertEquals(1, semanticReceipt.getJSONArray("visibleItems").length());
        assertEquals(
            openCheckpoint.getJSONObject("normalizedEnvelope").getLong("createdAt"),
            semanticReceipt.getJSONArray("visibleItems").getJSONObject(0).getLong("sentAt"));
        JSONObject directInput = semanticReceipt.getJSONObject("input");
        assertEquals("direct", directInput.getString("kind"));
        assertTrue(directInput.has("batch"));
        assertEquals(3, directInput.getJSONObject("batch").getJSONArray("items").length());
        assertEquals(directInput.getJSONObject("batch").getString("checksum"),
            directInput.getString("checksum"));
        assertEquals(receipt.getString("commitChecksum"),
            BridgeAuthority.sha256CanonicalJson(
                receipt.getJSONObject("manifest").getJSONObject("semantic")));
        String publicReceipt = BridgeAuthority.canonicalJson(receipt);
        assertEquals(false, publicReceipt.contains("fallbackExecution"));
        assertEquals(false, publicReceipt.contains("configId"));
        assertEquals(false, publicReceipt.contains("system"));
        assertEquals(false, publicReceipt.contains("private cognition prompt"));

        long journalSyncSeq = checkpoint.getLong("journalSyncSeq");
        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.commitAndroidFallback(
                localTurnId,
                attempt.attemptId,
                Collections.singletonList(draft),
                "visible",
                999L
            ));
        JSONObject replay = new JSONObject(
            store.activeAttempt(localTurnId).bridgeAuthorityCheckpointJson);
        assertEquals(journalSyncSeq, replay.getLong("journalSyncSeq"));
        assertEquals(1, store.replyParts(localTurnId).size());
    }

    @Test
    public void androidFallbackRetryReceiptRetainsItsVerifiedRemoteParent() throws Exception {
        String localTurnId = "local-v3-android-fallback-retry";
        store.submitTurn(yuqiFallbackSubmission(
            localTurnId, "msg-android-fallback-retry-3", 185L));
        TurnSubmission parent = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 186L);
        JSONObject parentCheckpoint = new JSONObject(parent.bridgeAuthorityCheckpointJson);
        ExecutionAttemptEntity parentAttempt = store.activeAttempt(localTurnId);
        BridgeResult failure = BridgeTurnStatus.parseV3(
            canonicalFailure(parentCheckpoint, true, 187L).toString(),
            "cloud", "relay-android-fallback-parent");
        store.commitVerifiedRemoteFailure(
            localTurnId, parentAttempt.attemptId, failure, 188L);

        ExecutionAttemptEntity childAttempt = store.startRetry(localTurnId, 189L);
        TurnSubmission child = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 190L);
        JSONObject childCheckpoint = new JSONObject(child.bridgeAuthorityCheckpointJson);
        ReplyPartEntity draft = textPart(
            localTurnId, childAttempt.attemptId, "重试后改由本地完成");

        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.commitAndroidFallback(
                localTurnId, childAttempt.attemptId,
                Collections.singletonList(draft), "visible", 191L));

        JSONObject semantic = new JSONObject(
            store.activeAttempt(localTurnId).bridgeAuthorityCheckpointJson)
            .getJSONObject("outcome").getJSONObject("result").getJSONObject("semantic");
        assertEquals(parent.authoritativeTurnId, semantic.getString("retryOfTurnId"));
        assertEquals(child.authoritativeTurnId, semantic.getString("authoritativeTurnId"));
        assertEquals(childCheckpoint.getLong("claimedLineageRevision"),
            semantic.getLong("lineageRevisionAtCreation"));
    }

    @Test
    public void automaticAndroidFallbackSkipCommitsAGroupReceiptWithoutPartsOrUiInbox()
        throws Exception {
        String localTurnId = "local-v3-android-fallback-skip";
        store.submitTurn(yuqiAutomaticFallbackSubmission(localTurnId, 190L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 191L);
        ExecutionAttemptEntity attempt = store.activeAttempt(localTurnId);
        JSONObject openCheckpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);

        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.commitAndroidFallback(
                localTurnId, attempt.attemptId, Collections.emptyList(), "skip", 192L));

        ChatTurnEntity committed = store.turn(localTurnId);
        JSONObject checkpoint = new JSONObject(
            store.activeAttempt(localTurnId).bridgeAuthorityCheckpointJson);
        JSONObject semantic = checkpoint.getJSONObject("outcome")
            .getJSONObject("result").getJSONObject("semantic");
        assertEquals(AuthorityIdentity.groupId(openCheckpoint.getString("authorityLineageKey")),
            committed.visibleGroupId);
        assertEquals("skip", committed.terminalDisposition);
        assertEquals(0, store.replyParts(localTurnId).size());
        assertEquals(0, semantic.getJSONArray("replyItems").length());
        assertEquals(0, semantic.getJSONArray("actions").length());
        assertEquals("automatic", semantic.getJSONObject("input").getString("kind"));
        assertEquals(committed.completedAt, committed.uiAppliedAt);
        assertEquals(0, store.unappliedCompletedTurns(10).stream()
            .filter(turn -> localTurnId.equals(turn.turnId)).count());
    }

    @Test
    public void automaticAndroidFallbackVisibleCommitsOneDeterministicReceipt() throws Exception {
        String localTurnId = "local-v3-android-fallback-automatic-visible";
        store.submitTurn(yuqiAutomaticFallbackSubmission(localTurnId, 195L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 196L);
        ExecutionAttemptEntity attempt = store.activeAttempt(localTurnId);
        ReplyPartEntity draft = textPart(
            localTurnId, attempt.attemptId, "刚把今天的安排收了一下。");

        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.commitAndroidFallback(
                localTurnId, attempt.attemptId,
                Collections.singletonList(draft), "visible", 197L));

        ChatTurnEntity committed = store.turn(localTurnId);
        JSONObject semantic = new JSONObject(
            store.activeAttempt(localTurnId).bridgeAuthorityCheckpointJson)
            .getJSONObject("outcome").getJSONObject("result").getJSONObject("semantic");
        assertEquals("visible", committed.terminalDisposition);
        assertEquals(1, semantic.getJSONArray("replyItems").length());
        assertEquals("automatic", semantic.getJSONObject("input").getString("kind"));
        assertEquals(
            semantic.getJSONObject("input").getJSONObject("trigger").getLong("executedAt"),
            semantic.getJSONArray("visibleItems").getJSONObject(0).getLong("sentAt"));
        assertEquals(null, committed.uiAppliedAt);
    }

    @Test
    public void automaticAndroidFallbackActionOnlyPinsTheMomentTargetAndOneActionReceipt()
        throws Exception {
        String localTurnId = "local-v3-android-fallback-action";
        store.submitTurn(yuqiMomentFallbackSubmission(localTurnId, 200L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 201L);
        ExecutionAttemptEntity attempt = store.activeAttempt(localTurnId);
        ReplyPartEntity action = new ReplyPartEntity();
        action.replyPartId = "draft-action";
        action.turnId = localTurnId;
        action.attemptId = attempt.attemptId;
        action.sequence = 0;
        action.type = "MOMENT_ACTION";
        action.content = "";
        action.payloadJson = new JSONObject()
            .put("momentId", "moment-fallback-1")
            .put("like", true)
            .toString();
        action.createdAt = 202L;

        assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
            store.commitAndroidFallback(
                localTurnId, attempt.attemptId,
                Collections.singletonList(action), "action_only", 202L));

        ChatTurnEntity committed = store.turn(localTurnId);
        JSONObject checkpoint = new JSONObject(
            store.activeAttempt(localTurnId).bridgeAuthorityCheckpointJson);
        JSONObject semantic = checkpoint.getJSONObject("outcome")
            .getJSONObject("result").getJSONObject("semantic");
        assertEquals("action_only", committed.terminalDisposition);
        assertEquals(0, semantic.getJSONArray("replyItems").length());
        assertEquals(0, semantic.getJSONArray("visibleItems").length());
        assertEquals(1, semantic.getJSONArray("actions").length());
        JSONObject receiptAction = semantic.getJSONArray("actions").getJSONObject(0);
        assertEquals("moment_like", receiptAction.getString("kind"));
        assertEquals("moment:moment-fallback-1", receiptAction.getString("targetKey"));
        assertEquals(AuthorityIdentity.actionId(committed.visibleGroupId, 0),
            receiptAction.getString("actionId"));
        assertEquals("MOMENT_ACTION", store.replyParts(localTurnId).get(0).type);
        assertEquals(null, committed.uiAppliedAt);
    }

    @Test
    public void oldEpochAndroidFallbackCommitsOnlyARedactedMetadataCheckpoint()
        throws Exception {
        String localTurnId = "local-v3-android-fallback-redacted";
        store.submitTurn(yuqiFallbackSubmission(
            localTurnId, "msg-android-fallback-redacted-3", 210L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 211L);
        ExecutionAttemptEntity attempt = store.activeAttempt(localTurnId);
        JSONObject open = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        ReplyPartEntity draft = textPart(
            localTurnId, attempt.attemptId, "这条已经晚于清除边界");
        store.markConversationCleared("yuqi", 0L, 1L, 212L);

        assertEquals(RoomExecutionStore.DeliveryDisposition.REDACTED,
            store.commitAndroidFallback(
                localTurnId, attempt.attemptId,
                Collections.singletonList(draft), "visible", 213L));

        ChatTurnEntity redacted = store.turn(localTurnId);
        JSONObject checkpoint = new JSONObject(
            store.activeAttempt(localTurnId).bridgeAuthorityCheckpointJson);
        JSONObject outcome = checkpoint.getJSONObject("outcome");
        assertEquals(TurnState.COMPLETED.name(), redacted.state);
        assertEquals(Long.valueOf(213L), redacted.deletedAt);
        assertEquals(null, redacted.visibleGroupId);
        assertEquals(null, redacted.bridgeCommitChecksum);
        assertEquals(0, store.replyParts(localTurnId).size());
        assertEquals(2, checkpoint.getInt("version"));
        assertEquals(0L, checkpoint.getLong("journalSyncSeq"));
        assertEquals("redacted", outcome.getString("type"));
        assertEquals("local", outcome.getString("route"));
        assertEquals(213L, outcome.getLong("redactedAt"));
        assertEquals("android-fallback-redacted-v1",
            outcome.getJSONObject("result").getString("contract"));
        assertEquals(null, BridgeReceiptCheckpoint.extractLocalAuthorityReceipt(
            store.activeAttempt(localTurnId).bridgeAuthorityCheckpointJson,
            store.activeAttempt(localTurnId).bridgeAuthorityCheckpointChecksum));
        ConversationAuthorityEntity authority = database.executionDao()
            .conversationAuthority(open.getString("authorityLineageKey"));
        assertEquals("CANCELLED", authority.state);
        assertEquals(null, authority.visibleGroupId);
        assertEquals(null, authority.commitChecksum);
    }

    @Test
    public void everyAndroidFallbackWriteBoundaryRollsBackJournalAuthorityPartsAndCursors()
        throws Exception {
        String visibleTurnId = "local-v3-android-fallback-visible-fault";
        store.submitTurn(yuqiFallbackSubmission(
            visibleTurnId, "msg-android-fallback-visible-fault-3", 214L));
        TurnSubmission visiblePrepared = store.prepareBridgeSubmission(
            persistedSubmission(visibleTurnId), "device_gateway", 215L);
        JSONObject visibleCheckpoint = new JSONObject(visiblePrepared.bridgeAuthorityCheckpointJson);
        String visibleAttemptId = store.activeAttempt(visibleTurnId).attemptId;
        ReplyPartEntity visibleDraft = textPart(
            visibleTurnId, visibleAttemptId, "这条用来验证本地事务回滚");
        long visibleChanges = rowCount("change_events");
        long visibleDiagnostics = rowCount("diagnostics");
        String[] visibleBoundaries = new String[]{
            RoomExecutionStore.FAULT_LOCAL_JOURNAL,
            RoomExecutionStore.FAULT_CHECKPOINT,
            RoomExecutionStore.FAULT_REPLY_PARTS,
            RoomExecutionStore.FAULT_AUTHORITY,
            RoomExecutionStore.FAULT_TURN,
            RoomExecutionStore.FAULT_ATTEMPT,
            RoomExecutionStore.FAULT_NATIVE_CURSOR,
            RoomExecutionStore.FAULT_CHANGE
        };
        for (String boundary : visibleBoundaries) {
            RoomExecutionStore faulted = new RoomExecutionStore(database, reached -> {
                if (boundary.equals(reached)) throw new IllegalStateException("fault:" + reached);
            });
            assertThrows(IllegalStateException.class, () -> faulted.commitAndroidFallback(
                visibleTurnId, visibleAttemptId, Collections.singletonList(visibleDraft),
                "visible", 216L));
            assertOpenCanonicalAttemptAfterRollback(
                visibleTurnId, visibleAttemptId, visibleCheckpoint,
                visibleChanges, visibleDiagnostics);
            assertNull(database.executionDao().syncCursor("__local_journal_sequence__"));
        }

        String skipTurnId = "local-v3-android-fallback-skip-fault";
        store.submitTurn(yuqiAutomaticFallbackSubmission(skipTurnId, 217L));
        TurnSubmission skipPrepared = store.prepareBridgeSubmission(
            persistedSubmission(skipTurnId), "device_gateway", 218L);
        JSONObject skipCheckpoint = new JSONObject(skipPrepared.bridgeAuthorityCheckpointJson);
        String skipAttemptId = store.activeAttempt(skipTurnId).attemptId;
        long skipChanges = rowCount("change_events");
        long skipDiagnostics = rowCount("diagnostics");
        String[] skipBoundaries = new String[]{
            RoomExecutionStore.FAULT_LOCAL_JOURNAL,
            RoomExecutionStore.FAULT_CHECKPOINT,
            RoomExecutionStore.FAULT_AUTHORITY,
            RoomExecutionStore.FAULT_TURN,
            RoomExecutionStore.FAULT_ATTEMPT,
            RoomExecutionStore.FAULT_NATIVE_CURSOR,
            RoomExecutionStore.FAULT_UI_CURSOR,
            RoomExecutionStore.FAULT_CHANGE
        };
        for (String boundary : skipBoundaries) {
            RoomExecutionStore faulted = new RoomExecutionStore(database, reached -> {
                if (boundary.equals(reached)) throw new IllegalStateException("fault:" + reached);
            });
            assertThrows(IllegalStateException.class, () -> faulted.commitAndroidFallback(
                skipTurnId, skipAttemptId, Collections.emptyList(), "skip", 219L));
            assertOpenCanonicalAttemptAfterRollback(
                skipTurnId, skipAttemptId, skipCheckpoint, skipChanges, skipDiagnostics);
            assertNull(database.executionDao().syncCursor("__local_journal_sequence__"));
        }

        String redactedTurnId = "local-v3-android-fallback-redacted-fault";
        store.submitTurn(yuqiFallbackSubmission(
            redactedTurnId, "msg-android-fallback-redacted-fault-3", 220L));
        TurnSubmission redactedPrepared = store.prepareBridgeSubmission(
            persistedSubmission(redactedTurnId), "device_gateway", 221L);
        JSONObject redactedCheckpoint = new JSONObject(redactedPrepared.bridgeAuthorityCheckpointJson);
        String redactedAttemptId = store.activeAttempt(redactedTurnId).attemptId;
        ReplyPartEntity redactedDraft = textPart(
            redactedTurnId, redactedAttemptId, "这条必须只留下红删元数据");
        store.markConversationCleared("yuqi", 0L, 1L, 222L);
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
            RoomExecutionStore faulted = new RoomExecutionStore(database, reached -> {
                if (boundary.equals(reached)) throw new IllegalStateException("fault:" + reached);
            });
            assertThrows(IllegalStateException.class, () -> faulted.commitAndroidFallback(
                redactedTurnId, redactedAttemptId,
                Collections.singletonList(redactedDraft), "visible", 223L));
            assertOpenCanonicalAttemptAfterRollback(
                redactedTurnId, redactedAttemptId, redactedCheckpoint,
                redactedChanges, redactedDiagnostics);
            assertNull(database.executionDao().syncCursor("__local_journal_sequence__"));
        }
    }

    @Test
    public void androidFallbackReceiptAndLaterMessageKeepGlobalOrderAcrossRestartAndAck()
        throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "android-fallback-journal-" + UUID.randomUUID() + ".db";
        AlExecutionDatabase durable = Room.databaseBuilder(context, AlExecutionDatabase.class, name)
            .allowMainThreadQueries()
            .build();
        try {
            RoomExecutionStore durableStore = new RoomExecutionStore(durable);
            String turnId = "local-v3-android-fallback-journal-restart";
            durableStore.submitTurn(yuqiAutomaticFallbackSubmission(turnId, 224L));
            durableStore.prepareBridgeSubmission(
                persistedSubmission(durableStore, turnId), "device_gateway", 225L);
            ExecutionAttemptEntity attempt = durableStore.activeAttempt(turnId);
            ReplyPartEntity draft = textPart(turnId, attempt.attemptId, "先记住这条本地结果");
            assertEquals(RoomExecutionStore.DeliveryDisposition.APPLY,
                durableStore.commitAndroidFallback(
                    turnId, attempt.attemptId, Collections.singletonList(draft),
                    "visible", 226L));
            JSONObject checkpoint = new JSONObject(
                durableStore.activeAttempt(turnId).bridgeAuthorityCheckpointJson);
            long receiptSequence = checkpoint.getLong("journalSyncSeq");

            long laterSequence = durable.executionDao().allocateJournalSyncSeq(227L);
            RawMessageEntity later = new RawMessageEntity();
            later.messageId = "msg-after-android-fallback-receipt";
            later.turnId = turnId;
            later.characterId = "yuqi";
            later.speakerId = "user";
            later.speakerType = "user";
            later.recipientId = "yuqi";
            later.content = "后来的普通消息";
            later.sentAt = 227L;
            later.origin = "phone";
            later.deviceId = "phone";
            later.deviceSeq = laterSequence;
            later.syncSeq = laterSequence;
            later.checksum = RoomExecutionStore.canonicalRawMessageChecksum(later);
            assertNotEquals(-1L, durable.executionDao().insertRawMessage(later));

            JSONObject beforeRestart = new FallbackJournal(
                durable.executionDao(), "phone").pendingPacket(10);
            assertEquals(2, beforeRestart.getJSONArray("entries").length());
            assertEquals(receiptSequence,
                beforeRestart.getJSONArray("entries").getJSONObject(0).getLong("seq"));
            assertEquals("authority_receipt",
                beforeRestart.getJSONArray("entries").getJSONObject(0).getString("entityType"));
            assertEquals(laterSequence,
                beforeRestart.getJSONArray("entries").getJSONObject(1).getLong("seq"));

            durable.close();
            durable = Room.databaseBuilder(context, AlExecutionDatabase.class, name)
                .allowMainThreadQueries()
                .build();
            FallbackJournal restarted = new FallbackJournal(durable.executionDao(), "phone");
            JSONObject replay = restarted.pendingPacket(10);
            assertEquals(BridgeAuthority.canonicalJson(beforeRestart),
                BridgeAuthority.canonicalJson(replay));

            restarted.acknowledge(receiptSequence);
            JSONObject afterReceiptAck = restarted.pendingPacket(10);
            assertEquals(1, afterReceiptAck.getJSONArray("entries").length());
            assertEquals(laterSequence,
                afterReceiptAck.getJSONArray("entries").getJSONObject(0).getLong("seq"));
            restarted.acknowledge(laterSequence);

            durable.close();
            durable = Room.databaseBuilder(context, AlExecutionDatabase.class, name)
                .allowMainThreadQueries()
                .build();
            assertEquals(0, new FallbackJournal(
                durable.executionDao(), "phone").pendingPacket(10)
                .getJSONArray("entries").length());
        } finally {
            if (durable.isOpen()) durable.close();
            context.deleteDatabase(name);
        }
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
    public void v3RetryRecoveryDoesNotSkipAnOlderFailedDirectTurnAfterANewerInput()
        throws Exception {
        String failedTurnId = "local-v3-recover-older";
        store.submitTurn(yuqiThreeBubbleSubmission(
            failedTurnId, "msg-recover-older-3", 300L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(failedTurnId), "device_gateway", 301L);
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        BridgeResult failure = BridgeTurnStatus.parseV3(
            canonicalFailure(checkpoint, true, 302L).toString(), "cloud", "relay-recover-older");
        ExecutionAttemptEntity failedAttempt = store.activeAttempt(failedTurnId);
        store.commitVerifiedRemoteFailure(
            failedTurnId, failedAttempt.attemptId, failure, 303L);

        String newerTurnId = "local-v3-recover-newer";
        store.submitTurn(yuqiThreeBubbleSubmission(
            newerTurnId, "msg-recover-newer-3", 400L));

        RetryRecoveryResult recovery = store.recoverDueRetries(20_000L);

        assertEquals(1, recovery.restarted);
        assertEquals(TurnState.QUEUED.name(), store.turn(failedTurnId).state);
        assertEquals(2, store.activeAttempt(failedTurnId).sequence);
        assertEquals(TurnState.QUEUED.name(), store.turn(newerTurnId).state);
    }

    @Test
    public void peerAwareVerifiedFailureRejectsForeignPeerBeforeAnyWrite() throws Exception {
        String localTurnId = "local-v3-peer-failure";
        store.submitTurn(yuqiThreeBubbleSubmission(localTurnId, "msg-peer-failure-3", 306L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 307L);
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        BridgeResult result = BridgeTurnStatus.parseV3(
            canonicalFailure(checkpoint, false, 308L).toString(), "lan", null);
        ExecutionAttemptEntity attempt = store.activeAttempt(localTurnId);
        ChatTurnEntity beforeTurn = store.turn(localTurnId);
        long beforeChanges = rowCount("change_events");
        long beforeDiagnostics = rowCount("diagnostics");
        assertThrows(IllegalStateException.class, () -> store.commitVerifiedRemoteFailureWithPeer(
            localTurnId, attempt.attemptId, result, "foreign-peer", 309L));
        ChatTurnEntity afterReject = store.turn(localTurnId);
        assertEquals(beforeTurn.state, afterReject.state);
        assertEquals(0, store.replyParts(localTurnId).size());
        assertEquals(beforeChanges, rowCount("change_events"));
        assertEquals(beforeDiagnostics, rowCount("diagnostics"));
        store.commitVerifiedRemoteFailureWithPeer(
            localTurnId, attempt.attemptId, result, "device_gateway", 310L);
        assertEquals(TurnState.FAILED_FINAL.name(), store.turn(localTurnId).state);
    }

    @Test
    public void peerAwareVerifiedFailureClearTombstoneIsRedactedAndForeignPeerIsRejected()
        throws Exception {
        String localTurnId = "local-v3-clear-failure-peer";
        store.submitTurn(yuqiThreeBubbleSubmission(localTurnId, "msg-clear-failure-peer", 312L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", 313L);
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        BridgeResult result = BridgeTurnStatus.parseV3(
            canonicalFailure(checkpoint, false, 314L).toString(), "lan", null);
        ExecutionAttemptEntity attempt = store.activeAttempt(localTurnId);
        ConversationCursorEntity cursor = store.getConversationCursor("yuqi");
        LifecycleControl clear = store.createConversationClear(
            "yuqi", RoomExecutionStore.conversationCursorChecksum("yuqi", cursor));
        assertNotNull(clear);
        ChatTurnEntity redacted = store.turn(localTurnId);
        long beforeChanges = rowCount("change_events");
        long beforeDiagnostics = rowCount("diagnostics");
        store.commitVerifiedRemoteFailureWithPeer(
            localTurnId, attempt.attemptId, result, "device_gateway", 315L);
        assertEquals(beforeChanges, rowCount("change_events"));
        assertEquals(beforeDiagnostics, rowCount("diagnostics"));
        assertEquals(TurnState.COMPLETED.name(), store.turn(localTurnId).state);
        assertEquals(redacted.deletedAt, store.turn(localTurnId).deletedAt);
        assertEquals(0, store.replyParts(localTurnId).size());
        assertThrows(IllegalStateException.class, () -> store.commitVerifiedRemoteFailureWithPeer(
            localTurnId, attempt.attemptId, result, "foreign-peer", 316L));
        assertEquals(beforeChanges, rowCount("change_events"));
        assertEquals(beforeDiagnostics, rowCount("diagnostics"));
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
    public void readAuthorityUsesActiveCurrentCheckpointAndSeparatesLocalAndRemoteTurnIds()
        throws Exception {
        CanonicalFixture fixture = commitCanonicalFixture(
            "c3b-r1-current", "visible", 240L);
        ExecutionAttemptEntity active = store.activeAttempt(fixture.localTurnId);
        BridgeReceiptDeliveryCoordinator.AuthoritySnapshot snapshot =
            store.readAuthority(fixture.localTurnId);

        assertNotNull(snapshot);
        assertEquals(fixture.localTurnId, snapshot.localTurnId);
        assertEquals(active.bridgeAuthorityCheckpointJson, snapshot.checkpointJson);
        assertEquals(active.bridgeAuthorityCheckpointChecksum, snapshot.checkpointChecksum);
        JSONObject checkpoint = new JSONObject(snapshot.checkpointJson);
        assertEquals(
            fixture.result.authoritativeTurnId,
            checkpoint.getString("authoritativeTurnId"));
        assertNotEquals(fixture.localTurnId, fixture.result.authoritativeTurnId);
        assertEquals(null, snapshot.uiAppliedAt);
        assertTrue(!snapshot.redacted);
    }

    @Test
    public void readAuthorityRejectsForeignAttemptAndOneSidedOrDamagedCheckpoint() throws Exception {
        CanonicalFixture fixture = commitCanonicalFixture(
            "c3b-r1-corrupt", "visible", 250L);
        String originalAttemptId = store.turn(fixture.localTurnId).activeAttemptId;
        store.submitTurn(yuqiThreeBubbleSubmission("c3b-r1-foreign", "msg-c3b-r1-foreign", 251L));
        String foreignAttemptId = store.activeAttempt("c3b-r1-foreign").attemptId;

        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET activeAttemptId=? WHERE turnId=?",
            new Object[]{foreignAttemptId, fixture.localTurnId});
        assertThrows(IllegalStateException.class,
            () -> store.readAuthority(fixture.localTurnId));

        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET activeAttemptId=? WHERE turnId=?",
            new Object[]{originalAttemptId, fixture.localTurnId});
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE execution_attempts SET bridgeAuthorityCheckpointChecksum=NULL WHERE attemptId=?",
            new Object[]{originalAttemptId});
        assertThrows(IllegalStateException.class,
            () -> store.readAuthority(fixture.localTurnId));

        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE execution_attempts SET bridgeAuthorityCheckpointChecksum=? WHERE attemptId=?",
            new Object[]{fixture.checkpointChecksum, originalAttemptId});
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE execution_attempts SET bridgeAuthorityCheckpointChecksum=? WHERE attemptId=?",
            new Object[]{"corrupt-checksum", originalAttemptId});
        assertThrows(IllegalStateException.class,
            () -> store.readAuthority(fixture.localTurnId));
    }

    @Test
    public void readAuthorityIgnoresForgedMemoryResultWhenCheckpointIsValid() throws Exception {
        CanonicalFixture fixture = commitCanonicalFixture(
            "c3b-r1-memory", "visible", 260L);
        String checkpointJson = store.activeAttempt(fixture.localTurnId).bridgeAuthorityCheckpointJson;
        JSONObject forgedMemory = new JSONObject(checkpointJson);
        forgedMemory.getJSONObject("outcome").getJSONObject("result")
            .put("turnId", "forged");
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE execution_attempts SET memoryResult=? WHERE attemptId=?",
            new Object[]{forgedMemory.toString(), store.turn(fixture.localTurnId).activeAttemptId});

        BridgeReceiptDeliveryCoordinator.AuthoritySnapshot snapshot =
            store.readAuthority(fixture.localTurnId);

        assertEquals(checkpointJson, snapshot.checkpointJson);
        assertEquals(
            fixture.checkpointChecksum,
            snapshot.checkpointChecksum);
    }

    @Test
    public void readAuthorityRejectsPersistedTurnPinsThatDisagreeWithTheActiveCheckpoint()
        throws Exception {
        String[] columns = {
            "authorityLineageKey", "visibleGroupId", "bridgeCommitChecksum", "terminalDisposition"
        };
        String[] values = {
            "lineage_forged", AuthorityIdentity.groupId("lineage_forged"), repeat('b', 64), "skip"
        };
        for (int index = 0; index < columns.length; index += 1) {
            CanonicalFixture fixture = commitCanonicalFixture(
                "c3b-r1-turn-pin-" + index, "visible", 265L + index);
            database.getOpenHelper().getWritableDatabase().execSQL(
                "UPDATE chat_turns SET " + columns[index] + "=? WHERE turnId=?",
                new Object[]{values[index], fixture.localTurnId});

            assertThrows(IllegalStateException.class,
                () -> store.readAuthority(fixture.localTurnId));
        }
    }

    @Test
    public void confirmCloudReceiptExactCommitsAndReplaysAfterRoomStoreRestart() throws Exception {
        CanonicalFixture fixture = commitCanonicalFixture(
            "c3b-r2-exact", "skip", 270L);
        BridgeReceiptDeliveryCoordinator.AuthorityReceipt receipt =
            captureReceiptWithoutPersisting(store, fixture.localTurnId);

        assertEquals(
            BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFIRMED,
            store.confirmCloudReceiptExact(receipt, 999L));
        Long confirmedAt = store.turn(fixture.localTurnId).cloudConfirmedAt;
        assertEquals(Long.valueOf(999L), confirmedAt);

        RoomExecutionStore restarted = new RoomExecutionStore(database);
        assertEquals(
            BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFIRMED,
            restarted.confirmCloudReceiptExact(receipt, 1200L));
        assertEquals(confirmedAt, restarted.turn(fixture.localTurnId).cloudConfirmedAt);
    }

    @Test
    public void changedAuthorityProofsReturnConflictWithoutStoreWrites() throws Exception {
        CanonicalFixture fixture = commitCanonicalFixture(
            "c3b-r2-conflicts", "skip", 280L);
        BridgeReceiptDeliveryCoordinator.AuthoritySnapshot canonical =
            store.readAuthority(fixture.localTurnId);
        long beforeChanges = rowCount("change_events");
        long beforeDiagnostics = rowCount("diagnostics");

        List<AuthoritySnapshotMutation> mutations = new ArrayList<>();
        mutations.add(base -> mutateCheckpoint(base, payload ->
            payload.put("turnId", "remote-changed")));
        mutations.add(base -> mutateCheckpoint(base, payload -> {
            payload.put("authorityLineageKey", "lineage-changed");
            payload.put("visibleGroupId", AuthorityIdentity.groupId("lineage-changed"));
        }));
        mutations.add(base -> mutateCheckpoint(base, payload ->
            payload.put("visibleGroupId", AuthorityIdentity.groupId("forged-group"))));
        mutations.add(base -> mutateCheckpoint(base, payload ->
            payload.put("commitChecksum", repeat('b', 64))));
        mutations.add(base -> mutateCheckpoint(base, payload ->
            payload.put("terminalDisposition", "action_only")));
        mutations.add(base -> {
            JSONObject checkpoint = new JSONObject(base.checkpointJson);
            checkpoint.getJSONObject("outcome").put("route", "cloud")
                .put("relayMessageId", "relay-changed");
            return snapshotWithCheckpoint(base, checkpoint, "cloud", "relay-changed");
        });
        mutations.add(base -> new BridgeReceiptDeliveryCoordinator.AuthoritySnapshot(
            base.localTurnId, base.checkpointJson, base.checkpointChecksum,
            base.uiAppliedAt + 1L, base.redacted, false,
            base.peerId, base.route, base.relayMessageId));
        mutations.add(base -> new BridgeReceiptDeliveryCoordinator.AuthoritySnapshot(
            base.localTurnId, base.checkpointJson, base.checkpointChecksum,
            base.uiAppliedAt, base.redacted, false,
            "foreign-peer", base.route, base.relayMessageId));
        mutations.add(base -> new BridgeReceiptDeliveryCoordinator.AuthoritySnapshot(
            base.localTurnId, base.checkpointJson, "corrupt-checksum",
            base.uiAppliedAt, base.redacted, false,
            base.peerId, base.route, base.relayMessageId));

        int index = 0;
        for (AuthoritySnapshotMutation mutation : mutations) {
            BridgeReceiptDeliveryCoordinator.Store adversarial =
                new PresentedSnapshotStore(store, mutation.apply(canonical));
            try {
                new BridgeReceiptDeliveryCoordinator(adversarial, receipt -> {})
                    .deliver(fixture.localTurnId);
                throw new AssertionError("changed authority proof must conflict at case " + index);
            } catch (IllegalArgumentException expected) {
                assertTrue(expected.getMessage().contains("authority")
                    || expected.getMessage().contains("receipt")
                    || expected.getMessage().contains("checksum"));
            }
            assertEquals(beforeChanges, rowCount("change_events"));
            assertEquals(beforeDiagnostics, rowCount("diagnostics"));
            assertEquals(null, store.turn(fixture.localTurnId).cloudConfirmedAt);
            index += 1;
        }
    }

    @Test
    public void twoRoomStoreHandlesConcurrentExactConfirmationAndOnlyOneLocalPushRemains()
        throws Exception {
        CanonicalFixture fixture = commitCanonicalFixture(
            "c3b-r2-concurrent", "skip", 290L);
        RoomExecutionStore first = new RoomExecutionStore(database);
        RoomExecutionStore second = new RoomExecutionStore(database);
        BridgeReceiptDeliveryCoordinator.AuthorityReceipt receipt =
            captureReceiptWithoutPersisting(first, fixture.localTurnId);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<BridgeReceiptDeliveryCoordinator.ConfirmationResult> one = pool.submit(
                () -> first.confirmCloudReceiptExact(receipt, 1300L));
            Future<BridgeReceiptDeliveryCoordinator.ConfirmationResult> two = pool.submit(
                () -> second.confirmCloudReceiptExact(receipt, 1400L));
            assertEquals(
                BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFIRMED,
                one.get());
            assertEquals(
                BridgeReceiptDeliveryCoordinator.ConfirmationResult.CONFIRMED,
                two.get());
        } finally {
            pool.shutdownNow();
        }
        Long confirmedAt = store.turn(fixture.localTurnId).cloudConfirmedAt;
        assertNotNull(confirmedAt);
        assertEquals(confirmedAt, first.turn(fixture.localTurnId).cloudConfirmedAt);
        assertEquals(confirmedAt, second.turn(fixture.localTurnId).cloudConfirmedAt);
    }

    @Test
    public void durableWakePrearmRunsInsideClearTransactionAndFailureRollsEverythingBack()
        throws Exception {
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        ConversationCursorEntity initial = new ConversationCursorEntity();
        String checksum = RoomExecutionStore.conversationCursorChecksum("yuqi", initial);

        assertThrows(IllegalStateException.class, () -> configured.createConversationClear(
            "yuqi", "device_gateway", checksum, 400L,
            () -> { throw new IllegalStateException("durable wake prearm failed"); }));
        assertEquals(0L, rowCount("lifecycle_controls"));
        assertNull(database.executionDao().conversationCursor("yuqi"));

        boolean[] sawPersistedControl = {false};
        LifecycleControl created = configured.createConversationClear(
            "yuqi", "device_gateway", checksum, 401L,
            () -> sawPersistedControl[0] = rowCount("lifecycle_controls") == 1L);
        assertTrue(sawPersistedControl[0]);
        assertNotNull(database.executionDao().lifecycleControl(created.controlId));

        ConversationCursorEntity after = database.executionDao().conversationCursor("yuqi");
        boolean[] replayPrearmed = {false};
        LifecycleControl replay = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum("yuqi", after), 402L,
            () -> replayPrearmed[0] = true);
        assertTrue(replayPrearmed[0]);
        assertEquals(created.controlId, replay.controlId);
        assertEquals(1L, rowCount("lifecycle_controls"));
    }

    @Test
    public void storeOwnedConversationClearCreatesOneControlAndRedactsCheckpointAtomically()
        throws Exception {
        CanonicalFixture fixture = commitCanonicalFixture("task20b-clear", "visible", 410L);
        ConversationCursorEntity before = database.executionDao().conversationCursor("yuqi");
        assertNotNull(before);
        String beforeChecksum = RoomExecutionStore.conversationCursorChecksum("yuqi", before);
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");

        LifecycleControl control = configured.createConversationClear(
            "yuqi", "device_gateway", beforeChecksum, 420L);

        assertEquals(LifecycleControl.CLEAR_KIND, control.controlKind);
        assertEquals("device_gateway", control.peerId);
        assertEquals(1L, control.clearEpoch.longValue());
        assertEquals(1L, database.executionDao().conversationCursor("yuqi").clearEpoch);
        ExecutionAttemptEntity redacted = database.executionDao().attempt(
            store.turn(fixture.localTurnId).activeAttemptId);
        assertNotNull(redacted);
        JSONObject tombstone = new JSONObject(redacted.bridgeAuthorityCheckpointJson);
        assertEquals(JSONObject.NULL, tombstone.get("normalizedEnvelope"));
        assertEquals("redacted", tombstone.getJSONObject("outcome").getString("type"));
        assertEquals(1L, database.executionDao().lifecycleControl(control.controlId).clearEpoch.longValue());

        ConversationCursorEntity after = database.executionDao().conversationCursor("yuqi");
        LifecycleControl replay = configured.createConversationClear(
            "yuqi", "device_gateway", RoomExecutionStore.conversationCursorChecksum("yuqi", after), 421L);
        assertEquals(control.controlId, replay.controlId);
        assertEquals(1L, rowCount("lifecycle_controls"));
        assertThrows(IllegalArgumentException.class, () -> configured.createConversationClear(
            "yuqi", "foreign-device", RoomExecutionStore.conversationCursorChecksum("yuqi", after), 422L));
    }

    @Test
    public void conversationClearFinalizesInFlightV3TurnAndCancelsOpenAuthorityAtomically()
        throws Exception {
        String turnId = "task20b-clear-inflight";
        store.submitTurn(yuqiThreeBubbleSubmission(turnId, "msg-task20b-clear-inflight", 430L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(turnId), "device_gateway", 431L);
        ExecutionAttemptEntity beforeAttempt = store.activeAttempt(turnId);
        ChatTurnEntity beforeTurn = store.turn(turnId);
        ConversationAuthorityEntity beforeAuthority = database.executionDao().conversationAuthority(
            beforeTurn.authorityLineageKey);
        assertEquals(TurnState.MEMORY_RUNNING.name(), beforeTurn.state);
        assertEquals(AttemptStage.MEMORY.name(), beforeAttempt.stage);
        assertEquals(TurnState.MEMORY_RUNNING.name(), beforeAttempt.state);
        assertNotNull(beforeAuthority);
        assertEquals("OPEN", beforeAuthority.state);
        assertNotNull(prepared.bridgeAuthorityCheckpointJson);

        ConversationCursorEntity cursor = database.executionDao().conversationCursor("yuqi");
        String inputChecksum = RoomExecutionStore.conversationCursorChecksum("yuqi", cursor);
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        LifecycleControl control = configured.createConversationClear(
            "yuqi", "device_gateway", inputChecksum, 440L);

        ChatTurnEntity clearedTurn = configured.turn(turnId);
        ExecutionAttemptEntity clearedAttempt = configured.activeAttempt(turnId);
        ConversationAuthorityEntity cancelled = database.executionDao().conversationAuthority(
            beforeTurn.authorityLineageKey);
        assertEquals(LifecycleControl.CLEAR_KIND, control.controlKind);
        assertEquals(TurnState.COMPLETED.name(), clearedTurn.state);
        assertNotNull(clearedTurn.completedAt);
        assertNotNull(clearedTurn.deletedAt);
        assertEquals(TurnState.COMPLETED.name(), clearedAttempt.state);
        assertEquals(AttemptStage.FINISHED.name(), clearedAttempt.stage);
        assertNotNull(clearedAttempt.finishedAt);
        assertEquals(false, clearedAttempt.retryable);
        assertEquals("CANCELLED", cancelled.state);
        assertEquals(beforeAuthority.revision + 1L, cancelled.revision);
        assertNull(cancelled.visibleGroupId);
        assertNull(cancelled.commitChecksum);
        assertEquals(0, configured.replyParts(turnId).size());
    }

    @Test
    public void conversationClearFaultsAtEachLifecycleBoundaryRollbackEveryAffectedRow()
        throws Exception {
        String turnId = "task20b-clear-faults";
        store.submitTurn(yuqiThreeBubbleSubmission(turnId, "msg-task20b-clear-faults", 450L));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(turnId), "device_gateway", 451L);
        String attemptId = store.activeAttempt(turnId).attemptId;
        String lineage = store.turn(turnId).authorityLineageKey;
        String checkpointJson = store.activeAttempt(turnId).bridgeAuthorityCheckpointJson;
        String checkpointChecksum = store.activeAttempt(turnId).bridgeAuthorityCheckpointChecksum;
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi"));
        long rawBefore = rowCount("yuqi_raw_messages");
        long replyBefore = store.replyParts(turnId).size();
        DiagnosticEntity diagnostic = new DiagnosticEntity();
        diagnostic.turnId = turnId;
        diagnostic.attemptId = attemptId;
        diagnostic.code = "TURN_FAILED";
        diagnostic.detail = "secret model/network detail";
        diagnostic.createdAt = 455L;
        database.executionDao().insertDiagnostic(diagnostic);
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = turnId;
        change.type = "TURN_COMMITTED";
        change.payloadJson = "{\"visibleGroupId\":\"group-secret\",\"terminalDisposition\":\"visible\",\"route\":\"lan\",\"text\":\"secret\"}";
        change.createdAt = 456L;
        database.executionDao().insertChange(change);
        ChangeEventEntity staleRedacted = new ChangeEventEntity();
        staleRedacted.turnId = turnId;
        staleRedacted.type = "TURN_REDACTED";
        staleRedacted.payloadJson = "{\"visibleGroupId\":\"stale-secret\",\"route\":\"cloud\",\"text\":\"stale secret\"}";
        staleRedacted.createdAt = 457L;
        database.executionDao().insertChange(staleRedacted);
        String changePayloadBefore = staleRedacted.payloadJson;
        String[] boundaries = new String[]{
            "lifecycle_checkpoint", "lifecycle_semantics",
            "lifecycle_cursor", "lifecycle_control"
        };
        for (int index = 0; index < boundaries.length; index += 1) {
            String boundary = boundaries[index];
            final long requestedAt = 460L + index;
            RoomExecutionStore faulted = new RoomExecutionStore(database, reached -> {
                if (boundary.equals(reached)) throw new IllegalStateException("fault:" + reached);
            });
            assertThrows(IllegalStateException.class, () -> faulted.createConversationClear(
                "yuqi", "device_gateway", cursorChecksum, requestedAt));

            ChatTurnEntity afterTurn = store.turn(turnId);
            ExecutionAttemptEntity afterAttempt = database.executionDao().attempt(attemptId);
            ConversationAuthorityEntity afterAuthority = database.executionDao().conversationAuthority(lineage);
            assertEquals(TurnState.MEMORY_RUNNING.name(), afterTurn.state);
            assertEquals(AttemptStage.MEMORY.name(), afterAttempt.stage);
            assertEquals(TurnState.MEMORY_RUNNING.name(), afterAttempt.state);
            assertEquals(checkpointJson, afterAttempt.bridgeAuthorityCheckpointJson);
            assertEquals(checkpointChecksum, afterAttempt.bridgeAuthorityCheckpointChecksum);
            assertEquals("OPEN", afterAuthority.state);
            assertEquals(1L, afterAuthority.revision);
            assertEquals(rawBefore, rowCount("yuqi_raw_messages"));
            assertEquals(replyBefore, store.replyParts(turnId).size());
            assertEquals(1L, countForTurn("diagnostics", turnId));
            assertEquals(changePayloadBefore, changePayloadForTurn(turnId));
            assertEquals(0L, rowCount("lifecycle_controls"));
            assertEquals(cursorChecksum, RoomExecutionStore.conversationCursorChecksum(
                "yuqi", database.executionDao().conversationCursor("yuqi")));
            assertNotNull(prepared.bridgeAuthorityCheckpointJson);
        }
    }

    @Test
    public void conversationClearRejectsV3NullVisibilitySequenceButRetainsFutureSequence()
        throws Exception {
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        String nullTurnId = "task20b-clear-v3-null-sequence";
        store.submitTurn(yuqiThreeBubbleSubmission(nullTurnId, "msg-task20b-null", 580L));
        ConversationCursorEntity beforeNull = database.executionDao().conversationCursor("yuqi");
        ChatTurnEntity nullTurnBefore = store.turn(nullTurnId);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET inputVisibilitySequence=NULL WHERE turnId=?",
            new Object[]{nullTurnId});
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum("yuqi", beforeNull);
        long changes = rowCount("change_events");
        long diagnostics = rowCount("diagnostics");
        assertThrows(IllegalStateException.class, () -> configured.createConversationClear(
            "yuqi", "device_gateway", cursorChecksum, 581L));
        assertEquals(nullTurnBefore.state, store.turn(nullTurnId).state);
        assertNull(store.turn(nullTurnId).inputVisibilitySequence);
        assertEquals(cursorChecksum, RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi")));
        assertEquals(changes, rowCount("change_events"));
        assertEquals(diagnostics, rowCount("diagnostics"));

        for (long invalid : new long[]{-1L, 9007199254740992L}) {
            database.getOpenHelper().getWritableDatabase().execSQL(
                "UPDATE chat_turns SET inputVisibilitySequence=? WHERE turnId=?",
                new Object[]{invalid, nullTurnId});
            assertThrows(IllegalStateException.class, () -> configured.createConversationClear(
                "yuqi", "device_gateway", cursorChecksum, 583L));
            assertEquals(Long.valueOf(invalid), store.turn(nullTurnId).inputVisibilitySequence);
            assertEquals(cursorChecksum, RoomExecutionStore.conversationCursorChecksum(
                "yuqi", database.executionDao().conversationCursor("yuqi")));
            assertEquals(changes, rowCount("change_events"));
            assertEquals(diagnostics, rowCount("diagnostics"));
        }

        // Restore the malformed row to a valid sequence before exercising the
        // independent future-boundary retention case.
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET inputVisibilitySequence=? WHERE turnId=?",
            new Object[]{beforeNull.localSequence, nullTurnId});

        String futureTurnId = "task20b-clear-v3-future-sequence";
        store.submitTurn(yuqiThreeBubbleSubmission(futureTurnId, "msg-task20b-future", 590L));
        ConversationCursorEntity beforeFuture = database.executionDao().conversationCursor("yuqi");
        ChatTurnEntity futureBefore = store.turn(futureTurnId);
        long boundary = beforeFuture.localSequence;
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE chat_turns SET inputVisibilitySequence=? WHERE turnId=?",
            new Object[]{boundary + 100L, futureTurnId});
        ConversationCursorEntity clearCursor = database.executionDao().conversationCursor("yuqi");
        LifecycleControl control = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum("yuqi", clearCursor), 591L);
        assertNotNull(control);
        ChatTurnEntity futureAfter = store.turn(futureTurnId);
        assertEquals(futureBefore.state, futureAfter.state);
        assertEquals(Long.valueOf(boundary + 100L), futureAfter.inputVisibilitySequence);
    }

    @Test
    public void conversationClearRejectsCheckpointPeerMismatchWithoutAnyWrites()
        throws Exception {
        String turnId = "task20b-clear-peer-mismatch";
        store.submitTurn(yuqiThreeBubbleSubmission(turnId, "msg-task20b-peer-mismatch", 595L));
        store.prepareBridgeSubmission(persistedSubmission(turnId), "device_A", 596L);
        ChatTurnEntity beforeTurn = store.turn(turnId);
        ExecutionAttemptEntity beforeAttempt = store.activeAttempt(turnId);
        ConversationAuthorityEntity beforeAuthority = database.executionDao()
            .conversationAuthority(beforeTurn.authorityLineageKey);
        ConversationCursorEntity beforeCursor = database.executionDao().conversationCursor("yuqi");
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum("yuqi", beforeCursor);
        long changes = rowCount("change_events");
        long diagnostics = rowCount("diagnostics");
        RoomExecutionStore deviceB = new RoomExecutionStore(database, "device_B");

        assertThrows(IllegalStateException.class, () -> deviceB.createConversationClear(
            "yuqi", "device_B", cursorChecksum, 597L));

        ChatTurnEntity afterTurn = store.turn(turnId);
        ExecutionAttemptEntity afterAttempt = store.activeAttempt(turnId);
        ConversationAuthorityEntity afterAuthority = database.executionDao()
            .conversationAuthority(beforeTurn.authorityLineageKey);
        assertEquals(beforeTurn.state, afterTurn.state);
        assertEquals(beforeTurn.updatedAt, afterTurn.updatedAt);
        assertEquals(beforeAttempt.bridgeAuthorityCheckpointJson,
            afterAttempt.bridgeAuthorityCheckpointJson);
        assertEquals(beforeAttempt.bridgeAuthorityCheckpointChecksum,
            afterAttempt.bridgeAuthorityCheckpointChecksum);
        assertEquals(beforeAuthority.state, afterAuthority.state);
        assertEquals(beforeAuthority.revision, afterAuthority.revision);
        assertEquals(cursorChecksum, RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi")));
        assertEquals(0L, rowCount("lifecycle_controls"));
        assertEquals(changes, rowCount("change_events"));
        assertEquals(diagnostics, rowCount("diagnostics"));
    }

    @Test
    public void conversationClearRedactsDiagnosticsAndChangeEventsWithoutDuplicateSemanticEvents()
        throws Exception {
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        CanonicalFixture fixture = commitCanonicalFixture(
            "task20b-clear-redact-events", "visible", 600L);
        DiagnosticEntity diagnostic = new DiagnosticEntity();
        diagnostic.turnId = fixture.localTurnId;
        diagnostic.code = "TURN_FAILED";
        diagnostic.detail = "secret error detail";
        diagnostic.createdAt = 603L;
        database.executionDao().insertDiagnostic(diagnostic);
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = fixture.localTurnId;
        change.type = "TURN_COMMITTED";
        change.payloadJson = "{\"visibleGroupId\":\"secret-group\",\"terminalDisposition\":\"visible\",\"route\":\"cloud\",\"text\":\"secret text\"}";
        change.createdAt = 604L;
        database.executionDao().insertChange(change);
        ChangeEventEntity staleRedacted = new ChangeEventEntity();
        staleRedacted.turnId = fixture.localTurnId;
        staleRedacted.type = "TURN_REDACTED";
        staleRedacted.payloadJson = "{\"visibleGroupId\":\"stale-group\",\"route\":\"lan\",\"text\":\"stale secret\"}";
        staleRedacted.createdAt = 605L;
        database.executionDao().insertChange(staleRedacted);
        long changeCountBefore = countForTurn("change_events", fixture.localTurnId);
        ConversationCursorEntity cursor = database.executionDao().conversationCursor("yuqi");
        LifecycleControl control = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum("yuqi", cursor), 605L);
        assertNotNull(control);
        assertEquals(0L, countForTurn("diagnostics", fixture.localTurnId));
        String redactedPayload = changePayloadForTurn(fixture.localTurnId);
        assertEquals("TURN_REDACTED", changeTypeForTurn(fixture.localTurnId));
        assertTrue(redactedPayload.contains("conversation-clear-v1"));
        assertTrue(!redactedPayload.contains("visibleGroupId"));
        assertTrue(!redactedPayload.contains("terminalDisposition"));
        assertTrue(!redactedPayload.contains("route"));
        assertTrue(!redactedPayload.contains("secret"));
        RoomExecutionStore reopened = new RoomExecutionStore(database, "device_gateway");
        assertNotNull(reopened.turn(fixture.localTurnId));
        assertEquals("TURN_REDACTED", changeTypeForTurn(fixture.localTurnId));
        assertEquals(changeCountBefore, countForTurn("change_events", fixture.localTurnId));
        for (String payload : changePayloadsForTurn(fixture.localTurnId)) {
            assertEquals(redactedPayload, payload);
        }
    }

    @Test
    public void conversationClearFinalizesBridgeWaitingAndRetryableChildInFlight() throws Exception {
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");

        String waitingTurnId = "task20b-clear-waiting";
        store.submitTurn(yuqiThreeBubbleSubmission(
            waitingTurnId, "msg-task20b-clear-waiting", 470L));
        TurnSubmission waitingPrepared = store.prepareBridgeSubmission(
            persistedSubmission(waitingTurnId), "device_gateway", 471L);
        ExecutionAttemptEntity waitingAttempt = store.activeAttempt(waitingTurnId);
        store.markBridgeWaiting(waitingTurnId, waitingAttempt.attemptId, "cloud", 472L);
        ConversationCursorEntity waitingCursor = database.executionDao().conversationCursor("yuqi");
        LifecycleControl waitingControl = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum("yuqi", waitingCursor), 473L);
        assertEquals(TurnState.COMPLETED.name(), configured.turn(waitingTurnId).state);
        assertEquals(AttemptStage.FINISHED.name(), configured.activeAttempt(waitingTurnId).stage);
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE lifecycle_controls SET state='APPLIED', appliedAt=?, updatedAt=? WHERE controlId=?",
            new Object[]{473L, 473L, waitingControl.controlId});

        String retryTurnId = "task20b-clear-retry-child";
        store.submitTurn(yuqiThreeBubbleSubmission(
            retryTurnId, "msg-task20b-clear-retry-child", 480L));
        TurnSubmission parent = store.prepareBridgeSubmission(
            persistedSubmission(retryTurnId), "device_gateway", 481L);
        ExecutionAttemptEntity parentAttempt = store.activeAttempt(retryTurnId);
        BridgeResult failure = BridgeTurnStatus.parseV3(
            canonicalFailure(new JSONObject(parent.bridgeAuthorityCheckpointJson), true, 482L).toString(),
            "cloud", "relay-task20b-child");
        store.commitVerifiedRemoteFailure(retryTurnId, parentAttempt.attemptId, failure, 483L);
        store.startRetry(retryTurnId, 484L);
        TurnSubmission child = store.prepareBridgeSubmission(
            persistedSubmission(retryTurnId), "device_gateway", 485L);
        ExecutionAttemptEntity childAttempt = store.activeAttempt(retryTurnId);
        assertNotEquals(parentAttempt.attemptId, childAttempt.attemptId);
        assertEquals(TurnState.MEMORY_RUNNING.name(), store.turn(retryTurnId).state);
        assertNotNull(child.bridgeAuthorityCheckpointJson);

        ConversationCursorEntity retryCursor = database.executionDao().conversationCursor("yuqi");
        LifecycleControl retryControl = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum("yuqi", retryCursor), 486L);
        assertEquals(LifecycleControl.CLEAR_KIND, retryControl.controlKind);
        assertEquals(TurnState.COMPLETED.name(), configured.turn(retryTurnId).state);
        for (ExecutionAttemptEntity attempt : database.executionDao().attempts(retryTurnId)) {
            assertEquals(TurnState.COMPLETED.name(), attempt.state);
            assertEquals(AttemptStage.FINISHED.name(), attempt.stage);
            assertEquals(false, attempt.retryable);
            assertNotNull(attempt.finishedAt);
        }
        ConversationAuthorityEntity authority = database.executionDao().conversationAuthority(
            configured.turn(retryTurnId).authorityLineageKey);
        assertEquals("CANCELLED", authority.state);
    }

    @Test
    public void sequentialConversationClearPreservesPriorTombstoneAndControlIdentity() throws Exception {
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        CanonicalFixture fixture = commitCanonicalFixture("task20b-clear-sequential", "visible", 490L);
        LifecycleControl first = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum(
                "yuqi", database.executionDao().conversationCursor("yuqi")), 500L);
        ExecutionAttemptEntity oldAttempt = database.executionDao().attempt(
            fixture.localTurnId);
        String oldTombstone = oldAttempt.bridgeAuthorityCheckpointJson;
        Long oldDeletedAt = configured.turn(fixture.localTurnId).deletedAt;
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE lifecycle_controls SET state='APPLIED', appliedAt=?, updatedAt=? WHERE controlId=?",
            new Object[]{500L, 500L, first.controlId});

        TurnSubmission laterLegacy = new TurnSubmission(
            "task20b-clear-later-legacy", "yuqi", "msg-task20b-clear-later-legacy",
            TurnKind.DIRECT_REPLY, "{}", "{}", null, 501L);
        store.submitTurn(laterLegacy);
        LifecycleControl second = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum(
                "yuqi", database.executionDao().conversationCursor("yuqi")), 510L);

        assertNotEquals(first.controlId, second.controlId);
        assertEquals(oldTombstone,
            database.executionDao().attempt(configured.turn(fixture.localTurnId).activeAttemptId)
                .bridgeAuthorityCheckpointJson);
        assertEquals(oldDeletedAt, configured.turn(fixture.localTurnId).deletedAt);
        assertEquals(2L, rowCount("lifecycle_controls"));
        assertEquals(2L, configured.getConversationCursor("yuqi").clearEpoch);
    }

    @Test
    public void sequentialConversationClearRejectsDeletedControlOrReopenedAuthorityWithoutWrites()
        throws Exception {
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        CanonicalFixture fixture = commitCanonicalFixture("task20b-clear-corrupt", "visible", 520L);
        LifecycleControl first = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum(
                "yuqi", database.executionDao().conversationCursor("yuqi")), 530L);
        String oldTombstone = database.executionDao().attempt(
            configured.turn(fixture.localTurnId).activeAttemptId).bridgeAuthorityCheckpointJson;
        String beforeCursor = RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi"));
        database.getOpenHelper().getWritableDatabase().execSQL(
            "DELETE FROM lifecycle_controls WHERE controlId=?", new Object[]{first.controlId});
        assertThrows(IllegalStateException.class, () -> configured.createConversationClear(
            "yuqi", "device_gateway", beforeCursor, 540L));
        assertEquals(beforeCursor, RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi")));
        assertEquals(oldTombstone, database.executionDao().attempt(
            configured.turn(fixture.localTurnId).activeAttemptId).bridgeAuthorityCheckpointJson);
        assertEquals(0L, rowCount("lifecycle_controls"));
    }

    @Test
    public void lifecycleStoreRecomputesRelayIdentityFromPersistedSemanticBeforeAccepting()
        throws Exception {
        CanonicalFixture fixture = commitCanonicalFixture("task20c-relay-identity", "visible", 430L);
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        ConversationCursorEntity cursor = database.executionDao().conversationCursor("yuqi");
        LifecycleControl control = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum("yuqi", cursor), 440L);
        LifecycleControl claimed = configured.claimLifecycleControl(450L);
        assertNotNull(claimed);
        String expectedRelay = LifecycleControlSender.relayMessageId(claimed);
        String foreignRelay = expectedRelay.substring(0, expectedRelay.length() - 1) + "0";
        assertNotEquals(expectedRelay, foreignRelay);

        assertTrue(!configured.acceptLifecycleRelay(
            claimed.controlId, claimed.semanticChecksum, claimed.leaseId,
            claimed.leaseAttempt, claimed.leasedAt,
            foreignRelay, 1_000L, 451L));
        LifecycleControl after = configured.lifecycleControl(control.controlId);
        assertEquals(LifecycleControl.PENDING, after.state);
        assertNull(after.relayMessageId);
        assertNull(after.relayExpiresAt);
    }

    @Test
    public void changedAppliedAtIsHandledOnceWithoutDowngradingApplied() throws Exception {
        CanonicalFixture fixture = commitCanonicalFixture("task20c-applied-conflict", "visible", 460L);
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        ConversationCursorEntity cursor = database.executionDao().conversationCursor("yuqi");
        LifecycleControl control = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum("yuqi", cursor), 470L);
        LifecycleControl claimed = configured.claimLifecycleControl(480L);
        String relay = LifecycleControlSender.relayMessageId(claimed);
        assertTrue(configured.acceptLifecycleRelay(
            claimed.controlId, claimed.semanticChecksum, claimed.leaseId,
            claimed.leaseAttempt, claimed.leasedAt, relay, 1_000L, 481L));
        assertTrue(configured.applyLifecycleControl(
            claimed.controlId, claimed.semanticChecksum, claimed.clearEpoch,
            claimed.clearedThroughSequence, 500L, 501L));

        assertTrue(configured.applyLifecycleControl(
            claimed.controlId, claimed.semanticChecksum, claimed.clearEpoch,
            claimed.clearedThroughSequence, 501L, 502L, "inbound-applied-1"));
        LifecycleControl after = configured.lifecycleControl(claimed.controlId);
        assertEquals(LifecycleControl.APPLIED, after.state);
        assertEquals(Long.valueOf(500L), after.appliedAt);
        String detail = BridgeAuthority.canonicalJson(new JSONObject()
            .put("redacted", true)
            .put("reason", "applied_ack_conflict")
            .put("controlId", claimed.controlId)
            .put("inboundRelayMessageId", "inbound-applied-1")
            .put("controlChecksum", claimed.semanticChecksum));
        assertEquals(1L, database.executionDao().diagnosticCountByCodeAndDetail(
            "LIFECYCLE_CONTROL_QUARANTINED", detail));
        assertTrue(configured.applyLifecycleControl(
            claimed.controlId, claimed.semanticChecksum, claimed.clearEpoch,
            claimed.clearedThroughSequence, 501L, 503L, "inbound-applied-1"));
        assertEquals(1L, database.executionDao().diagnosticCountByCodeAndDetail(
            "LIFECYCLE_CONTROL_QUARANTINED", detail));
        assertTrue(configured.applyLifecycleControl(
            claimed.controlId, claimed.semanticChecksum,
            claimed.clearEpoch + 1L, claimed.clearedThroughSequence,
            500L, 504L, "inbound-applied-epoch"));
        String epochDetail = BridgeAuthority.canonicalJson(new JSONObject()
            .put("redacted", true)
            .put("reason", "applied_ack_conflict")
            .put("controlId", claimed.controlId)
            .put("inboundRelayMessageId", "inbound-applied-epoch")
            .put("controlChecksum", claimed.semanticChecksum));
        assertEquals(1L, database.executionDao().diagnosticCountByCodeAndDetail(
            "LIFECYCLE_CONTROL_QUARANTINED", epochDetail));
    }

    @Test
    public void changedAppliedAckChecksumIsHandledOnceWithoutDowngradingApplied()
        throws Exception {
        CanonicalFixture fixture = commitCanonicalFixture("task20c-applied-checksum", "visible", 490L);
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        ConversationCursorEntity cursor = database.executionDao().conversationCursor("yuqi");
        LifecycleControl control = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum("yuqi", cursor), 500L);
        LifecycleControl claimed = configured.claimLifecycleControl(510L);
        String relay = LifecycleControlSender.relayMessageId(claimed);
        assertTrue(configured.acceptLifecycleRelay(
            claimed.controlId, claimed.semanticChecksum, claimed.leaseId,
            claimed.leaseAttempt, claimed.leasedAt, relay, 1_000L, 511L));
        assertTrue(configured.applyLifecycleControl(
            claimed.controlId, claimed.semanticChecksum, claimed.clearEpoch,
            claimed.clearedThroughSequence, 520L, 521L));

        String changedChecksum = repeat('c', 64);
        assertTrue(configured.recordLifecycleAppliedAckConflict(
            claimed.controlId, claimed.semanticChecksum, changedChecksum,
            "inbound-applied-checksum", 522L));
        LifecycleControl after = configured.lifecycleControl(claimed.controlId);
        assertEquals(LifecycleControl.APPLIED, after.state);
        assertEquals(Long.valueOf(520L), after.appliedAt);
        String detail = BridgeAuthority.canonicalJson(new JSONObject()
            .put("redacted", true)
            .put("reason", "applied_ack_conflict")
            .put("controlId", claimed.controlId)
            .put("inboundRelayMessageId", "inbound-applied-checksum")
            .put("controlChecksum", changedChecksum));
        assertEquals(1L, database.executionDao().diagnosticCountByCodeAndDetail(
            "LIFECYCLE_CONTROL_QUARANTINED", detail));
        assertTrue(configured.recordLifecycleAppliedAckConflict(
            claimed.controlId, claimed.semanticChecksum, changedChecksum,
            "inbound-applied-checksum", 523L));
        assertEquals(1L, database.executionDao().diagnosticCountByCodeAndDetail(
            "LIFECYCLE_CONTROL_QUARANTINED", detail));
    }

    @Test
    public void changedAckOnRelayAcceptedQuarantinesAndHandlesInboundExactlyOnce()
        throws Exception {
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        LifecycleControl control = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum("yuqi", new ConversationCursorEntity()),
            600L);
        LifecycleControl claimed = configured.claimLifecycleControl(610L);
        String outboundRelay = LifecycleControlSender.relayMessageId(claimed);
        assertTrue(configured.acceptLifecycleRelay(
            claimed.controlId, claimed.semanticChecksum, claimed.leaseId,
            claimed.leaseAttempt, claimed.leasedAt, outboundRelay, 2_000L, 611L));

        RoomBridgeMirror mirror = new RoomBridgeMirror(
            database.executionDao(), configured, "device_gateway");
        Method factory = ExecutionRuntime.class.getDeclaredMethod(
            "cloudInboxConsumer", RoomBridgeMirror.class, RoomExecutionStore.class);
        factory.setAccessible(true);
        BridgeClient.CloudInboxConsumer consumer = (BridgeClient.CloudInboxConsumer) factory.invoke(
            null, mirror, configured);
        JSONObject changedType = LifecycleControlSender.encodeAppliedAck(control, 620L)
            .put("type", "WRONG_ACK_TYPE");
        String inboundRelay = "inbound-applied-conflict-1";
        assertTrue(consumer.applyLifecycleControl(
            changedType.toString(), inboundRelay, 2_100L, 621L));
        assertEquals(LifecycleControl.QUARANTINED,
            configured.lifecycleControl(control.controlId).state);
        String detail = BridgeAuthority.canonicalJson(new JSONObject()
            .put("redacted", true)
            .put("reason", "applied_ack_conflict")
            .put("controlId", control.controlId)
            .put("inboundRelayMessageId", inboundRelay)
            .put("controlChecksum", control.semanticChecksum));
        assertEquals(1L, database.executionDao().diagnosticCountByCodeAndDetail(
            "LIFECYCLE_CONTROL_QUARANTINED", detail));
        assertTrue(consumer.applyLifecycleControl(
            changedType.toString(), inboundRelay, 2_100L, 622L));
        assertEquals(1L, database.executionDao().diagnosticCountByCodeAndDetail(
            "LIFECYCLE_CONTROL_QUARANTINED", detail));
    }

    @Test
    public void twoFileBackedRoomConnectionsHaveSingleLeaseWinnerAndRejectLateOldLeaseAfterReopen()
        throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "task20c-dual-room-" + UUID.randomUUID() + ".db";
        AlExecutionDatabase firstDb = null;
        AlExecutionDatabase secondDb = null;
        AlExecutionDatabase reopenedDb = null;
        try {
            firstDb = Room.databaseBuilder(context, AlExecutionDatabase.class, name)
                .allowMainThreadQueries().build();
            secondDb = Room.databaseBuilder(context, AlExecutionDatabase.class, name)
                .allowMainThreadQueries().build();
            RoomExecutionStore first = new RoomExecutionStore(firstDb, "device_gateway");
            RoomExecutionStore second = new RoomExecutionStore(secondDb, "device_gateway");
            String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
                "yuqi", new ConversationCursorEntity());
            LifecycleControl created = first.createConversationClear(
                "yuqi", "device_gateway", cursorChecksum, 900L);
            LifecycleControl oldLease = first.claimLifecycleControl(1_000L);
            assertNotNull(oldLease);
            assertNull(second.claimLifecycleControl(1_000L));
            assertNull(second.claimLifecycleControl(60_999L));
            LifecycleControl replacement = second.claimLifecycleControl(61_000L);
            assertNotNull(replacement);
            assertEquals(oldLease.controlId, replacement.controlId);
            assertEquals(oldLease.leaseAttempt + 1L, replacement.leaseAttempt);
            assertNotEquals(oldLease.leaseId, replacement.leaseId);

            assertTrue(!second.acceptLifecycleRelay(
                oldLease.controlId, oldLease.semanticChecksum, oldLease.leaseId,
                oldLease.leaseAttempt, oldLease.leasedAt,
                LifecycleControlSender.relayMessageId(oldLease), 70_000L, 61_001L));
            assertTrue(!second.applyLifecycleControl(
                oldLease.controlId, oldLease.semanticChecksum, oldLease.clearEpoch,
                oldLease.clearedThroughSequence, oldLease.leaseId, oldLease.leaseAttempt,
                oldLease.leasedAt, 61_002L, 61_003L));
            assertTrue(!second.quarantineLifecycleControl(
                oldLease.controlId, oldLease.semanticChecksum, oldLease.leaseId,
                oldLease.leaseAttempt, oldLease.leasedAt, 61_004L));
            assertTrue(!second.quarantineLifecycleControl(
                oldLease.controlId, oldLease.semanticChecksum, 61_004L));

            firstDb.close();
            secondDb.close();
            reopenedDb = Room.databaseBuilder(context, AlExecutionDatabase.class, name)
                .allowMainThreadQueries().build();
            RoomExecutionStore reopened = new RoomExecutionStore(reopenedDb, "device_gateway");
            LifecycleControl afterRestart = reopened.lifecycleControl(created.controlId);
            assertEquals(LifecycleControl.PENDING, afterRestart.state);
            assertEquals(replacement.leaseId, afterRestart.leaseId);
            assertEquals(replacement.leaseAttempt, afterRestart.leaseAttempt);
            assertEquals(replacement.leasedAt, afterRestart.leasedAt);
            assertTrue(!reopened.applyLifecycleControl(
                oldLease.controlId, oldLease.semanticChecksum, oldLease.clearEpoch,
                oldLease.clearedThroughSequence, oldLease.leaseId, oldLease.leaseAttempt,
                oldLease.leasedAt, 61_005L, 61_006L));
            assertEquals(LifecycleControl.PENDING,
                reopened.lifecycleControl(created.controlId).state);

            String relay = LifecycleControlSender.relayMessageId(replacement);
            assertTrue(reopened.acceptLifecycleRelay(
                replacement.controlId, replacement.semanticChecksum, replacement.leaseId,
                replacement.leaseAttempt, replacement.leasedAt, relay, 70_000L, 61_010L));
            assertEquals(LifecycleControl.RELAY_ACCEPTED,
                reopened.lifecycleControl(created.controlId).state);
            assertTrue(reopened.applyLifecycleControl(
                replacement.controlId, replacement.semanticChecksum,
                replacement.clearEpoch, replacement.clearedThroughSequence,
                61_011L, 61_012L, "inbound-applied-dual-room"));
            reopenedDb.close();
            reopenedDb = Room.databaseBuilder(context, AlExecutionDatabase.class, name)
                .allowMainThreadQueries().build();
            RoomExecutionStore appliedAgain = new RoomExecutionStore(reopenedDb, "device_gateway");
            assertEquals(LifecycleControl.APPLIED,
                appliedAgain.lifecycleControl(created.controlId).state);
            assertEquals(Long.valueOf(61_011L),
                appliedAgain.lifecycleControl(created.controlId).appliedAt);
            assertTrue(appliedAgain.applyLifecycleControl(
                replacement.controlId, replacement.semanticChecksum,
                replacement.clearEpoch, replacement.clearedThroughSequence,
                61_011L, 61_013L, "inbound-applied-dual-room"));
        } finally {
            if (firstDb != null && firstDb.isOpen()) firstDb.close();
            if (secondDb != null && secondDb.isOpen()) secondDb.close();
            if (reopenedDb != null && reopenedDb.isOpen()) reopenedDb.close();
            context.deleteDatabase(name);
        }
    }

    @Test
    public void sequentialConversationClearRejectsReopenedAuthorityWithoutWrites() throws Exception {
        RoomExecutionStore configured = new RoomExecutionStore(database, "device_gateway");
        CanonicalFixture fixture = commitCanonicalFixture("task20b-clear-authority-open", "visible", 550L);
        LifecycleControl first = configured.createConversationClear(
            "yuqi", "device_gateway",
            RoomExecutionStore.conversationCursorChecksum(
                "yuqi", database.executionDao().conversationCursor("yuqi")), 560L);
        String beforeCursor = RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi"));
        String lineage = configured.turn(fixture.localTurnId).authorityLineageKey;
        String oldTombstone = database.executionDao().attempt(
            configured.turn(fixture.localTurnId).activeAttemptId).bridgeAuthorityCheckpointJson;
        database.getOpenHelper().getWritableDatabase().execSQL(
            "UPDATE conversation_authorities SET state='OPEN' WHERE authorityLineageKey=?",
            new Object[]{lineage});
        assertThrows(IllegalStateException.class, () -> configured.createConversationClear(
            "yuqi", "device_gateway", beforeCursor, 570L));
        assertEquals(beforeCursor, RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi")));
        assertEquals(oldTombstone, database.executionDao().attempt(
            configured.turn(fixture.localTurnId).activeAttemptId).bridgeAuthorityCheckpointJson);
        assertEquals("OPEN", database.executionDao().conversationAuthority(lineage).state);
        assertEquals(1L, rowCount("lifecycle_controls"));
        assertEquals(first.controlId,
            database.executionDao().lifecycleControls().get(0).controlId);
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

    private void insertRoleDeleteTombstone(String characterId, long requestedAt)
        throws Exception {
        JSONObject receipt = backupReceipt(characterId, requestedAt - 1L);
        LifecycleControlCodec.Encoded encoded = LifecycleControlCodec.encodeRoleDelete(
            characterId, "device_gateway", requestedAt, receipt);
        LifecycleControlEntity row = new LifecycleControlEntity();
        row.controlId = encoded.controlId;
        row.controlKind = LifecycleControl.ROLE_DELETE_KIND;
        row.characterId = characterId;
        row.peerId = "device_gateway";
        row.requestedAt = requestedAt;
        row.semanticJson = encoded.semantic.toString();
        row.semanticChecksum = encoded.semanticChecksum;
        row.state = LifecycleControl.WAITING;
        row.leaseAttempt = 0L;
        row.updatedAt = requestedAt;
        database.executionDao().insertLifecycleControl(row);
    }

    private TurnSubmission persistedSubmission(String turnId) {
        return persistedSubmission(store, turnId);
    }

    private static TurnSubmission persistedSubmission(RoomExecutionStore targetStore, String turnId) {
        ChatTurnEntity turn = targetStore.turn(turnId);
        if (TurnState.QUEUED.name().equals(turn.state)) {
            targetStore.markStage(
                turnId, turn.activeAttemptId, TurnState.MEMORY_RUNNING,
                AttemptStage.MEMORY, Math.max(1L, turn.updatedAt + 1L));
            turn = targetStore.turn(turnId);
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

    private static TurnSubmission yuqiFallbackSubmission(
        String turnId,
        String lastMessageId,
        long createdAt
    ) throws Exception {
        TurnSubmission base = yuqiThreeBubbleSubmission(
            turnId, lastMessageId, createdAt);
        JSONObject semantic = new JSONObject()
            .put("contract", "cognition-v3")
            .put("schemaVersion", 3)
            .put("roleId", "yuqi")
            .put("hardConstraints", new JSONArray())
            .put("preferences", new JSONArray())
            .put("currentStances", new JSONArray())
            .put("relationship", new JSONObject().put("base", "close"))
            .put("recentGroups", new JSONArray())
            .put("verifiedFacts", new JSONArray())
            .put("lifeSignals", new JSONArray())
            .put("authorSettings", new JSONObject())
            .put("fallbackExecution", new JSONObject()
                .put("contract", "cognition-v3-fallback-v1")
                .put("deviceId", "device_gateway")
                .put("cognition", new JSONObject()
                    .put("configId", "memory-v3")
                    .put("system", "private cognition prompt")
                    .put("messages", new JSONArray()))
                .put("expression", new JSONObject()
                    .put("configId", "chat-v3")
                    .put("system", "private expression prompt")
                    .put("messages", new JSONArray())));
        return new TurnSubmission(
            base.turnId,
            base.characterId,
            base.sourceMessageId,
            base.kind,
            base.inputJson,
            semantic.toString(),
            base.cloudJobId,
            base.createdAt
        );
    }

    private static TurnSubmission yuqiAutomaticFallbackSubmission(String turnId, long createdAt)
        throws Exception {
        JSONObject snapshot = new JSONObject()
            .put("contract", "cognition-v3")
            .put("schemaVersion", 3)
            .put("roleId", "yuqi")
            .put("hardConstraints", new JSONArray())
            .put("preferences", new JSONArray())
            .put("currentStances", new JSONArray())
            .put("relationship", new JSONObject().put("base", "close"))
            .put("recentGroups", new JSONArray())
            .put("verifiedFacts", new JSONArray())
            .put("lifeSignals", new JSONArray())
            .put("authorSettings", new JSONObject())
            .put("fallbackExecution", new JSONObject()
                .put("contract", "cognition-v3-fallback-v1")
                .put("deviceId", "device_gateway")
                .put("cognition", new JSONObject()
                    .put("configId", "memory-v3")
                    .put("system", "private cognition prompt")
                    .put("messages", new JSONArray()))
                .put("expression", new JSONObject()
                    .put("configId", "chat-v3")
                    .put("system", "private expression prompt")
                    .put("messages", new JSONArray())));
        return new TurnSubmission(
            turnId,
            "yuqi",
            "source-" + turnId,
            TurnKind.PROACTIVE_CHAT,
            new JSONObject().put("scheduledFor", createdAt).toString(),
            snapshot.toString(),
            "job-" + turnId,
            createdAt
        );
    }

    private static TurnSubmission yuqiMomentFallbackSubmission(String turnId, long createdAt)
        throws Exception {
        TurnSubmission base = yuqiAutomaticFallbackSubmission(turnId, createdAt);
        JSONObject input = new JSONObject()
            .put("scheduledFor", createdAt)
            .put("momentId", "moment-fallback-1")
            .put("targetMoment", new JSONObject()
                .put("momentId", "moment-fallback-1")
                .put("authorId", "yuqi")
                .put("revision", 3));
        return new TurnSubmission(
            base.turnId,
            base.characterId,
            "trigger-" + turnId,
            TurnKind.MOMENT_INTERACTION,
            input.toString(),
            base.snapshotJson,
            "job-" + turnId,
            createdAt
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

    private CanonicalFixture commitCanonicalFixture(
        String localTurnId,
        String disposition,
        long base
    ) throws Exception {
        store.submitTurn(yuqiThreeBubbleSubmission(
            localTurnId, "msg-" + localTurnId, base));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(localTurnId), "device_gateway", base + 1L);
        ExecutionAttemptEntity attempt = store.activeAttempt(localTurnId);
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        int partCount = "visible".equals(disposition) ? 3 : 0;
        BridgeResult result = BridgeTurnStatus.parseV3(
            canonicalTerminal(checkpoint, disposition, partCount, new JSONArray()).toString(),
            "lan",
            null);
        store.commitBridgedTerminal(localTurnId, attempt.attemptId, result, base + 2L);
        ExecutionAttemptEntity committed = store.activeAttempt(localTurnId);
        return new CanonicalFixture(
            localTurnId,
            result,
            committed.bridgeAuthorityCheckpointJson,
            committed.bridgeAuthorityCheckpointChecksum);
    }

    private static BridgeReceiptDeliveryCoordinator.AuthorityReceipt captureReceiptWithoutPersisting(
        RoomExecutionStore target,
        String localTurnId
    ) {
        final BridgeReceiptDeliveryCoordinator.AuthorityReceipt[] captured =
            new BridgeReceiptDeliveryCoordinator.AuthorityReceipt[1];
        BridgeReceiptDeliveryCoordinator.Store adapter =
            new BridgeReceiptDeliveryCoordinator.Store() {
                @Override public BridgeReceiptDeliveryCoordinator.AuthoritySnapshot readAuthority(
                    String requestedLocalTurnId
                ) {
                    return target.readAuthority(requestedLocalTurnId);
                }

                @Override public BridgeReceiptDeliveryCoordinator.ConfirmationResult
                    confirmCloudReceiptExact(
                        BridgeReceiptDeliveryCoordinator.AuthorityReceipt expected,
                        long confirmedAt
                    ) {
                    captured[0] = expected;
                    return BridgeReceiptDeliveryCoordinator.ConfirmationResult.RETRYABLE;
                }
            };
        BridgeReceiptDeliveryCoordinator.Outcome outcome =
            new BridgeReceiptDeliveryCoordinator(adapter, receipt -> {})
                .deliver(localTurnId);
        assertEquals(
            BridgeReceiptDeliveryCoordinator.OutcomeStatus.RETRYABLE,
            outcome.status);
        assertNotNull(captured[0]);
        return captured[0];
    }

    private static BridgeReceiptDeliveryCoordinator.AuthoritySnapshot mutateCheckpoint(
        BridgeReceiptDeliveryCoordinator.AuthoritySnapshot base,
        PayloadMutation mutation
    ) throws Exception {
        JSONObject checkpoint = new JSONObject(base.checkpointJson);
        mutation.apply(checkpoint.getJSONObject("outcome").getJSONObject("result"));
        return snapshotWithCheckpoint(base, checkpoint, base.route, base.relayMessageId);
    }

    private static BridgeReceiptDeliveryCoordinator.AuthoritySnapshot snapshotWithCheckpoint(
        BridgeReceiptDeliveryCoordinator.AuthoritySnapshot base,
        JSONObject checkpoint,
        String route,
        String relayMessageId
    ) throws Exception {
        String json = BridgeAuthority.canonicalJson(checkpoint);
        return new BridgeReceiptDeliveryCoordinator.AuthoritySnapshot(
            base.localTurnId,
            json,
            BridgeAuthority.sha256CanonicalJson(checkpoint),
            base.uiAppliedAt,
            base.redacted,
            false,
            base.peerId,
            route,
            relayMessageId);
    }

    private static AutomaticScheduleContract.Policy automaticPolicy() {
        return new AutomaticScheduleContract.Policy(
            1L, repeat('9', 64), "planned", 60_000L, 600_000L, null);
    }

    private static AutomaticScheduleContract.Source automaticSource(
        String type, String id, char checksum, long conversationSequence, long occurredAt
    ) {
        return new AutomaticScheduleContract.Source(
            type, id, repeat(checksum, 64), conversationSequence, occurredAt);
    }

    private static long countRows(AlExecutionDatabase target, String table) {
        Cursor cursor = target.getOpenHelper().getReadableDatabase().query(
            "SELECT COUNT(*) FROM " + table);
        try {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        } finally {
            cursor.close();
        }
    }

    private static String outboxSnapshot(AlExecutionDatabase target) {
        Cursor cursor = target.getOpenHelper().getReadableDatabase().query(
            "SELECT * FROM automatic_schedule_outbox ORDER BY outboxId");
        StringBuilder snapshot = new StringBuilder();
        try {
            while (cursor.moveToNext()) {
                for (int column = 0; column < cursor.getColumnCount(); column += 1) {
                    snapshot.append(cursor.isNull(column) ? "<null>" : cursor.getString(column));
                    snapshot.append('\u001f');
                }
                snapshot.append('\n');
            }
            return snapshot.toString();
        } finally {
            cursor.close();
        }
    }

    private static long countResultRows(AlExecutionDatabase target, String resultCode) {
        Cursor cursor = target.getOpenHelper().getReadableDatabase().query(
            "SELECT COUNT(*) FROM automatic_schedule_events WHERE resultCode=?",
            new String[] { resultCode });
        try {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        } finally {
            cursor.close();
        }
    }

    private static String repeat(char value, int length) {
        char[] output = new char[length];
        java.util.Arrays.fill(output, value);
        return new String(output);
    }

    private static JSONObject backupReceipt(String roleId, long createdAt) throws Exception {
        String manifestChecksum = repeat('a', 64);
        String snapshotSha256 = repeat('b', 64);
        String logicalChecksum = repeat('c', 64);
        JSONObject idBasis = new JSONObject()
            .put("contract", "yuqi-backup-receipt-id-v1")
            .put("roleId", roleId)
            .put("manifestChecksum", manifestChecksum)
            .put("snapshotSha256", snapshotSha256)
            .put("logicalChecksum", logicalChecksum)
            .put("createdAt", createdAt);
        JSONObject receipt = new JSONObject()
            .put("receiptVersion", "yuqi-backup-receipt-v1")
            .put("receiptId", "bkrcpt_"
                + BridgeAuthority.sha256CanonicalJson(idBasis).substring(0, 24))
            .put("roleId", roleId)
            .put("manifestChecksum", manifestChecksum)
            .put("snapshotSha256", snapshotSha256)
            .put("logicalChecksum", logicalChecksum)
            .put("createdAt", createdAt);
        return receipt.put("receiptChecksum", BridgeAuthority.sha256CanonicalJson(receipt));
    }

    private void seedRoleOwnedRows(String turnId) {
        MemoryRecordEntity memory = new MemoryRecordEntity();
        memory.memoryId = "memory-role-delete";
        memory.sourceKey = "role-delete-source";
        memory.characterId = "yuqi";
        memory.title = "旧记忆";
        memory.content = "需要随角色删除";
        memory.eventTime = 1L;
        memory.createdAt = 1L;
        memory.updatedAt = 1L;
        database.executionDao().upsertMemory(Collections.singletonList(memory));

        EvidenceFactEntity fact = new EvidenceFactEntity();
        fact.factId = "fact-role-delete";
        fact.characterId = "yuqi";
        fact.subjectId = "yuqi";
        fact.predicate = "likes";
        fact.objectJson = "\"tea\"";
        fact.checksum = repeat('d', 64);
        fact.updatedAt = 1L;
        database.executionDao().upsertEvidenceFacts(Collections.singletonList(fact));

        CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
        snapshot.snapshotId = "snapshot-role-delete";
        snapshot.characterId = "yuqi";
        snapshot.characterName = "虞栖";
        snapshot.playerName = "用户";
        snapshot.createdAt = 1L;
        database.executionDao().upsertSnapshot(snapshot);

        RolePlanEntity plan = new RolePlanEntity();
        plan.planId = "plan-role-delete";
        plan.characterId = "yuqi";
        plan.updatedAt = 1L;
        database.executionDao().upsertRolePlans(Collections.singletonList(plan));
        RolePlanHistoryEntity history = new RolePlanHistoryEntity();
        history.historyId = "history-role-delete";
        history.planId = plan.planId;
        history.createdAt = 1L;
        database.executionDao().upsertRolePlanHistory(Collections.singletonList(history));
        RolePlanOccurrenceEntity occurrence = new RolePlanOccurrenceEntity();
        occurrence.occurrenceId = "occurrence-role-delete";
        occurrence.planId = plan.planId;
        occurrence.characterId = "yuqi";
        occurrence.turnId = "occurrence-turn-role-delete";
        occurrence.scheduledFor = 1L;
        occurrence.updatedAt = 1L;
        database.executionDao().insertRolePlanOccurrence(occurrence);

        YuqiAnnotationEntity annotation = new YuqiAnnotationEntity();
        annotation.annotationId = "annotation-role-delete";
        annotation.turnId = turnId;
        annotation.createdAt = 1L;
        annotation.syncSeq = 1L;
        annotation.checksum = repeat('e', 64);
        database.executionDao().insertYuqiAnnotation(annotation);
        DiagnosticEntity diagnostic = new DiagnosticEntity();
        diagnostic.turnId = turnId;
        diagnostic.code = "ROLE_DELETE_TEST";
        diagnostic.createdAt = 1L;
        database.executionDao().insertDiagnostic(diagnostic);
        ChangeEventEntity change = new ChangeEventEntity();
        change.turnId = turnId;
        change.createdAt = 1L;
        database.executionDao().insertChange(change);
    }

    private static JSONObject without(JSONObject source, String key) throws Exception {
        JSONObject copy = new JSONObject();
        java.util.Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String current = keys.next();
            if (!key.equals(current)) copy.put(current, source.get(current));
        }
        return copy;
    }

    private long count(String table) {
        return countFrom(database, table);
    }

    private static long countFrom(AlExecutionDatabase source, String table) {
        Cursor cursor = source.getOpenHelper().getWritableDatabase().query(
            "SELECT COUNT(*) FROM `" + table + "`");
        try {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        } finally {
            cursor.close();
        }
    }

    private interface PayloadMutation {
        void apply(JSONObject payload) throws Exception;
    }

    private interface AuthoritySnapshotMutation {
        BridgeReceiptDeliveryCoordinator.AuthoritySnapshot apply(
            BridgeReceiptDeliveryCoordinator.AuthoritySnapshot base
        ) throws Exception;
    }

    private static final class PresentedSnapshotStore
        implements BridgeReceiptDeliveryCoordinator.Store {
        private final RoomExecutionStore delegate;
        private final BridgeReceiptDeliveryCoordinator.AuthoritySnapshot presented;

        PresentedSnapshotStore(
            RoomExecutionStore delegate,
            BridgeReceiptDeliveryCoordinator.AuthoritySnapshot presented
        ) {
            this.delegate = delegate;
            this.presented = presented;
        }

        @Override public BridgeReceiptDeliveryCoordinator.AuthoritySnapshot readAuthority(
            String localTurnId
        ) {
            return presented.localTurnId.equals(localTurnId) ? presented : null;
        }

        @Override public BridgeReceiptDeliveryCoordinator.ConfirmationResult
            confirmCloudReceiptExact(
                BridgeReceiptDeliveryCoordinator.AuthorityReceipt expected,
                long confirmedAt
            ) {
            return delegate.confirmCloudReceiptExact(expected, confirmedAt);
        }
    }

    private static final class CanonicalFixture {
        private final String localTurnId;
        private final BridgeResult result;
        private final String checkpointJson;
        private final String checkpointChecksum;

        CanonicalFixture(
            String localTurnId,
            BridgeResult result,
            String checkpointJson,
            String checkpointChecksum
        ) {
            this.localTurnId = localTurnId;
            this.result = result;
            this.checkpointJson = checkpointJson;
            this.checkpointChecksum = checkpointChecksum;
        }
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

    private long countForTurn(String table, String turnId) {
        Cursor cursor = database.getOpenHelper().getReadableDatabase().query(
            "SELECT COUNT(*) FROM " + table + " WHERE turnId=?",
            new String[]{turnId}
        );
        try {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        } finally {
            cursor.close();
        }
    }

    private String changePayloadForTurn(String turnId) {
        Cursor cursor = database.getOpenHelper().getReadableDatabase().query(
            "SELECT payloadJson FROM change_events WHERE turnId=? ORDER BY cursor DESC LIMIT 1",
            new String[]{turnId}
        );
        try {
            assertTrue(cursor.moveToFirst());
            return cursor.getString(0);
        } finally {
            cursor.close();
        }
    }

    private List<String> changePayloadsForTurn(String turnId) {
        Cursor cursor = database.getOpenHelper().getReadableDatabase().query(
            "SELECT payloadJson FROM change_events WHERE turnId=? ORDER BY cursor ASC",
            new String[]{turnId}
        );
        try {
            List<String> payloads = new ArrayList<>();
            while (cursor.moveToNext()) payloads.add(cursor.getString(0));
            return payloads;
        } finally {
            cursor.close();
        }
    }

    private String changeTypeForTurn(String turnId) {
        Cursor cursor = database.getOpenHelper().getReadableDatabase().query(
            "SELECT type FROM change_events WHERE turnId=? ORDER BY cursor DESC LIMIT 1",
            new String[]{turnId}
        );
        try {
            assertTrue(cursor.moveToFirst());
            return cursor.getString(0);
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
