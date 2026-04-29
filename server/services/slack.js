const fetch = require('node-fetch');

function isSlackConfigured() {
  return !!process.env.SLACK_WEBHOOK_URL;
}

/**
 * Send a Slack message via the configured incoming webhook.
 * @param {string|object} message - plain string OR { text, blocks } object
 * @returns {Promise<{ok: boolean, status: number, error?: string}>}
 */
async function notify(message) {
  if (!isSlackConfigured()) {
    return { ok: false, status: 503, error: 'SLACK_WEBHOOK_URL not configured' };
  }
  const body = typeof message === 'string' ? { text: message } : message;
  try {
    const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 5000
    });
    const respText = await res.text();
    // Slack incoming webhooks reply with the literal string "ok" on success
    if (!res.ok || respText !== 'ok') {
      return { ok: false, status: res.status, error: respText };
    }
    return { ok: true, status: 200 };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

module.exports = { isSlackConfigured, notify };
