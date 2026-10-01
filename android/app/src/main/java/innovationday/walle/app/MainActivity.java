package innovationday.walle.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;

/**
 * The app's single Activity.
 *
 * WallETcpPlugin is registered here rather than relying on Capacitor's
 * generated plugin list, because a plugin written inside the app project is
 * not on that list until someone regenerates it.
 */
public class MainActivity extends BridgeActivity {

    private static final int REQ_MIC = 4242;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must run before super.onCreate, which builds the bridge and would
        // otherwise start without the plugin.
        registerPlugin(WallETcpPlugin.class);
        super.onCreate(savedInstanceState);
        requestMicrophone();
    }

    /**
     * Ask for the microphone once, on first launch.
     *
     * The robot has no microphone, so this is the only way a child can talk to
     * it. It is requested up front rather than on first mic press so the
     * permission dialog is not stacked on top of the demo: Android only makes
     * this look reasonable if it is not interrupted.
     */
    private void requestMicrophone() {
        final String permission = Manifest.permission.RECORD_AUDIO;
        final boolean granted =
                ContextCompat.checkSelfPermission(this, permission)
                        == PackageManager.PERMISSION_GRANTED;
        if (granted) return;

        ActivityCompat.requestPermissions(this, new String[] { permission }, REQ_MIC);
    }

    /** Convenience for anything that needs to know the bridge is ready. */
    @SuppressWarnings("unused")
    Class<? extends Plugin> tcpPlugin() {
        return WallETcpPlugin.class;
    }
}