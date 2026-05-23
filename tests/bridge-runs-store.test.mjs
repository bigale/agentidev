/**
 * Tests for SQLite-backed run + artifact retrieval in the bridge's db.mjs.
 *
 * Drives:
 *   - getRunWithArtifacts(scriptId) — joins script_runs + script_artifacts
 *     into the shape the script:run CLI returns.
 *   - persistInlineArtifact(artifact, scriptId, artifactsDir) — writes inline
 *     `data` to disk so the dual-write into SQLite carries a non-null disk_path.
 *
 * Run with:  node --test tests/bridge-runs-store.test.mjs
 *
 * Uses Node's built-in test runner because the bridge is ESM and the existing
 * jest setup is CJS. No global config touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initDB,
  saveRun,
  saveArtifact,
  getRunWithArtifacts,
  persistInlineArtifact,
} from "../packages/bridge/db.mjs";

// One temp DB shared across this file's tests — initDB caches its connection,
// so we can't re-open against a different path mid-file.
const TMP_DIR = mkdtempSync(join(tmpdir(), "bridge-test-"));
const DB_PATH = join(TMP_DIR, "test.sqlite");
initDB({ dbPath: DB_PATH });

test("getRunWithArtifacts returns null for an unknown scriptId", () => {
  const result = getRunWithArtifacts("script_does_not_exist");
  assert.equal(result, null);
});

test("getRunWithArtifacts returns {run, artifacts} for a known run", () => {
  const scriptId = "script_test_001";
  const startedAt = Date.now();

  saveRun({
    scriptId,
    name: "test-script",
    state: "complete",
    startedAt,
    completedAt: startedAt + 1000,
    durationMs: 1000,
    step: 3,
    totalSteps: 3,
    errors: 0,
    sessionId: null,
    artifactCount: 2,
  });

  saveArtifact({
    runId: scriptId,
    type: "lyricist-output",
    label: "en sentence",
    diskPath: "/tmp/fake-en.json",
    size: 1234,
    contentType: "application/json",
    timestamp: startedAt + 500,
  });
  saveArtifact({
    runId: scriptId,
    type: "result",
    label: "ContrastSet",
    diskPath: "/tmp/fake-cs.json",
    size: 9999,
    contentType: "application/json",
    timestamp: startedAt + 900,
  });

  const result = getRunWithArtifacts(scriptId);

  assert.notEqual(result, null, "expected a result for known scriptId");
  assert.equal(result.run.script_id, scriptId);
  assert.equal(result.run.state, "complete");
  assert.equal(result.run.errors, 0);
  assert.equal(result.run.duration_ms, 1000);

  assert.equal(result.artifacts.length, 2);
  // Ordered by timestamp ASC per getArtifacts contract.
  assert.equal(result.artifacts[0].label, "en sentence");
  assert.equal(result.artifacts[1].label, "ContrastSet");
  assert.equal(result.artifacts[0].disk_path, "/tmp/fake-en.json");
  assert.equal(result.artifacts[1].size, 9999);
});

test("persistInlineArtifact writes data to disk and returns the diskPath", () => {
  const scriptId = "script_test_002";
  const artifactsDir = join(TMP_DIR, "artifacts");
  const inlinePayload = JSON.stringify({ language: "es", sentenceText: "Hola." });

  const diskPath = persistInlineArtifact(
    {
      type: "lyricist-output",
      label: "es line",
      data: inlinePayload,
      contentType: "application/json",
      timestamp: 1779999999999,
    },
    scriptId,
    artifactsDir,
  );

  assert.ok(diskPath, "expected a diskPath to be returned");
  assert.ok(
    diskPath.startsWith(join(artifactsDir, scriptId)),
    `expected diskPath under ${join(artifactsDir, scriptId)}, got ${diskPath}`,
  );
  assert.equal(existsSync(diskPath), true, "expected the file to exist on disk");
  assert.equal(readFileSync(diskPath, "utf8"), inlinePayload);
});

test("persistInlineArtifact picks an extension that matches the contentType", () => {
  const scriptId = "script_test_003";
  const artifactsDir = join(TMP_DIR, "artifacts");

  const jsonPath = persistInlineArtifact(
    {
      type: "result",
      label: "json artifact",
      data: '{"k":1}',
      contentType: "application/json",
      timestamp: 1779999990001,
    },
    scriptId,
    artifactsDir,
  );
  const textPath = persistInlineArtifact(
    {
      type: "console",
      label: "console artifact",
      data: "stdout line",
      contentType: "text/plain",
      timestamp: 1779999990002,
    },
    scriptId,
    artifactsDir,
  );

  assert.ok(jsonPath.endsWith(".json"), `expected .json ext, got ${jsonPath}`);
  assert.ok(textPath.endsWith(".txt") || textPath.endsWith(".log"),
    `expected .txt/.log ext for text/plain, got ${textPath}`);
});
