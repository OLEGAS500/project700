import { describe, expect, it } from "vitest";
import { calculateBaseline, createBaselineConfigHash } from "./baseline";

function observation(index: number, value: number, configurationHash = "config-a") {
  return {
    snapshotId: `snapshot-${index}`,
    value,
    comparable: true,
    configurationHash,
    observedAt: new Date(Date.UTC(2026, 6, index)).toISOString()
  };
}

describe("calculateBaseline", () => {
  it("creates a learning baseline from the first comparable snapshot", () => {
    const baseline = calculateBaseline({
      observations: [observation(1, 642)]
    });

    expect(baseline).toMatchObject({
      status: "learning",
      medianValue: 642,
      sampleCount: 1
    });
  });

  it("becomes ready for confirmation after seven comparable samples", () => {
    const baseline = calculateBaseline({
      observations: [640, 641, 642, 642, 643, 644, 645].map((value, index) =>
        observation(index + 1, value)
      )
    });

    expect(baseline).toMatchObject({
      status: "ready_for_confirmation",
      medianValue: 642,
      sampleCount: 7
    });
  });

  it("stays active after manual confirmation", () => {
    const baseline = calculateBaseline({
      observations: [640, 641, 642, 642, 643, 644, 645].map((value, index) =>
        observation(index + 1, value)
      ),
      wasConfirmed: true
    });

    expect(baseline?.status).toBe("active");
  });

  it("uses the latest 14 comparable samples", () => {
    const baseline = calculateBaseline({
      observations: Array.from({ length: 15 }, (_, index) =>
        observation(index + 1, index + 1)
      )
    });

    expect(baseline?.sampleCount).toBe(14);
    expect(baseline?.observationSnapshotIds[0]).toBe("snapshot-2");
  });

  it("ignores old observations from a previous configuration", () => {
    const baseline = calculateBaseline({
      observations: [
        observation(1, 100, "old-config"),
        observation(2, 200, "new-config")
      ]
    });

    expect(baseline).toMatchObject({
      configurationHash: "new-config",
      medianValue: 200,
      sampleCount: 1
    });
  });

  it("creates stable configuration hashes", () => {
    expect(createBaselineConfigHash({ b: 2, a: 1 })).toBe(
      createBaselineConfigHash({ a: 1, b: 2 })
    );
  });
});
