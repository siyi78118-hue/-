package com.siyi.al;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import android.content.Context;
import androidx.room.Room;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.execution.RoomExecutionStore;
import com.siyi.al.execution.LifecycleControl;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgeMode;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ConversationCursorEntity;
import com.siyi.al.execution.db.LifecycleControlEntity;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class AlExecutionPluginTest {
    @Test
    public void savedPeerRebindsStoreWithoutRestartAndOldPeerIsNotUsed() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AlExecutionDatabase database = Room.inMemoryDatabaseBuilder(context, AlExecutionDatabase.class)
            .allowMainThreadQueries()
            .build();
        try {
            RoomExecutionStore noPeer = AlExecutionPlugin.storeForBridgeConfig(
                database, bridgeConfig(""));
            ConversationCursorEntity initial = noPeer.getConversationCursor("yuqi");
            String initialChecksum = RoomExecutionStore.conversationCursorChecksum("yuqi", initial);
            assertThrows(IllegalStateException.class, () -> noPeer.createConversationClear(
                "yuqi", initialChecksum));

            RoomExecutionStore savedPeer = AlExecutionPlugin.storeForBridgeConfig(
                database, bridgeConfig("device-after-save"));
            LifecycleControl control = savedPeer.createConversationClear("yuqi", initialChecksum);
            LifecycleControlEntity first = database.executionDao().lifecycleControl(control.controlId);
            assertEquals(control.controlId, first.controlId);
            assertEquals("device-after-save", first.peerId);

            database.getOpenHelper().getWritableDatabase().execSQL(
                "UPDATE lifecycle_controls SET state='applied', appliedAt=?, updatedAt=? WHERE controlId=?",
                new Object[]{first.requestedAt, first.requestedAt, first.controlId});
            ConversationCursorEntity after = savedPeer.getConversationCursor("yuqi");
            RoomExecutionStore changedPeer = AlExecutionPlugin.storeForBridgeConfig(
                database, bridgeConfig("device-after-rotation"));
            LifecycleControl second = changedPeer.createConversationClear(
                "yuqi", RoomExecutionStore.conversationCursorChecksum("yuqi", after));
            assertEquals("device-after-rotation",
                database.executionDao().lifecycleControl(second.controlId).peerId);
        } finally {
            database.close();
        }
    }

    private static BridgeConfig bridgeConfig(String deviceId) {
        return new BridgeConfig(false, BridgeMode.AUTO, "", "", deviceId, "", "", "",
            1200, 90000, 60, 1000);
    }
}
