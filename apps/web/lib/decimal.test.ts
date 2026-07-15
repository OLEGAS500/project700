import { describe, expect, it } from "vitest";
import { decimalToPercentage, percentageToDecimal } from "./decimal";

describe("bounded decimal utilities", () => {
  it("preserves precise percentage values", () => {
    expect(percentageToDecimal("33.333")).toBe(0.33333);
    expect(decimalToPercentage(0.33333)).toBe("33.333");
  });

  it("round-trips finite numbers represented with exponent notation", () => {
    expect(percentageToDecimal(decimalToPercentage(1e-100))).toBe(1e-100);
    expect(percentageToDecimal(decimalToPercentage(1e100))).toBe(1e100);
  });

  it("rejects exponent notation and huge input without throwing", () => {
    expect(() => percentageToDecimal("1e1000000000")).not.toThrow();
    expect(percentageToDecimal("1e1000000000")).toBeNaN();
    expect(percentageToDecimal("1e3")).toBeNaN();
  });
});
