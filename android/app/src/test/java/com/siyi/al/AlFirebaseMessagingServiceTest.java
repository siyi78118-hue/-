package com.siyi.al;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.siyi.al.execution.db.CharacterSnapshotEntity;
import org.junit.Test;

public class AlFirebaseMessagingServiceTest {
    @Test
    public void acceptsOnlyTheCloudJobStoredInLatestSnapshot() {
        CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
        snapshot.contextJson = "{\"cloudJobId\":\"job-current\"}";

        assertTrue(AlFirebaseMessagingService.matchesSnapshotJob(snapshot, "job-current"));
        assertFalse(AlFirebaseMessagingService.matchesSnapshotJob(snapshot, "job-old"));
        assertFalse(AlFirebaseMessagingService.matchesSnapshotJob(snapshot, ""));
    }
}
