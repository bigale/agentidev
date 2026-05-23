/**
 * Tests for the POST /plugin-message/<handler> HTTP→SW relay.
 *
 * Spawns the bridge server in a child process on an ephemeral port, connects
 * a fake "extension" WebSocket client, and verifies the HTTP route forwards
 * to the extension and returns the reply.
 *
 * Run with:  node --test tests/bridge-plugin-message.test.mjs
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "packages", "bridge", "server.mjs");
const PORT = 19876; // off the default 9876 so we don't collide with a dev bridge

let bridgeProc;
let extensionWs;

function startBridge() {
  return new Promise((resolveBoot, rejectBoot) => {
    bridgeProc = spawn("node", [SERVER_PATH, `--port=${PORT}`], {
      env: { ...process.env, BRIDGE_OPERATOR_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let booted = false;
    const onData = (buf) => {
      const s = buf.toString();
      if (!booted && s.includes("listening on http")) {
        booted = true;
        resolveBoot();
      }
    };
    bridgeProc.stdout.on("data", onData);
    bridgeProc.stderr.on("data", onData);
    bridgeProc.on("error", rejectBoot);
    setTimeout(() => { if (!booted) rejectBoot(new Error("bridge boot timeout")); }, 10000);
  });
}

function connectFakeExtension(handlerImpl) {
  return new Promise((resolveConn, rejectConn) => {
    extensionWs = new WebSocket(`ws://localhost:${PORT}`);
    extensionWs.on("open", () => {
      const identify = {
        id: `fake_${Date.now()}_1`,
        type: "BRIDGE_IDENTIFY",
        source: "extension",
        timestamp: Date.now(),
        payload: { role: "extension" },
      };
      extensionWs.send(JSON.stringify(identify));
    });
    extensionWs.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "BRIDGE_IDENTIFY" && msg.replyTo) {
        resolveConn();
        return;
      }
      if (msg.type === "BRIDGE_PLUGIN_MESSAGE") {
        const { handler, args } = msg.payload || {};
        let payload;
        try {
          payload = await handlerImpl(handler, args || {});
        } catch (err) {
          payload = { error: err.message };
        }
        extensionWs.send(JSON.stringify({
          id: `fake_${Date.now()}_2`,
          type: "BRIDGE_PLUGIN_MESSAGE",
          source: "extension",
          timestamp: Date.now(),
          replyTo: msg.id,
          payload,
        }));
      }
    });
    extensionWs.on("error", rejectConn);
  });
}

async function httpPost(path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, raw: text };
}

after(async () => {
  try { extensionWs?.close(); } catch {}
  if (bridgeProc) {
    bridgeProc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    try { bridgeProc.kill("SIGKILL"); } catch {}
  }
});

await startBridge();
await connectFakeExtension(async (handler, args) => {
  if (handler === "TEST_ECHO") {
    return { result: { echoed: args, handler } };
  }
  if (handler === "TEST_BOOM") {
    throw new Error("intentional test failure");
  }
  return { error: `unknown handler in test: ${handler}` };
});

test("POST /plugin-message/<handler> round-trips body to SW and back", async () => {
  const { status, body } = await httpPost("/plugin-message/TEST_ECHO", { foo: 1, bar: "two" });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.result, { echoed: { foo: 1, bar: "two" }, handler: "TEST_ECHO" });
});

test("missing handler segment → 400", async () => {
  const { status, body } = await httpPost("/plugin-message/", {});
  assert.equal(status, 400);
  assert.equal(body.success, false);
});

test("SW-side handler error surfaces as 500 with error string", async () => {
  const { status, body } = await httpPost("/plugin-message/TEST_BOOM", {});
  assert.equal(status, 500);
  assert.equal(body.success, false);
  assert.match(body.error, /intentional test failure/);
});

test("__timeoutMs is honored and returns 504 when SW doesn't reply", async () => {
  // Replace the extension handler with one that never replies for this case.
  // We can do that by sending a request the fake SW won't respond to.
  // The fake SW's handler returns { error: ... } for unknown handlers
  // synchronously, so we use a special handler name that the SW will ignore
  // by overriding the listener for one round-trip.
  const original = extensionWs.listeners("message")[0];
  extensionWs.removeListener("message", original);
  extensionWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "BRIDGE_PLUGIN_MESSAGE") {
      original(raw);
    }
    // else: drop on the floor → bridge will time out
  });
  try {
    const { status, body } = await httpPost(
      "/plugin-message/TEST_NEVER_REPLIES",
      { __timeoutMs: 500 },
    );
    assert.equal(status, 504);
    assert.equal(body.success, false);
    assert.match(body.error, /timed out/);
  } finally {
    extensionWs.removeAllListeners("message");
    extensionWs.on("message", original);
  }
});
