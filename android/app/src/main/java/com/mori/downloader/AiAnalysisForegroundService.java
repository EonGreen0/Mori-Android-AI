package com.mori.downloader;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import org.json.JSONObject;

public class AiAnalysisForegroundService extends Service {
    private static final String CHANNEL_ID = "mori_ai_analysis_channel_v1";
    private static final int NOTIFICATION_ID = 2002;
    private static final String EXTRA_PAYLOAD = "payload";
    private static volatile boolean running = false;

    public static void dispatch(Context context, String payload) {
        Intent intent = new Intent(context, AiAnalysisForegroundService.class);
        intent.putExtra(EXTRA_PAYLOAD, payload);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !running) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String payload = intent != null ? intent.getStringExtra(EXTRA_PAYLOAD) : null;
        try {
            JSONObject data = new JSONObject(payload != null ? payload : "{}");
            String action = safeText(data.optString("action"), 24);
            if ("finish".equals(action)) {
                Notification notification = buildFinalNotification(data);
                startForeground(NOTIFICATION_ID, notification);
                stopForeground(STOP_FOREGROUND_DETACH);
                NotificationManager manager = getSystemService(NotificationManager.class);
                if (manager != null) manager.notify(NOTIFICATION_ID, notification);
                running = false;
                stopSelf();
            } else {
                Notification notification = buildProgressNotification(data);
                startForeground(NOTIFICATION_ID, notification);
                NotificationManager manager = getSystemService(NotificationManager.class);
                if (manager != null) manager.notify(NOTIFICATION_ID, notification);
                running = true;
            }
        } catch (Throwable error) {
            if (running) {
                stopForeground(STOP_FOREGROUND_REMOVE);
                running = false;
            }
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildProgressNotification(JSONObject data) {
        int total = Math.max(1, Math.min(999, data.optInt("total", 1)));
        int current = Math.max(0, Math.min(total, data.optInt("current", 0)));
        String title = textOr(data.optString("title"), "AI 正在分析图片");
        String text = textOr(data.optString("text"), "正在分析 " + current + "/" + total);
        String shortText = safeText(data.optString("shortText"), 16);
        PendingIntent contentIntent = contentIntent();

        if (Build.VERSION.SDK_INT >= 36) {
            Notification.ProgressStyle style = new Notification.ProgressStyle()
                    .setProgress(current)
                    .setStyledByProgress(true)
                    .addProgressSegment(new Notification.ProgressStyle.Segment(total))
                    .setProgressTrackerIcon(Icon.createWithResource(this, R.drawable.ic_ai_progress));
            Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_ai_progress)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setSubText(shortText)
                    .setCategory(Notification.CATEGORY_PROGRESS)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setShowWhen(false)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setContentIntent(contentIntent)
                    .setProgress(total, current, false)
                    .setStyle(style);
            if (!shortText.isEmpty()) builder.setShortCriticalText(shortText);
            return builder.build();
        }

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_ai_progress)
                .setContentTitle(title)
                .setContentText(text)
                .setSubText(shortText)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setProgress(total, current, false)
                .setContentIntent(contentIntent)
                .build();
    }

    private Notification buildFinalNotification(JSONObject data) {
        String state = safeText(data.optString("state"), 20);
        String fallbackTitle = "complete".equals(state) ? "AI 分析完成" : "AI 分析未完成";
        String title = textOr(data.optString("title"), fallbackTitle);
        String text = textOr(data.optString("text"), fallbackTitle);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_ai_progress)
                .setContentTitle(title)
                .setContentText(text)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(false)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(contentIntent())
                .build();
    }

    private PendingIntent contentIntent() {
        Intent launch = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                this,
                0,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private String textOr(String value, String fallback) {
        String text = safeText(value, 220);
        return text.isEmpty() ? fallback : text;
    }

    private String safeText(String value, int maxLength) {
        String text = String.valueOf(value == null ? "" : value)
                .replaceAll("[\\r\\n\\t]+", " ")
                .replaceAll("\\s{2,}", " ")
                .trim();
        return text.substring(0, Math.min(maxLength, text.length()));
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Mori AI image analysis",
                NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Shows live progress while Mori analyzes images");
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setShowBadge(false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }
}
