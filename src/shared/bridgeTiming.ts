export const AGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Let the Host deliver its timeout result before a disconnected transport expires.
export const BRIDGE_TRANSPORT_IDLE_TIMEOUT_MS = AGENT_IDLE_TIMEOUT_MS + 15000;

export function createIdleTimer(onTimeout: () => void, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const reset = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(onTimeout, timeoutMs);
  };
  reset();
  return {
    reset,
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
