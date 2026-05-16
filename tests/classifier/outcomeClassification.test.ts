import { describe, it, expect } from "@jest/globals";
import { classifyOutcome } from "../../src/classifier/outcomeClassification.js";

describe("classifyOutcome", () => {
  it("detects failed", () => {
    const r = classifyOutcome("We failed to replicate the original finding.");
    expect(r.outcome).toBe("failed");
    expect(r.phrase).toContain("failed to replicate");
    expect(r.sentence).toContain("failed to replicate");
  });

  it("detects successful", () => {
    const r = classifyOutcome(
      "We successfully replicated the original effect.",
    );
    expect(r.outcome).toBe("successful");
    expect(r.phrase).toContain("successfully replicated");
  });

  it("detects mixed", () => {
    const r = classifyOutcome("Results were mixed across the three studies.");
    expect(r.outcome).toBe("mixed");
  });

  it("returns unknown when no outcome phrase", () => {
    const r = classifyOutcome("We conducted a replication of Smith (2010).");
    expect(r.outcome).toBe("unknown");
  });

  it("detects effect-size collapse pattern", () => {
    const r = classifyOutcome(
      "Original reported d = 0.5; we observed d = 0.03.",
    );
    expect(r.outcome).toBe("failed");
    expect(r.phrase).toMatch(/d = 0\.03/);
  });

  it("detects correlation effect-size collapse pattern", () => {
    const r = classifyOutcome(
      "The original study reported r = 0.32, but this replication found r = 0.04.",
    );
    expect(r.outcome).toBe("failed");
  });

  it("detects confidence intervals crossing zero", () => {
    const r = classifyOutcome(
      "The 95% confidence interval included zero for the key effect.",
    );
    expect(r.outcome).toBe("failed");
  });

  it("detects failed significant-effects wording", () => {
    const r = classifyOutcome(
      "All three replication attempts failed to produce significant effects.",
    );
    expect(r.outcome).toBe("failed");
  });

  it("detects successful equivalence language", () => {
    const r = classifyOutcome(
      "The replication was successful and did not differ from the original.",
    );
    expect(r.outcome).toBe("successful");
  });

  it("detects present-tense successful replication wording", () => {
    const r = classifyOutcome(
      "This paper successfully replicates the original analysis.",
    );
    expect(r.outcome).toBe("successful");
  });

  it("detects condition-dependent mixed outcomes", () => {
    const r = classifyOutcome(
      "The results revealed a significant facial-feedback effect in the absence of a camera, which was eliminated in the camera's presence.",
    );
    expect(r.outcome).toBe("mixed");
  });

  it("prefers failed when both failed and successful appear (conservative)", () => {
    const r = classifyOutcome(
      "We successfully tested the method but failed to replicate the core effect.",
    );
    expect(r.outcome).toBe("failed");
  });

  it("does not classify negated failed wording as failed", () => {
    const r = classifyOutcome(
      "The results were not failed to replicate the original finding.",
    );
    expect(r.outcome).toBe("unknown");
  });

  it("does not flag collapse when original effect size is below 0.3", () => {
    const r = classifyOutcome(
      "Original reported d = 0.15; we observed d = 0.03.",
    );
    expect(r.outcome).toBe("unknown");
  });
});
