package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;

import android.content.Context;
import androidx.room.Room;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.RoleDeleteOperationEntity;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RoleDeleteOperationTest {
    private AlExecutionDatabase database;
    private RoomExecutionStore store;

    @Before
    public void setUp() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        database = Room.inMemoryDatabaseBuilder(context, AlExecutionDatabase.class)
            .allowMainThreadQueries()
            .build();
        store = new RoomExecutionStore(database, "device_gateway");
        store.getConversationCursor("yuqi");
    }

    @After
    public void tearDown() {
        database.close();
    }

    @Test
    public void roleDeleteCreatesOperationAndFreezeTogether() throws Exception {
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi"));
        JSONObject receipt = backupReceipt("yuqi", 100L);
        String operationId = store.roleDeleteOperationIdForRequest(
            "yuqi", cursorChecksum, receipt);

        LifecycleControl control = store.createRoleDelete(
            operationId,
            "yuqi",
            "device_gateway",
            cursorChecksum,
            receipt,
            101L,
            null,
            null
        );

        assertNotNull(control);
        RoleDeleteOperationEntity operation =
            database.executionDao().roleDeleteOperation(operationId);
        assertNotNull(operation);
        assertEquals(operationId, operation.operationId);
        assertEquals(control.controlId, operation.controlId);
        assertEquals("yuqi", operation.characterId);
        assertEquals("completed", operation.state);
        assertEquals("complete", operation.phase);
        assertEquals(
            "{\"expectedCursorChecksum\":\"" + cursorChecksum + "\"}",
            operation.cursorJson);
        assertEquals(operation.operationId, store.queryRoleDeleteOperation(operationId).operationId);
        assertNotNull(database.executionDao().lifecycleControl(control.controlId));
    }

    @Test
    public void expiredRunningOperationBecomesUnknownWithoutRemovingFreeze() throws Exception {
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi"));
        JSONObject receipt = backupReceipt("yuqi", 500L);
        String operationId = store.roleDeleteOperationIdForRequest(
            "yuqi", cursorChecksum, receipt);
        LifecycleControl control = store.createRoleDelete(
            operationId, "yuqi", "device_gateway", cursorChecksum, receipt, 501L, null, null);
        RoleDeleteOperationEntity operation = database.executionDao().roleDeleteOperation(operationId);
        assertNotNull(operation);
        assertEquals(1, database.executionDao().compareAndSetRoleDeleteOperation(
            operationId, "completed", "running", "deleting", operation.cursorJson,
            operation.affectedCount, operation.updatedAt, operation.cursorJson,
            operation.affectedCount, 600L, null));

        RoleDeleteOperationEntity reconciled = store.reconcileRoleDeleteOperation(
            operationId, 10_000L, 1_000L);
        assertNotNull(reconciled);
        assertEquals("unknown", reconciled.state);
        assertEquals("unknown", reconciled.phase);
        assertEquals("OPERATION_TIMEOUT_OR_RESTART", reconciled.lastError);
        assertNotNull(store.roleDeleteControl("yuqi"));
        assertEquals(control.controlId, reconciled.controlId);
    }

    @Test
    public void failedDeleteRetainsFreezeAndJournalForRestartDiagnosis() throws Exception {
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi"));
        JSONObject receipt = backupReceipt("yuqi", 300L);
        String operationId = store.roleDeleteOperationIdForRequest(
            "yuqi", cursorChecksum, receipt);
        RoomExecutionStore faulted = new RoomExecutionStore(
            database, "device_gateway", boundary -> {
                if ("role_delete_control".equals(boundary)) {
                    throw new IllegalStateException("injected role delete failure");
                }
            }, 0);

        assertThrows(IllegalStateException.class, () -> faulted.createRoleDelete(
            operationId, "yuqi", "device_gateway", cursorChecksum, receipt, 301L, null, null));
        RoleDeleteOperationEntity operation = database.executionDao().roleDeleteOperation(operationId);
        assertNotNull(operation);
        assertEquals("failed", operation.state);
        assertEquals("failed", operation.phase);
        assertEquals("ROLE_DELETE_OPERATION_FAILED", operation.lastError);
        assertNotNull(database.executionDao().lifecycleControl(operation.controlId));

        RoomExecutionStore reopened = new RoomExecutionStore(database, "device_gateway");
        assertEquals("failed", reopened.queryRoleDeleteOperation(operationId).state);
        assertNotNull(reopened.roleDeleteControl("yuqi"));
    }

    @Test
    public void reopenRejectsCorruptRoleDeleteOperationJournal() {
        RoleDeleteOperationEntity corrupt = new RoleDeleteOperationEntity();
        corrupt.operationId = "rdop_" + repeat('a', 64);
        corrupt.controlId = "control-corrupt";
        corrupt.characterId = "yuqi";
        corrupt.operationChecksum = "not-a-sha";
        corrupt.state = "prepared";
        corrupt.phase = "prepared";
        corrupt.cursorJson = "{\"expectedCursorChecksum\":\"" + repeat('b', 64) + "\"}";
        corrupt.createdAt = 1L;
        corrupt.updatedAt = 1L;
        assertEquals(1L, database.executionDao().insertRoleDeleteOperation(corrupt));

        assertThrows(IllegalStateException.class,
            () -> new RoomExecutionStore(database, "device_gateway"));
    }

    @Test
    public void sameOperationIdReplaysWithoutCreatingAnotherDelete() throws Exception {
        String cursorChecksum = RoomExecutionStore.conversationCursorChecksum(
            "yuqi", database.executionDao().conversationCursor("yuqi"));
        JSONObject receipt = backupReceipt("yuqi", 200L);
        String operationId = store.roleDeleteOperationIdForRequest(
            "yuqi", cursorChecksum, receipt);

        LifecycleControl first = store.createRoleDelete(
            operationId, "yuqi", "device_gateway", cursorChecksum, receipt, 201L, null, null);
        LifecycleControl replay = store.createRoleDelete(
            operationId, "yuqi", "device_gateway", cursorChecksum, receipt, 202L, null, null);

        assertEquals(first.controlId, replay.controlId);
        JSONObject changedReceipt = backupReceipt("yuqi", 203L);
        assertThrows(IllegalStateException.class, () -> store.createRoleDelete(
            operationId, "yuqi", "device_gateway", cursorChecksum, changedReceipt, 204L, null, null));
        assertEquals(1L, database.executionDao().roleDeleteOperationCount());
        assertEquals(1L, database.executionDao().roleDeleteControlsForCharacter("yuqi").size());
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

    private static String repeat(char value, int length) {
        char[] output = new char[length];
        java.util.Arrays.fill(output, value);
        return new String(output);
    }

}
