export type ErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "ALREADY_EXISTS" | "INTEGRITY" | "KEY_UNAVAILABLE" | "LOCK_TIMEOUT" | "UNSAFE_PATH";

export class ProfileError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProfileError";
  }
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
