package innovationday.walle.app;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * A raw TCP socket, exposed to the WebView.
 *
 * This plugin is deliberately dumb. It knows three things: open a socket,
 * write bytes, read bytes. It does NOT know what a byte means.
 *
 * That matters because the protocol — framing, the 700 ms watchdog, reconnect
 * backoff, every safety rule — lives in TypeScript, in
 * {@code src/shared/robotCore.ts}, and is shared with the desktop server. If
 * the framing lived here as well it would exist twice and drift, and the two
 * implementations would disagree about what a command means.
 *
 * Payloads cross the bridge as base64 so arbitrary binary survives the trip;
 * the WebView side decodes it back to bytes and hands it to RobotCore.
 *
 * All socket work happens on a background thread: Android throws
 * NetworkOnMainThreadException if it does not.
 */
@CapacitorPlugin(name = "WallETcp")
public class WallETcpPlugin extends Plugin {

    private static final int CONNECT_TIMEOUT_MS = 4000;

    private Socket socket;
    private OutputStream out;
    private InputStream in;
    private Thread readerThread;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final AtomicBoolean closing = new AtomicBoolean(false);

    // ------------------------------------------------------------------
    // JS surface
    // ------------------------------------------------------------------

    /** Open a connection. Resolves once the handshake completes. */
    @PluginMethod
    public void connect(final PluginCall call) {
        final String host = call.getString("host");
        final int port = call.getInt("port", 8080);

        if (host == null || host.trim().isEmpty()) {
            call.reject("host is required");
            return;
        }

        io.execute(() -> {
            closeQuietly();
            closing.set(false);
            try {
                final Socket s = new Socket();
                s.setTcpNoDelay(true); // frames are 10 bytes; Nagle only adds latency
                s.connect(new InetSocketAddress(host.trim(), port), CONNECT_TIMEOUT_MS);

                socket = s;
                out = s.getOutputStream();
                in = s.getInputStream();

                startReader();

                final JSObject result = new JSObject();
                result.put("host", host.trim());
                result.put("port", port);
                call.resolve(result);
            } catch (Exception e) {
                closeQuietly();
                call.reject("connect failed: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Write bytes. base64 is the payload's own encoding; the plugin does not
     * interpret it beyond decoding to a byte array.
     */
    @PluginMethod
    public void send(final PluginCall call) {
        final String b64 = call.getString("data");
        if (b64 == null) {
            call.reject("data is required");
            return;
        }

        io.execute(() -> {
            final OutputStream stream = out;
            if (stream == null) {
                call.reject("not connected");
                return;
            }
            try {
                stream.write(Base64.decode(b64, Base64.DEFAULT));
                stream.flush();
                call.resolve();
            } catch (Exception e) {
                call.reject("write failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void close(final PluginCall call) {
        closeQuietly();
        call.resolve();
    }

    @PluginMethod
    public void isConnected(final PluginCall call) {
        final Socket s = socket;
        final boolean up = s != null && s.isConnected() && !s.isClosed();
        final JSObject result = new JSObject();
        result.put("connected", up);
        call.resolve(result);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /**
     * Pump bytes to JS until the socket closes.
     *
     * A single "close" event carries the reason, so RobotCore can schedule a
     * reconnect exactly as it would for a Node socket. Bytes may arrive in any
     * grouping — a read can return half a packet or three — which is precisely
     * why RobotCore owns the reassembly rather than this plugin.
     */
    private void startReader() {
        closing.set(false);
        readerThread = new Thread(() -> {
            final byte[] buffer = new byte[4096];
            try {
                int n;
                while (!closing.get() && (n = in.read(buffer)) != -1) {
                    if (n <= 0) continue;
                    final byte[] chunk = new byte[n];
                    System.arraycopy(buffer, 0, chunk, 0, n);

                    final JSObject event = new JSObject();
                    event.put("data", Base64.encodeToString(chunk, Base64.NO_WRAP));
                    notifyListeners("data", event);
                }
                emitClosed("closed by peer");
            } catch (Exception e) {
                emitClosed(e.getMessage() == null ? "read failed" : e.getMessage());
            }
        }, "walle-tcp-reader");
        readerThread.setDaemon(true);
        readerThread.start();
    }

    private void emitClosed(String reason) {
        final JSObject event = new JSObject();
        event.put("reason", reason);
        notifyListeners("closed", event);
    }

    private void closeQuietly() {
        closing.set(true);
        if (readerThread != null) {
            readerThread.interrupt();
            readerThread = null;
        }
        try {
            if (socket != null) socket.close();
        } catch (Exception ignored) {
            // Already gone; nothing useful to do.
        }
        socket = null;
        out = null;
        in = null;
    }

    @Override
    protected void handleOnDestroy() {
        closeQuietly();
        io.shutdownNow();
        super.handleOnDestroy();
    }

    /** Kept so lint does not flag the unused import when logging is added. */
    @SuppressWarnings("unused")
    private static String utf8(byte[] b) {
        return new String(b, StandardCharsets.UTF_8);
    }
}