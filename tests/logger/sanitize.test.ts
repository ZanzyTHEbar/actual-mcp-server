import { describe, it, expect } from 'vitest';
import { sanitizeError, sanitizeForLog } from '../../src/logger.js';

describe('sanitizeError', () => {
  it('should redact Bearer token from error message', () => {
    const err = new Error('Auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx');
    const out = sanitizeError(err);
    expect(out.message).toContain('[REDACTED]');
    expect(out.message).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('should redact password= from error message', () => {
    const err = new Error('Invalid password=superSecret123 for user');
    const out = sanitizeError(err);
    expect(out.message).toContain('[REDACTED]');
    expect(out.message).not.toContain('superSecret123');
  });

  it('should preserve non-sensitive error message', () => {
    const err = new Error('Connection refused to localhost:5006');
    const out = sanitizeError(err);
    expect(out.message).toBe('Connection refused to localhost:5006');
  });

  it('should handle non-Error values', () => {
    const out = sanitizeError('string error');
    expect(out.message).toBe('string error');
  });

  it('should sanitize stack traces', () => {
    const err = new Error('Failed');
    err.stack = 'Error: Failed\n  at foo (Bearer secret123)';
    const out = sanitizeError(err);
    expect(out.stack).toContain('[REDACTED]');
    expect(out.stack).not.toContain('secret123');
  });
});

describe('sanitizeForLog', () => {
  it('should redact authorization header', () => {
    const obj = { headers: { authorization: 'Bearer xxx' } };
    const out = sanitizeForLog(obj) as { headers: { authorization: string } };
    expect(out.headers.authorization).toBe('[REDACTED]');
  });

  it('should redact password keys', () => {
    const obj = { password: 'secret', user: 'alice' };
    const out = sanitizeForLog(obj) as { password: string; user: string };
    expect(out.password).toBe('[REDACTED]');
    expect(out.user).toBe('alice');
  });

  it('should redact nested sensitive keys', () => {
    const obj = { config: { api_key: 'sk-xxx' } };
    const out = sanitizeForLog(obj) as { config: { api_key: string } };
    expect((out.config as any).api_key).toBe('[REDACTED]');
  });
});
