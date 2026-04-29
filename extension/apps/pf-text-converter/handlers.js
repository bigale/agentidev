/**
 * pf-text-converter plugin handlers.
 *
 * One handler — PF_TEXT_CONVERT — that defines and runs a PocketFlow flow
 * via the bridge. The flow is a 3-node graph adapted from the cookbook
 * pocketflow-flow example: Validate -> Transform on the happy path, or
 * Validate -> Reject when input is missing/invalid.
 *
 * The flow source is embedded as a string constant. Each button click
 * idempotently defines the flow on disk (~5ms) and runs it. That way the
 * plugin source is the single source of truth — bumping the plugin updates
 * the on-disk flow on next click.
 */

// PocketFlow source — kept as a string so the plugin file is the source
// of truth. The bridge's BRIDGE_FLOW_DEFINE writes this verbatim to
// ~/.agentidev/flows/pf-text-converter.py on each call.
const FLOW_SOURCE = `"""
pf-text-converter — Validate -> Transform | Reject

Adapted from PocketFlow's cookbook/pocketflow-flow text converter.
The cookbook version uses input() for interactive use; this version is
driven by shared state set by the plugin handler so it can run headless
under the bridge's flow runner.

Read text + choice from shared, dispatch to a transformation, return.
"""
import json
import sys

from pocketflow import Flow, Node


VALID_CHOICES = {"upper", "lower", "reverse", "collapse"}


class Validate(Node):
    def prep(self, shared):
        return {
            "text": shared.get("text", ""),
            "choice": shared.get("choice", ""),
        }

    def exec(self, prep_res):
        text, choice = prep_res["text"], prep_res["choice"]
        if not isinstance(text, str) or not text.strip():
            return {"valid": False, "reason": "text is required"}
        if choice not in VALID_CHOICES:
            return {"valid": False, "reason": f"choice must be one of {sorted(VALID_CHOICES)}"}
        return {"valid": True}

    def post(self, shared, prep_res, exec_res):
        if exec_res["valid"]:
            shared["validated"] = True
            return "valid"
        shared["error"] = exec_res["reason"]
        return "invalid"


class Transform(Node):
    def prep(self, shared):
        return shared["text"], shared["choice"]

    def exec(self, inputs):
        text, choice = inputs
        if choice == "upper": return text.upper()
        if choice == "lower": return text.lower()
        if choice == "reverse": return text[::-1]
        if choice == "collapse": return " ".join(text.split())
        return text  # unreachable — Validate guards this

    def post(self, shared, prep_res, exec_res):
        shared["result"] = exec_res
        shared["original_length"] = len(prep_res[0])
        shared["result_length"] = len(exec_res)
        return "default"


class Reject(Node):
    def post(self, shared, prep_res, exec_res):
        # error already set by Validate; nothing to do
        return "default"


def build_flow():
    validate, transform, reject = Validate(), Transform(), Reject()
    validate - "valid" >> transform
    validate - "invalid" >> reject
    return Flow(start=validate)


if __name__ == "__main__":
    shared = {}
    if not sys.stdin.isatty():
        try: shared = json.loads(sys.stdin.read())
        except json.JSONDecodeError: shared = {}

    flow = build_flow()
    flow.run(shared)

    json.dump(shared, sys.stdout)
    sys.stdout.write("\\n")
`;

const FLOW_NAME = 'pf-text-converter';

export function register(handlers /*, { manifest } */) {
  /**
   * Run a text transformation through PocketFlow.
   * Idempotently saves the flow source on each invocation so the plugin
   * file is always the source of truth, then runs it with shared = {text,choice}.
   */
  handlers['PF_TEXT_CONVERT'] = async (msg) => {
    const text = (msg && typeof msg.text === 'string') ? msg.text : '';
    const choice = (msg && typeof msg.choice === 'string') ? msg.choice : 'upper';

    // Step 1: Define (writes to ~/.agentidev/flows/pf-text-converter.py)
    const defineRes = await handlers['FLOW_DEFINE']({ name: FLOW_NAME, source: FLOW_SOURCE });
    if (!defineRes.success) {
      return { success: false, error: 'flow define failed: ' + (defineRes.error || 'unknown') };
    }

    // Step 2: Run with shared state seeded from the UI inputs
    const runRes = await handlers['FLOW_RUN']({ name: FLOW_NAME, shared: { text, choice }, timeout: 30000 });
    if (!runRes.success) {
      return {
        success: false,
        error: 'flow run failed: ' + (runRes.error || 'unknown'),
        stderr: runRes.stderr,
      };
    }

    const final = runRes.shared || {};
    return {
      success: true,
      result: final.result || null,
      error: final.error || null,
      validated: !!final.validated,
      originalLength: final.original_length,
      resultLength: final.result_length,
      // Echo full shared state for the inspector panel
      shared: final,
    };
  };
}
