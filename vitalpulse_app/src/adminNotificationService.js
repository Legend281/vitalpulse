// =========================================================================
// VITALPULSE ADMIN NOTIFICATION SERVICE (WHATSAPP, EMAIL & IN-APP ALERTS)
// =========================================================================
// Automatically alerts VitalPulse administrators via WhatsApp, Email, and
// Real-time Dashboard notifications when critical events occur:
// 1. New Hospital Registration (requiring verification)
// 2. Public Emergency Blood Request submitted
// 3. New Blood Donor Registration
// =========================================================================

import { collection, addDoc, doc, getDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from './firebase';

export const DEFAULT_ADMIN_ALERT_CONFIG = {
  adminEmail: 'info@vitalpulse237.com',
  adminPhone: '+237674922015',
  notifyHospitalReg: true,
  notifyPublicRequest: true,
  notifyDonorReg: true,
  whatsAppWebhook: '',
  emailWebhook: ''
};

/**
 * Fetch latest admin notification configuration from Firestore system settings.
 */
export async function getAdminNotificationSettings() {
  try {
    const snap = await getDoc(doc(db, 'system_settings', 'config'));
    if (snap.exists()) {
      const d = snap.data();
      return {
        adminEmail: d.adminNotificationEmail || DEFAULT_ADMIN_ALERT_CONFIG.adminEmail,
        adminPhone: d.adminNotificationPhone || DEFAULT_ADMIN_ALERT_CONFIG.adminPhone,
        notifyHospitalReg: d.adminNotifyHospitalReg !== false,
        notifyPublicRequest: d.adminNotifyPublicRequest !== false,
        notifyDonorReg: d.adminNotifyDonorReg !== false,
        whatsAppWebhook: d.adminWhatsAppWebhook || '',
        emailWebhook: d.adminEmailWebhook || ''
      };
    }
  } catch (e) {
    console.warn('[AdminNotificationService] Failed to load settings, using defaults:', e);
  }
  return DEFAULT_ADMIN_ALERT_CONFIG;
}

/**
 * Build rich, structured WhatsApp message text with dashboard action deep-links.
 */
export function formatWhatsAppMessage({ eventTitle, name, bloodType, city, phone, email, urgency, details, actionUrl }) {
  const timestamp = new Date().toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  return (
    `🚨 *[VITALPULSE ADMIN ALERT]* 🚨\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📋 *Event:* ${eventTitle}\n` +
    (name ? `👤 *Name / Facility:* ${name}\n` : '') +
    (bloodType ? `🩸 *Blood Group:* ${bloodType}\n` : '') +
    (urgency ? `⚠️ *Urgency:* ${urgency.toUpperCase()}\n` : '') +
    (city ? `📍 *Location:* ${city}\n` : '') +
    (phone ? `📞 *Phone:* ${phone}\n` : '') +
    (email ? `✉️ *Email:* ${email}\n` : '') +
    (details ? `ℹ️ *Details:* ${details}\n` : '') +
    `⏰ *Timestamp:* ${timestamp}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    (actionUrl ? `🔗 *Open Dashboard to Review / Resolve:*\n${actionUrl}\n` : '') +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_VitalPulse National Emergency Network_`
  );
}

/**
 * Core alert dispatcher: writes to Firestore admin_notifications, sends WhatsApp webhook / creates URL, and dispatches Email alert.
 */
export async function dispatchAdminAlert({
  type, // 'HOSPITAL_REGISTRATION' | 'PUBLIC_REQUEST' | 'DONOR_REGISTRATION' | 'TEST_ALERT'
  title,
  name,
  bloodType,
  city,
  phone,
  email,
  urgency = 'routine',
  details,
  dashboardView = 'overview'
}) {
  const config = await getAdminNotificationSettings();

  // Honor administrator event toggle preferences
  if (type === 'HOSPITAL_REGISTRATION' && !config.notifyHospitalReg) return null;
  if (type === 'PUBLIC_REQUEST' && !config.notifyPublicRequest) return null;
  if (type === 'DONOR_REGISTRATION' && !config.notifyDonorReg) return null;

  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://vitalpulse237.com';
  const actionUrl = `${origin}/admin.html#${dashboardView}`;

  const formattedText = formatWhatsAppMessage({
    eventTitle: title,
    name,
    bloodType,
    city,
    phone,
    email,
    urgency,
    details,
    actionUrl
  });

  const cleanPhone = (config.adminPhone || '').replace(/[^0-9+]/g, '');
  const whatsappUrl = `https://api.whatsapp.com/send?phone=${encodeURIComponent(cleanPhone)}&text=${encodeURIComponent(formattedText)}`;

  // 1. Real-time In-App Admin Notification in Firestore
  let firestoreNotifId = null;
  try {
    const notifRef = await addDoc(collection(db, 'admin_notifications'), {
      title,
      message: `${name || 'User'} — ${details || city || 'Action required'}`,
      type: urgency === 'critical' ? 'warning' : 'info',
      eventType: type,
      view: dashboardView,
      metadata: {
        name: name || null,
        bloodType: bloodType || null,
        city: city || null,
        phone: phone || null,
        email: email || null,
        urgency,
        details: details || null,
        whatsappUrl,
        actionUrl
      },
      read: false,
      createdAt: new Date().toISOString()
    });
    firestoreNotifId = notifRef.id;
  } catch (err) {
    console.warn('[AdminNotificationService] Failed to record in-app notification:', err);
  }

  // 2. Automated WhatsApp Bot / Webhook Dispatch (Green API, CallMeBot, Twilio, or Zapier)
  if (config.whatsAppWebhook) {
    try {
      const webhookUrl = config.whatsAppWebhook.trim();
      if (webhookUrl.includes('callmebot.com')) {
        // CallMeBot uses GET request with phone, text, apikey
        const urlObj = new URL(webhookUrl);
        if (!urlObj.searchParams.has('phone')) urlObj.searchParams.set('phone', cleanPhone);
        urlObj.searchParams.set('text', formattedText);
        await fetch(urlObj.toString(), { method: 'GET', mode: 'no-cors' });
      } else if (webhookUrl.includes('green-api.com') || webhookUrl.includes('greenapi.com')) {
        // Green API format: requires chatId (e.g. 237674922015@c.us) and message
        const targetChatId = cleanPhone.replace(/[^0-9]/g, '') + '@c.us';
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: targetChatId,
            message: formattedText
          })
        });
      } else {
        // Standard JSON POST Webhook
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: cleanPhone,
            message: formattedText,
            text: formattedText,
            event: type,
            timestamp: new Date().toISOString()
          })
        });
      }
      console.log('[AdminNotificationService] WhatsApp automated delivery dispatched.');
    } catch (err) {
      console.warn('[AdminNotificationService] WhatsApp automated dispatch failed:', err);
    }
  }

  // 3. Automated Server-Side Email Dispatch via Cloud Functions (Resend API) + Webhook Fallback
  let emailDeliveryResult = null;
  try {
    const sendEmailFn = httpsCallable(getFunctions(), 'sendAdminNotificationEmail');
    const emailRes = await sendEmailFn({
      title,
      name: name || null,
      bloodType: bloodType || null,
      city: city || null,
      phone: phone || null,
      email: email || null,
      urgency,
      details: details || null,
      actionUrl,
      eventType: type,
      toEmail: config.adminEmail,
      customApiKey: config.emailWebhook && config.emailWebhook.startsWith('re_') ? config.emailWebhook : null
    });
    emailDeliveryResult = emailRes.data;
    if (emailDeliveryResult?.success) {
      console.log('[AdminNotificationService] Email automated delivery dispatched successfully via Cloud Function:', emailDeliveryResult);
    }
  } catch (err) {
    console.warn('[AdminNotificationService] Server-side email callable error:', err?.message || err);
    emailDeliveryResult = { success: false, error: err?.message || String(err) };
  }

  // Fallback webhook if server callable wasn't used or returned false, and a public webhook URL is configured
  if (!emailDeliveryResult?.success && config.emailWebhook && config.emailWebhook.startsWith('http')) {
    try {
      const hookRes = await fetch(config.emailWebhook.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: config.adminEmail,
          subject: `[VitalPulse Alert] ${title} - ${name || city || 'Immediate Action Required'}`,
          message: formattedText,
          eventType: type,
          details,
          actionUrl,
          timestamp: new Date().toISOString()
        })
      });
      if (hookRes.ok) {
        emailDeliveryResult = { success: true, channel: 'webhook' };
        console.log('[AdminNotificationService] Email fallback webhook dispatched successfully.');
      }
    } catch (e) {
      console.warn('[AdminNotificationService] Email fallback webhook failed:', e);
    }
  }

  return {
    notifId: firestoreNotifId,
    formattedText,
    whatsappUrl,
    adminEmail: config.adminEmail,
    adminPhone: config.adminPhone,
    emailResult: emailDeliveryResult
  };
}

/**
 * Helper to trigger a test alert to verify WhatsApp and Email configuration.
 */
export async function sendTestAdminAlert() {
  return await dispatchAdminAlert({
    type: 'TEST_ALERT',
    title: '🔔 VitalPulse Admin Notification System Test',
    name: 'VitalPulse Live Monitoring',
    bloodType: 'O+ (Emergency Ready)',
    city: 'Yaoundé & Douala',
    phone: '+237 674 92 20 15',
    email: 'info@vitalpulse237.com',
    urgency: 'critical',
    details: 'This is a test notification confirming that WhatsApp & Email alert channels are active and operational.',
    dashboardView: 'overview'
  });
}
