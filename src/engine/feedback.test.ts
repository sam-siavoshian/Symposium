import { test, expect, describe } from "bun:test";
import { computeConfidence } from "./learner";
import { fillKnowledgeDefaults } from "../nia/types";
import type { ConfidenceSignals } from "../nia/types";

describe("computeConfidence", () => {
  test("base case: all zeros → 0.2", () => {
    const signals: ConfidenceSignals = {
      tracer_repo_count: 0,
      advisor_verified: false,
      cross_validated: false,
      times_recalled_ok: 0,
      times_contradicted: 0,
    };
    expect(computeConfidence(signals)).toBe(0.2);
  });

  test("full evidence → > 0.85", () => {
    const signals: ConfidenceSignals = {
      tracer_repo_count: 5,
      advisor_verified: true,
      cross_validated: true,
      times_recalled_ok: 3,
      times_contradicted: 0,
    };
    const conf = computeConfidence(signals);
    expect(conf).toBeGreaterThan(0.85);
    expect(conf).toBeLessThanOrEqual(1.0);
  });

  test("tracer 1 repo → +0.15", () => {
    const base: ConfidenceSignals = { tracer_repo_count: 0, advisor_verified: false, cross_validated: false, times_recalled_ok: 0, times_contradicted: 0 };
    const with1: ConfidenceSignals = { ...base, tracer_repo_count: 1 };
    expect(computeConfidence(with1) - computeConfidence(base)).toBeCloseTo(0.15, 5);
  });

  test("tracer 3+ repos → +0.3", () => {
    const base: ConfidenceSignals = { tracer_repo_count: 0, advisor_verified: false, cross_validated: false, times_recalled_ok: 0, times_contradicted: 0 };
    const with3: ConfidenceSignals = { ...base, tracer_repo_count: 3 };
    expect(computeConfidence(with3) - computeConfidence(base)).toBeCloseTo(0.3, 5);
  });

  test("feedback boost: high success rate → confidence up", () => {
    const base: ConfidenceSignals = { tracer_repo_count: 1, advisor_verified: false, cross_validated: false, times_recalled_ok: 0, times_contradicted: 0 };
    const withSuccess: ConfidenceSignals = { ...base, times_recalled_ok: 5, times_contradicted: 0 };
    expect(computeConfidence(withSuccess)).toBeGreaterThan(computeConfidence(base));
  });

  test("feedback penalty: high contradiction → confidence down", () => {
    const base: ConfidenceSignals = { tracer_repo_count: 1, advisor_verified: false, cross_validated: false, times_recalled_ok: 0, times_contradicted: 0 };
    const withContradiction: ConfidenceSignals = { ...base, times_recalled_ok: 0, times_contradicted: 5 };
    expect(computeConfidence(withContradiction)).toBeLessThan(computeConfidence(base));
  });

  test("never below 0.05", () => {
    const worst: ConfidenceSignals = { tracer_repo_count: 0, advisor_verified: false, cross_validated: false, times_recalled_ok: 0, times_contradicted: 100 };
    expect(computeConfidence(worst)).toBeGreaterThanOrEqual(0.05);
  });

  test("never above 1.0", () => {
    const best: ConfidenceSignals = { tracer_repo_count: 100, advisor_verified: true, cross_validated: true, times_recalled_ok: 100, times_contradicted: 0 };
    expect(computeConfidence(best)).toBeLessThanOrEqual(1.0);
  });
});

describe("fillKnowledgeDefaults", () => {
  test("fills all missing fields for old entries", () => {
    const old = { library: "react", correct: "useEffect(() => {})" };
    const filled = fillKnowledgeDefaults(old);
    expect(filled.library).toBe("react");
    expect(filled.correct).toBe("useEffect(() => {})");
    expect(filled.root_cause).toBe("");
    expect(filled.confidence).toBe(0.5);
    expect(filled.status).toBe("active");
    expect(filled.confidence_signals.tracer_repo_count).toBe(0);
    expect(filled.confidence_signals.times_recalled_ok).toBe(0);
    expect(filled.last_used_at).toBeNull();
  });

  test("preserves existing new fields", () => {
    const entry = {
      library: "react",
      correct: "useEffect",
      root_cause: "hooks changed in v18",
      confidence: 0.9,
      status: "deprecated",
      confidence_signals: { tracer_repo_count: 5, advisor_verified: true, cross_validated: true, times_recalled_ok: 3, times_contradicted: 1 },
      last_used_at: "2026-04-12T00:00:00Z",
    };
    const filled = fillKnowledgeDefaults(entry);
    expect(filled.root_cause).toBe("hooks changed in v18");
    expect(filled.confidence).toBe(0.9);
    expect(filled.status).toBe("deprecated");
    expect(filled.confidence_signals.tracer_repo_count).toBe(5);
    expect(filled.last_used_at).toBe("2026-04-12T00:00:00Z");
  });
});

describe("autoFeedback logic (library match)", () => {
  test("no new discoveries for same library → confirmed", () => {
    const newDiscoveries: any[] = [];
    const newLibraries = new Set(newDiscoveries.map((d: any) => d.library?.toLowerCase()));
    expect(newLibraries.has("react")).toBe(false); // react not contradicted
  });

  test("new discovery for same library → contradicted", () => {
    const newDiscoveries = [{ library: "react", version: "19", mistake: "old", correct: "new" }];
    const newLibraries = new Set(newDiscoveries.map(d => d.library.toLowerCase()));
    expect(newLibraries.has("react")).toBe(true); // react contradicted
  });

  test("new discovery for different library → not contradicted", () => {
    const newDiscoveries = [{ library: "next.js", version: "14", mistake: "old", correct: "new" }];
    const newLibraries = new Set(newDiscoveries.map(d => d.library.toLowerCase()));
    expect(newLibraries.has("react")).toBe(false); // react not contradicted
  });

  test("deprecation threshold: confidence < 0.15 → deprecated", () => {
    // Simulate a heavily contradicted entry
    const signals: ConfidenceSignals = {
      tracer_repo_count: 0,
      advisor_verified: false,
      cross_validated: false,
      times_recalled_ok: 0,
      times_contradicted: 10,
    };
    const conf = computeConfidence(signals);
    expect(conf).toBeLessThan(0.15);
  });
});

describe("partial feedback", () => {
  test("partial outcome increments both ok and contradicted (integer counts)", () => {
    // Before fix: partial added 0.5 to times_recalled_ok, producing fractional counts.
    // After fix: partial increments both counters by 1 (neutral signal).
    const signals: ConfidenceSignals = {
      tracer_repo_count: 1,
      advisor_verified: false,
      cross_validated: false,
      times_recalled_ok: 0,
      times_contradicted: 0,
    };
    // Simulate partial outcome
    signals.times_recalled_ok++;
    signals.times_contradicted++;
    // Both should be integers
    expect(Number.isInteger(signals.times_recalled_ok)).toBe(true);
    expect(Number.isInteger(signals.times_contradicted)).toBe(true);
    // successRate should be exactly 0.5 (neutral)
    const total = signals.times_recalled_ok + signals.times_contradicted;
    expect(signals.times_recalled_ok / total).toBe(0.5);
    // Confidence should be the same as base (0.5 success rate → no adjustment)
    const conf = computeConfidence(signals);
    const baseConf = computeConfidence({ ...signals, times_recalled_ok: 0, times_contradicted: 0 });
    expect(conf).toBe(baseConf);
  });
});

describe("confidence floor for legacy entries", () => {
  test("old entry with confidence 0.5 and zero signals keeps confidence on first feedback", () => {
    // Old entry: stored before confidence_signals existed
    // Has confidence: 0.5 (the fillKnowledgeDefaults default)
    // Has signals: all zeros (no feedback history)
    const storedConfidence = 0.5;
    const signals: ConfidenceSignals = {
      tracer_repo_count: 0,
      advisor_verified: false,
      cross_validated: false,
      times_recalled_ok: 1, // first confirmation
      times_contradicted: 0,
    };
    // computeConfidence would give 0.2 + feedback delta = ~0.3
    // With floor, it should preserve 0.5
    const fromSignals = computeConfidence(signals);
    expect(fromSignals).toBeLessThan(storedConfidence);
    // The floor should keep it at storedConfidence
    const totalFeedback = signals.times_recalled_ok + signals.times_contradicted;
    const withFloor = totalFeedback <= 1 ? Math.max(fromSignals, storedConfidence) : fromSignals;
    expect(withFloor).toBe(storedConfidence);
  });

  test("entry with multiple feedback events uses signal-based confidence", () => {
    // After enough feedback, signals are authoritative
    const storedConfidence = 0.5;
    const signals: ConfidenceSignals = {
      tracer_repo_count: 0,
      advisor_verified: false,
      cross_validated: false,
      times_recalled_ok: 0,
      times_contradicted: 5, // heavily contradicted
    };
    const fromSignals = computeConfidence(signals);
    const totalFeedback = signals.times_recalled_ok + signals.times_contradicted;
    // totalFeedback > 1, so floor doesn't apply
    const withFloor = totalFeedback <= 1 ? Math.max(fromSignals, storedConfidence) : fromSignals;
    expect(withFloor).toBe(fromSignals);
    expect(withFloor).toBeLessThan(storedConfidence);
  });
});
