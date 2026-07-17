import { describe, expect, it } from "vitest";
import { metadata } from "./layout";

describe("root metadata", () => {
  it("publishes the Google Search Console verification tag in the document head", () => {
    expect(metadata).toMatchObject({
      verification: {
        google: "5z2X6PdxJd7qhs-uyXZNj_-M3uGY4CSqXCFX8ffqi3g"
      }
    });
  });
});
