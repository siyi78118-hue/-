package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

public class RolePlanScheduleTest {
    @BeforeClass
    public static void setTimezone() {
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"));
    }

    @Test
    public void dailyPlanAdvancesInDeviceLocalTime() throws Exception {
        JSONObject schedule = new JSONObject().put("kind", "daily").put("time", "09:00");
        assertEquals(at("2026-07-17 09:00"), RolePlanSchedule.nextOccurrence(schedule, at("2026-07-16 09:00")).longValue());
    }

    @Test
    public void oncePlanCompletesAfterItsOccurrence() throws Exception {
        JSONObject schedule = new JSONObject().put("kind", "once").put("at", "2026-07-16T09:00:00+08:00");
        assertNull(RolePlanSchedule.nextOccurrence(schedule, at("2026-07-16 09:00")));
    }

    @Test
    public void intervalPlanSkipsDirectlyToNextFutureSlot() throws Exception {
        JSONObject schedule = new JSONObject()
            .put("kind", "interval")
            .put("startsAt", "2026-07-16T08:00:00+08:00")
            .put("intervalMs", 60 * 60 * 1000L);
        assertEquals(at("2026-07-16 12:00"), RolePlanSchedule.nextOccurrence(schedule, at("2026-07-16 11:17")).longValue());
    }

    private static long at(String value) throws Exception {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).parse(value).getTime();
    }
}
