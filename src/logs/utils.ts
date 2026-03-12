/** Format a data record as inline key=value pairs for log output. */
export function formatInline(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([k, v]) => v !== undefined && v !== null && k !== 'stack')
    .map(([k, v]) => {
      if (typeof v === 'string') {
        const clean = v.split('\n')[0]!;
        const limit = k === 'error' ? 512 : 120;
        return `${k}=${clean.length > limit ? clean.slice(0, limit) + '...' : clean}`;
      }
      if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${v}`;
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(' ');
}