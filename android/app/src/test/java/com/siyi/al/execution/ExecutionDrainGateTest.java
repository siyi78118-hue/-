package com.siyi.al.execution;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ExecutionDrainGateTest {
    @Test
    public void requestDuringDrainForcesAnotherCycle() {
        ExecutionDrainGate gate = new ExecutionDrainGate();

        assertTrue(gate.request());
        assertFalse(gate.request());
        assertTrue(gate.finishCycle());
        assertFalse(gate.finishCycle());
    }

    @Test
    public void requestAfterCompletedDrainStartsNewDrain() {
        ExecutionDrainGate gate = new ExecutionDrainGate();

        assertTrue(gate.request());
        assertFalse(gate.finishCycle());
        assertTrue(gate.request());
    }

    @Test
    public void closeReleasesDrainAfterUnexpectedFailure() {
        ExecutionDrainGate gate = new ExecutionDrainGate();

        assertTrue(gate.request());
        gate.close();
        assertTrue(gate.request());
    }

    @Test
    public void abortReportsARequestThatArrivedDuringFailure() {
        ExecutionDrainGate gate = new ExecutionDrainGate();

        assertTrue(gate.request());
        assertFalse(gate.request());
        assertTrue(gate.abortCycle());
        assertTrue(gate.request());
    }
}
