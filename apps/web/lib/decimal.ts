const MAX_DECIMAL_INPUT_LENGTH = 512;
const MAX_DECIMAL_OUTPUT_LENGTH = 4096;
const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;
const DECIMAL_WITH_EXPONENT_PATTERN = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;

export function decimalToPercentage(value: number): string {
  if (!Number.isFinite(value)) return "";

  return shiftDecimal(value.toString(), 2, true) ?? "";
}

export function percentageToDecimal(raw: string): number {
  if (typeof raw !== "string" || raw.length > MAX_DECIMAL_INPUT_LENGTH) return Number.NaN;

  const decimal = shiftDecimal(raw.trim(), -2, false);
  return decimal === null ? Number.NaN : Number(decimal);
}

function shiftDecimal(raw: string, shift: number, allowExponent: boolean): string | null {
  if (raw.length === 0 || raw.length > MAX_DECIMAL_INPUT_LENGTH) return null;

  const match = raw.match(allowExponent ? DECIMAL_WITH_EXPONENT_PATTERN : DECIMAL_PATTERN);
  if (!match) return null;

  const [, integerPart, fractionPart = "", exponentText] = match;
  const exponent = Number(exponentText ?? 0);
  if (!Number.isSafeInteger(exponent)) return null;

  const digits = integerPart + fractionPart;
  const decimalIndex = integerPart.length + exponent + shift;
  const outputLength = decimalIndex <= 0
    ? 2 + -decimalIndex + digits.length
    : decimalIndex >= digits.length
      ? decimalIndex
      : digits.length + 1;

  if (outputLength > MAX_DECIMAL_OUTPUT_LENGTH) return null;

  if (decimalIndex <= 0) {
    return `0.${"0".repeat(-decimalIndex)}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return trimLeadingZeros(`${digits}${"0".repeat(decimalIndex - digits.length)}`);
  }

  return trimLeadingZeros(`${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`);
}

function trimLeadingZeros(value: string): string {
  if (!value.includes(".")) return value.replace(/^0+(?=\d)/, "");

  const [integerPart, fractionPart] = value.split(".");
  return `${integerPart.replace(/^0+(?=\d)/, "")}.${fractionPart}`;
}
