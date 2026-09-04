export function parseStoredBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'boolean' ? parsed : fallback
  } catch {
    return fallback
  }
}

export function parseStoredArray<T>(value: string | null): T[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}
