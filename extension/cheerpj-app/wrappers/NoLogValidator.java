import java.util.logging.LogManager;
import java.util.logging.Logger;
import java.util.logging.Level;

/**
 * Wrapper that disables java.util.logging before delegating to
 * com.aav.nist.BrowserValidator.main(). CheerpJ 4.0's Java 11 runtime is
 * missing the StackStreamFactory_checkStackWalkModes JNI binding, which
 * blows up the moment any code calls Logger.info() (because SimpleFormatter
 * walks the stack to infer the caller class). Resetting the LogManager
 * removes all handlers, so format() is never called.
 */
public class NoLogValidator {
    public static void main(String[] args) throws Exception {
        // Reset first: removes ConsoleHandler from root logger
        LogManager.getLogManager().reset();
        // Belt + suspenders: also force level OFF on root
        Logger.getLogger("").setLevel(Level.OFF);
        // Delegate
        com.aav.nist.BrowserValidator.main(args);
    }
}
