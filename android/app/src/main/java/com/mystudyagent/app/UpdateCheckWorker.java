package com.mystudyagent.app;

import android.app.DownloadManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

public class UpdateCheckWorker extends Worker {
    private static final String RELEASES_URL = "https://api.github.com/repos/qiuyinlan/my_study_agent/releases?per_page=10";

    public UpdateCheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(RELEASES_URL).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(15000);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("User-Agent", "MyStudyAgent-Android-Updater");
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return Result.retry();

            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }
            JSONArray releases = new JSONArray(body.toString());
            for (int i = 0; i < releases.length(); i++) {
                JSONObject release = releases.getJSONObject(i);
                if (release.optBoolean("draft", false) || release.optBoolean("prerelease", false)) continue;
                String version = cleanVersion(release.optString("tag_name", ""));
                String currentVersion = getApplicationContext().getPackageManager()
                        .getPackageInfo(getApplicationContext().getPackageName(), 0).versionName;
                if (version.isEmpty() || compareVersions(version, currentVersion) <= 0) continue;

                String apkUrl = findApk(release.optJSONArray("assets"));
                if (apkUrl.isEmpty()) continue;
                if (hasUsableDownload(version)) return Result.success();

                long id = AppUpdaterPlugin.enqueueDownload(getApplicationContext(), apkUrl, version);
                AppUpdaterPlugin.saveDownload(getApplicationContext(), id, version);
                return Result.success();
            }
            return Result.success();
        } catch (Exception error) {
            return Result.retry();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private boolean hasUsableDownload(String version) {
        Context context = getApplicationContext();
        android.content.SharedPreferences prefs = context.getSharedPreferences("app_update_download", Context.MODE_PRIVATE);
        if (!version.equals(prefs.getString("version", ""))) return false;
        long id = prefs.getLong("downloadId", -1L);
        if (id < 0) return false;
        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor == null || !cursor.moveToFirst()) return false;
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            return status != DownloadManager.STATUS_FAILED;
        }
    }

    private static String findApk(JSONArray assets) {
        if (assets == null) return "";
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.optJSONObject(i);
            if (asset != null && "MyStudyAgent.apk".equals(asset.optString("name"))) {
                String url = asset.optString("browser_download_url", "");
                Uri uri = Uri.parse(url);
                if ("https".equals(uri.getScheme()) && "github.com".equals(uri.getHost())) return url;
            }
        }
        return "";
    }

    private static String cleanVersion(String value) {
        String version = value.startsWith("v") || value.startsWith("V") ? value.substring(1) : value;
        return version.matches("\\d+\\.\\d+\\.\\d+") ? version : "";
    }

    private static int compareVersions(String left, String right) {
        String[] a = left.split("\\."), b = right.split("\\.");
        for (int i = 0; i < 3; i++) {
            int x = i < a.length ? Integer.parseInt(a[i]) : 0;
            int y = i < b.length ? Integer.parseInt(b[i]) : 0;
            if (x != y) return Integer.compare(x, y);
        }
        return 0;
    }
}
