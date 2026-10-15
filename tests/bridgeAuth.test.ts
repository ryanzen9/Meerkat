import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { generateKeyPair, SignJWT, jwtVerify } from 'jose';
import {
  ChatGPTAuth,
  CHATGPT_ISSUER,
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
} from '../src/extension/bridge/auth/chatgpt';
import type { HttpFetch } from '../src/extension/bridge/http';
import { memorySecrets, serial } from './bridgeFixture';

const keys = await generateKeyPair('RS256');
const wrongKeys = await generateKeyPair('RS256');
async function fixture() {
  const secrets = memorySecrets();
  let now = Date.now();
  let nonce = '';
  let identity: Record<string, unknown> = {};
  let refreshCalls = 0;
  let refreshFailure: { code: string; status: number } | undefined;
  let failRevocation = false;
  let wrongSignature = false;
  let scopes: string | undefined = CHATGPT_SCOPES.join(' ');
  const requests: URLSearchParams[] = [];
  const http: HttpFetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('openid-configuration'))
      return Response.json({
        issuer: CHATGPT_ISSUER,
        authorization_endpoint: `${CHATGPT_ISSUER}/api/accounts/authorize`,
        token_endpoint: `${CHATGPT_ISSUER}/api/accounts/oauth/token`,
        jwks_uri: `${CHATGPT_ISSUER}/.well-known/jwks.json`,
        revocation_endpoint: `${CHATGPT_ISSUER}/revoke`,
      });
    const params = new URLSearchParams(init?.body as URLSearchParams);
    requests.push(params);
    if (url.endsWith('/revoke')) return new Response(null, { status: failRevocation ? 503 : 200 });
    if (params.get('grant_type') === 'refresh_token') {
      refreshCalls++;
      await Bun.sleep(5);
      if (refreshFailure)
        return Response.json(
          { error: refreshFailure.code, error_description: 'test-access-secret' },
          { status: refreshFailure.status },
        );
      return Response.json({
        access_token: 'renewed-access',
        refresh_token: 'rotated-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    const idToken = await new SignJWT({ nonce, ...identity })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(String(identity.iss ?? CHATGPT_ISSUER))
      .setAudience(String(identity.aud ?? 'oaiapp_fixture'))
      .setSubject(String(identity.sub ?? 'subject-1'))
      .setIssuedAt()
      .setExpirationTime(Number(identity.exp ?? Math.floor(Date.now() / 1000) + 3600))
      .sign(wrongSignature ? wrongKeys.privateKey : keys.privateKey);
    return Response.json({
      access_token: 'test-access-secret',
      refresh_token: 'test-refresh-secret',
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: 3600,
      ...(scopes !== undefined ? { scope: scopes } : {}),
    });
  };
  const auth = new ChatGPTAuth({
    secrets,
    exclusive: serial(),
    fetch: http,
    now: () => now,
    verifyIdToken: async (token, clientId) =>
      (
        await jwtVerify(token, keys.publicKey, {
          issuer: CHATGPT_ISSUER,
          audience: clientId,
          algorithms: ['RS256'],
          requiredClaims: ['sub', 'exp', 'iat'],
        })
      ).payload,
  });
  const login = async (accountId?: string) => {
    const url = new URL(await auth.login('http://127.0.0.1:12345/auth/callback', accountId));
    nonce = url.searchParams.get('nonce')!;
    return url;
  };
  const callback = (url: URL, overrides?: Record<string, string>) =>
    auth.callback(
      new URLSearchParams({
        state: url.searchParams.get('state')!,
        code: 'fixture-code',
        client_id: 'oaiapp_fixture',
        ...overrides,
      }),
    );
  return {
    auth,
    secrets,
    requests,
    login,
    callback,
    refreshCount: () => refreshCalls,
    advance: () => {
      now += 3590000;
    },
    failRefresh: (code = 'invalid_grant', status = 400) => {
      refreshFailure = { code, status };
    },
    failRevocation: () => {
      failRevocation = true;
    },
    claims: (next: Record<string, unknown>) => {
      identity = next;
    },
    wrongSignature: () => {
      wrongSignature = true;
    },
    scopes: (value: string | undefined) => {
      scopes = value;
    },
  };
}

test('dynamic OAuth uses PKCE, issued client ID, protected persistence and restart restoration', async () => {
  const f = await fixture();
  const url = await f.login();
  expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
  expect(url.searchParams.get('resource')).toBe(CHATGPT_RESOURCE);
  expect(url.searchParams.get('agent_name_hint')).toBe('Meerkat');
  expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
  await f.callback(url);
  const params = f.requests[0]!;
  expect(params.get('client_id')).toBe('oaiapp_fixture');
  expect(params.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
  expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(
    url.searchParams.get('code_challenge')!,
  );
  const status = await f.auth.status();
  expect(status.authenticated).toBe(true);
  expect(JSON.stringify(status)).not.toMatch(/test-access|test-refresh|idToken/);
  const restored = new ChatGPTAuth({ secrets: f.secrets, exclusive: serial() });
  expect(await restored.status()).toEqual(status);
  expect((await restored.credential(status.activeAccountId!)).tokens.accessToken).toBe(
    'test-access-secret',
  );
  await expect(f.callback(url)).rejects.toThrow('state');
});

test('rejects state mismatch, duplicate callback fields and denied consent', async () => {
  const f = await fixture();
  const url = await f.login();
  await expect(f.callback(url, { state: 'wrong-state' })).rejects.toThrow('state');
  const duplicate = new URLSearchParams({
    state: url.searchParams.get('state')!,
    code: 'one',
    client_id: 'oaiapp_fixture',
  });
  duplicate.append('code', 'two');
  await expect(f.auth.callback(duplicate)).rejects.toThrow('Duplicate');
  const denied = await f.login();
  await expect(f.callback(denied, { error: 'access_denied' })).rejects.toThrow('declined');
  expect(f.requests).toHaveLength(0);
});

test('signature, issuer, audience, expiration and nonce must all validate', async () => {
  for (const claims of [
    { iss: 'https://evil.invalid' },
    { aud: 'other-client' },
    { exp: 1 },
    { nonce: 'wrong' },
  ]) {
    const f = await fixture();
    f.claims(claims);
    await expect(f.callback(await f.login())).rejects.toThrow('identity');
    expect((await f.auth.status()).authenticated).toBe(false);
  }
  const f = await fixture();
  f.wrongSignature();
  await expect(f.callback(await f.login())).rejects.toThrow('identity');
});

test('requires plan scopes, rejects missing issued client and account substitution', async () => {
  const f = await fixture();
  f.scopes('openid email');
  await expect(f.callback(await f.login())).rejects.toThrow('authorized');
  const missing = await fixture();
  await expect(
    missing.callback(await missing.login(), { client_id: 'dynamic_agent_client' }),
  ).rejects.toThrow('client ID');
  const saved = await fixture();
  await saved.callback(await saved.login());
  const accountId = (await saved.auth.status()).activeAccountId!;
  const returning = await saved.login(accountId);
  expect(returning.searchParams.get('client_id')).toBe('oaiapp_fixture');
  expect(returning.searchParams.has('agent_name_hint')).toBe(false);
  expect(returning.searchParams.has('id_token_hint')).toBe(true);
  await expect(saved.callback(returning, { client_id: 'oaiapp_other' })).rejects.toThrow(
    'client ID',
  );
  saved.claims({ sub: 'another-account' });
  await expect(saved.callback(await saved.login(accountId))).rejects.toThrow('differs');
});

test('omitted initial scope inherits this authorization request, while explicit empty/reduced grants fail', async () => {
  const f = await fixture();
  f.scopes(undefined);
  const url = await f.login();
  await f.callback(url);
  const status = await f.auth.status();
  const credential = await f.auth.credential(status.activeAccountId!);
  expect(credential.tokens.scopes).toEqual(url.searchParams.get('scope')!.split(' '));
  f.advance();
  expect((await f.auth.credential(status.activeAccountId!)).tokens.scopes).toEqual(
    credential.tokens.scopes,
  );
  expect(f.refreshCount()).toBe(1);

  for (const scope of ['', 'openid profile email']) {
    const denied = await fixture();
    denied.scopes(scope);
    await expect(denied.callback(await denied.login())).rejects.toThrow('authorized');
    expect((await denied.auth.status()).authenticated).toBe(false);
  }
});

test('ended authorization reports a sanitized failure, and retry clears it without replacing the active account', async () => {
  const f = await fixture();
  await f.callback(await f.login());
  const activeId = (await f.auth.status()).activeAccountId!;
  const pending = await f.login(activeId);
  expect((await f.auth.status()).signInPending).toBe(true);
  await expect(f.callback(pending, { error: 'access_denied' })).rejects.toThrow('declined');
  const failed = await f.auth.status();
  expect(failed.signInPending).toBe(false);
  expect(failed.signInError).toContain('declined');
  expect(failed.activeAccountId).toBe(activeId);
  expect(failed.authenticated).toBe(true);
  await f.login(activeId);
  expect((await f.auth.status()).signInError).toBeUndefined();
});

test('callback identity failure ends the pending attempt and exposes only a public error', async () => {
  const f = await fixture();
  f.wrongSignature();
  await expect(f.callback(await f.login())).rejects.toThrow('identity');
  const status = await f.auth.status();
  expect(status.signInPending).toBe(false);
  expect(status.signInError).toBe('OpenAI identity verification failed.');
  expect(JSON.stringify(status)).not.toMatch(/test-access|test-refresh|id_token/);
});

test('concurrent refreshes rotate once, persist together and clear invalid credentials', async () => {
  const f = await fixture();
  await f.callback(await f.login());
  const account = (await f.auth.status()).activeAccountId!;
  f.advance();
  const credentials = await Promise.all(
    Array.from({ length: 12 }, () => f.auth.credential(account)),
  );
  expect(f.refreshCount()).toBe(1);
  expect(credentials.every((c) => c.tokens.refreshToken === 'rotated-refresh')).toBe(true);
  const refresh = f.requests.at(-1)!;
  expect(refresh.get('client_id')).toBe('oaiapp_fixture');
  expect(refresh.has('scope')).toBe(false);
  f.failRefresh();
  await expect(f.auth.credential(account, true)).rejects.toThrow('expired');
  expect((await f.auth.status()).authenticated).toBe(false);
});

test.each([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])(
  'terminal refresh error %s clears tokens and retains the issued client for sign-in',
  async (code) => {
    const f = await fixture();
    const initial = await f.login();
    await f.callback(initial);
    const account = (await f.auth.status()).activeAccountId!;
    f.advance();
    f.failRefresh(code);
    await expect(f.auth.credential(account)).rejects.toMatchObject({
      code: 'auth_expired',
      status: 401,
    });
    const status = await f.auth.status();
    expect(status.authenticated).toBe(false);
    expect(status.accounts).toMatchObject([{ id: account, signedIn: false }]);
    expect([...f.secrets.values.values()].join('')).not.toMatch(/test-access|test-refresh|idToken/);
    await expect(f.auth.credential(account)).rejects.toMatchObject({ code: 'sign_in_required' });
    expect(f.refreshCount()).toBe(1);
    const returning = await f.login(account);
    expect(returning.searchParams.get('client_id')).toBe('oaiapp_fixture');
    expect(returning.searchParams.get('ext_agent_host_id')).toBe(
      initial.searchParams.get('ext_agent_host_id'),
    );
    await f.callback(returning);
    expect((await f.auth.status()).authenticated).toBe(true);
  },
);

test.each([
  ['temporarily_unavailable', 503],
  ['server_error', 500],
  ['rate_limited', 429],
] as const)('transient refresh error %s preserves credentials', async (code, status) => {
  const f = await fixture();
  await f.callback(await f.login());
  const account = (await f.auth.status()).activeAccountId!;
  const saved = [...f.secrets.values.values()];
  f.advance();
  f.failRefresh(code, status);
  await expect(f.auth.credential(account)).rejects.toMatchObject({
    code: 'auth_unavailable',
    status: 502,
  });
  expect((await f.auth.status()).authenticated).toBe(true);
  expect([...f.secrets.values.values()]).toEqual(saved);
});

test('logout revokes renewable session, clears tokens and retains host/client mapping', async () => {
  for (const unavailable of [false, true]) {
    const f = await fixture();
    const url = await f.login();
    await f.callback(url);
    const account = (await f.auth.status()).activeAccountId!;
    if (unavailable) f.failRevocation();
    expect((await f.auth.logout()).remoteRevocationConfirmed).toBe(!unavailable);
    expect((await f.auth.status()).authenticated).toBe(false);
    expect([...f.secrets.values.values()].join('')).not.toMatch(/test-access|test-refresh/);
    const returning = await f.login(account);
    expect(returning.searchParams.get('client_id')).toBe('oaiapp_fixture');
    expect(returning.searchParams.get('ext_agent_host_id')).toBe(
      url.searchParams.get('ext_agent_host_id'),
    );
    expect(returning.searchParams.has('id_token_hint')).toBe(false);
  }
});
