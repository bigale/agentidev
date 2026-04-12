package com.agentidev;

/**
 * Bridge class for CheerpJ library mode. The native method sendResult()
 * is implemented in JavaScript via cheerpjInit({ natives: {...} }). When
 * Java calls sendResult(str), LiveConnect auto-converts the Java String
 * to a JS string at the parameter boundary — bypassing the Proxy-to-
 * primitive coercion issue on method return values.
 *
 * Usage from the runtime page:
 *   1. Load this JAR alongside the target JAR on the classpath
 *   2. Call the target method via library mode Proxy walk
 *   3. Pass the return value to AgentidevBridge.sendResult()
 *   4. JS side awaits window._waitForNativeResult()
 */
public class AgentidevBridge {
    /**
     * Send a string result back to JavaScript via the native method bridge.
     * LiveConnect converts the Java String parameter to a JS string.
     */
    public static native void sendResult(String result);
}
