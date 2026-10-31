package xyz.kyeai.rmdex;

import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

/** An isolated browsing WebView: remote pages never receive the Capacitor bridge. */
public class RmdexBrowserActivity extends AppCompatActivity {
    private static final int INK = Color.rgb(38, 53, 69), MUTED = Color.rgb(130, 144, 160), BLUE = Color.rgb(8, 121, 249);
    private WebView webView;
    private TextView title, address, errorText;
    private LinearLayout errorPanel;
    private ProgressBar progress;
    private ImageButton back, forward;
    private String currentUrl;

    static boolean isWebUri(Uri uri) {
        return uri != null && ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))
                && uri.getHost() != null && !uri.getHost().isEmpty() && uri.getUserInfo() == null;
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        currentUrl = getIntent().getStringExtra("url");
        if (currentUrl == null || !isWebUri(Uri.parse(currentUrl))) { finish(); return; }
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(true);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightNavigationBars(true);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        setContentView(root);

        LinearLayout header = row();
        header.setPadding(dp(8), dp(4), dp(8), dp(4));
        header.setBackgroundColor(Color.rgb(248, 250, 252));
        header.addView(icon("关闭网页", "close", this::finish));
        LinearLayout labels = new LinearLayout(this);
        labels.setOrientation(LinearLayout.VERTICAL);
        labels.setPadding(dp(6), 0, dp(6), 0);
        title = text("网页", 15, INK);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        address = text(Uri.parse(currentUrl).getHost(), 11, MUTED);
        address.setSingleLine(true);
        address.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        labels.addView(title); labels.addView(address);
        labels.setContentDescription("网页标题和地址");
        labels.setOnClickListener(view -> Toast.makeText(this, currentUrl, Toast.LENGTH_LONG).show());
        header.addView(labels, new LinearLayout.LayoutParams(0, dp(48), 1));
        header.addView(icon("复制链接", "copy", this::copyLink));
        header.addView(icon("在浏览器中打开", "external", this::openExternal));
        root.addView(header, new LinearLayout.LayoutParams(-1, dp(64)));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(BLUE));
        progress.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(232, 237, 243)));
        root.addView(progress, new LinearLayout.LayoutParams(-1, dp(2)));

        FrameLayout content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        webView = new WebView(this);
        content.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        webView.setBackgroundColor(Color.WHITE);
        // No addJavascriptInterface, permission auto-grants, or SSL-error bypass.
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (isWebUri(request.getUrl())) return false;
                if (request.isForMainFrame()) Toast.makeText(RmdexBrowserActivity.this, "此链接需要在对应应用中打开", Toast.LENGTH_SHORT).show();
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                currentUrl = url;
                address.setText(Uri.parse(url).getHost());
                title.setText("正在打开…");
                errorPanel.setVisibility(View.GONE);
                progress.setVisibility(View.VISIBLE);
                updateNavigation();
            }
            @Override public void onPageFinished(WebView view, String url) { updateNavigation(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError("网页暂时无法加载，请检查网络后重试。");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) showError("网页返回错误（" + response.getStatusCode() + "），可重试或在浏览器中打开。");
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) { progress.setProgress(value); if (value == 100) progress.setVisibility(View.INVISIBLE); }
            @Override public void onReceivedTitle(WebView view, String value) { title.setText(value == null || value.isEmpty() ? "网页" : value); }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, Message result) {
                if (!userGesture) return false;
                WebView popup = new WebView(RmdexBrowserActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) {
                        if (isWebUri(request.getUrl())) webView.loadUrl(request.getUrl().toString());
                        popup.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(popup);
                result.sendToTarget();
                return true;
            }
        });

        errorPanel = new LinearLayout(this);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setPadding(dp(28), dp(24), dp(28), dp(24));
        errorPanel.setBackgroundColor(Color.rgb(248, 250, 252));
        TextView errorTitle = text("暂时无法打开网页", 19, INK);
        errorTitle.setTypeface(null, android.graphics.Typeface.BOLD);
        errorText = text("", 14, MUTED);
        errorText.setGravity(Gravity.CENTER);
        errorText.setPadding(0, dp(12), 0, dp(24));
        Button retry = new Button(this);
        retry.setText("重新加载");
        retry.setAllCaps(false);
        retry.setTextColor(Color.WHITE);
        android.graphics.drawable.GradientDrawable retryBackground = new android.graphics.drawable.GradientDrawable();
        retryBackground.setColor(BLUE); retryBackground.setCornerRadius(dp(7));
        retry.setBackground(retryBackground);
        retry.setPadding(dp(24), 0, dp(24), 0);
        retry.setOnClickListener(view -> webView.loadUrl(currentUrl));
        errorPanel.addView(errorTitle); errorPanel.addView(errorText);
        errorPanel.addView(retry, new LinearLayout.LayoutParams(-2, dp(44)));
        errorPanel.setVisibility(View.GONE);
        content.addView(errorPanel, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout navigation = row();
        navigation.setGravity(Gravity.CENTER);
        navigation.setBackgroundColor(Color.rgb(248, 250, 252));
        back = icon("上一页", "back", () -> { if (webView.canGoBack()) webView.goBack(); });
        forward = icon("下一页", "forward", () -> { if (webView.canGoForward()) webView.goForward(); });
        navigation.addView(back); navigation.addView(forward);
        navigation.addView(icon("刷新网页", "reload", () -> webView.reload()));
        root.addView(navigation, new LinearLayout.LayoutParams(-1, dp(52)));
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { if (webView.canGoBack()) webView.goBack(); else finish(); }
        });
        if (savedState == null || webView.restoreState(savedState) == null) webView.loadUrl(currentUrl);
        else { currentUrl = webView.getUrl(); address.setText(Uri.parse(currentUrl).getHost()); updateNavigation(); }
    }

    private LinearLayout row() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.HORIZONTAL); view.setGravity(Gravity.CENTER_VERTICAL); return view; }
    private TextView text(String value, int size, int color) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); return view; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private ImageButton icon(String label, String kind, Runnable action) {
        ImageButton button = new ImageButton(this);
        button.setContentDescription(label);
        button.setImageDrawable(new BrowserIcon(kind));
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setPadding(dp(14), dp(14), dp(14), dp(14));
        button.setLayoutParams(new ViewGroup.LayoutParams(dp(48), dp(48)));
        button.setOnClickListener(view -> action.run());
        return button;
    }
    private void updateNavigation() { if (back == null) return; back.setEnabled(webView.canGoBack()); back.setAlpha(webView.canGoBack() ? 1f : .3f); forward.setEnabled(webView.canGoForward()); forward.setAlpha(webView.canGoForward() ? 1f : .3f); }
    private void showError(String message) { errorText.setText(message); errorPanel.setVisibility(View.VISIBLE); progress.setVisibility(View.INVISIBLE); title.setText("加载失败"); }
    private void copyLink() { ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("网页链接", currentUrl)); Toast.makeText(this, "已复制链接", Toast.LENGTH_SHORT).show(); }
    private void openExternal() {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(currentUrl)).addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            android.content.pm.ResolveInfo target = getPackageManager().queryIntentActivities(intent, 0).stream()
                    .filter(info -> info.activityInfo != null && !getPackageName().equals(info.activityInfo.packageName))
                    .findFirst().orElse(null);
            if (target == null) { Toast.makeText(this, "没有可用的浏览器", Toast.LENGTH_SHORT).show(); return; }
            intent.setComponent(new android.content.ComponentName(target.activityInfo.packageName, target.activityInfo.name));
            startActivity(intent);
        } catch (RuntimeException error) { Toast.makeText(this, "没有可用的浏览器", Toast.LENGTH_SHORT).show(); }
    }
    @Override protected void onSaveInstanceState(Bundle state) { super.onSaveInstanceState(state); if (webView != null) webView.saveState(state); }
    @Override protected void onPause() { if (webView != null) webView.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (webView != null) webView.onResume(); }
    @Override protected void onDestroy() { if (webView != null) { ((ViewGroup) webView.getParent()).removeView(webView); webView.stopLoading(); webView.destroy(); } super.onDestroy(); }

    private static class BrowserIcon extends Drawable {
        private final String kind;
        BrowserIcon(String kind) { this.kind = kind; }
        @Override public void draw(Canvas canvas) {
            canvas.save(); canvas.translate(getBounds().left, getBounds().top); canvas.scale(getBounds().width() / 24f, getBounds().height() / 24f);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG); paint.setColor(MUTED); paint.setStrokeWidth(1.8f); paint.setStyle(Paint.Style.STROKE); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND);
            Path path = new Path();
            if (kind.equals("close")) { path.moveTo(6, 6); path.lineTo(18, 18); path.moveTo(18, 6); path.lineTo(6, 18); }
            else if (kind.equals("back") || kind.equals("forward")) { if (kind.equals("forward")) { canvas.translate(24, 0); canvas.scale(-1, 1); } path.moveTo(14, 5); path.lineTo(7, 12); path.lineTo(14, 19); }
            else if (kind.equals("copy")) { path.addRoundRect(8, 8, 20, 21, 2, 2, Path.Direction.CW); path.moveTo(16, 5); path.lineTo(16, 3); path.lineTo(3, 3); path.lineTo(3, 16); path.lineTo(5, 16); }
            else if (kind.equals("external")) { path.moveTo(14, 3); path.lineTo(21, 3); path.lineTo(21, 10); path.moveTo(21, 3); path.lineTo(11, 13); path.moveTo(10, 3); path.lineTo(4, 3); path.lineTo(3, 4); path.lineTo(3, 20); path.lineTo(4, 21); path.lineTo(20, 21); path.lineTo(21, 20); path.lineTo(21, 14); }
            else { path.addArc(4, 4, 20, 20, 45, 285); path.moveTo(20, 4); path.lineTo(20, 10); path.lineTo(14, 10); }
            canvas.drawPath(path, paint); canvas.restore();
        }
        @Override public void setAlpha(int alpha) { }
        @Override public void setColorFilter(ColorFilter filter) { }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }
}
