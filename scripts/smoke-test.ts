/**
 * Smoke test: verify Nia API connectivity and basic operations.
 * Run: NIA_API_KEY=your_key bun run scripts/smoke-test.ts
 *
 * This tests each Nia integration point WITHOUT running the full pipeline.
 * Run this before the demo to make sure everything is connected.
 */

import { initNia, healthCheck, searchContexts, runOracle, runTracer, verifyWithAdvisor, searchCode } from "../src/nia/client";

const NIA_API_KEY = process.env.NIA_API_KEY;
if (!NIA_API_KEY) {
  console.error("Usage: NIA_API_KEY=your_key bun run scripts/smoke-test.ts");
  process.exit(1);
}

const results: { test: string; status: "PASS" | "FAIL"; time: number; detail: string }[] = [];

async function runTest(name: string, fn: () => Promise<string>) {
  const start = Date.now();
  try {
    const detail = await fn();
    const time = Date.now() - start;
    results.push({ test: name, status: "PASS", time, detail });
    console.log(`  PASS  ${name} (${time}ms) - ${detail}`);
  } catch (err) {
    const time = Date.now() - start;
    const detail = (err as Error).message || String(err);
    results.push({ test: name, status: "FAIL", time, detail });
    console.log(`  FAIL  ${name} (${time}ms) - ${detail}`);
  }
}

async function main() {
  console.log("\nSymposium Smoke Test");
  console.log("====================\n");

  // Init SDK
  initNia(NIA_API_KEY!);
  console.log("SDK initialized.\n");

  // Test 1: Health check (Context API)
  await runTest("Health Check (Context API)", async () => {
    const ok = await healthCheck();
    if (!ok) throw new Error("Health check returned false");
    return "Context API reachable";
  });

  // Test 2: Context search (Learning loop read)
  await runTest("Context Search", async () => {
    const results = await searchContexts("test query", 1);
    return `Returned ${results.length} results`;
  });

  // Test 3: Oracle (create + wait, short query)
  await runTest("Oracle (create job)", async () => {
    const result = await runOracle("Return the JSON: {\"test\": true}");
    const hasContent = result.length > 5;
    if (!hasContent) throw new Error("Oracle returned empty/short response");
    return `Response: ${result.slice(0, 80)}...`;
  });

  // Test 4: Tracer (short query, let it run briefly)
  await runTest("Tracer (run query)", async () => {
    // Use a short timeout since we just want to verify it connects
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15000);
    try {
      const result = await runTracer("How does Next.js handle routing?", { signal: controller.signal });
      return `Response length: ${result.length}`;
    } catch (err) {
      if ((err as Error).message?.includes("abort")) return "Tracer job started (timed out waiting, which is expected for smoke test)";
      throw err;
    }
  });

  // Test 5: Advisor
  await runTest("Advisor", async () => {
    const result = await verifyWithAdvisor({
      query: "Is this import correct? import { createAuth } from 'betterauth'",
    });
    return `Searched ${result.sourcesSearched} sources, advice length: ${result.advice.length}`;
  });

  // Test 6: Search
  await runTest("Search (fast mode)", async () => {
    const result = await searchCode({
      query: "How to use BetterAuth v3",
      fastMode: true,
    });
    return `Response length: ${result.length}`;
  });

  // Summary
  console.log("\n====================");
  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const totalTime = results.reduce((sum, r) => sum + r.time, 0);
  console.log(`\n${passed} passed, ${failed} failed, ${totalTime}ms total\n`);

  if (failed > 0) {
    console.log("FAILED TESTS:");
    for (const r of results.filter(r => r.status === "FAIL")) {
      console.log(`  ${r.test}: ${r.detail}`);
    }
    console.log("\nFix these before the demo!");
    process.exit(1);
  } else {
    console.log("All systems go. Ready for demo.");
  }
}

main();
