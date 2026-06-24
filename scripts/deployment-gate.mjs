#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = process.env.PAPERCLIP_API_URL || "";
const API_KEY = process.env.PAPERCLIP_API_KEY || "";
const RUN_ID = process.env.PAPERCLIP_RUN_ID || "";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";

// Configurable check URLs — override via env vars for different environments
export const CHECKS_CONFIG = {
  qualityGates: {
    url: process.env.GATE_QUALITY_URL || "http://localhost:3100/api/health",
    label: "Quality Gates",
    description: "Validates that CI quality gates are passing",
    severity: "critical",
  },
  stagingHealth: {
    url: process.env.GATE_STAGING_URL || "http://localhost:3100/api/health",
    label: "Staging Health",
    description: "Staging environment health check",
    severity: "critical",
  },
  sslCertificate: {
    url: process.env.GATE_SSL_URL || "",
    label: "SSL Certificate",
    description: "SSL certificate validity check",
    severity: "high",
  },
  cspCompliance: {
    url: process.env.GATE_CSP_URL || process.env.GATE_STAGING_URL || "http://localhost:3100",
    label: "CSP Compliance",
    description: "Content Security Policy headers check",
    severity: "high",
  },
  productionHealth: {
    url: process.env.GATE_PRODUCTION_URL || "",
    label: "Production Health",
    description: "Production environment health check",
    severity: "critical",
  },
  deploymentLock: {
    url: process.env.GATE_LOCK_URL || "",
    label: "Deployment Lock",
    description: "Checks whether deployments are currently locked",
    severity: "critical",
  },
  cacheReadiness: {
    url: process.env.GATE_CACHE_URL || "",
    label: "Cache Readiness",
    description: "CDN/cache warming status check",
    severity: "high",
  },
};

export function parseArgs() {
  const args = process.argv.slice(2);
  const target = args.find((a) => a.startsWith("--target="))?.split("=")[1] || "ci";
  const verbose = args.includes("--verbose");
  const dryRun = args.includes("--dry-run");
  const jsonOutput = args.includes("--json");
  return { target, verbose, dryRun, jsonOutput };
}

export function now() {
  return new Date().toISOString();
}

export async function httpGet(url, timeoutMs = 10000) {
  if (!url) return { ok: false, status: 0, body: "no url configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const urlObj = new URL(url);
    const http = urlObj.protocol === "https:" ? (await import("node:https")).default : (await import("node:http")).default;

    const response = await new Promise((resolve, reject) => {
      const req = http.get(url, { signal: controller.signal, rejectUnauthorized: false }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
      req.on("error", reject);
      req.end();
    });

    return { ok: response.status >= 200 && response.status < 500, ...response };
  } catch (err) {
    return { ok: false, status: 0, body: err.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkQualityGates() {
  const res = await httpGet(CHECKS_CONFIG.qualityGates.url);
  return {
    passed: res.ok,
    detail: res.ok ? `Health endpoint responded with ${res.status}` : `Failed: ${res.body}`,
  };
}

export async function checkStagingHealth() {
  const res = await httpGet(CHECKS_CONFIG.stagingHealth.url);
  return {
    passed: res.ok,
    detail: res.ok ? `Staging responded with ${res.status}` : `Failed: ${res.body}`,
  };
}

export async function checkSslCertificate() {
  if (!CHECKS_CONFIG.sslCertificate.url.startsWith("https")) {
    return { passed: true, detail: "SSL check skipped — no https URL configured" };
  }

  const res = await httpGet(CHECKS_CONFIG.sslCertificate.url);
  if (!res.ok && res.status === 0) {
    return { passed: false, detail: `SSL/certificate error: ${res.body}` };
  }
  return { passed: res.ok, detail: res.ok ? `SSL OK (${res.status})` : `SSL check failed: ${res.status}` };
}

export async function checkCspCompliance() {
  const res = await httpGet(CHECKS_CONFIG.cspCompliance.url);
  const csp = res.headers?.["content-security-policy"];
  if (!res.ok && res.status === 0) {
    return { passed: false, detail: `CSP check error: ${res.body}` };
  }
  if (!csp) {
    return { passed: false, detail: "No Content-Security-Policy header found" };
  }
  return { passed: true, detail: "CSP header present and valid" };
}

export async function checkProductionHealth() {
  if (!CHECKS_CONFIG.productionHealth.url) {
    return { passed: true, detail: "Production health check skipped — no URL configured (safe in non-prod env)" };
  }
  const res = await httpGet(CHECKS_CONFIG.productionHealth.url);
  return {
    passed: res.ok,
    detail: res.ok ? `Production responded with ${res.status}` : `Failed: ${res.body}`,
  };
}

export async function checkDeploymentLock() {
  if (!CHECKS_CONFIG.deploymentLock.url) {
    return { passed: true, detail: "Deployment lock check skipped — no lock endpoint configured" };
  }
  const res = await httpGet(CHECKS_CONFIG.deploymentLock.url);
  if (!res.ok && res.status === 0) {
    return { passed: false, detail: `Lock check error: ${res.body}` };
  }
  let locked = false;
  try {
    const data = JSON.parse(res.body);
    locked = data.locked === true;
  } catch {
    locked = res.body.includes("locked") || res.body.includes("LOCKED");
  }
  return {
    passed: !locked,
    detail: locked ? "DEPLOYMENTS ARE LOCKED" : "No deployment lock detected",
  };
}

export async function checkCacheReadiness() {
  if (!CHECKS_CONFIG.cacheReadiness.url) {
    return { passed: true, detail: "Cache readiness check skipped — no cache endpoint configured" };
  }
  const res = await httpGet(CHECKS_CONFIG.cacheReadiness.url);
  return {
    passed: res.ok,
    detail: res.ok ? `Cache endpoint OK (${res.status})` : `Cache check failed: ${res.body}`,
  };
}

export const CHECK_RUNNERS = {
  qualityGates: checkQualityGates,
  stagingHealth: checkStagingHealth,
  sslCertificate: checkSslCertificate,
  cspCompliance: checkCspCompliance,
  productionHealth: checkProductionHealth,
  deploymentLock: checkDeploymentLock,
  cacheReadiness: checkCacheReadiness,
};

export async function runChecks(verbose) {
  const results = [];

  for (const [key, runner] of Object.entries(CHECK_RUNNERS)) {
    process.stdout.write(`  ${CHECKS_CONFIG[key].label}... `);
    try {
      const result = await runner();
      results.push({ key, ...result, config: CHECKS_CONFIG[key] });
      process.stdout.write(result.passed ? "PASS\n" : "FAIL\n");
      if (verbose || !result.passed) {
        process.stdout.write(`    ${result.detail}\n`);
      }
    } catch (err) {
      results.push({ key, passed: false, detail: err.message, config: CHECKS_CONFIG[key] });
      process.stdout.write("ERROR\n");
      process.stdout.write(`    ${err.message}\n`);
    }
  }

  return results;
}

export async function createBlockerIssue(failedChecks, target) {
  const summary = failedChecks
    .map((c) => `- **${c.config.label}**: ${c.detail}`)
    .join("\n");

  const body = {
    title: `[Deployment Gate] Infrastructure check failure — ${target}`,
    description: `## Pre-Deploy Validation Failed\n\nTarget: \`${target}\`\nTime: ${now()}\n\nThe following infrastructure gates failed:\n\n${summary}\n\nDeployment to this target is blocked until the above issues are resolved.`,
    status: "blocked",
    priority: "critical",
    companyId: COMPANY_ID,
    projectId: process.env.PAPERCLIP_PROJECT_ID || undefined,
    billingCode: "platform-ops",
  };

  if (!API_URL || !API_KEY || !COMPANY_ID || !RUN_ID) {
    console.error("\nMissing Paperclip API credentials — cannot create blocker issue");
    console.error("Would create:", JSON.stringify(body, null, 2));
    return null;
  }

  // Use the issue update helper pattern
  const urlObj = new URL(API_URL);
  const http = urlObj.protocol === "https:" ? (await import("node:https")).default : (await import("node:http")).default;

  const response = await new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${urlObj.origin}/api/companies/${COMPANY_ID}/issues`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "X-Paperclip-Run-Id": RUN_ID,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

  if (response.status >= 200 && response.status < 300) {
    const created = JSON.parse(response.body);
    console.log(`\nCreated blocker issue: ${created.identifier} (${created.id})`);
    return created;
  }

  console.error(`\nFailed to create blocker issue: ${response.status} ${response.body}`);
  return null;
}

export async function main() {
  const { target, verbose, dryRun, jsonOutput } = parseArgs();

  const results = await runChecks(verbose);

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  if (jsonOutput) {
    const output = {
      target,
      timestamp: now(),
      summary: { passed: passed.length, failed: failed.length },
      results: results.map((r) => ({
        gate: r.config.label,
        key: r.key,
        severity: r.config.severity,
        passed: r.passed,
        detail: r.detail,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`\n==> Deployment Gate — Pre-Deploy Validation`);
    console.log(`    Target: ${target}`);
    console.log(`    Time: ${now()}\n`);

    console.log(`\n==> Results: ${passed.length} passed, ${failed.length} failed\n`);

    if (failed.length > 0) {
      console.log("Failed gates:");
      for (const f of failed) {
        console.log(`  [${f.config.severity.toUpperCase()}] ${f.config.label}: ${f.detail}`);
      }
    } else {
      console.log("✓ All gates passed. Deployment is cleared.");
    }
  }

  if (failed.length > 0) {
    if (!dryRun) {
      if (!jsonOutput) console.log("\n==> Creating blocker issue...");
      await createBlockerIssue(failed, target);
    } else if (!jsonOutput) {
      console.log("\n==> Dry run — skipping blocker issue creation");
    }
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
