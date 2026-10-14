import type { PanelSnapshot } from '../../shared/models';
import type { ExtensionToWebviewMessage } from '../../shared/protocol';

export interface PanelUiState {
  snapshot: PanelSnapshot | null;
  reply: string | null;
  error: string | null;
}

export const initialPanelState: PanelUiState = { snapshot: null, reply: null, error: null };

export function panelReducer(
  state: PanelUiState,
  message: ExtensionToWebviewMessage,
): PanelUiState {
  switch (message.type) {
    case 'host/snapshot':
      return { ...state, snapshot: message.snapshot, error: null };
    case 'host/error':
      return { ...state, error: message.message };
    case 'host/action':
      return { ...state, error: null };
    case 'host/hello':
      return {
        ...state,
        reply: message.message,
        error: null,
        snapshot: state.snapshot
          ? { ...state.snapshot, state: { messageCount: message.messageCount } }
          : null,
      };
  }
}
