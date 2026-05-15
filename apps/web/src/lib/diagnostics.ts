const PII_PATTERNS: Array<[RegExp, string]> = [
  [/\+?\d[\d\s().-]{7,}\d/g, "[phone]"],
  [/\b[\w.-]+@[\w-]+\.[\w.-]+\b/g, "[email]"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[hex]"],
  [/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [token]"],
  [/"sessionId"\s*:\s*"[^"]+"/g, '"sessionId":"[redacted]"'],
  [/"password"\s*:\s*"[^"]+"/g, '"password":"[redacted]"'],
  [/"apiHash"\s*:\s*"[^"]+"/g, '"apiHash":"[redacted]"'],
];

export function scrubPii(input: string): string {
  let output = input;
  for (const [pattern, replacement] of PII_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function buildDiagnostics(error: Error): string {
  const parts = [
    `Time: ${new Date().toISOString()}`,
    `URL: ${typeof window !== "undefined" ? window.location.href : "(unknown)"}`,
    `UA: ${typeof navigator !== "undefined" ? navigator.userAgent : "(unknown)"}`,
    `Error: ${error.name}: ${error.message}`,
    error.stack ? `Stack:\n${error.stack}` : "",
  ].filter(Boolean);
  return scrubPii(parts.join("\n"));
}
