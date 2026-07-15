import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  StoreThresholdsNotFoundError: class StoreThresholdsNotFoundError extends Error {},
  updateStoreThresholds: vi.fn()
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

import { updateStoreThresholdsAction } from "./actions";

const storeId = "70000000-0000-4000-8000-000000000001";
const initialState = { error: null };

describe("threshold server action", () => {
  beforeEach(() => {
    database.updateStoreThresholds.mockReset();
    cache.revalidatePath.mockReset();
    navigation.redirect.mockClear();
  });

  it("rejects incomplete input before calling the database", async () => {
    const result = await updateStoreThresholdsAction(storeId, initialState, formData({}));

    expect(result).toEqual({ error: "Enter valid threshold values before saving." });
    expect(database.updateStoreThresholds).not.toHaveBeenCalled();
  });

  it("converts displayed percentages and saves the existing threshold contract", async () => {
    database.updateStoreThresholds.mockResolvedValue({});

    await expect(
      updateStoreThresholdsAction(
        storeId,
        initialState,
        formData({
          catalogDropPercentage: "25",
          catalogDropAbsolute: "30",
          sourceDivergencePercentage: "12.5",
          sourceDivergenceAbsolute: "24",
          priceMismatchAbsolute: "0.05",
          priceMismatchRelative: "0.2",
          minimumMismatchCount: "7",
          minimumMismatchRatio: "30",
          seoCoverageMinimum: "85",
          sourceHealthConsecutiveFailures: "3"
        })
      )
    ).rejects.toThrow(`NEXT_REDIRECT:/stores/${storeId}/thresholds`);

    expect(database.updateStoreThresholds).toHaveBeenCalledWith(storeId, {
      catalogDropPercentage: 0.25,
      catalogDropAbsolute: 30,
      sourceDivergencePercentage: 0.125,
      sourceDivergenceAbsolute: 24,
      priceMismatchTolerance: { absolute: 0.05, relative: 0.002 },
      minimumMismatchCount: 7,
      minimumMismatchRatio: 0.3,
      seoCoverageMinimum: 0.85,
      sourceHealthConsecutiveFailures: 3
    });
    expect(cache.revalidatePath.mock.calls).toEqual([[`/stores/${storeId}/thresholds`]]);
  });

  it("maps a missing threshold record to a safe message", async () => {
    database.updateStoreThresholds.mockRejectedValue(
      new database.StoreThresholdsNotFoundError("missing")
    );

    const result = await updateStoreThresholdsAction(
      storeId,
      initialState,
      formData(validValues())
    );

    expect(result).toEqual({ error: "Threshold settings for this store no longer exist." });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("does not expose database errors", async () => {
    database.updateStoreThresholds.mockRejectedValue(
      new Error("SQL https://internal.example/thresholds")
    );

    const result = await updateStoreThresholdsAction(
      storeId,
      initialState,
      formData(validValues())
    );

    expect(result).toEqual({ error: "The threshold settings could not be saved." });
    expect(result.error).not.toContain("internal.example");
  });
});

function validValues(): Record<string, string> {
  return {
    catalogDropPercentage: "20",
    catalogDropAbsolute: "20",
    sourceDivergencePercentage: "10",
    sourceDivergenceAbsolute: "20",
    priceMismatchAbsolute: "0.02",
    priceMismatchRelative: "0.1",
    minimumMismatchCount: "5",
    minimumMismatchRatio: "20",
    seoCoverageMinimum: "80",
    sourceHealthConsecutiveFailures: "2"
  };
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}
