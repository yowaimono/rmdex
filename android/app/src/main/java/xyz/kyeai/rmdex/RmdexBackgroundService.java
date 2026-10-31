package xyz.kyeai.rmdex;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.SharedPreferences;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class RmdexBackgroundService extends Service {
    public static final String EXTRA_RELAY_URL = "relayUrl";
    public static final String EXTRA_PUSH_TOKEN = "pushToken";
    public static final String ACTION_STOP = "xyz.kyeai.rmdex.action.STOP_BACKGROUND_SERVICE";
    private static final String CONNECTION_CHANNEL = "rmdex-connection";
    private static final String TASK_CHANNEL = "rmdex-task-alerts-v2";
    private static final int SERVICE_NOTIFICATION_ID = 18787;
    private static final String PREFERENCES = "rmdex-background-service";
    private static final String PREF_RELAY_URL = "relayUrl";
    private static final String PREF_PUSH_TOKEN = "pushToken";
    private static final String PREF_CURSOR = "cursor";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile boolean stopped;
    private volatile boolean polling;
    private String relayUrl;
    private String pushToken;
    private long cursor;
    private SharedPreferences preferences;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE);
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rmdex:notification-poll");
            wakeLock.setReferenceCounted(false);
        }
        restoreState();
        createChannels();
        startForeground(SERVICE_NOTIFICATION_ID, serviceNotification());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            clearState();
            stopped = true;
            stopForeground(true);
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (intent != null) {
            String nextRelayUrl = intent.getStringExtra(EXTRA_RELAY_URL);
            String nextPushToken = intent.getStringExtra(EXTRA_PUSH_TOKEN);
            if (nextRelayUrl != null && !nextRelayUrl.isEmpty() && nextPushToken != null && !nextPushToken.isEmpty()) {
                if (!nextRelayUrl.equals(relayUrl) || !nextPushToken.equals(pushToken)) cursor = 0;
                relayUrl = nextRelayUrl;
                pushToken = nextPushToken;
                persistState();
            }
        }
        stopped = false;
        if (!polling && relayUrl != null && pushToken != null) {
            polling = true;
            executor.submit(this::pollLoop);
        }
        return START_STICKY;
    }

    private void pollLoop() {
        try {
            while (!stopped && relayUrl != null && pushToken != null) {
                HttpURLConnection connection = null;
                try {
                    if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(40_000L);
                    String query = "/api/notifications/poll?wait=25000&after=" + cursor;
                    URL url = new URL(relayUrl.replaceAll("/$", "") + query);
                    connection = (HttpURLConnection) url.openConnection();
                    connection.setRequestMethod("GET");
                    connection.setConnectTimeout(10000);
                    connection.setReadTimeout(35000);
                    connection.setRequestProperty("Authorization", "Bearer " + pushToken);
                    int status = connection.getResponseCode();
                    if (status == HttpURLConnection.HTTP_UNAUTHORIZED || status == HttpURLConnection.HTTP_FORBIDDEN) {
                        clearState();
                        stopSelf();
                        return;
                    }
                    if (status != HttpURLConnection.HTTP_OK) throw new IllegalStateException("poll HTTP " + status);
                    String text = read(connection.getInputStream());
                    JSONObject response = new JSONObject(text);
                    cursor = Math.max(cursor, response.optLong("cursor", cursor));
                    persistCursor();
                    JSONArray events = response.optJSONArray("data");
                    if (events != null) for (int index = 0; index < events.length(); index++) showTask(events.getJSONObject(index));
                } catch (Exception ignored) {
                    sleep(3000);
                } finally {
                    if (connection != null) connection.disconnect();
                    if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
                }
            }
        } finally {
            polling = false;
        }
    }

    private void restoreState() {
        if (preferences == null) return;
        if (relayUrl == null || relayUrl.isEmpty()) relayUrl = preferences.getString(PREF_RELAY_URL, null);
        if (pushToken == null || pushToken.isEmpty()) pushToken = preferences.getString(PREF_PUSH_TOKEN, null);
        cursor = Math.max(cursor, preferences.getLong(PREF_CURSOR, 0));
    }

    private void persistState() {
        if (preferences == null) return;
        preferences.edit()
                .putString(PREF_RELAY_URL, relayUrl)
                .putString(PREF_PUSH_TOKEN, pushToken)
                .putLong(PREF_CURSOR, cursor)
                .apply();
    }

    private void persistCursor() {
        if (preferences != null) preferences.edit().putLong(PREF_CURSOR, cursor).apply();
    }

    private void clearState() {
        relayUrl = null;
        pushToken = null;
        cursor = 0;
        if (preferences != null) preferences.edit().clear().apply();
    }

    private void showTask(JSONObject event) {
        String threadId = event.optString("threadId", "");
        if (threadId.isEmpty()) return;
        String title = event.optString("title", "Codex 任务已完成");
        String body = event.optString("body", "点击查看任务结果");
        Intent intent = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse("https://code.kyeai.xyz/#thread=" + Uri.encode(threadId)))
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, threadId.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(this, TASK_CHANNEL)
                .setSmallIcon(android.R.drawable.ic_popup_sync)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setDefaults(Notification.DEFAULT_ALL)
                .setTicker(title)
                .build();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(Math.abs((threadId + event.optString("turnId", "")).hashCode()), notification);
    }

    private Notification serviceNotification() {
        Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 18788, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CONNECTION_CHANNEL)
                .setSmallIcon(android.R.drawable.ic_popup_sync)
                .setContentTitle("rmdex 后台连接")
                .setContentText("正在等待 Codex 任务完成提醒")
                .setOngoing(true)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        manager.createNotificationChannel(new NotificationChannel(CONNECTION_CHANNEL, "后台连接", NotificationManager.IMPORTANCE_LOW));
        NotificationChannel taskChannel = new NotificationChannel(TASK_CHANNEL, "任务完成提醒", NotificationManager.IMPORTANCE_HIGH);
        taskChannel.setDescription("Codex 任务完成时弹出声音和震动提醒");
        taskChannel.enableVibration(true);
        taskChannel.setVibrationPattern(new long[]{0, 300, 180, 300});
        taskChannel.setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
        taskChannel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(taskChannel);
    }

    private static String read(InputStream input) throws Exception {
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) result.append(line);
        }
        return result.toString();
    }

    private static void sleep(long milliseconds) {
        try { Thread.sleep(milliseconds); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
    }

    @Override
    public void onDestroy() {
        stopped = true;
        executor.shutdownNow();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }
}
