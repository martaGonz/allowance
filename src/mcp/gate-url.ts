export function buildGateUrl(base: string, toolName: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `${base}/tools/${encodeURIComponent(toolName)}?${query.toString()}`;
}
