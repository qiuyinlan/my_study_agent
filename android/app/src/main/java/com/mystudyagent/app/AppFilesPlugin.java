package com.mystudyagent.app;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 备份文件的读写入口。
 *
 * 为什么需要原生实现：WebView 里的 &lt;input type=file&gt; 在不少国产 ROM 上根本
 * 不弹选择器，&lt;a download&gt; 也不会真的把文件落盘 —— 用户点「导出/导入」只会得到
 * 一个"没反应"。这里改用系统 SAF（Storage Access Framework）：
 *   · 导出 → ACTION_CREATE_DOCUMENT，用户自己挑保存位置（下载目录、网盘、微信…）
 *   · 导入 → ACTION_OPEN_DOCUMENT，用户自己挑文件
 * 两者都是系统对话框，行为和文件管理器一致，也不需要申请存储权限。
 */
@CapacitorPlugin(name = "AppFiles")
public class AppFilesPlugin extends Plugin {
    private static final int MAX_BYTES = 64 * 1024 * 1024;

    @PluginMethod
    public void saveTextFile(PluginCall call) {
        String text = call.getString("text", null);
        if (text == null) {
            call.reject("没有要保存的内容");
            return;
        }
        String name = call.getString("name", "backup.json");
        String mime = call.getString("mime", "application/json");

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "saveResult");
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = resultData(result);
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            call.reject("cancelled");
            return;
        }
        String text = call.getString("text", "");
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new IllegalStateException("无法打开目标文件");
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.flush();
            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            ret.put("name", displayName(uri));
            call.resolve(ret);
        } catch (Exception error) {
            call.reject("写入失败：" + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void pickTextFile(PluginCall call) {
        String mime = call.getString("mime", "application/json");
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        // 很多文件管理器不把 application/json 当成可显示类型，用 */* 再限定 MIME 优先项。
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{ mime, "text/plain", "application/octet-stream" });
        startActivityForResult(call, intent, "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = resultData(result);
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            call.reject("cancelled");
            return;
        }
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IllegalStateException("无法读取这个文件");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            int total = 0;
            while ((read = in.read(chunk)) != -1) {
                total += read;
                if (total > MAX_BYTES) throw new IllegalStateException("文件太大（超过 64MB），不像是备份文件");
                buffer.write(chunk, 0, read);
            }
            JSObject ret = new JSObject();
            ret.put("name", displayName(uri));
            ret.put("text", buffer.toString("UTF-8"));
            call.resolve(ret);
        } catch (Exception error) {
            call.reject("读取失败：" + error.getMessage(), error);
        }
    }

    private Uri resultData(ActivityResult result) {
        Intent data = result.getData();
        return data == null ? null : data.getData();
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver()
                .query(uri, new String[]{ OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {
            // 拿不到文件名不影响读写，用路径兜底
        }
        String fallback = uri.getLastPathSegment();
        return fallback == null ? "backup.json" : fallback;
    }
}
