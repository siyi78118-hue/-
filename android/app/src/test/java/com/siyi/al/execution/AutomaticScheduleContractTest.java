package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Test;

public class AutomaticScheduleContractTest {
    @Test
    public void androidConsumesTheFrozenNodeScheduleVector() throws Exception {
        JSONObject vector = readFixture().getJSONArray("vectors").getJSONObject(0);
        JSONObject transition = vector.getJSONObject("transition");

        AutomaticScheduleContract.ValidatedTransition validated =
            AutomaticScheduleContract.validateTransition(transition);

        assertEquals(vector.getString("transitionCanonicalJson"), validated.transitionCanonicalJson);
        assertEquals(vector.getString("transitionChecksum"), validated.transitionChecksum);
        assertEquals(vector.getString("jobId"), validated.jobId);
        assertEquals(vector.getString("scheduleCanonicalJson"), validated.scheduleCanonicalJson);
        assertEquals(vector.getString("scheduleChecksum"), validated.scheduleChecksum);
    }

    @Test
    public void transitionContractRejectsUnknownFieldsAndChecksumDrift() throws Exception {
        JSONObject original = readFixture().getJSONArray("vectors").getJSONObject(0)
            .getJSONObject("transition");
        JSONObject extra = new JSONObject(original.toString()).put("extra", "leak");
        JSONObject changed = new JSONObject(original.toString()).put("dueAt", 1786728600001L);

        assertThrows(IllegalArgumentException.class,
            () -> AutomaticScheduleContract.validateTransition(extra));
        assertThrows(IllegalArgumentException.class,
            () -> AutomaticScheduleContract.validateTransition(changed));
    }

    private static JSONObject readFixture() throws Exception {
        File root = new File(System.getProperty("user.dir", "."));
        File fixture = new File(root, "tests/fixtures/automatic-schedule-authority-v1.json");
        if (!fixture.isFile()) fixture = new File(root, "../tests/fixtures/automatic-schedule-authority-v1.json");
        if (!fixture.isFile()) fixture = new File(root, "../../tests/fixtures/automatic-schedule-authority-v1.json");
        if (!fixture.isFile()) throw new IllegalStateException("automatic schedule fixture is missing");
        return new JSONObject(new String(Files.readAllBytes(fixture.toPath()), StandardCharsets.UTF_8));
    }
}
