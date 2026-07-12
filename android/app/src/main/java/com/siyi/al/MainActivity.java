package com.siyi.al;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(AlReplyQueuePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
