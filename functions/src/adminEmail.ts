import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { db } from './firebaseAdmin';
import { adminEmailAlertSchema, type AdminEmailAlertInput } from './schemas';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

export function buildAdminAlertEmailHtml(data: AdminEmailAlertInput): string {
  const urgencyLower = (data.urgency || '').toLowerCase();
  const urgencyColor = urgencyLower === 'critical' ? '#dc2626' : urgencyLower === 'urgent' ? '#ea580c' : '#0284c7';
  const urgencyText = (data.urgency || 'routine').toUpperCase();
  const timestamp = new Date().toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Douala'
  });

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1e293b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f8fafc;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
          <tr>
            <td style="height:4px;background:linear-gradient(to right, #059669, #dc2626, #f59e0b);"></td>
          </tr>
          <tr>
            <td style="padding:28px 32px 20px;background-color:#0f172a;color:#ffffff;">
              <table role="presentation" width="100%">
                <tr>
                  <td>
                    <span style="font-size:10px;font-weight:800;letter-spacing:0.15em;text-transform:uppercase;color:#94a3b8;display:block;margin-bottom:6px;">Republic of Cameroon • National Blood Network</span>
                    <h1 style="margin:0;font-size:20px;font-weight:900;color:#ffffff;line-height:1.3;">🚨 ${data.title}</h1>
                  </td>
                  <td align="right" valign="top" style="white-space:nowrap;">
                    <span style="background-color:${urgencyColor};color:#ffffff;font-size:11px;font-weight:800;padding:4px 10px;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;display:inline-block;">${urgencyText}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px;">
              <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                A priority event has been recorded on the VitalPulse National Blood Coordination Network requiring administrative awareness or triage.
              </p>

              <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:24px;background-color:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;">
                ${data.name ? `<tr><td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;border-bottom:1px solid #e2e8f0;width:35%;">Facility / Name</td><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#0f172a;border-bottom:1px solid #e2e8f0;">${data.name}</td></tr>` : ''}
                ${data.bloodType ? `<tr><td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;border-bottom:1px solid #e2e8f0;">Blood Group</td><td style="padding:10px 16px;font-size:13px;font-weight:800;color:#dc2626;border-bottom:1px solid #e2e8f0;">🩸 ${data.bloodType}</td></tr>` : ''}
                ${data.city ? `<tr><td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;border-bottom:1px solid #e2e8f0;">Jurisdiction / City</td><td style="padding:10px 16px;font-size:13px;font-weight:600;color:#0f172a;border-bottom:1px solid #e2e8f0;">📍 ${data.city}</td></tr>` : ''}
                ${data.phone ? `<tr><td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;border-bottom:1px solid #e2e8f0;">Contact Phone</td><td style="padding:10px 16px;font-size:13px;font-weight:600;color:#0f172a;border-bottom:1px solid #e2e8f0;">📞 <a href="tel:${data.phone}" style="color:#0284c7;text-decoration:none;">${data.phone}</a></td></tr>` : ''}
                ${data.email ? `<tr><td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;border-bottom:1px solid #e2e8f0;">Contact Email</td><td style="padding:10px 16px;font-size:13px;font-weight:600;color:#0f172a;border-bottom:1px solid #e2e8f0;">✉️ <a href="mailto:${data.email}" style="color:#0284c7;text-decoration:none;">${data.email}</a></td></tr>` : ''}
                ${data.details ? `<tr><td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;border-bottom:1px solid #e2e8f0;">Clinical Details</td><td style="padding:10px 16px;font-size:13px;font-weight:500;color:#334155;border-bottom:1px solid #e2e8f0;line-height:1.5;">${data.details}</td></tr>` : ''}
                <tr>
                  <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;">Timestamp</td>
                  <td style="padding:10px 16px;font-size:12px;font-weight:600;color:#64748b;">⏰ ${timestamp} (WAT)</td>
                </tr>
              </table>

              ${data.actionUrl ? `
              <table role="presentation" width="100%" style="margin-top:20px;">
                <tr>
                  <td align="center">
                    <a href="${data.actionUrl}" style="background-color:#0f172a;color:#ffffff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:800;font-size:13px;display:inline-block;box-shadow:0 2px 4px rgba(0,0,0,0.1);letter-spacing:0.02em;">
                      Open Admin Portal to Review & Triage &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              ` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background-color:#f1f5f9;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;text-align:center;line-height:1.5;">
              This is an automated alert from the VitalPulse Emergency National Blood Coordination Network.<br/>
              Support & WhatsApp Coordinator Desk: <a href="https://wa.me/237674922015" style="color:#059669;font-weight:700;text-decoration:none;">+237 674 92 20 15</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendViaResend(apiKey: string, toEmail: string, subject: string, html: string, plainText: string) {
  const trySend = async (fromAddress: string) => {
    return await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [toEmail],
        subject,
        html,
        text: plainText
      }),
    });
  };

  // Primary attempt with branded domain
  let res = await trySend('Vital Pulse Alerts <contact@vitalpulse237.com>');
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.warn(`[AdminEmail] Primary sender failed (${res.status}): ${errBody}. Retrying with test domain...`);
    // Fallback attempt with verified test domain
    res = await trySend('VitalPulse Alert <onboarding@resend.dev>');
    if (!res.ok) {
      const fallbackBody = await res.text().catch(() => '');
      throw new Error(`Resend API error ${res.status}: ${fallbackBody || errBody}`);
    }
  }

  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return data.id || 'resend-ok';
}

export async function sendAdminNotificationEmailHandler(request: CallableRequest) {
  const parsed = adminEmailAlertSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid admin email alert payload.', parsed.error.flatten());
  }

  const input = parsed.data;

  // Resolve target email and api key
  let toEmail = input.toEmail || null;
  let customApiKey = input.customApiKey || null;
  let webhookEndpoint: string | null = null;

  try {
    const configSnap = await db.collection('system_settings').doc('config').get();
    if (configSnap.exists) {
      const d = configSnap.data() || {};
      if (!toEmail && d.adminNotificationEmail) {
        toEmail = String(d.adminNotificationEmail).trim();
      }
      if (!customApiKey && d.adminEmailWebhook && String(d.adminEmailWebhook).trim().startsWith('re_')) {
        customApiKey = String(d.adminEmailWebhook).trim();
      } else if (d.adminEmailWebhook && String(d.adminEmailWebhook).trim().startsWith('http')) {
        webhookEndpoint = String(d.adminEmailWebhook).trim();
      }
    }
  } catch (err) {
    console.warn('[AdminEmail] Could not read system_settings/config:', err);
  }

  toEmail = toEmail || 'info@vitalpulse237.com';

  let apiKey: string | null = null;
  try {
    apiKey = customApiKey || RESEND_API_KEY.value() || process.env.RESEND_API_KEY || null;
  } catch {
    apiKey = customApiKey || process.env.RESEND_API_KEY || null;
  }

  const subject = `[VitalPulse Alert] ${input.title} - ${input.name || input.city || 'Action Required'}`;
  const html = buildAdminAlertEmailHtml(input);
  const plainText = `${input.title}\n\nName/Facility: ${input.name || 'N/A'}\nBlood Type: ${input.bloodType || 'N/A'}\nCity: ${input.city || 'N/A'}\nPhone: ${input.phone || 'N/A'}\nEmail: ${input.email || 'N/A'}\nUrgency: ${input.urgency || 'routine'}\nDetails: ${input.details || 'N/A'}\n\nOpen Admin Dashboard: ${input.actionUrl || 'https://vitalpulse237.com/admin.html'}`;

  // 1. Attempt delivery via Resend API
  if (apiKey) {
    try {
      const messageId = await sendViaResend(apiKey, toEmail, subject, html, plainText);
      return {
        success: true,
        channel: 'resend',
        recipient: toEmail,
        messageId
      };
    } catch (err: any) {
      console.error('[AdminEmail] Resend delivery failed:', err?.message || err);
      if (!webhookEndpoint) {
        return {
          success: false,
          channel: 'resend',
          recipient: toEmail,
          error: err?.message || 'Failed to dispatch via Resend'
        };
      }
    }
  }

  // 2. Attempt delivery via configured HTTP Webhook (Formspree, Zapier, etc.)
  if (webhookEndpoint) {
    try {
      const hookRes = await fetch(webhookEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: toEmail,
          subject,
          html,
          message: plainText,
          data: input,
          timestamp: new Date().toISOString()
        })
      });
      if (hookRes.ok) {
        return {
          success: true,
          channel: 'webhook',
          recipient: toEmail
        };
      }
      const hookErr = await hookRes.text().catch(() => '');
      return {
        success: false,
        channel: 'webhook',
        recipient: toEmail,
        error: `Webhook returned ${hookRes.status}: ${hookErr}`
      };
    } catch (err: any) {
      return {
        success: false,
        channel: 'webhook',
        recipient: toEmail,
        error: err?.message || 'Webhook request failed'
      };
    }
  }

  return {
    success: false,
    channel: 'none',
    recipient: toEmail,
    error: 'No email delivery provider configured. Set RESEND_API_KEY secret or enter a Resend Key / Webhook in Admin Settings.'
  };
}

export const sendAdminNotificationEmail = onCall(
  { secrets: [RESEND_API_KEY] },
  sendAdminNotificationEmailHandler
);
