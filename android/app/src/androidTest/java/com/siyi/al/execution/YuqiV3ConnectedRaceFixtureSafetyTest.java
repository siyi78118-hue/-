package com.siyi.al.execution;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

import android.content.ContextWrapper;
import org.junit.Test;

public final class YuqiV3ConnectedRaceFixtureSafetyTest {
    @Test
    public void productionSingletonFixtureIsDisabledBeforeAnyContextOrRoomAccess() {
        IllegalStateException error = assertThrows(
            IllegalStateException.class,
            () -> YuqiV3ConnectedRaceFixture.open(null));
        assertTrue(error.getMessage().contains("UNSAFE_CONNECTED_FIXTURE_DISABLED"));
    }

    @Test
    public void isolatedApplicationEntryPointRejectsMissingOrProductionContext() {
        IllegalStateException error = assertThrows(
            IllegalStateException.class,
            () -> YuqiV3ConnectedRaceFixture.openIsolatedApplication(null));
        assertTrue(error.getMessage().contains("ISOLATED_TEST_APPLICATION_REQUIRED"));

        ContextWrapper productionContext = new ContextWrapper(null) {
            @Override public String getPackageName() { return "com.siyi.al"; }
        };
        IllegalStateException productionError = assertThrows(
            IllegalStateException.class,
            () -> YuqiV3ConnectedRaceFixture.openIsolatedApplication(productionContext));
        assertTrue(productionError.getMessage().contains("ISOLATED_TEST_APPLICATION_REQUIRED"));
    }
}
