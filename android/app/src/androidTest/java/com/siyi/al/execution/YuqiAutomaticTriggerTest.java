package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.content.Context;
import androidx.room.Room;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgeMode;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.secure.AlSecretStore;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class YuqiAutomaticTriggerTest {
    @Test public void alarmAndFcmReplayCreateOnePersistedAutomaticTurn() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AlExecutionDatabase database = Room.inMemoryDatabaseBuilder(context, AlExecutionDatabase.class)
            .allowMainThreadQueries().build();
        try {
            String epoch = "00112233445566778899aabbccddeeff";
            AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, "device_gateway");
            AutomaticScheduleAuthorityEntity authority = schedules.configure(
                "yuqi", "chat", epoch,
                new AutomaticScheduleContract.Source("bootstrap", "trigger-test", repeat('b'), 0L, 1_000L),
                new AutomaticScheduleContract.Policy(1L, repeat('a'), "planned", 1L, 1L, null),
                1_000L
            );
            CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
            snapshot.snapshotId = "yuqi:chat";
            snapshot.characterId = "yuqi";
            snapshot.characterName = "虞栖";
            snapshot.playerName = "我";
            snapshot.contextJson = new JSONObject()
                .put("automaticPolicyRevision", 1L)
                .put("automaticPolicyChecksum", repeat('a'))
                .put("automaticPolicyMode", "planned")
                .put("automaticPolicyMinDelayMs", 1L)
                .put("automaticPolicyMaxDelayMs", 1L)
                .toString();
            snapshot.automaticTasksEnabled = true;
            snapshot.automaticKind = "chat";
            snapshot.cloudJobId = authority.activeJobId;
            snapshot.scheduledFor = authority.dueAt;
            database.executionDao().upsertSnapshot(snapshot);

            java.util.HashMap<String, String> raw = new java.util.HashMap<>();
            raw.put("charId", "yuqi");
            raw.put("kind", "chat");
            raw.put("jobId", authority.activeJobId);
            raw.put("authorityEpoch", epoch);
            raw.put("generation", String.valueOf(authority.generation));
            AutomaticTaskCoordinator coordinator = new AutomaticTaskCoordinator(database);
            AutomaticTaskCoordinator.ClaimToken token = AutomaticTaskCoordinator.ClaimToken.from(raw);

            assertEquals(AutomaticTaskCoordinator.DispatchOutcome.CLAIMED,
                coordinator.dispatch(token, authority.dueAt));
            assertEquals(AutomaticTaskCoordinator.DispatchOutcome.REPLAY,
                coordinator.dispatch(token, authority.dueAt));
            String automaticTurnId = RoomExecutionStore.automaticTurnId(authority.activeJobId);
            assertNotNull(database.executionDao().turn(automaticTurnId));
            assertEquals(1, database.executionDao().attempts(automaticTurnId).size());
        } finally {
            database.close();
        }
    }

    @Test public void proactiveTriggerGetsOneCodexReplyAndNoUserRow() throws Exception {
        assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("yuqiE2e")));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        configure(context);
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        RoomExecutionStore store = new RoomExecutionStore(database);
        long now = System.currentTimeMillis();
        String turnId = "turn_android_trigger_" + now;
        String triggerId = "trigger_android_" + now;
        JSONObject input = new JSONObject()
            .put("scheduledFor", now)
            .put("reason", "端到端主动消息测试：自然地发一句简短问候，不要换行")
            .put("deviceSeq", now);
        store.submitTurn(new TurnSubmission(
            turnId, "yuqi", triggerId, TurnKind.PROACTIVE_CHAT,
            input.toString(), "{}", "job_android_" + now, now
        ));

        assertTrue(ExecutionRuntime.create(context).runNext());

        assertEquals(TurnState.COMPLETED.name(), store.turn(turnId).state);
        assertFalse(store.replyParts(turnId).isEmpty());
        int userRows = 0;
        int characterRows = 0;
        for (RawMessageEntity row : database.executionDao().recentRawMessages("yuqi", 100)) {
            if (!turnId.equals(row.turnId)) continue;
            if ("user".equals(row.speakerType)) userRows += 1;
            if ("character".equals(row.speakerType)) {
                characterRows += 1;
                assertEquals("yuqi", row.speakerId);
                assertEquals("codex", row.origin);
            }
        }
        assertEquals(0, userRows);
        assertEquals(1, characterRows);
    }

    static void configure(Context context) {
        new AlSecretStore(context).saveBridgeConfig(new BridgeConfig(
            true, BridgeMode.LAN, "http://127.0.0.1:17892", "", "android-e2e-device",
            "yuqi-e2e-pairing-secret-20260719", "", "", 5_000, 15_000, 1, 500, 1_200_000
        ));
    }

    private static String repeat(char value) {
        return new String(new char[64]).replace('\0', value);
    }
}
