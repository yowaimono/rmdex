package xyz.kyeai.rmdex;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "RmdexBrowser")
public class RmdexBrowserPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String value = call.getString("url", "");
        Uri uri = Uri.parse(value);
        if (!RmdexBrowserActivity.isWebUri(uri)) {
            call.reject("仅支持 HTTP 或 HTTPS 网页链接");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(new Intent(getContext(), RmdexBrowserActivity.class).putExtra("url", uri.toString()));
                call.resolve();
            } catch (RuntimeException error) { call.reject("网页窗口无法打开", error); }
        });
    }
}
