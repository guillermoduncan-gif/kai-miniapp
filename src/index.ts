import "dotenv/config";
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { AppServer, TpaSession } from '@mentra/sdk';
import { callKaiAPI, translateText, detectLanguage, lookupContact, userIdToSpeakerKey, KaiResponse } from './kai-client';

const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.kai.glasses';
const MENTRA_API_KEY = process.env.MENTRA_API_KEY || '';
const PORT = parseInt(process.env.PORT || '3000');
const WEBVIEW_PORT = PORT + 1;
const DEFAULT_TARGET_LANG = process.env.TARGET_LANG || 'English';
const USER_LANG_CODE = process.env.USER_LANG_CODE || 'en';
const KAI_API_URL = process.env.KAI_API_URL || 'https://kai-cloud-production.up.railway.app';
const KAI_API_KEY_VAL = process.env.KAI_API_KEY || 'kai-secret-guille-2026';
const WEBVIEW_HTML = fs.readFileSync(path.join(__dirname, '..', 'webview.html'), 'utf-8');

// SSE clients
const sseClients = new Set<http.ServerResponse>();
function broadcast(event: string, data: object) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(payload); } catch {} });
}

const translationModeMap = new Map<string, boolean>();

type Intent =
  | { type: 'toggle_translation'; on: boolean }
  | { type: 'translate'; text: string }
  | { type: 'call'; name: string; app: 'phone' | 'whatsapp' | 'facetime' }
  | { type: 'test_call'; name: string }
  | { type: 'normal' };

function getIntent(text: string): Intent {
  let t = text.toLowerCase().trim();
  t = t.replace(/^(hey\s+kai|ok\s+kai|kai)[,!\s]+/, '').trim();
  t = t.replace(/[,!.]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (/^(translation|translate)\s+on$/.test(t) || t.includes('translation mode on') || t.includes('start translating'))
    return { type: 'toggle_translation', on: true };
  if (/^(translation|translate)\s+off$/.test(t) || t.includes('translation mode off') || t.includes('stop translating'))
    return { type: 'toggle_translation', on: false };

  const testCallMatch = t.match(/^(?:simulate|test|fake)\s+(?:call|incoming)\s+(?:from\s+)?(.+)$/);
  if (testCallMatch) return { type: 'test_call', name: testCallMatch[1].trim() };

  const waMatch = t.match(/^(?:whatsapp|whats app)\s+(.+?)$/) ||
    t.match(/^(?:message|text)\s+(.+?)\s+on\s+whatsapp$/);
  if (waMatch) return { type: 'call', name: waMatch[1].trim(), app: 'whatsapp' };

  const ftMatch = t.match(/^facetime\s+(.+?)$/);
  if (ftMatch) return { type: 'call', name: ftMatch[1].trim(), app: 'facetime' };

  const appCallMatch = t.match(/^(?:call|llama(?:\s+a)?)\s+(.+?)\s+on\s+(whatsapp|facetime|phone)$/) ||
    t.match(/^(?:call|llama(?:\s+a)?)\s+(.+?)\s+(?:por|via|through)\s+(whatsapp|facetime|phone)$/);
  if (appCallMatch) return { type: 'call', name: appCallMatch[1].trim(), app: appCallMatch[2] as any };

  const phoneMatch = t.match(/^call\s+(.+?)(?:\s+on\s+(?:phone|regular))?$/) ||
    t.match(/^llama(?:r)?(?:\s+a)?\s+(.+?)$/) ||
    t.match(/^(?:can you |please )?call\s+(.+?)$/);
  if (phoneMatch) return { type: 'call', name: phoneMatch[1].trim(), app: 'phone' };

  if (/^translate\s+\S+/i.test(t))
    return { type: 'translate', text: t.replace(/^translate\s+/i, '') };

  return { type: 'normal' };
}

// ── Standalone HTTP server for webview + SSE + API proxy ──────────────────────
function startWebviewServer() {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // SSE endpoint
    if (url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: session_start\ndata: ${JSON.stringify({ clear: true })}\n\n`);
      res.write(`event: status\ndata: ${JSON.stringify({ state: 'ready', translation_mode: false })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // Webview page
    if (url === '/' || url === '/webview') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(WEBVIEW_HTML);
      return;
    }

    // Contacts proxy — GET list
    if (url === '/api/contacts' && req.method === 'GET') {
      try {
        const r = await fetch(`${KAI_API_URL}/contacts/guille`, { headers: { 'x-api-key': KAI_API_KEY_VAL } });
        const data = await r.json();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch { res.writeHead(500); res.end('{}'); }
      return;
    }

    // Contacts proxy — DELETE all
    if (url === '/api/contacts' && req.method === 'DELETE') {
      try {
        const r = await fetch(`${KAI_API_URL}/contacts/guille`, { method: 'DELETE', headers: { 'x-api-key': KAI_API_KEY_VAL } });
        const data = await r.json();
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch { res.writeHead(500); res.end('{}'); }
      return;
    }

    // Contacts proxy — DELETE single
    const delMatch = url.match(/^\/api\/contacts\/(.+)$/);
    if (delMatch && req.method === 'DELETE') {
      try {
        await fetch(`${KAI_API_URL}/contacts/guille/${delMatch[1]}`, { method: 'DELETE', headers: { 'x-api-key': KAI_API_KEY_VAL } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'deleted' }));
      } catch { res.writeHead(500); res.end('{}'); }
      return;
    }

    // Contacts proxy — POST sync (vCard)
    if (url === '/api/contacts/sync' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks);
          const r = await fetch(`${KAI_API_URL}/contacts/guille/sync`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'content-type': req.headers['content-type'] || '', 'content-length': body.length.toString() },
            body,
          });
          const data = await r.json();
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        } catch { res.writeHead(500); res.end('{"error":"Sync failed"}'); }
      });
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.listen(WEBVIEW_PORT, () => {
    console.log(`🌐 Webview server on port ${WEBVIEW_PORT}`);
  });
}

// ── KAI App ───────────────────────────────────────────────────────────────────
class KaiApp extends AppServer {
  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: MENTRA_API_KEY,
      port: PORT,
    } as any);
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`\n🟢 KAI session started — user: ${userId}`);
    const speakerKey = userIdToSpeakerKey(userId);
    translationModeMap.set(sessionId, false);
    broadcast('session_start', { clear: true });
    broadcast('status', { state: 'ready', translation_mode: false });

    // Clear Redis session history
    try {
      await fetch(`${KAI_API_URL}/session/clear`, {
        method: 'POST',
        headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      console.log('🧹 Redis session cleared');
    } catch (e) { console.warn('Redis clear failed:', e); }

    await session.layouts.showTextWall('KAI is ready 👋');
    setTimeout(() => session.layouts.showTextWall(''), 2000);

    // Incoming call notifications
    try {
      session.events.onPhoneNotifications((notification: any) => {
        console.log('🔔 RAW notification:', JSON.stringify(notification));
        const title = String(notification?.title || notification?.appName || '');
        const body = String(notification?.body || notification?.message || notification?.content || '');
        const combined = (title + ' ' + body).toLowerCase();
        const isCall = combined.includes('incoming') || combined.includes('calling') ||
          combined.includes('call from') || combined.includes('llamada') ||
          notification?.type === 'call';
        if (isCall) {
          const caller = body || title || 'Unknown';
          session.layouts.showTextWall(`📞 ${caller}`);
          broadcast('incoming_call', { caller, title, body });
          broadcast('reply', { text: `📞 Incoming: ${caller}` });
          setTimeout(() => session.layouts.showTextWall(''), 15000);
          console.log(`📞 Incoming call: ${caller}`);
        }
      });
      console.log('✅ onPhoneNotifications registered');
    } catch (e) { console.log('⚠️ onPhoneNotifications error:', e); }

    // Transcription handler
    const transcriptionHandler = async (data: any) => {
      const userText = (data.text || '').trim();
      if (!userText || userText.length < 2) return;
      if (!data.isFinal) { session.layouts.showTextWall(`🎙️ "${userText}"`); return; }

      console.log(`\n👤 "${userText}"`);

      // Filter ambient noise
      const words = userText.trim().split(/\s+/);
      const knownCommands = ['call', 'llama', 'llamar', 'translate', 'traducir',
        'help', 'ayuda', 'facetime', 'whatsapp', 'translation', 'simulate'];
      const isKnownCommand = knownCommands.some(cmd => userText.toLowerCase().startsWith(cmd));
      if (words.length === 1 && userText.length < 8 && !isKnownCommand) {
        console.log(`   → Ignored ambient: "${userText}"`);
        return;
      }

      const intent = getIntent(userText);
      console.log(`   → ${intent.type}`);

      if (intent.type === 'test_call') {
        const msg = `📞 Incoming: ${intent.name}`;
        await session.layouts.showTextWall(msg);
        broadcast('incoming_call', { caller: intent.name, title: intent.name, body: '' });
        broadcast('reply', { text: msg });
        setTimeout(() => session.layouts.showTextWall(''), 10000);
        return;
      }

      if (intent.type === 'toggle_translation') {
        translationModeMap.set(sessionId, intent.on);
        const msg = intent.on ? '🌍 Translation mode ON' : '🔇 Translation mode OFF';
        await session.layouts.showTextWall(msg);
        broadcast('user', { text: userText });
        broadcast('reply', { text: msg });
        broadcast('status', { state: 'ready', translation_mode: intent.on });
        return;
      }

      if (intent.type === 'call') {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'calling' });
        await session.layouts.showTextWall(`📞 Looking up ${intent.name}...`);
        const contact = await lookupContact(speakerKey, intent.name);
        if (!contact) {
          const msg = `I don't have ${intent.name} in your contacts.`;
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
          return;
        }
        const app = intent.app !== 'phone' ? intent.app : (contact.default_app as any || 'phone');
        const appNames: Record<string, string> = { phone: 'Phone', whatsapp: 'WhatsApp', facetime: 'FaceTime' };
        const msg = `📞 Calling ${contact.name}...`;
        await session.layouts.showTextWall(msg);
        broadcast('direct_call', { contact, app });
        broadcast('reply', { text: msg });
        broadcast('status', { state: 'ready' });
        return;
      }

      if (intent.type === 'translate') {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'translating' });
        await session.layouts.showTextWall('🌍 Translating...');
        try {
          const result = await translateText(intent.text, DEFAULT_TARGET_LANG, speakerKey);
          if (result.is_same_language) {
            const msg = `Already ${DEFAULT_TARGET_LANG}: "${result.translation}"`;
            await session.layouts.showTextWall(msg);
            broadcast('reply', { text: msg });
          } else {
            await session.layouts.showTextWall(`[${result.detected_language}] ${result.translation}`);
            broadcast('translation', result);
          }
          broadcast('status', { state: 'ready' });
          setTimeout(() => session.layouts.showTextWall(''), 10000);
        } catch {
          await session.layouts.showTextWall('Translation failed.');
          broadcast('reply', { text: 'Translation failed.' });
          broadcast('status', { state: 'ready' });
        }
        return;
      }

      if (translationModeMap.get(sessionId)) {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'translating' });
        try {
          const detected = await detectLanguage(userText);
          if (detected.language_code !== USER_LANG_CODE && detected.confidence !== 'low') {
            const result = await translateText(userText, DEFAULT_TARGET_LANG, speakerKey);
            await session.layouts.showTextWall(`[${result.detected_language}] ${result.translation}`);
            broadcast('translation', result);
            broadcast('status', { state: 'ready' });
            setTimeout(() => session.layouts.showTextWall(''), 10000);
            return;
          }
        } catch {}
      }

      broadcast('user', { text: userText });
      broadcast('status', { state: 'thinking' });
      await session.layouts.showTextWall('KAI is thinking...');
      try {
        const response: KaiResponse = await callKaiAPI(userText, sessionId, userId);
        const replyText = response.text || response.response || 'Sorry, I had trouble with that.';
        console.log(`🤖 "${replyText}"`);
        await session.layouts.showTextWall(replyText);
        broadcast('reply', { text: replyText });
        broadcast('status', { state: 'ready' });
        setTimeout(() => session.layouts.showTextWall(''), 8000);
      } catch {
        await session.layouts.showTextWall('Connection error.');
        broadcast('reply', { text: 'Connection error. Try again.' });
        broadcast('status', { state: 'ready' });
      }
    };

    session.events.onTranscription(transcriptionHandler);
  }
}

// Start both servers
startWebviewServer();

const app = new KaiApp();
app.start()
  .then(() => {
    console.log(`\n🚀 KAI running on port ${PORT}`);
    console.log(`🌐 Webview on port ${WEBVIEW_PORT}`);
    console.log(`📦 Package: ${PACKAGE_NAME}`);
    console.log(`🌍 Translation target: ${DEFAULT_TARGET_LANG}`);
    console.log(`🔗 Waiting for connections...\n`);
  })
  .catch(err => { console.error('Failed:', err); process.exit(1); });
