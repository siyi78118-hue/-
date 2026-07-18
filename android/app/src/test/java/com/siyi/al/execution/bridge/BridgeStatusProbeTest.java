package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;
import org.junit.Test;

public class BridgeStatusProbeTest {
    @Test public void reportsThreeIndependentRoleThreadsAndQuotaWarnings() throws Exception {
        BridgeStatusProbe.Snapshot snapshot = new BridgeStatusProbe.Snapshot();
        BridgeStatusProbe.parseHealth(new JSONObject("{\"roleThreads\":{\"memory\":true,\"brain\":true,\"supervisor\":false},\"presetVersion\":\"1.2.0\"}"), snapshot);
        BridgeStatusProbe.parseQuota(new JSONObject("{\"warningLevel\":75}"), snapshot);
        assertEquals("2/3 已建立", snapshot.threadHealth);
        assertEquals("1.2.0", snapshot.presetVersion);
        assertEquals(75, snapshot.quotaWarningLevel);
    }
}
