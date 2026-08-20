import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('MountainView mobile SPMT browser auth', () => {
  it('uses an external browser and app deep link instead of an embedded auth WebView', () => {
    const patch = read('scripts/patch-mobile-spmt-browser-auth.mjs');
    expect(patch).toContain('Linking.openURL(loginUrl)');
    expect(patch).toContain('Linking.addEventListener("url"');
    expect(patch).toContain('mountainviewai://auth?code=');
    expect(patch).toContain('Finish sign-in in your browser');
    expect(patch).toContain('window.location.replace');
    expect(patch).toContain('source = required(source, webViewBlock, browserBlock');
  });

  it('keeps the real MountainView session token out of the deep-link URL', () => {
    const patch = read('scripts/patch-mobile-spmt-browser-auth.mjs');
    expect(patch).toContain('mobile_auth_handoffs');
    expect(patch).toContain('encrypted_session_token');
    expect(patch).toContain('hashToken(code)');
    expect(patch).toContain('this.encrypt(sessionToken)');
    expect(patch).toContain('DELETE FROM mobile_auth_handoffs WHERE code_hash = ?');
    expect(patch).toContain('/api/auth/mobile/exchange');
  });

  it('limits the one-time browser handoff to two minutes', () => {
    const patch = read('scripts/patch-mobile-spmt-browser-auth.mjs');
    expect(patch).toContain('2 * 60 * 1000');
    expect(patch).toContain('Mobile sign-in code is invalid or expired.');
  });
});
