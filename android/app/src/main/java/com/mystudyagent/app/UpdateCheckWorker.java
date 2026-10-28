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
    // Releases API 未登录每小时只有 60 次、按出口 IP 算，共享 IP（VPN/运营商 NAT）
    // 很容易 403。这两个静态文件带 CORS、不走 API 配额，作为后台检查的兜底。
    private static final String[] MANIFEST_URLS = {
            "https://cdn.jsdelivr.net/gh/qiuyinlan/my_study_agent@main/package.json",
            "https://fastly.jsdelivr.net/gh/qiuyinlan/my_study_agent@main/package.json",
            "https://raw.githubusercontent.com/qiuyinlan/my_study_agent/main/package.json",
    };

    public UpdateCheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            Release latest = fetchLatestRelease();
            if (latest == null) latest = fetchManifestVersion();
            if (latest == null) return Result.retry();

            String currentVersion = getApplicationContext().getPackageManager()
                    .getPackageInfo(getApplicationContext().getPackageName(), 0).versionName;
            if (compareVersions(latest.version, currentVersion) <= 0) return Result.success();
            if (hasUsableDownload(latest.version)) return Result.success();

            long id = AppUpdaterPlugin.enqueueDownload(getApplicationContext(), latest.url, latest.version, false);
            AppUpdaterPlugin.saveDownload(getApplicationContext(), id, latest.version);
            return Result.success();
        } catch (Exception error) {
            return Result.retry();
        }
    }

    private static final class Release {
        final String version;
        final String url;

        Release(String version, String url) {
            this.version = version;
            this.url = url;
        }
    }

    private Release fetchLatestRelease() {
        HttpURLConnection connection = null;
        try {
            connection = open(RELEASES_URL);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;
            JSONArray releases = new JSONArray(readAll(connection));
            for (int i = 0; i < releases.length(); i++) {
                JSONObject release = releases.getJSONObject(i);
                if (release.optBoolean("draft", false) || release.optBoolean("prerelease", false)) continue;
                String version = cleanVersion(release.optString("tag_name", ""));
                if (version.isEmpty()) continue;
                String apkUrl = findApk(release.optJSONArray("assets"));
                if (apkUrl.isEmpty()) continue;
                return new Release(version, apkUrl);
            }
            return null;
        } catch (Exception error) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private Release fetchManifestVersion() {
        for (String url : MANIFEST_URLS) {
            HttpURLConnection connection = null;
            try {
                connection = open(url);
                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) continue;
                JSONObject manifest = new JSONObject(readAll(connection));
                String version = cleanVersion(manifest.optString("version", ""));
                if (version.isEmpty()) continue;
                return new Release(version, apkUrlFor(version));
            } catch (Exception ignored) {
                // 试下一个源
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        return null;
    }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("User-Agent", "MyStudyAgent-Android-Updater");
        return connection;
    }

    private static String readAll(HttpURLConnection connection) throws Exception {
        StringBuilder body = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) body.append(line);
        }
        return body.toString();
    }

    private static String apkUrlFor(String version) {
        return "https://github.com/qiuyinlan/my_study_agent/releases/download/v" + version + "/MyStudyAgent.apk";
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
