export function createBlacklist(env: string | undefined): (pool?: string | null) => boolean {
  const names = new Set((env ?? '').split(',').map(s => s.trim()).filter(Boolean));
  return (pool) => !!pool && names.has(pool);
}
