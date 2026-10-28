package com.mystudyagent.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private static final String PREFS = "app_update_download";
    private static final String APK_MIME = "application/vnd.android.package-archive";

    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        String url = call.getString("url", "");
        String version = call.getString("version", "");
        // 自动更新只在 Wi-Fi 下下，别烧用户流量；用户自己点「下载更新」时
        // 一律允许移动网络 —— 否则在流量下 DownloadManager 会一直排队等 Wi-Fi，
        // 界面上看起来就是"点了没反应"。
        boolean allowMobileData = Boolean.TRUE.equals(call.getBoolean("allowMobileData", true));
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme()) || !"github.com".equals(uri.getHost())
                || !uri.getPath().contains("/releases/download/") || version.isEmpty()) {
            call.reject("Invalid release APK URL");
            return;
        }

        try {
            long previous = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getLong("downloadId", -1L);
            if (previous >= 0) cancelQuietly(previous);
            long id = enqueueDownload(getContext(), url, version, allowMobileData);
            saveDownload(getContext(), id, version);
            JSObject result = new JSObject();
            result.put("downloadId", id);
            result.put("version", version);
            result.put("allowMobileData", allowMobileData);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not start APK download", error);
        }
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        long id = call.getData().optLong("downloadId", -1L);
        if (id >= 0) cancelQuietly(id);
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void getLatestDownload(PluginCall call) {
        long id = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getLong("downloadId", -1L);
        String version = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString("version", "");
        JSObject result = id < 0 ? new JSObject() : downloadStatus(id, version);
        call.resolve(result);
    }

    @PluginMethod
    public void getDownloadStatus(PluginCall call) {
        long id = call.getData().optLong("downloadId", -1L);
        if (id < 0) {
            call.reject("Invalid download ID");
            return;
        }
        call.resolve(downloadStatus(id, call.getString("version", "")));
    }

    @PluginMethod
    public void installDownloadedApk(PluginCall call) {
        long id = call.getData().optLong("downloadId", -1L);
        if (id < 0) {
            call.reject("Invalid download ID");
            return;
        }

        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        Uri apkUri = manager.getUriForDownloadedFile(id);
        if (apkUri == null) {
            call.reject("APK download is not complete");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            JSObject result = new JSObject();
            result.put("permissionRequired", true);
            call.resolve(result);
            return;
        }

        try {
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(apkUri, APK_MIME);
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(install);
            call.resolve(new JSObject());
        } catch (Exception error) {
            call.reject("Could not open Android package installer", error);
        }
    }

    static long enqueueDownload(Context context, String url, String version) {
        return enqueueDownload(context, url, version, false);
    }

    static long enqueueDownload(Context context, String url, String version, boolean allowMobileData) {
        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        String safeVersion = version.replaceAll("[^A-Za-z0-9._-]", "_");
        int networks = allowMobileData
                ? DownloadManager.Request.NETWORK_WIFI | DownloadManager.Request.NETWORK_MOBILE
                : DownloadManager.Request.NETWORK_WIFI;
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                .setTitle("My Study Agent v" + version)
                .setDescription(allowMobileData ? "Downloading app update" : "Downloading app update (Wi-Fi)")
                .setMimeType(APK_MIME)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedNetworkTypes(networks)
                .setAllowedOverRoaming(false)
                .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS,
                        "MyStudyAgent-v" + safeVersion + ".apk");
        return manager.enqueue(request);
    }

    private void cancelQuietly(long downloadId) {
        try {
            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            manager.remove(downloadId);
        } catch (Exception ignored) {
            // 取消失败不影响新任务开始。
        }
    }

    static void saveDownload(Context context, long id, String version) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong("downloadId", id).putString("version", version).apply();
    }

    private JSObject downloadStatus(long id, String version) {
        JSObject result = new JSObject();
        result.put("downloadId", id);
        result.put("version", version);
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
        try (android.database.Cursor cursor = manager.query(query)) {
            if (cursor == null || !cursor.moveToFirst()) {
                result.put("status", "missing");
                return result;
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long downloaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
            String label = status == DownloadManager.STATUS_SUCCESSFUL ? "complete"
                    : status == DownloadManager.STATUS_FAILED ? "failed"
                    : status == DownloadManager.STATUS_PAUSED ? "paused"
                    : status == DownloadManager.STATUS_RUNNING ? "downloading" : "pending";
            result.put("status", label);
            result.put("downloadedBytes", downloaded);
            result.put("totalBytes", total);
            result.put("reason", reason);
            // PAUSED_WAITING_FOR_NETWORK：任务在排队等它被允许的网络。
            // 自动更新只允许 Wi-Fi，这里如实告诉前端"它在等 Wi-Fi"，
            // 前端才好给出「用流量下载」的出口，而不是让用户对着进度干等。
            result.put("waitingForNetwork",
                    (status == DownloadManager.STATUS_PAUSED && reason == 198)
                            || status == DownloadManager.STATUS_PENDING);
            return result;
        }
    }
}
