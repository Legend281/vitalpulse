import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { checkPasswordBreachHandler } from './checkPasswordBreach';

function req(auth: { uid: string; token: Record<string, unknown> } | undefined, data: unknown): CallableRequest {
  return { auth, data } as unknown as CallableRequest;
}

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('checkPasswordBreachHandler', () => {
  it('HOSTILE: rejects a prefix that is too short', async () => {
    await expect(checkPasswordBreachHandler(req(undefined, { prefix: 'ABC' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('HOSTILE: rejects a prefix that is too long', async () => {
    await expect(checkPasswordBreachHandler(req(undefined, { prefix: 'ABCDEF' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('HOSTILE: rejects a non-hex prefix', async () => {
    await expect(checkPasswordBreachHandler(req(undefined, { prefix: 'ZZZZZ' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('HOSTILE: rejects a payload carrying extra fields (e.g. an accidental raw password)', async () => {
    await expect(
      checkPasswordBreachHandler(req(undefined, { prefix: 'ABCDE', password: 'hunter2' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a missing prefix', async () => {
    await expect(checkPasswordBreachHandler(req(undefined, {}))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('does not require authentication — callable before any Firebase Auth session exists', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '' });
    await expect(checkPasswordBreachHandler(req(undefined, { prefix: 'ABCDE' }))).resolves.toBeDefined();
  });

  it('queries HIBP with the uppercased prefix and the padding header, and parses suffixes', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => '003D68EB55068C33ACE09247EE4C639306:3\r\n011053FD0102E94D6AE2F8B83D76FAF94F:1\r\n',
    });

    const result = await checkPasswordBreachHandler(req(undefined, { prefix: 'abcde' }));

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.pwnedpasswords.com/range/ABCDE',
      expect.objectContaining({ headers: { 'Add-Padding': 'true' } }),
    );
    expect(result).toEqual({
      suffixes: ['003D68EB55068C33ACE09247EE4C639306', '011053FD0102E94D6AE2F8B83D76FAF94F'],
      degraded: false,
    });
  });

  it('fails open (empty list, degraded: true) when the HIBP request throws', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const result = await checkPasswordBreachHandler(req(undefined, { prefix: 'ABCDE' }));
    expect(result).toEqual({ suffixes: [], degraded: true });
  });

  it('fails open (empty list, degraded: true) when HIBP responds with a non-OK status', async () => {
    mockFetch.mockResolvedValue({ ok: false, text: async () => '' });
    const result = await checkPasswordBreachHandler(req(undefined, { prefix: 'ABCDE' }));
    expect(result).toEqual({ suffixes: [], degraded: true });
  });
});
