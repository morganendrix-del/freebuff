/** Explicit success/failure values for decisions callers must handle (no exceptions for control flow). */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

export function mapResult<T, U, E>(result: Result<T, E>, map: (value: T) => U): Result<U, E> {
  return result.ok ? ok(map(result.value)) : result;
}

export function mapError<T, E, F>(result: Result<T, E>, map: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(map(result.error));
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function unwrapOrThrow<T, E>(result: Result<T, E>, describe?: (error: E) => string): T {
  if (result.ok) return result.value;
  throw new Error(describe ? describe(result.error) : "Result was an error.");
}

export async function fromPromise<T>(operation: Promise<T>): Promise<Result<T, unknown>> {
  try {
    return ok(await operation);
  } catch (error) {
    return err(error);
  }
}
