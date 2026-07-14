import { describe, expect, it } from "vitest";
import { createAlertPreferencesHash } from "./alert-preferences";

describe("alert preferences", () => {
  it("hashes equivalent muted incident types canonically", () => {
    const base = {
      enabled: true,
      emailEnabled: true,
      telegramEnabled: false,
      notifyOnOpen: true,
      notifyOnWorsening: true,
      notifyOnRecovery: false,
      worseningAffectedCountPercent: 0.2,
      worseningSeverityIncrease: true
    };

    expect(
      createAlertPreferencesHash({ ...base, mutedIncidentTypes: ["seo_regression", "source_health"] })
    ).toBe(
      createAlertPreferencesHash({ ...base, mutedIncidentTypes: ["source_health", "seo_regression"] })
    );
  });
});
