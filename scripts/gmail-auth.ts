#!/usr/bin/env tsx
/**
 * Gmail OAuth setup CLI.
 *
 * Usage:
 *   tsx scripts/gmail-auth.ts <email>
 *
 * Prereq env (in .env):
 *   GMAIL_CLIENT_ID
 *   GMAIL_CLIENT_SECRET
 *
 * Output:
 *   Opens the Google consent screen, listens on http://localhost:53682,
 *   exchanges the code for a refresh token, validates by fetching the user's
 *   profile, and prints the line to paste into .env.
 *
 * Standalone — does not touch the project DB.
 */

import 'dotenv/config';
import http from 'node:http';
import { URL } from 'node:url';
import { exec } from 'node:child_process';
import { google } from 'googleapis';

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
];

// (email → env var label) — printed for the user's reference.
const ACCOUNT_LABELS: Record<string, string> = {
  'greatsumini@gmail.com': 'GREATSUMINI',
  'cursormatfia@gmail.com': 'CURSORMATFIA',
  'lead@awesome.dev': 'LEAD_AWESOMEDEV',
  'sumin@vooster.ai': 'SUMIN_VOOSTER',
};

function die(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`error: ${msg}`);
  process.exit(1);
}

function envLabelFor(email: string): string {
  return (
    ACCOUNT_LABELS[email] ??
    email
      .replace(/@/g, '_')
      .replace(/\./g, '')
      .toUpperCase()
  );
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) die('usage: tsx scripts/gmail-auth.ts <email>');

  const clientId = process.env.GMAIL_CLIENT_ID ?? '';
  const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? '';
  if (!clientId) die('GMAIL_CLIENT_ID is missing in .env');
  if (!clientSecret) die('GMAIL_CLIENT_SECRET is missing in .env');

  const oauth = new google.auth.OAuth2({
    clientId,
    clientSecret,
    redirectUri: REDIRECT_URI,
  });

  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    login_hint: email,
  });

  // eslint-disable-next-line no-console
  console.log('\nOpen this URL in your browser to authorize:');
  // eslint-disable-next-line no-console
  console.log(`\n  ${url}\n`);

  if (process.platform === 'darwin') {
    exec(`open "${url}"`, (err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.warn('(could not auto-open browser; copy the URL above)');
      }
    });
  } else {
    // eslint-disable-next-line no-console
    console.log('(non-darwin platform — copy the URL above into your browser)');
  }

  // Promise that resolves once we get the callback (or rejects on error).
  const codePromise = new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        if (!req.url) {
          res.statusCode = 400;
          res.end('bad request');
          return;
        }
        const parsed = new URL(req.url, `http://localhost:${PORT}`);
        if (parsed.pathname !== '/oauth2callback') {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const err = parsed.searchParams.get('error');
        if (err) {
          res.statusCode = 400;
          res.end(`oauth error: ${err}`);
          server.close();
          reject(new Error(`oauth error from google: ${err}`));
          return;
        }
        const code = parsed.searchParams.get('code');
        if (!code) {
          res.statusCode = 400;
          res.end('no code');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
          '<html><body style="font-family:sans-serif;padding:2em;">' +
            '<h2>OK — authorized</h2>' +
            '<p>You can close this tab and return to your terminal.</p>' +
            '</body></html>',
        );
        server.close();
        resolve(code);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    server.on('error', (e) => reject(e));
    server.listen(PORT, '127.0.0.1', () => {
      // eslint-disable-next-line no-console
      console.log(`(listening on http://localhost:${PORT}/oauth2callback for callback...)\n`);
    });
  });

  const code = await codePromise;

  const tokenResp = await oauth.getToken(code);
  const tokens = tokenResp.tokens;
  if (!tokens.refresh_token) {
    die(
      'no refresh_token returned. Revoke at https://myaccount.google.com/permissions and retry — Google only emits a refresh token on first consent.',
    );
  }
  oauth.setCredentials(tokens);

  // Validate by fetching the profile.
  const gmail = google.gmail({ version: 'v1', auth: oauth });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const actualEmail = profile.data.emailAddress ?? '';

  if (actualEmail.toLowerCase() !== email.toLowerCase()) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n[warn] you authorized as "${actualEmail}" but the CLI arg was "${email}".`,
    );
    // eslint-disable-next-line no-console
    console.warn('       Use the var matching the actual account below.\n');
  }

  const label = envLabelFor(actualEmail || email);
  // eslint-disable-next-line no-console
  console.log(`\n✓ OAuth complete for ${actualEmail || email}\n`);
  // eslint-disable-next-line no-console
  console.log('Add this to your .env:');
  // eslint-disable-next-line no-console
  console.log(`  GMAIL_REFRESH_TOKEN_${label}=${tokens.refresh_token}\n`);
  // eslint-disable-next-line no-console
  console.log('The mapping for the 4 configured accounts:');
  // eslint-disable-next-line no-console
  console.log('  greatsumini@gmail.com    → GMAIL_REFRESH_TOKEN_GREATSUMINI');
  // eslint-disable-next-line no-console
  console.log('  cursormatfia@gmail.com   → GMAIL_REFRESH_TOKEN_CURSORMATFIA');
  // eslint-disable-next-line no-console
  console.log('  lead@awesome.dev         → GMAIL_REFRESH_TOKEN_LEAD_AWESOMEDEV');
  // eslint-disable-next-line no-console
  console.log('  sumin@vooster.ai         → GMAIL_REFRESH_TOKEN_SUMIN_VOOSTER\n');

  // Clean exit.
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nfatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
