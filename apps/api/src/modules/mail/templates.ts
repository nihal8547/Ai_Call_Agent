/**
 * The platform's own emails. Plain HTML with inline styles (what email clients render reliably)
 * and a text version; every value from users is escaped.
 */

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

type Rendered = { subject: string; text: string; html: string };

function layout(
  heading: string,
  paragraphs: string[],
  button: { label: string; url: string },
  footer: string,
) {
  const p = (t: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#262626">${t}</p>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e8e8e8;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<tr><td style="padding:32px 32px 8px">
<p style="margin:0 0 24px;font-size:13px;font-weight:600;letter-spacing:.02em;color:#0a0a0a">Voice Agent Platform</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#0a0a0a">${heading}</h1>
${paragraphs.map(p).join("\n")}
<p style="margin:24px 0"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:8px">${escapeHtml(button.label)}</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b6b6b">Or copy this link into your browser:<br><span style="word-break:break-all;color:#262626">${escapeHtml(button.url)}</span></p>
</td></tr>
<tr><td style="padding:16px 32px 28px;border-top:1px solid #efefef;font-size:12px;line-height:1.5;color:#8a8a8a">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

export function invitationEmail(o: {
  businessName: string;
  inviterName: string;
  roleName: string;
  url: string;
  expiresDays: number;
}): Rendered {
  const business = escapeHtml(o.businessName);
  const inviter = escapeHtml(o.inviterName);
  const role = escapeHtml(o.roleName);
  return {
    subject: `${o.inviterName} invited you to ${o.businessName}`,
    text: [
      `${o.inviterName} invited you to join ${o.businessName} on Voice Agent Platform as ${o.roleName}.`,
      "",
      `Accept the invitation: ${o.url}`,
      "",
      `The link works for ${o.expiresDays} days and only once. If you weren't expecting this, you can ignore this email.`,
    ].join("\n"),
    html: layout(
      `Join ${business}`,
      [
        `<strong>${inviter}</strong> invited you to join <strong>${business}</strong> on Voice Agent Platform as <strong>${role}</strong>.`,
        "You'll see the business's calls, leads and AI agents, depending on your role.",
      ],
      { label: "Accept invitation", url: o.url },
      `The link works for ${o.expiresDays} days and only once. If you weren't expecting this, you can ignore this email.`,
    ),
  };
}

export function passwordResetEmail(o: { name: string; url: string; minutes: number }): Rendered {
  return {
    subject: "Reset your Voice Agent Platform password",
    text: [
      `Hi ${o.name},`,
      "",
      `Someone asked to reset the password for your account. Choose a new one here: ${o.url}`,
      "",
      `The link works for ${o.minutes} minutes and only once. Resetting signs you out everywhere.`,
      "If you didn't ask for this, ignore this email: your password stays the same.",
    ].join("\n"),
    html: layout(
      "Reset your password",
      [
        `Hi ${escapeHtml(o.name)},`,
        "Someone asked to reset the password for your account. Choose a new one with the button below.",
      ],
      { label: "Choose a new password", url: o.url },
      `The link works for ${o.minutes} minutes and only once, and resetting signs you out on every device. If you didn't ask for this, ignore this email: your password stays the same.`,
    ),
  };
}
