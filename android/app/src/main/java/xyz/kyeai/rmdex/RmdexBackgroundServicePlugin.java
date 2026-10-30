package xyz.kyeai.rmdex;

import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

@CapacitorPlugin(name = "RmdexBackgroundService")
public class RmdexBackgroundServicePlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        String relayUrl = call.getString("relayUrl");
        String pushToken = call.getString("pushToken");
        if (relayUrl == null || pushToken == null || relayUrl.isEmpty() || pushToken.isEmpty()) {
            call.reject("缺少后台连接参数");
            return;
        }
        Intent intent = new Intent(getContext(), RmdexBackgroundService.class)
                .putExtra(RmdexBackgroundService.EXTRA_RELAY_URL, relayUrl)
                .putExtra(RmdexBackgroundService.EXTRA_PUSH_TOKEN, pushToken);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(getContext(), intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), RmdexBackgroundService.class)
                .setAction(RmdexBackgroundService.ACTION_STOP);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(getContext(), intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }
}
