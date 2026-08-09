package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ConversationCursorEntity;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class AlExecutionServiceStartupTest {
    @Test
    public void stoppingAndStoppedDestroyStatesAreIdempotent() {
        assertTrue(AlExecutionService.shouldIgnoreDestroy(AlExecutionService.StartupState.STOPPING));
        assertTrue(AlExecutionService.shouldIgnoreDestroy(AlExecutionService.StartupState.STOPPED));
        assertTrue(!AlExecutionService.shouldIgnoreDestroy(AlExecutionService.StartupState.READY));
    }

    @Test
    public void explicitForegroundStartDrainsDurableRoleNotificationCancellationOnWorker()
        throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        String characterId = "task24a-startup-" + UUID.randomUUID();
        String turnId = "task24a-turn-" + UUID.randomUUID();
        RoomExecutionStore store = new RoomExecutionStore(database, "device_gateway");
        store.submitTurn(new TurnSubmission(
            turnId,
            characterId,
            "task24a-source-" + turnId,
            TurnKind.DIRECT_REPLY,
            "{\"message\":\"startup cancellation\"}",
            "{\"scene\":\"startup\"}",
            null,
            System.currentTimeMillis()
        ));
        ConversationCursorEntity cursor = store.getConversationCursor(characterId);
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(characterId, cursor);
        long requestedAt = System.currentTimeMillis();
        store.createRoleDelete(
            characterId,
            "device_gateway",
            cursorChecksum,
            backupReceipt(characterId, requestedAt - 1L),
            requestedAt,
            null,
            null
        );
        assertEquals(1L, database.executionDao().roleNotificationCancellationCount());

        Intent serviceIntent = new Intent(context, AlExecutionService.class);
        try {
            ContextCompat.startForegroundService(context, serviceIntent);
            assertTrue(waitUntil(() ->
                database.executionDao().roleNotificationCancellationCount() == 0L,
                30_000L));
        } finally {
            context.stopService(serviceIntent);
        }
        assertEquals(0L, database.executionDao().roleNotificationCancellationCount());
    }

    private static boolean waitUntil(Check check, long timeoutMs) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        while (System.nanoTime() < deadline) {
            if (check.value()) return true;
            Thread.sleep(100L);
        }
        return check.value();
    }

    private interface Check { boolean value() throws Exception; }

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
            .put("receiptId", "bkrcpt_" + BridgeAuthority.sha256CanonicalJson(idBasis).substring(0, 24))
            .put("roleId", roleId)
            .put("manifestChecksum", manifestChecksum)
            .put("snapshotSha256", snapshotSha256)
            .put("logicalChecksum", logicalChecksum)
            .put("createdAt", createdAt);
        return receipt.put("receiptChecksum", BridgeAuthority.sha256CanonicalJson(receipt));
    }

    private static String repeat(char value, int length) {
        char[] output = new char[length];
        java.util.Arrays.fill(output, value);
        return new String(output);
    }
}
