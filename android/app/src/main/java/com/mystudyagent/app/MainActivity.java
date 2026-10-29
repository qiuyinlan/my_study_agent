package com.mystudyagent.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppUpdaterPlugin.class);
        registerPlugin(AppSettingsPlugin.class);
        registerPlugin(NotificationPermissionPlugin.class);
        registerPlugin(AppFilesPlugin.class);
        super.onCreate(savedInstanceState);
        UpdateCheckScheduler.schedule(this);
    }
}
