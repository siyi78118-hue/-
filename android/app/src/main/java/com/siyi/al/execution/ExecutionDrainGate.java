package com.siyi.al.execution;

final class ExecutionDrainGate {
    private boolean draining;
    private boolean pending;

    synchronized boolean request() {
        if (draining) {
            pending = true;
            return false;
        }
        draining = true;
        return true;
    }

    synchronized boolean finishCycle() {
        if (pending) {
            pending = false;
            return true;
        }
        draining = false;
        return false;
    }

    synchronized boolean abortCycle() {
        boolean restart = pending;
        pending = false;
        draining = false;
        return restart;
    }

    synchronized void close() {
        pending = false;
        draining = false;
    }
}
