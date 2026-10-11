'use strict';

// Real Auth.js OIDC code flow over a test-only transport. Nothing in production
// accepts these keys, identities, authorization codes, or transport settings.
const { generateKeyPairSync, createSign, createHash, randomUUID } = require('node:crypto');
const ISSUER = 'https://accounts.google.com';
const AUTHORIZE = `${ISSUER}/o/oauth2/v2/auth`;
const TOKEN = 'https://oauth2.googleapis.com/token';
const JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function createMockGoogle({ origin, clientId = 'test-google-client', clientSecret = 'test-google-secret' }) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: 'jwk' }), kid: 'mock-google-key', alg: 'RS256', use: 'sig' };
  const grants = new Map();
  const mock = {
    identity: { sub: 'google-subject-a', name: 'Test Pilot', email: 'pilot@example.test', email_verified: true,
      picture: 'https://example.test/pilot.png' },
    cancel: false, tokenError: false, claimOverrides: {}, counts: { discovery: 0, authorize: 0, token: 0, jwks: 0 },
  };
  function signedToken(claims) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey, 'base64url');
    return `${header}.${payload}.${signature}`;
  }
  mock.authorize = (req, res) => {
    const parameters = new URL(req.originalUrl, origin()).searchParams;
    const callback = new URL(parameters.get('redirect_uri'));
    if (callback.origin !== origin() || callback.pathname !== '/api/auth/callback/google'
      || parameters.get('client_id') !== clientId || parameters.get('code_challenge_method') !== 'S256'
      || !parameters.get('state') || !parameters.get('nonce')) return res.status(400).send('Invalid mock authorization request.');
    mock.counts.authorize++;
    callback.searchParams.set('state', parameters.get('state'));
    if (mock.cancel) callback.searchParams.set('error', 'access_denied');
    else {
      const code = randomUUID();
      grants.set(code, { challenge: parameters.get('code_challenge'), nonce: parameters.get('nonce'),
        redirectUri: callback.origin + callback.pathname, identity: { ...mock.identity } });
      callback.searchParams.set('code', code);
    }
    res.redirect(302, callback.href);
  };
  mock.authorizationUrl = url => `${origin()}/mock/google?${new URL(url).searchParams}`;
  mock.oauthFetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      mock.counts.discovery++;
      return json({ issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN,
        userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo', jwks_uri: JWKS,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic'] });
    }
    if (url === JWKS) { mock.counts.jwks++; return json({ keys: [key] }); }
    if (url === TOKEN) {
      mock.counts.token++;
      if (mock.tokenError) return new Response(JSON.stringify({ error: 'server_error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      const body = new URLSearchParams(init.body);
      const headers = new Headers(init.headers);
      const grant = grants.get(body.get('code'));
      if (!grant || headers.get('authorization') !== `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
        || body.get('grant_type') !== 'authorization_code' || body.get('redirect_uri') !== grant.redirectUri
        || createHash('sha256').update(body.get('code_verifier') || '').digest('base64url') !== grant.challenge) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      grants.delete(body.get('code'));
      const now = Math.floor(Date.now() / 1000);
      return json({ token_type: 'Bearer', expires_in: 3600, access_token: 'mock-google-access-secret',
        refresh_token: 'mock-google-refresh-secret', id_token: signedToken({
          iss: ISSUER, aud: clientId, iat: now, exp: now + 3600, nonce: grant.nonce,
          ...grant.identity, ...mock.claimOverrides,
        }) });
    }
    throw new Error(`Unexpected OAuth transport URL: ${url}`);
  };
  return mock;
}

module.exports = { createMockGoogle };
