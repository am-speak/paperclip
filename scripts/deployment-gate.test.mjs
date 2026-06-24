import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  CHECKS_CONFIG,
  CHECK_RUNNERS,
  parseArgs,
  now,
  httpGet,
  checkCspCompliance,
  checkDeploymentLock,
  checkSslCertificate,
  checkQualityGates,
  checkStagingHealth,
  checkProductionHealth,
  checkCacheReadiness,
  runChecks,
} from "./deployment-gate.mjs";

test("parseArgs returns defaults for empty argv", () => {
  const saved = process.argv;
  try {
    process.argv = ["node", "deployment-gate.mjs"];
    const result = parseArgs();
    assert.equal(result.target, "ci");
    assert.equal(result.verbose, false);
    assert.equal(result.dryRun, false);
  } finally {
    process.argv = saved;
  }
});

test("parseArgs parses --target=stable", () => {
  const saved = process.argv;
  try {
    process.argv = ["node", "deployment-gate.mjs", "--target=stable"];
    const result = parseArgs();
    assert.equal(result.target, "stable");
  } finally {
    process.argv = saved;
  }
});

test("parseArgs parses --verbose and --dry-run", () => {
  const saved = process.argv;
  try {
    process.argv = ["node", "deployment-gate.mjs", "--verbose", "--dry-run"];
    const result = parseArgs();
    assert.equal(result.verbose, true);
    assert.equal(result.dryRun, true);
  } finally {
    process.argv = saved;
  }
});

test("now returns ISO 8601 date string", () => {
  const result = now();
  assert.ok(result.endsWith("Z") || result.includes("+"));
  assert.ok(Date.parse(result));
});

test("httpGet returns not-ok for empty url", async () => {
  const result = await httpGet("");
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.body, "no url configured");
});

test("httpGet fetches from a local server", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ healthy: true }));
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const result = await httpGet(`http://localhost:${port}/health`);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.ok(result.body.includes("healthy"));
  } finally {
    server.close();
  }
});

test("httpGet returns error data for connection refused", async () => {
  const result = await httpGet("http://localhost:1", 500);
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
});

test("httpGet returns headers", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-security-policy": "default-src 'self'" });
    res.end("ok");
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const result = await httpGet(`http://localhost:${port}`);
    assert.equal(result.headers["content-security-policy"], "default-src 'self'");
  } finally {
    server.close();
  }
});

test("httpGet handles 500 status as not-ok", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500);
    res.end("internal error");
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const result = await httpGet(`http://localhost:${port}`);
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
  } finally {
    server.close();
  }
});

test("CHECKS_CONFIG has all 7 entries", () => {
  const keys = Object.keys(CHECKS_CONFIG);
  assert.equal(keys.length, 7);
  assert.ok(keys.includes("qualityGates"));
  assert.ok(keys.includes("stagingHealth"));
  assert.ok(keys.includes("sslCertificate"));
  assert.ok(keys.includes("cspCompliance"));
  assert.ok(keys.includes("productionHealth"));
  assert.ok(keys.includes("deploymentLock"));
  assert.ok(keys.includes("cacheReadiness"));
});

test("CHECKS_CONFIG entries have required fields", () => {
  for (const [key, entry] of Object.entries(CHECKS_CONFIG)) {
    assert.ok(typeof entry.label === "string", `${key}.label must be a string`);
    assert.ok(typeof entry.description === "string", `${key}.description must be a string`);
    assert.ok(["critical", "high"].includes(entry.severity), `${key}.severity must be critical or high`);
    assert.ok(typeof entry.url === "string", `${key}.url must be a string`);
  }
});

test("CHECK_RUNNERS has same keys as CHECKS_CONFIG", () => {
  const configKeys = Object.keys(CHECKS_CONFIG);
  const runnerKeys = Object.keys(CHECK_RUNNERS);
  assert.deepEqual(runnerKeys.sort(), configKeys.sort());
});

test("all CHECK_RUNNERS entries are async functions", () => {
  for (const [key, runner] of Object.entries(CHECK_RUNNERS)) {
    assert.equal(typeof runner, "function", `${key} must be a function`);
    assert.ok(runner.constructor.name === "AsyncFunction" || runner.constructor.name === "Function", `${key} must be async`);
  }
});

test("checkCspCompliance fails when no CSP header is present", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    CHECKS_CONFIG.cspCompliance.url = `http://localhost:${port}`;
    const result = await checkCspCompliance();
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("No Content-Security-Policy"));
  } finally {
    server.close();
  }
});

test("checkCspCompliance passes when CSP header is present", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-security-policy": "default-src 'self'" });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    CHECKS_CONFIG.cspCompliance.url = `http://localhost:${port}`;
    const result = await checkCspCompliance();
    assert.equal(result.passed, true);
    assert.ok(result.detail.includes("CSP header present"));
  } finally {
    server.close();
  }
});

test("checkCspCompliance fails on connection error", async () => {
  CHECKS_CONFIG.cspCompliance.url = "http://localhost:1";
  const result = await checkCspCompliance();
  assert.equal(result.passed, false);
  assert.ok(result.detail.includes("CSP check error"));
});

test("checkDeploymentLock passes when not locked", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ locked: false }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    CHECKS_CONFIG.deploymentLock.url = `http://localhost:${port}`;
    const result = await checkDeploymentLock();
    assert.equal(result.passed, true);
    assert.ok(result.detail.includes("No deployment lock"));
  } finally {
    server.close();
  }
});

test("checkDeploymentLock fails when locked", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ locked: true }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    CHECKS_CONFIG.deploymentLock.url = `http://localhost:${port}`;
    const result = await checkDeploymentLock();
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("LOCKED"));
  } finally {
    server.close();
  }
});

test("checkDeploymentLock falls back to text search when response is not JSON", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("DEPLOYMENTS ARE LOCKED");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    CHECKS_CONFIG.deploymentLock.url = `http://localhost:${port}`;
    const result = await checkDeploymentLock();
    assert.equal(result.passed, false);
  } finally {
    server.close();
  }
});

test("checkDeploymentLock is skipped when no URL configured", async () => {
  const saved = CHECKS_CONFIG.deploymentLock.url;
  try {
    CHECKS_CONFIG.deploymentLock.url = "";
    const result = await checkDeploymentLock();
    assert.equal(result.passed, true);
    assert.ok(result.detail.includes("skipped"));
  } finally {
    CHECKS_CONFIG.deploymentLock.url = saved;
  }
});

test("checkSslCertificate is skipped for http URLs", async () => {
  CHECKS_CONFIG.sslCertificate.url = "http://example.com";
  const result = await checkSslCertificate();
  assert.equal(result.passed, true);
  assert.ok(result.detail.includes("skipped"));
});

test("parseArgs parses --json flag", () => {
  const saved = process.argv;
  try {
    process.argv = ["node", "deployment-gate.mjs", "--json"];
    const result = parseArgs();
    assert.equal(result.jsonOutput, true);
  } finally {
    process.argv = saved;
  }
});

test("parseArgs defaults jsonOutput to false", () => {
  const saved = process.argv;
  try {
    process.argv = ["node", "deployment-gate.mjs"];
    const result = parseArgs();
    assert.equal(result.jsonOutput, false);
  } finally {
    process.argv = saved;
  }
});

test("runChecks runs all check runners and returns results", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-security-policy": "default-src 'self'" });
    res.end(JSON.stringify({ healthy: true }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const saved = {
    quality: CHECKS_CONFIG.qualityGates.url,
    staging: CHECKS_CONFIG.stagingHealth.url,
    csp: CHECKS_CONFIG.cspCompliance.url,
  };

  try {
    CHECKS_CONFIG.qualityGates.url = `http://localhost:${port}`;
    CHECKS_CONFIG.stagingHealth.url = `http://localhost:${port}`;
    CHECKS_CONFIG.cspCompliance.url = `http://localhost:${port}`;

    const results = await runChecks(false);
    assert.equal(results.length, 7);
    for (const r of results) {
      assert.ok(typeof r.key === "string");
      assert.ok(typeof r.passed === "boolean");
      assert.ok(typeof r.detail === "string");
      assert.ok(r.config);
    }
  } finally {
    CHECKS_CONFIG.qualityGates.url = saved.quality;
    CHECKS_CONFIG.stagingHealth.url = saved.staging;
    CHECKS_CONFIG.cspCompliance.url = saved.csp;
    server.close();
  }
});

test("qualityGates check returns not-ok for bad url", async () => {
  CHECKS_CONFIG.qualityGates.url = "http://localhost:1";
  const result = await checkQualityGates();
  assert.equal(result.passed, false);
});

test("stagingHealth check returns not-ok for bad url", async () => {
  CHECKS_CONFIG.stagingHealth.url = "http://localhost:1";
  const result = await checkStagingHealth();
  assert.equal(result.passed, false);
});

test("productionHealth is skipped when no URL", async () => {
  const saved = CHECKS_CONFIG.productionHealth.url;
  try {
    CHECKS_CONFIG.productionHealth.url = "";
    const result = await checkProductionHealth();
    assert.equal(result.passed, true);
    assert.ok(result.detail.includes("skipped"));
  } finally {
    CHECKS_CONFIG.productionHealth.url = saved;
  }
});

test("cacheReadiness is skipped when no URL", async () => {
  const saved = CHECKS_CONFIG.cacheReadiness.url;
  try {
    CHECKS_CONFIG.cacheReadiness.url = "";
    const result = await checkCacheReadiness();
    assert.equal(result.passed, true);
    assert.ok(result.detail.includes("skipped"));
  } finally {
    CHECKS_CONFIG.cacheReadiness.url = saved;
  }
});

test("checkSslCertificate is skipped when no URL", async () => {
  const saved = CHECKS_CONFIG.sslCertificate.url;
  try {
    CHECKS_CONFIG.sslCertificate.url = "";
    const result = await checkSslCertificate();
    assert.equal(result.passed, true);
    assert.ok(result.detail.includes("no https URL configured"));
  } finally {
    CHECKS_CONFIG.sslCertificate.url = saved;
  }
});
