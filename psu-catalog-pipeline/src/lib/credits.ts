export interface CreditsParsed {
  min: number;
  max: number;
  /** For "1-9 Credits/Maximum of 9" style strings. */
  repeatableMax: number | null;
}

/** Parse bulletin credit strings: "3 Credits", "1-9 Credits/Maximum of 9",
 * "1.5 Credits", "0.5-9 Credits". Returns null when unparseable. */
export function parseCredits(text: string): CreditsParsed | null {
  const m = /^\s*(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s*Credits?(?:\s*\/\s*Maximum of\s+(\d+(?:\.\d+)?))?/i.exec(text);
  if (!m) return null;
  const min = parseFloat(m[1]);
  const max = m[2] ? parseFloat(m[2]) : min;
  return { min, max, repeatableMax: m[3] ? parseFloat(m[3]) : null };
}
