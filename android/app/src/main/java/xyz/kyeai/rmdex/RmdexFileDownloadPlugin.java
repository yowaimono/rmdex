package xyz.kyeai.rmdex;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.util.HashSet;
import java.util.Set;

@CapacitorPlugin(name = "RmdexFileDownload")
public class RmdexFileDownloadPlugin extends Plugin {
    private final Set<Long> downloads = new HashSet<>();

    @PluginMethod
    public void enqueue(PluginCall call) {
        String url = call.getString("url", "");
        String fileName = safeFileName(call.getString("fileName", "download"));
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String authorization = call.getString("authorization", "");
        if (url.isEmpty()) {
            call.reject("缺少下载地址");
            return;
        }
        try {
            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                call.reject("系统下载服务不可用");
                return;
            }
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                    .setTitle(fileName)
                    .setDescription("rmdex 产物")
                    .setMimeType(mimeType)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setAllowedOverMetered(true)
                    .setAllowedOverRoaming(true)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, uniqueDownloadName(fileName));
            if (!authorization.isEmpty()) request.addRequestHeader("Authorization", authorization);
            long id = manager.enqueue(request);
            synchronized (downloads) { downloads.add(id); }
            JSObject result = new JSObject();
            // Keep DownloadManager ids as strings across the Capacitor bridge.
            // Some Android WebViews do not preserve Java long values reliably as JS numbers.
            result.put("id", String.valueOf(id));
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("无法开始系统下载", error);
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        long id = readDownloadId(call);
        if (id < 0) {
            call.reject("下载任务无效");
            return;
        }
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            call.reject("系统下载服务不可用");
            return;
        }
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
            JSObject result = new JSObject();
            if (cursor == null || !cursor.moveToFirst()) {
                result.put("status", "failed");
                result.put("loaded", 0);
                result.put("total", 0);
                call.resolve(result);
                return;
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long loaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            result.put("status", statusName(status));
            result.put("loaded", loaded);
            result.put("total", total);
            call.resolve(result);
            if (status == DownloadManager.STATUS_SUCCESSFUL || status == DownloadManager.STATUS_FAILED) {
                synchronized (downloads) { downloads.remove(id); }
            }
        } catch (RuntimeException error) {
            call.reject("读取系统下载进度失败", error);
        }
    }

    private static long readDownloadId(PluginCall call) {
        Object raw = call.getData().opt("id");
        if (raw instanceof Number) return ((Number) raw).longValue();
        if (raw instanceof String) {
            try { return Long.parseLong((String) raw); } catch (NumberFormatException ignored) { return -1L; }
        }
        return -1L;
    }

    @PluginMethod
    public void openDownloads(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Intent fallback = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    fallback.putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUri(
                            "com.android.externalstorage.documents", "primary:Download"));
                }
                getContext().startActivity(fallback);
                call.resolve();
            } catch (ActivityNotFoundException error) {
                try {
                    Intent generic = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    getContext().startActivity(generic);
                    call.resolve();
                } catch (RuntimeException fallbackError) { call.reject("没有可用的文件管理器", fallbackError); }
            } catch (RuntimeException error) { call.reject("无法打开下载目录", error); }
        });
    }

    private static String statusName(int status) {
        if (status == DownloadManager.STATUS_SUCCESSFUL) return "completed";
        if (status == DownloadManager.STATUS_FAILED) return "failed";
        if (status == DownloadManager.STATUS_PAUSED) return "downloading";
        return "downloading";
    }

    private String uniqueDownloadName(String name) {
        File directory = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        String base = name;
        String extension = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) { base = name.substring(0, dot); extension = name.substring(dot); }
        String candidate = name;
        int index = 1;
        while (new File(directory, candidate).exists()) candidate = base + " (" + index++ + ")" + extension;
        return candidate;
    }

    private static String safeFileName(String value) {
        String name = value == null || value.trim().isEmpty() ? "download" : value.trim();
        name = name.replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_");
        if (name.equals(".") || name.equals("..")) return "download";
        return name.length() > 180 ? name.substring(0, 180) : name;
    }
}
