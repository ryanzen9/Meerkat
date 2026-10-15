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
  return error instanceof BridgeError
    ? error
    : new BridgeError('internal_error', 'Bridge operation failed. Please retry.', 500);
}
