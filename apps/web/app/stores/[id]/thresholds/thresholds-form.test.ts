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
});
