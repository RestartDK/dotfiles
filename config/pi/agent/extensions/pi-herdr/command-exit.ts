export function parseCommandExit(output: string, marker: string | null): number | null {
  if (marker === null) return null;
  const matches = output.matchAll(new RegExp(`^${marker}=(\\d+)\\s*$`, "gm"));
  let exitCode: number | null = null;
  for (const match of matches) exitCode = Number(match[1]);
  return exitCode;
}
