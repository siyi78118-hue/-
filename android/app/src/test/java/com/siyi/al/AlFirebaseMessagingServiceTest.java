package com.siyi.al;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import com.siyi.al.execution.db.CharacterSnapshotEntity;
import org.junit.Test;

public class AlFirebaseMessagingServiceTest {
    @Test
    public void rolePlanSnapshotUsesStablePlanIdentifier() {
        assertEquals("char-a:role-plan:plan-a", AlFirebaseMessagingService.rolePlanSnapshotId("char-a", "plan-a"));
    }
    @Test
    public void cloudJobUsesJobSpecificSnapshotId() {
        assertEquals(
            "char-1:chat:pro-123",
            AlFirebaseMessagingService.snapshotId("char-1", "chat", "pro-123")
        );
    }

    @Test
    public void acceptsOnlyTheCloudJobStoredInLatestSnapshot() {
        CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
        snapshot.contextJson = "{\"cloudJobId\":\"job-current\"}";

        assertTrue(AlFirebaseMessagingService.matchesSnapshotJob(snapshot, "job-current"));
        assertFalse(AlFirebaseMessagingService.matchesSnapshotJob(snapshot, "job-old"));
        assertFalse(AlFirebaseMessagingService.matchesSnapshotJob(snapshot, ""));
    }

    @Test
    public void rejectsSnapshotWhenAutomaticTasksAreDisabled() {
        CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
        snapshot.contextJson = "{\"cloudJobId\":\"job-current\",\"automaticTasksEnabled\":false}";

        assertFalse(AlFirebaseMessagingService.snapshotAllowsAutomaticTask(snapshot, "job-current"));
    }
}
