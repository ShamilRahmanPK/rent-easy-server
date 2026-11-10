import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

export interface TemplateDefinition {
  subject: string;
  body: string;
  placeholders: string[];
  // Essential mail (security and account messages) is sent even when the person turned update emails off.
  essential: boolean;
}

const paragraph = (html: string) => `<p style="margin:0 0 16px;line-height:1.6">${html}</p>`;
const button = (label: string, url: string) =>
  `<p style="margin:24px 0"><a href="${url}" style="background:#1d4ed8;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${label}</a></p>`;

export const TEMPLATES: Record<string, TemplateDefinition> = {
  verify_email: {
    essential: true,
    placeholders: ["name", "link"],
    subject: "Verify your email address",
    body:
      paragraph("Hello {{name}},") +
      paragraph("Welcome to RentEasy. Please confirm your email address to finish setting up your account. This link works for 24 hours.") +
      button("Verify email", "{{link}}"),
  },
  reset_password: {
    essential: true,
    placeholders: ["name", "link"],
    subject: "Reset your password",
    body:
      paragraph("Hello {{name}},") +
      paragraph("We received a request to reset your password. This link works for 1 hour and can be used once.") +
      button("Choose a new password", "{{link}}") +
      paragraph("If you did not ask for this, you can ignore this email. Your password stays the same."),
  },
  password_changed: {
    essential: true,
    placeholders: ["name"],
    subject: "Your password was changed",
    body:
      paragraph("Hello {{name}},") +
      paragraph("The password for your RentEasy account was just changed. You have been signed out on other devices.") +
      paragraph("If this was not you, reset your password immediately and contact support."),
  },
  property_received: {
    essential: false,
    placeholders: ["name", "propertyName", "link"],
    subject: "We received your property: {{propertyName}}",
    body:
      paragraph("Hello {{name}},") +
      paragraph("Thank you for submitting <strong>{{propertyName}}</strong>. An administrator will review it and you will be notified of the decision.") +
      button("View your property", "{{link}}"),
  },
  property_review_needed: {
    essential: false,
    placeholders: ["name", "propertyName", "ownerName", "link"],
    subject: "New property to review: {{propertyName}}",
    body:
      paragraph("Hello {{name}},") +
      paragraph("{{ownerName}} submitted <strong>{{propertyName}}</strong> for approval.") +
      button("Review property", "{{link}}"),
  },
  property_approved: {
    essential: false,
    placeholders: ["name", "propertyName", "link"],
    subject: "Your property was approved: {{propertyName}}",
    body:
      paragraph("Hello {{name}},") +
      paragraph("Good news. <strong>{{propertyName}}</strong> was approved and is now listed. Your account now has the owner role, so you can manage your properties and units.") +
      button("Manage property", "{{link}}"),
  },
  property_rejected: {
    essential: false,
    placeholders: ["name", "propertyName", "reason", "link"],
    subject: "Your property needs changes: {{propertyName}}",
    body:
      paragraph("Hello {{name}},") +
      paragraph("<strong>{{propertyName}}</strong> was not approved yet.") +
      paragraph("<strong>Reason:</strong> {{reason}}") +
      paragraph("You can edit the property and submit it again.") +
      button("Edit property", "{{link}}"),
  },
  role_changed: {
    essential: true,
    placeholders: ["name", "change", "roles"],
    subject: "Your account role changed",
    body:
      paragraph("Hello {{name}},") +
      paragraph("{{change}}") +
      paragraph("Your current roles: <strong>{{roles}}</strong>."),
  },
  account_status_changed: {
    essential: true,
    placeholders: ["name", "status", "note"],
    subject: "Your account is now {{status}}",
    body:
      paragraph("Hello {{name}},") +
      paragraph("Your RentEasy account status is now <strong>{{status}}</strong>.") +
      paragraph("{{note}}"),
  },
  unit_assigned: {
    essential: false,
    placeholders: ["name", "unitName", "propertyName", "startDate", "link"],
    subject: "You are now the tenant of {{unitName}}",
    body:
      paragraph("Hello {{name}},") +
      paragraph("You have been linked as the tenant of unit <strong>{{unitName}}</strong> at <strong>{{propertyName}}</strong>, starting {{startDate}}.") +
      button("View your unit", "{{link}}"),
  },
  tenant_linked_owner: {
    essential: false,
    placeholders: ["name", "tenantName", "unitName", "propertyName", "startDate", "link"],
    subject: "{{tenantName}} is now the tenant of {{unitName}}",
    body:
      paragraph("Hello {{name}},") +
      paragraph("{{tenantName}} was linked as the tenant of unit <strong>{{unitName}}</strong> at <strong>{{propertyName}}</strong>, starting {{startDate}}.") +
      button("View property", "{{link}}"),
  },
  tenancy_ended: {
    essential: false,
    placeholders: ["name", "unitName", "propertyName"],
    subject: "Your tenancy of {{unitName}} has ended",
    body:
      paragraph("Hello {{name}},") +
      paragraph("Your tenancy of unit <strong>{{unitName}}</strong> at <strong>{{propertyName}}</strong> has ended."),
  },
  rent_request_received: {
    essential: false,
    placeholders: ["name", "requesterName", "unitName", "propertyName", "link"],
    subject: "New rent request for {{unitName}}",
    body:
      paragraph("Hello {{name}},") +
      paragraph("{{requesterName}} asked to rent unit <strong>{{unitName}}</strong> at <strong>{{propertyName}}</strong>.") +
      button("Review request", "{{link}}"),
  },
  rent_request_rejected: {
    essential: false,
    placeholders: ["name", "unitName", "note"],
    subject: "Update on your request for {{unitName}}",
    body:
      paragraph("Hello {{name}},") +
      paragraph("Your request to rent unit <strong>{{unitName}}</strong> was not approved.") +
      paragraph("{{note}}"),
  },
  announcement: {
    essential: false,
    placeholders: ["name", "title", "message"],
    subject: "{{title}}",
    body: paragraph("Hello {{name}},") + paragraph("{{message}}"),
  },
  new_login_alert: {
    essential: true,
    placeholders: ["name", "device", "time"],
    subject: "New sign-in to your account",
    body:
      paragraph("Hello {{name}},") +
      paragraph("We noticed a sign-in from a device we have not seen before.") +
      paragraph("<strong>Device:</strong> {{device}}<br><strong>Time:</strong> {{time}}") +
      paragraph("If this was you, no action is needed. If not, change your password now."),
  },
  staff_invite: {
    essential: true,
    placeholders: ["name", "role", "link"],
    subject: "You have been added as {{role}}",
    body:
      paragraph("Hello {{name}},") +
      paragraph("A RentEasy staff account with the role <strong>{{role}}</strong> was created for you. Set your password to sign in. This link works for 72 hours.") +
      button("Set your password", "{{link}}"),
  },
  test_email: {
    essential: true,
    placeholders: [],
    subject: "RentEasy test email",
    body: paragraph("This is a test message. Your email settings work."),
  },
  mail_failure_alert: {
    essential: true,
    placeholders: ["toEmail", "template", "error"],
    subject: "Email delivery failed",
    body:
      paragraph("An email could not be delivered after several attempts.") +
      paragraph("<strong>To:</strong> {{toEmail}}<br><strong>Template:</strong> {{template}}<br><strong>Error:</strong> {{error}}"),
  },
};

export const isEssentialTemplate = (key: string) => TEMPLATES[key]?.essential ?? false;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fill(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => escapeHtml(variables[name] ?? ""));
}

function wrap(innerHtml: string, brand: string, essential: boolean): string {
  const footer = essential
    ? "This is an account message from RentEasy."
    : `You receive this because email updates are on. You can change this in your profile settings: ${env.appUrl}/settings/notifications`;
  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#1d4ed8;color:#ffffff;padding:20px 28px;font-size:20px;font-weight:bold">${escapeHtml(brand)}</td></tr>
<tr><td style="padding:28px;font-size:15px">${innerHtml}</td></tr>
<tr><td style="padding:16px 28px;background:#f9fafb;color:#6b7280;font-size:12px">${escapeHtml(footer)}</td></tr>
</table></td></tr></table></body></html>`;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|tr|h\d)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

// A super admin can override the wording of any template; otherwise the built-in text is used.
export async function renderTemplate(
  key: string,
  variables: Record<string, string>,
  brand: string
): Promise<RenderedMail> {
  const definition = TEMPLATES[key];
  if (!definition) throw new Error(`Unknown email template "${key}"`);

  const override = await prisma.emailTemplate.findUnique({ where: { key } });
  const subjectSource = override?.subject ?? definition.subject;
  const bodySource = override?.bodyHtml ?? definition.body;

  const subject = fill(subjectSource, variables).replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (entity) =>
    ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[entity] ?? entity
  );
  const html = wrap(fill(bodySource, variables), brand, definition.essential);
  return { subject, html, text: htmlToText(html) };
}
