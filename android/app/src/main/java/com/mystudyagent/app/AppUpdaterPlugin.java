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
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme()) || !"github.com".equals(uri.getHost())
                || !uri.getPath().contains("/releases/download/") || version.isEmpty()) {
            call.reject("Invalid release APK URL");
            return;
        }

        try {
            long id = enqueueDownload(getContext(), url, version);
            saveDownload(getContext(), id, version);
            JSObject result = new JSObject();
            result.put("downloadId", id);
            result.put("version", version);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not start APK download", error);
        }
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
        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        String safeVersion = version.replaceAll("[^A-Za-z0-9._-]", "_");
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                .setTitle("My Study Agent v" + version)
                .setDescription("Downloading app update")
                .setMimeType(APK_MIME)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedNetworkTypes(DownloadManager.Request.NETWORK_WIFI)
                .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS,
                        "MyStudyAgent-v" + safeVersion + ".apk");
        return manager.enqueue(request);
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
            String label = status == DownloadManager.STATUS_SUCCESSFUL ? "complete"
                    : status == DownloadManager.STATUS_FAILED ? "failed"
                    : status == DownloadManager.STATUS_PAUSED ? "paused"
                    : status == DownloadManager.STATUS_RUNNING ? "downloading" : "pending";
            result.put("status", label);
            result.put("downloadedBytes", downloaded);
            result.put("totalBytes", total);
            if (status == DownloadManager.STATUS_FAILED) {
                result.put("reason", cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)));
            }
            return result;
        }
    }
}
