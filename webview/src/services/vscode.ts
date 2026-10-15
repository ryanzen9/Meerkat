import type { WebviewState } from '@shared/models';
import type { WebviewToExtensionMessage } from '@shared/protocol';

interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: WebviewState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Acquire once, keep private, and never expose the API on window.
const api = acquireVsCodeApi();

export const vscodeBridge = {
  postMessage: (message: WebviewToExtensionMessage): void => api.postMessage(message),
  getState: (): unknown => api.getState(),
  setState: (state: WebviewState): void => api.setState(state),
};
