import { useCallback, useEffect, useRef, useState } from 'react';
import { bridgeJson } from '../services/bridgeApi';
import type { AgentModel } from '../../shared/agentModels';

interface Account {
  id: string;
  email?: string;
  subject: string;
  signedIn: boolean;
}
interface Status {
  authenticated: boolean;
  activeAccountId?: string;
  signInPending?: boolean;
  signInError?: string;
  accounts: Account[];
}
export function useAgentConnection() {
  const [status, setStatus] = useState<Status>({ authenticated: false, accounts: [] });
  const [models, setModels] = useState<AgentModel[]>([]);
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(false);
  const waitingRef = useRef(false);
  const expectedAccount = useRef<string | undefined>(undefined);
  const accountBeforeLogin = useRef<string | undefined>(undefined);
  const previousAccount = useRef<string | undefined>(undefined);
  const refresh = useCallback(async () => {
    const next = await bridgeJson<Status>('/v1/providers/openai-agents/auth');
    setStatus(next);
    let attemptError = '';
    if (waitingRef.current && !next.signInPending) {
      // End the attempt independently of authentication/model loading success.
      waitingRef.current = false;
      setWaiting(false);
      const succeeded =
        next.authenticated &&
        (expectedAccount.current
          ? next.activeAccountId === expectedAccount.current
          : next.activeAccountId !== accountBeforeLogin.current);
      attemptError = next.signInError ?? (succeeded ? '' : 'ChatGPT 授权未完成，请重试。');
    }
    setError(attemptError);
    if (next.authenticated) {
      if (next.activeAccountId !== previousAccount.current) {
        setModels([]);
        setModel('');
      }
      try {
        const catalog = await bridgeJson<AgentModel[]>('/v1/providers/openai-agents/models');
        setModels(catalog);
        setModel((current) =>
          next.activeAccountId === previousAccount.current && catalog.some((m) => m.id === current)
            ? current
            : (catalog[0]?.id ?? ''),
        );
        previousAccount.current = next.activeAccountId;
      } catch (failure) {
        setError(
          attemptError ||
            (failure instanceof Error ? failure.message : 'Model catalog unavailable'),
        );
      }
    } else {
      setModels([]);
      setModel('');
    }
    return next;
  }, []);
  useEffect(() => {
    void refresh().catch((failure: Error) => setError(failure.message));
  }, [refresh]);
  useEffect(() => {
    if (!waiting) return;
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void refresh()
        .catch((failure: Error) => setError(failure.message))
        .finally(() => {
          polling = false;
        });
    }, 2000);
    const deadline = setTimeout(() => {
      waitingRef.current = false;
      setWaiting(false);
      setError('ChatGPT 授权等待超时，请重试。');
    }, 5 * 60000);
    return () => {
      clearInterval(timer);
      clearTimeout(deadline);
    };
  }, [waiting, refresh]);
  const login = async (accountId?: string) => {
    try {
      expectedAccount.current = accountId;
      accountBeforeLogin.current = status.activeAccountId;
      await bridgeJson('/v1/providers/openai-agents/login', 'POST', accountId ? { accountId } : {});
      waitingRef.current = true;
      setWaiting(true);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Sign-in failed');
    }
  };
  const logout = async () => {
    try {
      waitingRef.current = false;
      setWaiting(false);
      const result = await bridgeJson<{ remoteRevocationConfirmed: boolean }>(
        '/v1/providers/openai-agents/logout',
        'POST',
        {},
      );
      await refresh();
      if (!result.remoteRevocationConfirmed)
        setError('已在本机登出。远端撤销未确认，可在 ChatGPT Settings 断开应用。');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Sign-out failed');
    }
  };
  return { ...status, models, model, setModel, error, waiting, login, logout };
}
