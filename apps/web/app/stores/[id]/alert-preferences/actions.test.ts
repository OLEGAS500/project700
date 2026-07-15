import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  updateAlertPreferences: vi.fn()
}));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  })
}));

vi.mock("@eim/db", () => database);
vi.mock("next/cache", () => cache);
vi.mock("next/navigation", () => navigation);

import { updateAlertPreferencesAction } from "./actions";

const storeId = "70000000-0000-4000-8000-000000000001";
const initialState = { error: null };

describe("alert preferences server action", () => {
  beforeEach(() => {
    database.updateAlertPreferences.mockReset();
    cache.revalidatePath.mockReset();
    navigation.redirect.mockClear();
  });

  it("rejects invalid values before calling the database", async () => {
    const result = await updateAlertPreferencesAction(
      storeId,
      initialState,
      formData({ worseningAffectedCountPercent: "101" })
    );

    expect(result).toEqual({ error: "Enter valid alert preference values before saving." });
    expect(database.updateAlertPreferences).not.toHaveBeenCalled();
  });

  it("saves the complete preference contract, revalidates, and redirects", async () => {
    database.updateAlertPreferences.mockResolvedValue({});

    await expect(
      updateAlertPreferencesAction(
        storeId,
        initialState,
        formData({
          enabled: "on",
          emailEnabled: "on",
          telegramEnabled: "on",
          notifyOnOpen: "on",
          notifyOnRecovery: "on",
          worseningAffectedCountPercent: "33.333",
          worseningSeverityIncrease: "on",
          mutedIncidentTypes: ["source_health", "seo_regression"]
        })
      )
    ).rejects.toThrow(`NEXT_REDIRECT:/stores/${storeId}/alert-preferences`);

    expect(database.updateAlertPreferences).toHaveBeenCalledWith(storeId, {
      enabled: true,
      emailEnabled: true,
      telegramEnabled: true,
      mutedIncidentTypes: ["source_health", "seo_regression"],
      notifyOnOpen: true,
      notifyOnWorsening: false,
      notifyOnRecovery: true,
      worseningAffectedCountPercent: 0.33333,
      worseningSeverityIncrease: true
    });
    expect(cache.revalidatePath.mock.calls).toEqual([
      [`/stores/${storeId}/alert-preferences`],
      ["/dashboard"]
    ]);
  });

  it("maps database failures to a safe message", async () => {
    database.updateAlertPreferences.mockRejectedValue(new Error("SQL secret https://internal.example"));

    const result = await updateAlertPreferencesAction(storeId, initialState, formData(validValues()));

    expect(result).toEqual({ error: "The alert preferences could not be saved." });
    expect(result.error).not.toContain("internal.example");
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect(navigation.redirect).not.toHaveBeenCalled();
  });
});

function validValues(): Record<string, string> {
  return {
    enabled: "on",
    emailEnabled: "on",
    telegramEnabled: "off",
    notifyOnOpen: "on",
    notifyOnWorsening: "on",
    notifyOnRecovery: "off",
    worseningAffectedCountPercent: "20",
    worseningSeverityIncrease: "on"
  };
}

function formData(values: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      for (const item of value) data.append(name, item);
    } else {
      data.set(name, value);
    }
  }
  return data;
}
