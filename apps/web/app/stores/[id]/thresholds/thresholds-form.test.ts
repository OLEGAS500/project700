import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  updateStoreThresholdsAction: vi.fn()
}));

import { defaultStoreThresholds } from "@eim/core";
import ThresholdsForm from "./thresholds-form";

describe("thresholds form", () => {
  it("renders the current values and all supported threshold fields", () => {
    const html = renderToStaticMarkup(
      createElement(ThresholdsForm, {
        storeId: "70000000-0000-4000-8000-000000000001",
        thresholds: defaultStoreThresholds
      })
    );

    expect(html).toContain('name="catalogDropPercentage"');
    expect(html).toContain('name="sourceDivergencePercentage"');
    expect(html).toContain('name="priceMismatchAbsolute"');
    expect(html).toContain('name="priceMismatchRelative"');
    expect(html).toContain('name="seoCoverageMinimum"');
    expect(html).toContain('name="sourceHealthConsecutiveFailures"');
    expect(html).toContain('value="20"');
    expect(html).toContain("Save thresholds");
  });

  it("preserves contract-valid precise values without browser rounding constraints", () => {
    const html = renderToStaticMarkup(
      createElement(ThresholdsForm, {
        storeId: "70000000-0000-4000-8000-000000000001",
        thresholds: {
          ...defaultStoreThresholds,
          catalogDropPercentage: 0.12345,
          priceMismatchTolerance: { absolute: 0.005, relative: 1.5 },
          minimumMismatchRatio: 0.33333
        }
      })
    );

    expect(html).toContain('name="catalogDropPercentage"');
    expect(html).toContain('name="catalogDropPercentage" value="12.345"');
    expect(html).toContain('name="priceMismatchAbsolute" value="0.005"');
    expect(html).toContain('name="priceMismatchRelative" value="150"');
    expect(html).toContain('name="minimumMismatchRatio" value="33.333"');
    expect(html).toContain('step="any"');
    expect(html).not.toContain('name="priceMismatchRelative" max="100"');
  });
});
