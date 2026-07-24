package com.siyi.al.execution.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

public class BridgeRolePlanResultTest {
    @Test
    public void committedStatusCarriesStructuredPlanOperationsWithoutVisibleText() throws Exception {
        String raw = "{"
            + "\"turnId\":\"turn_plan_1\","
            + "\"state\":\"committed\","
            + "\"terminal\":true,"
            + "\"action\":\"send\","
            + "\"reply\":null,"
            + "\"rolePlanOperations\":[{\"op\":\"cancel\",\"planId\":\"plan_old\"}]"
            + "}";

        BridgeTurnStatus status = BridgeTurnStatus.parse(raw, "turn_plan_1");
        BridgeResult result = status.toResult("LAN");

        assertEquals("", result.replyText);
        assertFalse(result.rolePlanOperationsJson.isEmpty());
        assertEquals("[{\"op\":\"cancel\",\"planId\":\"plan_old\"}]", result.rolePlanOperationsJson);
    }
}
