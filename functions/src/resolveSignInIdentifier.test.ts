import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => {
  const get = vi.fn();
  const limit = vi.fn(() => ({ get }));
  const where = vi.fn(() => ({ limit }));
  const collection = vi.fn(() => ({ where }));
  return { get, limit, where, collection };
});

vi.mock('./firebaseAdmin', () => ({ db: { collection: mocks.collection } }));

import { resolveSignInIdentifierHandler } from './resolveSignInIdentifier';

function req(data: unknown): CallableRequest {
  return { auth: undefined, data } as unknown as CallableRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSignInIdentifierHandler', () => {
  it('does not require authentication', async () => {
    mocks.get.mockResolvedValue({ empty: true, docs: [] });
    await expect(resolveSignInIdentifierHandler(req({ identifier: '+237600000000' }))).resolves.toBeDefined();
  });

  it('HOSTILE: rejects an empty identifier', async () => {
    await expect(resolveSignInIdentifierHandler(req({ identifier: '' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('HOSTILE: rejects a missing identifier', async () => {
    await expect(resolveSignInIdentifierHandler(req({}))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('passes an email straight through, lowercased, with no Firestore lookup', async () => {
    const result = await resolveSignInIdentifierHandler(req({ identifier: 'Donor@Example.com' }));
    expect(result).toEqual({ email: 'donor@example.com' });
    expect(mocks.collection).not.toHaveBeenCalled();
  });

  it('resolves a valid Cameroon phone (various input formats) to the account email', async () => {
    mocks.get.mockResolvedValue({ empty: false, docs: [{ data: () => ({ email: 'found@x.com', phone: '+237600000000' }) }] });

    for (const input of ['600000000', '0600000000', '237600000000', '+237 600 000 000']) {
      const result = await resolveSignInIdentifierHandler(req({ identifier: input }));
      expect(result).toEqual({ email: 'found@x.com' });
    }
    expect(mocks.where).toHaveBeenCalledWith('phone', '==', '+237600000000');
  });

  it('returns { email: null } for an unmatched phone (no enumeration signal)', async () => {
    mocks.get.mockResolvedValue({ empty: true, docs: [] });
    const result = await resolveSignInIdentifierHandler(req({ identifier: '+237611111111' }));
    expect(result).toEqual({ email: null });
  });

  it('returns { email: null } for text that is neither an email nor a valid CM phone shape, without querying Firestore', async () => {
    const result = await resolveSignInIdentifierHandler(req({ identifier: 'not-a-real-identifier' }));
    expect(result).toEqual({ email: null });
    expect(mocks.collection).not.toHaveBeenCalled();
  });

  it('returns { email: null } when the matched account has no email field', async () => {
    mocks.get.mockResolvedValue({ empty: false, docs: [{ data: () => ({ phone: '+237600000000' }) }] });
    const result = await resolveSignInIdentifierHandler(req({ identifier: '+237600000000' }));
    expect(result).toEqual({ email: null });
  });
});
