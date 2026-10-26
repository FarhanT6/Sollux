/**
 * Optional parts of Sollux. Bills and expenses — utilities, payments,
 * insights, the portfolio, import and scan — are always on. The rest is a
 * module an account turns on in Settings, so a new customer starts with the
 * product they came for. Accounts from before modules existed have them all.
 */
export const MODULES = ['operations', 'books', 'personal'] as const;
export type ModuleKey = typeof MODULES[number];

/** The modules an account uses: modulesJson, or every module when unset. */
export function modulesOf(u: { modulesJson?: unknown }): ModuleKey[] {
  if (!Array.isArray(u.modulesJson)) return [...MODULES];
  return u.modulesJson.filter((m): m is ModuleKey => (MODULES as readonly string[]).includes(String(m)));
}
