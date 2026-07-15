export function decimalToPercentage(value: number): string {
  if (!Number.isFinite(value)) return "";

  return shiftDecimal(value.toString(), 2) ?? "";
}

export function percentageToDecimal(raw: string): number {
  const decimal = shiftDecimal(raw.trim(), -2);
  return decimal === null ? Number.NaN : Number(decimal);
}

function shiftDecimal(raw: string, shift: number): string | null {
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) return null;

  const [, sign, integerPart, fractionPart = "", exponentText] = match;
  const exponent = Number(exponentText ?? 0);
  const digits = integerPart + fractionPart;
  const decimalIndex = integerPart.length + exponent + shift;
  const prefix = sign === "-" ? "-" : "";

  if (decimalIndex <= 0) {
    return `${prefix}0.${"0".repeat(-decimalIndex)}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return `${prefix}${trimLeadingZeros(`${digits}${"0".repeat(decimalIndex - digits.length)}`)}`;
  }

  return `${prefix}${trimLeadingZeros(`${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`)}`;
}

function trimLeadingZeros(value: string): string {
  if (!value.includes(".")) return value.replace(/^0+(?=\d)/, "");

  const [integerPart, fractionPart] = value.split(".");
  return `${integerPart.replace(/^0+(?=\d)/, "")}.${fractionPart}`;
}
