package com.mystudyagent.app;

import android.Manifest;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "NotificationPermission",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class NotificationPermissionPlugin extends Plugin {
    @PluginMethod
    public void request(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(result(getPermissionState("notifications") == PermissionState.GRANTED));
            return;
        }
        requestPermissionForAlias("notifications", call, "permissionResult");
    }

    @PluginMethod
    public void check(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || getPermissionState("notifications") == PermissionState.GRANTED;
        call.resolve(result(granted));
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        call.resolve(result(getPermissionState("notifications") == PermissionState.GRANTED));
    }

    private JSObject result(boolean granted) {
        JSObject value = new JSObject();
        value.put("display", granted ? "granted" : "denied");
        return value;
    }
}
