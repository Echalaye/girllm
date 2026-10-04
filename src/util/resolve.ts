/**
 * A value, or a function producing the current value. Lets services take
 * fixed options (tests, scripts) or live ones (settings changed at runtime)
 * without caring which.
 */
export type Live<T> = T | (() => T);

export function resolve<T>(value: Live<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}
