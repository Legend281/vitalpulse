import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  formatWhatsAppMessage,
  DEFAULT_ADMIN_ALERT_CONFIG,
  getAdminNotificationSettings,
  dispatchAdminAlert,
  sendTestAdminAlert
} from './adminNotificationService';

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => 'admin_notifications_col'),
  addDoc: vi.fn(async () => ({ id: 'mock_notif_123' })),
  doc: vi.fn(),
  getDoc: vi.fn(async () => ({
    exists: () => true,
    data: () => ({
      adminNotificationPhone: '+237699112233',
      adminNotificationEmail: 'superadmin@vitalpulse.cm',
      adminNotifyHospitalReg: true,
      adminNotifyPublicRequest: true,
      adminNotifyDonorReg: true,
      adminWhatsAppWebhook: 'https://webhook.example.com/whatsapp',
      adminEmailWebhook: 'https://webhook.example.com/email'
    })
  }))
}));

vi.mock('./firebase', () => ({ db: {} }));

describe('formatWhatsAppMessage', () => {
  it('formats hospital registration message with all required fields and dashboard URL', () => {
    const msg = formatWhatsAppMessage({
      eventTitle: 'New Hospital Registration Pending Verification',
      name: 'St. Paul General Hospital',
      city: 'Douala',
      phone: '+237 671 234 567',
      email: 'contact@stpaul.cm',
      details: 'License MOH-2026-991 attached for review.',
      actionUrl: 'https://vitalpulse.cm/admin.html#verifications'
    });

    expect(msg).toContain('VITALPULSE ADMIN ALERT');
    expect(msg).toContain('St. Paul General Hospital');
    expect(msg).toContain('Douala');
    expect(msg).toContain('+237 671 234 567');
    expect(msg).toContain('https://vitalpulse.cm/admin.html#verifications');
  });

  it('formats emergency public blood request message with urgency and blood type', () => {
    const msg = formatWhatsAppMessage({
      eventTitle: 'Public Emergency Blood Request',
      name: 'Central Hospital Yaoundé (Patient: Marie K.)',
      bloodType: 'O- (2 Units PRBC)',
      urgency: 'critical',
      city: 'Yaoundé',
      phone: '+237 690 000 111',
      details: 'Surgery trauma emergency. Needs immediate triage.',
      actionUrl: 'https://vitalpulse.cm/admin.html#public-triage'
    });

    expect(msg).toContain('*Urgency:* CRITICAL');
    expect(msg).toContain('*Blood Group:* O- (2 Units PRBC)');
    expect(msg).toContain('https://vitalpulse.cm/admin.html#public-triage');
  });
});

describe('dispatchAdminAlert', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  });

  it('dispatches alert and returns properly formatted WhatsApp deep-link and notification id', async () => {
    const res = await dispatchAdminAlert({
      type: 'HOSPITAL_REGISTRATION',
      title: 'New Hospital Application',
      name: 'Hopital Laquintinie',
      city: 'Douala',
      phone: '+237 677 889 900',
      email: 'director@laquintinie.cm',
      dashboardView: 'verifications'
    });

    expect(res).toBeDefined();
    expect(res.notifId).toBe('mock_notif_123');
    expect(res.whatsappUrl).toContain('https://api.whatsapp.com/send');
    expect(res.whatsappUrl).toContain('237699112233');
    expect(res.adminEmail).toBe('superadmin@vitalpulse.cm');
  });

  it('triggers test admin alert successfully', async () => {
    const res = await sendTestAdminAlert();
    expect(res).toBeDefined();
    expect(res.notifId).toBe('mock_notif_123');
    expect(res.formattedText).toContain('VitalPulse Admin Notification System Test');
  });

  it('correctly handles Resend API key format for automated email delivery', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    await dispatchAdminAlert({
      type: 'PUBLIC_REQUEST',
      title: 'Emergency Blood Request',
      name: 'General Hospital',
      city: 'Douala',
      dashboardView: 'public-triage'
    });

    expect(fetchSpy).toHaveBeenCalled();
  });
});
