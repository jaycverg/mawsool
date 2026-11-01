import { describe, expect, it } from 'vitest';
import { originOf, staffContentSecurityPolicy, staffSecurityHeaders } from '../src';

const policy = (development: boolean) => staffContentSecurityPolicy({ apiOrigin: 'http://localhost:4000', development });
const directive = (text: string, name: string) => text.split('; ').find((part) => part.startsWith(`${name} `));

describe('the staff apps’ page policy', () => {
  it('lets a page talk to itself and the API and nothing else', () => {
    expect(directive(policy(false), 'connect-src')).toBe("connect-src 'self' http://localhost:4000");
    expect(directive(policy(false), 'default-src')).toBe("default-src 'self'");
  });

  it('cannot be framed, cannot move its base or its forms, and loads no plug-ins', () => {
    for (const rule of ["frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"]) expect(policy(false)).toContain(rule);
  });

  it('allows eval and the dev socket in development only', () => {
    expect(policy(true)).toContain("'unsafe-eval'");
    expect(policy(true)).toContain('ws:');
    expect(policy(false)).not.toContain('unsafe-eval');
    expect(policy(false)).not.toMatch(/\bws:/);
  });

  it('allows inline scripts, which Next.js needs on statically built pages, and says so in the code', () => {
    expect(directive(policy(false), 'script-src')).toBe("script-src 'self' 'unsafe-inline'");
  });

  it('takes the origin of the API address, dropping any path', () => {
    expect(originOf('https://api.example.test:8443/v1/')).toBe('https://api.example.test:8443');
    expect(() => originOf('not a url')).toThrow();
  });

  it('sends the policy with the other headers a page needs', () => {
    const headers = Object.fromEntries(staffSecurityHeaders({ apiUrl: 'http://localhost:4000/', development: false }).map((header) => [header.key, header.value]));
    expect(headers['Content-Security-Policy']).toBe(policy(false));
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Permissions-Policy']).toContain('camera=()');
  });
});
