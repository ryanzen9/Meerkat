import { useCallback, useEffect, useRef, useState } from 'react';
import { bridgeFetch } from '../services/bridgeFetch';

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
  accounts: Account[];
}
interface Model {
  id: string;
  name: string;
}
export async function bridgeJson<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await bridgeFetch(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? 'Bridge request failed');
  return value as T;
}

export function useAgentConnection() {
  const [status, setStatus] = useState<Status>({ authenticated: false, accounts: [] });
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(false);
  const expectedAccount = useRef<string | undefined>(undefined);
  const accountBeforeLogin = useRef<string | undefined>(undefined);
  const previousAccount = useRef<string | undefined>(undefined);
  const refresh = useCallback(async () => {
    const next = await bridgeJson<Status>('/v1/providers/openai-agents/auth');
    setStatus(next);
    if (next.authenticated) {
      const catalog = await bridgeJson<Model[]>('/v1/providers/openai-agents/models');
      setModels(catalog);
      setModel((current) =>
        next.activeAccountId === previousAccount.current && catalog.some((m) => m.id === current)
          ? current
          : (catalog[0]?.id ?? ''),
      );
      previousAccount.current = next.activeAccountId;
    } else {
      setModels([]);
      setModel('');
    }
    setError('');
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
        .then((next) => {
          if (
            !next.signInPending &&
            next.authenticated &&
            (expectedAccount.current
              ? next.activeAccountId === expectedAccount.current
              : next.activeAccountId !== accountBeforeLogin.current)
          )
            setWaiting(false);
        })
        .catch((failure: Error) => setError(failure.message))
        .finally(() => {
          polling = false;
        });
    }, 2000);
    const deadline = setTimeout(() => setWaiting(false), 5 * 60000);
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
      setWaiting(true);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Sign-in failed');
    }
  };
  const logout = async () => {
    try {
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
