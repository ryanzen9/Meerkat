import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { BridgeError, publicError } from '../errors';
import type { Exclusive, SecretStore } from './storage';
import type { HttpFetch } from '../http';
import type { AccountStatus } from '../providers/types';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct',
];
const secretKey = 'meerkat.bridge.chatgpt.v1';
const tokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().min(1).optional(),
  expiresAt: z.number(),
  earliestRefreshAt: z.number().optional(),
  scopes: z.array(z.string()),
});
const registrationSchema = z.object({
  id: z.string(),
  clientId: z.string().startsWith('oaiapp_'),
  issuer: z.literal(CHATGPT_ISSUER),
  subject: z.string().min(1),
  email: z.string().optional(),
  tokens: tokensSchema.optional(),
});
const vaultSchema = z.object({
  hostId: z.string().startsWith('urn:uuid:'),
  activeId: z.string().optional(),
  registrations: z.array(registrationSchema),
});
type Vault = z.infer<typeof vaultSchema>;
export type ChatGPTRegistration = z.infer<typeof registrationSchema>;
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  token_type: z.string(),
  expires_in: z.number().positive().max(86400),
  scope: z.string().optional(),
  earliest_refresh_at: z.number().optional(),
});
const discoverySchema = z.object({
  issuer: z.literal(CHATGPT_ISSUER),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  revocation_endpoint: z.string().url(),
});
type Discovery = z.infer<typeof discoverySchema>;
interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  registrationId?: string;
  clientId: string;
  requestedScopes: string[];
}
export interface ChatGPTAuthOptions {
  secrets: SecretStore;
  exclusive: Exclusive;
  fetch?: HttpFetch;
  now?: () => number;
  verifyIdToken?: (token: string, clientId: string, discovery: Discovery) => Promise<JWTPayload>;
}

export class ChatGPTAuth {
  private pending: Pending | undefined;
  private signInError: string | undefined;
  private discovery: Promise<Discovery> | undefined;
  private readonly http: HttpFetch;
  private readonly now: () => number;
  private readonly verify: NonNullable<ChatGPTAuthOptions['verifyIdToken']>;

  constructor(private readonly options: ChatGPTAuthOptions) {
    this.http = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.verify =
      options.verifyIdToken ??
      (async (token, clientId, discovery) => {
        const keys = createRemoteJWKSet(new URL(discovery.jwks_uri));
        return (
          await jwtVerify(token, keys, {
            issuer: CHATGPT_ISSUER,
            audience: clientId,
            algorithms: ['RS256'],
            requiredClaims: ['sub', 'exp', 'iat'],
            clockTolerance: 5,
          })
        ).payload;
      });
  }

  private async load(): Promise<Vault> {
    const saved = await this.options.secrets.get(secretKey);
    if (saved) {
      try {
        return vaultSchema.parse(JSON.parse(saved));
      } catch {
        throw new BridgeError(
          'credentials_invalid',
          'Saved credentials are invalid. Reset the credential vault.',
          401,
        );
      }
    }
    const vault: Vault = { hostId: `urn:uuid:${randomUUID()}`, registrations: [] };
    await this.save(vault);
    return vault;
  }
  private async save(vault: Vault): Promise<void> {
    await this.options.secrets.store(secretKey, JSON.stringify(vault));
  }
  private async discover(): Promise<Discovery> {
    this.discovery ??= this.request(`${CHATGPT_ISSUER}/.well-known/openid-configuration`)
      .then((value) => {
        const config = discoverySchema.parse(value);
        for (const endpoint of [
          config.authorization_endpoint,
          config.token_endpoint,
          config.jwks_uri,
          config.revocation_endpoint,
        ]) {
          if (new URL(endpoint).origin !== CHATGPT_ISSUER)
            throw new BridgeError(
              'discovery_invalid',
              'Unexpected OpenAI authentication endpoint.',
              502,
            );
        }
        return config;
      })
      .catch((error: unknown) => {
        this.discovery = undefined;
        throw error;
      });
    return this.discovery;
  }
  private async request(url: string, body?: URLSearchParams): Promise<unknown> {
    let response: Response;
    try {
      response = await this.http(url, {
        ...(body ? { method: 'POST', body } : {}),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw new BridgeError(
        'auth_unavailable',
        'OpenAI authentication is unavailable. Please retry.',
        502,
      );
    }
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      const code = z.object({ error: z.string() }).safeParse(data);
      if (
        code.success &&
        [
          'invalid_grant',
          'invalid_token',
          'invalid_client',
          'invalid_refresh_token',
          'token_expired',
          'refresh_token_expired',
          'refresh_token_invalidated',
          'refresh_token_reused',
        ].includes(code.data.error)
      )
        throw new BridgeError('auth_expired', 'ChatGPT authorization expired. Sign in again.', 401);
      throw new BridgeError(
        'auth_unavailable',
        'OpenAI authentication rejected the request. Please retry.',
        502,
      );
    }
    return response.status === 204 ? {} : response.json().catch(() => ({}));
  }

  status(): Promise<AccountStatus> {
    return this.options.exclusive(async () => {
      if (this.pending && this.pending.expiresAt <= this.now()) {
        this.pending = undefined;
        this.signInError = 'ChatGPT sign-in timed out. Please retry.';
      }
      const vault = await this.load();
      const active = vault.registrations.find((r) => r.id === vault.activeId);
      return {
        authenticated: !!active?.tokens,
        signInPending: !!this.pending && this.pending.expiresAt > this.now(),
        ...(this.signInError ? { signInError: this.signInError } : {}),
        ...(active?.tokens ? { activeAccountId: active.id } : {}),
        accounts: vault.registrations.map((r) => ({
          id: r.id,
          subject: r.subject,
          ...(r.email ? { email: r.email } : {}),
          signedIn: !!r.tokens,
        })),
      };
    });
  }

  login(redirectUri: string, accountId?: string): Promise<string> {
    return this.options.exclusive(async () => {
      const callback = new URL(redirectUri);
      if (
        callback.protocol !== 'http:' ||
        callback.hostname !== '127.0.0.1' ||
        callback.pathname !== '/auth/callback' ||
        callback.search ||
        callback.hash
      )
        throw new BridgeError(
          'callback_invalid',
          'OAuth requires a 127.0.0.1 /auth/callback listener.',
        );
      const vault = await this.load();
      const registration = accountId
        ? vault.registrations.find((r) => r.id === accountId)
        : undefined;
      if (accountId && !registration)
        throw new BridgeError('account_not_found', 'Account registration not found.', 404);
      const config = await this.discover();
      const pending: Pending = {
        state: randomBytes(32).toString('base64url'),
        nonce: randomBytes(32).toString('base64url'),
        verifier: randomBytes(48).toString('base64url'),
        redirectUri,
        expiresAt: this.now() + 5 * 60000,
        clientId: registration?.clientId ?? 'dynamic_agent_client',
        requestedScopes: [...CHATGPT_SCOPES],
        ...(registration ? { registrationId: registration.id } : {}),
      };
      this.pending = pending;
      this.signInError = undefined;
      const url = new URL(config.authorization_endpoint);
      const params: Record<string, string> = {
        client_id: pending.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: pending.requestedScopes.join(' '),
        resource: CHATGPT_RESOURCE,
        state: pending.state,
        nonce: pending.nonce,
        ext_agent_host_id: vault.hostId,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
      };
      if (!registration) params.agent_name_hint = 'Meerkat';
      if (registration?.tokens?.idToken) params.id_token_hint = registration.tokens.idToken;
      if (registration?.email) params.login_hint = registration.email;
      url.search = new URLSearchParams(params).toString();
      return url.toString();
    });
  }

  callback(params: URLSearchParams): Promise<void> {
    return this.options.exclusive(async () => {
      const pending = this.pending;
      const state = params.get('state') ?? '';
      if (
        !pending ||
        this.now() > pending.expiresAt ||
        !/^[A-Za-z0-9_-]{43}$/.test(state) ||
        state.length !== pending.state.length ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))
      )
        throw new BridgeError(
          'oauth_state_invalid',
          'Invalid or expired OAuth state. Restart sign-in.',
        );
      this.pending = undefined; // One-time consumption, including access_denied and failed exchanges.
      try {
        for (const key of ['state', 'code', 'client_id', 'error'])
          if (params.getAll(key).length > 1)
            throw new BridgeError('oauth_callback_invalid', 'Duplicate OAuth callback parameter.');
        if (params.has('error'))
          throw new BridgeError('oauth_denied', 'ChatGPT authorization was declined.');
        const code = params.get('code');
        const clientId = params.get('client_id') ?? pending.clientId;
        if (
          !code ||
          !clientId.startsWith('oaiapp_') ||
          clientId.length > 256 ||
          (pending.registrationId && clientId !== pending.clientId)
        )
          throw new BridgeError(
            'oauth_client_invalid',
            'OAuth registration returned an invalid client ID.',
          );
        const vault = await this.load();
        const config = await this.discover();
        const response = tokenResponseSchema.parse(
          await this.request(
            config.token_endpoint,
            new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: clientId,
              code,
              code_verifier: pending.verifier,
              redirect_uri: pending.redirectUri,
              resource: CHATGPT_RESOURCE,
            }),
          ),
        );
        if (!response.id_token)
          throw new BridgeError('id_token_missing', 'OpenAI did not return an ID token.', 401);
        let identity: JWTPayload;
        try {
          identity = await this.verify(response.id_token, clientId, config);
        } catch {
          throw new BridgeError('id_token_invalid', 'OpenAI identity verification failed.', 401);
        }
        if (identity.nonce !== pending.nonce || !identity.sub)
          throw new BridgeError(
            'id_token_invalid',
            'OpenAI identity nonce or subject is invalid.',
            401,
          );
        const existing = vault.registrations.find((r) => r.id === pending.registrationId);
        if (existing && existing.subject !== identity.sub)
          throw new BridgeError(
            'account_mismatch',
            'ChatGPT account differs from the selected registration.',
            401,
          );
        const tokens = this.tokens(response, undefined, pending.requestedScopes);
        const registration: ChatGPTRegistration = {
          id: existing?.id ?? randomUUID(),
          clientId,
          issuer: CHATGPT_ISSUER,
          subject: identity.sub,
          ...(typeof identity.email === 'string' ? { email: identity.email } : {}),
          tokens,
        };
        vault.registrations = vault.registrations.filter((r) => r.id !== registration.id);
        vault.registrations.push(registration);
        vault.activeId = registration.id;
        await this.save(vault);
      } catch (error) {
        this.signInError = publicError(error).message;
        throw error;
      }
    });
  }

  private tokens(
    response: z.infer<typeof tokenResponseSchema>,
    previous?: z.infer<typeof tokensSchema>,
    requestedScopes: string[] = [],
  ) {
    if (response.token_type.toLowerCase() !== 'bearer')
      throw new BridgeError('token_type_invalid', 'Unsupported OAuth token type.', 401);
    // RFC 6749 §5.1: an omitted scope means the grant matches the request.
    // Explicit empty/reduced grants must still pass the permission checks below.
    const scopes =
      response.scope?.split(/\s+/).filter(Boolean) ?? previous?.scopes ?? requestedScopes;
    if (
      !['resource.invoke', 'chatgpt.tokens.use.direct', 'offline_access'].every((scope) =>
        scopes.includes(scope),
      )
    )
      throw new BridgeError(
        'plan_permission_missing',
        'ChatGPT plan usage and offline access must be authorized.',
        403,
      );
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      ...(response.id_token
        ? { idToken: response.id_token }
        : previous?.idToken
          ? { idToken: previous.idToken }
          : {}),
      expiresAt: this.now() + response.expires_in * 1000,
      scopes,
      ...(response.earliest_refresh_at !== undefined
        ? { earliestRefreshAt: response.earliest_refresh_at * 1000 }
        : {}),
    };
  }

  credential(
    accountId: string,
    forceRefresh = false,
  ): Promise<ChatGPTRegistration & { tokens: z.infer<typeof tokensSchema> }> {
    return this.options.exclusive(async () => {
      const vault = await this.load();
      const registration = vault.registrations.find((r) => r.id === accountId);
      if (!registration?.tokens || vault.activeId !== accountId)
        throw new BridgeError(
          'sign_in_required',
          'Continue with ChatGPT before starting this session.',
          401,
        );
      const current = registration.tokens;
      if (forceRefresh || current.expiresAt - this.now() < 60000) {
        if (current.earliestRefreshAt && this.now() < current.earliestRefreshAt) {
          if (current.expiresAt <= this.now())
            throw new BridgeError(
              'refresh_too_early',
              'Token renewal is not available yet. Please retry.',
              503,
            );
        } else {
          try {
            const config = await this.discover();
            const response = tokenResponseSchema.parse(
              await this.request(
                config.token_endpoint,
                new URLSearchParams({
                  grant_type: 'refresh_token',
                  client_id: registration.clientId,
                  refresh_token: current.refreshToken,
                  resource: CHATGPT_RESOURCE,
                }),
              ),
            );
            if (response.id_token) {
              try {
                const identity = await this.verify(
                  response.id_token,
                  registration.clientId,
                  config,
                );
                if (identity.sub !== registration.subject)
                  throw new Error('Refresh identity mismatch');
              } catch {
                throw new BridgeError(
                  'id_token_invalid',
                  'Refreshed OpenAI identity verification failed.',
                  401,
                );
              }
            }
            registration.tokens = this.tokens(response, current);
            await this.save(vault); // Access + rotating refresh token replaced in one secret write.
          } catch (error) {
            if (error instanceof BridgeError && [401, 403].includes(error.status)) {
              delete registration.tokens;
              await this.save(vault);
            }
            throw error;
          }
        }
      }
      return { ...registration, tokens: registration.tokens! };
    });
  }

  invalidate(accountId: string): Promise<void> {
    return this.options.exclusive(async () => {
      const vault = await this.load();
      const registration = vault.registrations.find((r) => r.id === accountId);
      if (registration) delete registration.tokens;
      await this.save(vault);
    });
  }

  logout(): Promise<{ remoteRevocationConfirmed: boolean }> {
    this.pending = undefined;
    this.signInError = undefined;
    return this.options.exclusive(async () => {
      const vault = await this.load();
      const registration = vault.registrations.find((r) => r.id === vault.activeId);
      let confirmed = !registration?.tokens;
      if (registration?.tokens) {
        try {
          const config = await this.discover();
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await this.request(
                config.revocation_endpoint,
                new URLSearchParams({
                  token: registration.tokens.refreshToken,
                  token_type_hint: 'refresh_token',
                  client_id: registration.clientId,
                }),
              );
              confirmed = true;
              break;
            } catch {
              if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
        } catch {
          /* Local sign-out must complete even when discovery is unavailable. */
        }
        delete registration.tokens;
      }
      delete vault.activeId;
      await this.save(vault);
      return { remoteRevocationConfirmed: confirmed };
    });
  }
}
