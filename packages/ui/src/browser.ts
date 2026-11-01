/** `window.localStorage`, or undefined when the browser blocks it (reading the property itself can throw). */
export function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
