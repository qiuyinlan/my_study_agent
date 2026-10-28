package com.mystudyagent.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 把用户送到本应用的「通知」系统设置页。
 *
 * 为什么需要它：Android 13 起通知是运行时权限，但用户连续拒绝两次后系统
 * 不再弹框，requestPermissions() 只会立刻返回 denied —— 此时应用里点任何
 * 按钮都"没反应"，唯一出路是去系统设置手动允许。没有这个方法，应用能给的
 * 只有一句文字说明，用户得自己在设置里翻三层菜单。
 */
@CapacitorPlugin(name = "AppSettings")
public class AppSettingsPlugin extends Plugin {

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            // Android 8 之前没有通知渠道，走应用详情页兜底。
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", getContext().getPackageName(), null));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法打开系统通知设置", error);
        }
    }
}
