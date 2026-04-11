/**
 * Tiny wrapper that lets the cheerpj runtime invoke BeanShell as a Java
 * scripting interpreter from a single command line. main() takes one string
 * argument (the BSH expression to eval) and prints the result.
 *
 * Used by extension/lib/host/runtimes/jython.js (Phase 3 composition proof)
 * and runs on top of cheerpj — same pattern as the NoLogValidator wrapper
 * from Phase 1.8.
 */
public class BshEval {
    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.out.println("usage: BshEval <code>");
            return;
        }
        bsh.Interpreter interp = new bsh.Interpreter();
        Object result = interp.eval(args[0]);
        System.out.println(result == null ? "null" : result.toString());
    }
}
