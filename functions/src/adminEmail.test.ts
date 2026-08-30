import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

vi.mock('./firebaseAdmin', () => ({
  db: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: vi.fn().mockResolvedValue({
          exists: true,
          data: () => ({
            adminNotificationEmail: 'info@vitalpulse237.com',
            adminEmailWebhook: 're_test_key_12345'
          })
        })
      }))
    }))
  }
}));

import { sendAdminNotificationEmailHandler, buildAdminAlertEmailHtml } from './adminEmail';

function req(data: unknown): CallableRequest {
  return { data } as unknown as CallableRequest;
}

describe('adminEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds rich HTML email template with proper urgency and contact links', () => {
    const html = buildAdminAlertEmailHtml({
      title: 'New Hospital Registration',
      name: 'Central Hospital Yaoundé',
      bloodType: 'AB+',
      city: 'Yaoundé',
      phone: '+237674922015',
      email: 'hospital@central.cm',
      urgency: 'critical',
      details: 'Facility license uploaded and awaiting verification.',
      actionUrl: 'https://vitalpulse237.com/admin.html#verifications'
    });

    expect(html).toContain('Central Hospital Yaoundé');
    expect(html).toContain('CRITICAL');
    expect(html).toContain('Yaoundé');
    expect(html).toContain('tel:+237674922015');
    expect(html).toContain('https://vitalpulse237.com/admin.html#verifications');
    expect(html).toContain('Republic of Cameroon');
  });

  it('rejects invalid payload without title', async () => {
    await expect(
      sendAdminNotificationEmailHandler(req({ title: '' }))
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('dispatches email via Resend when API key is provided and returns messageId', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'email_msg_12345' }),
      text: async () => ''
    } as any);

    const result = await sendAdminNotificationEmailHandler(req({
      title: 'Test Admin Notification',
      name: 'System Monitor',
      city: 'Douala',
      urgency: 'urgent',
      customApiKey: 're_123456789'
    }));

    expect(result).toMatchObject({
      success: true,
      channel: 'resend',
      recipient: 'info@vitalpulse237.com',
      messageId: 'email_msg_12345'
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer re_123456789'
        })
      })
    );

    fetchSpy.mockRestore();
  });
});
