export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// Never serialize SDK errors: their messages can contain request bodies or credentials.
export function publicError(error: unknown): BridgeError {
  // Official providers wrap fetch/stream failures in SDK errors. Recover only
  // our own safe error type; never expose the SDK message, body or headers.
  for (let depth = 0; depth < 8 && error instanceof Error; depth++) {
    if (error instanceof BridgeError) return error;
    error = error.cause;
  }
  return new BridgeError('internal_error', 'Bridge operation failed. Please retry.', 500);
}
