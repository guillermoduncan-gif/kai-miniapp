import "dotenv/config";
import * as fs from 'fs';
import * as path from 'path';
import { AppServer, TpaSession } from '@mentra/sdk';
import { callKaiAPI, translateText, detectLanguage, lookupContact, userIdToSpeakerKey, KaiResponse } from './kai-client';

const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.kai.glasses';
const MENTRA_API_KEY = process.env.MENTRA_API_KEY || '';
const PORT = parseInt(process.env.PORT || '3000');
const DEFAULT_TARGET_LANG = process.env.TARGET_LANG || 'English';
const USER_LANG_CODE = process.env.USER_LANG_CODE || 'en';
const KAI_API_URL = process.env.KAI_API_URL || 'https://kai-cloud-production.up.railway.app';
const KAI_API_KEY_VAL = process.env.KAI_API_KEY || 'kai-secret-guille-2026';

const WEBVIEW_HTML = fs.readFileSync(path.join(__dirname, '..', 'webview.html'), 'utf-8');

const sseClients = new Set<any>();
function broadcast(event: string, data: object) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(payload); } catch {} });
}

const translationModeMap = new Map<string, boolean>();

type Intent =
  | { type: 'toggle_translation'; on: boolean }
  | { type: 'translate'; text: string }
  | { type: 'call'; name: string; app: 'phone' | 'whatsapp' | 'facetime' }
  | { type: 'normal' };

function getIntent(text: string): Intent {
  // Strip common prefixes and punctuation
  let t = text.toLowerCase().trim();
  t = t.replace(/^(hey\s+kai|ok\s+kai|kai)[,!\s]+/, '').trim();
  t = t.replace(/[,!.]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Translation toggles
  if (/^(translation|translate)\s+on$/.test(t) || t.includes('translation mode on') || t.includes('start translating'))
    return { type: 'toggle_translation', on: true };
  if (/^(translation|translate)\s+off$/.test(t) || t.includes('translation mode off') || t.includes('stop translating'))
    return { type: 'toggle_translation', on: false };

  // WhatsApp
  const waMatch = t.match(/^(?:whatsapp|whats app)\s+(.+?)$/) ||
    t.match(/^(?:message|text)\s+(.+?)\s+on\s+whatsapp$/);
  if (waMatch) return { type: 'call', name: waMatch[1].trim(), app: 'whatsapp' };

  // FaceTime
  const ftMatch = t.match(/^facetime\s+(.+?)$/);
  if (ftMatch) return { type: 'call', name: ftMatch[1].trim(), app: 'facetime' };

  // Call on specific app: "call [name] on whatsapp/facetime"
  const appCallMatch = t.match(/^(?:call|llama(?:\s+a)?)\s+(.+?)\s+on\s+(whatsapp|facetime|phone)$/) ||
    t.match(/^(?:call|llama(?:\s+a)?)\s+(.+?)\s+(?:por|via|through)\s+(whatsapp|facetime|phone)$/);
  if (appCallMatch) return { type: 'call', name: appCallMatch[1].trim(), app: appCallMatch[2] as any };

  // Phone call — English: "call [name]" or Spanish: "llama a [name]" / "llamar a [name]"
  const phoneMatch = t.match(/^call\s+(.+?)(?:\s+on\s+(?:phone|regular))?$/) ||
    t.match(/^llama(?:r)?(?:\s+a)?\s+(.+?)$/) ||
    t.match(/^(?:can you |please )?call\s+(.+?)$/) ||
    t.match(/^hacer una llamada a\s+(.+?)$/);
  if (phoneMatch) return { type: 'call', name: phoneMatch[1].trim(), app: 'phone' };

  // Translate
  if (/^translate\s+\S+/i.test(t))
    return { type: 'translate', text: t.replace(/^translate\s+/i, '') };

  return { type: 'normal' };
}

class KaiApp extends AppServer {
  constructor() {
    super({ packageName: PACKAGE_NAME, apiKey: MENTRA_API_KEY, port: PORT });
    const expressApp = (this as any).app;

    // SSE
    expressApp.get('/events', (req: any, res: any) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.flushHeaders();
      res.write(`event: session_start\ndata: ${JSON.stringify({ clear: true })}\n\n`);
      res.write(`event: status\ndata: ${JSON.stringify({ state: 'ready', translation_mode: false })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
    });

    // Contacts proxy — GET list
    expressApp.get('/api/contacts', async (_req: any, res: any) => {
      try {
        const r = await fetch(`${KAI_API_URL}/contacts/guille`, { headers: { 'x-api-key': KAI_API_KEY_VAL } });
        res.json(await r.json());
      } catch { res.json({ contacts: [] }); }
    });

    // Contacts proxy — DELETE single
    expressApp.delete('/api/contacts/:id', async (req: any, res: any) => {
      try {
        await fetch(`${KAI_API_URL}/contacts/guille/${req.params.id}`, {
          method: 'DELETE', headers: { 'x-api-key': KAI_API_KEY_VAL }
        });
        res.json({ status: 'deleted' });
      } catch { res.status(500).json({ error: 'Failed' }); }
    });

    // Contacts proxy — DELETE ALL (bulk)
    expressApp.delete('/api/contacts', async (_req: any, res: any) => {
      try {
        const r = await fetch(`${KAI_API_URL}/contacts/guille`, {
          method: 'DELETE', headers: { 'x-api-key': KAI_API_KEY_VAL }
        });
        res.status(r.status).json(await r.json());
      } catch { res.status(500).json({ error: 'Failed to clear contacts' }); }
    });

    // Contacts proxy — vCard SYNC (multipart passthrough)
    expressApp.post('/api/contacts/sync', async (req: any, res: any) => {
      try {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          const body = Buffer.concat(chunks);
          const r = await fetch(`${KAI_API_URL}/contacts/guille/sync`, {
            method: 'POST',
            headers: {
              'x-api-key': KAI_API_KEY_VAL,
              'content-type': req.headers['content-type'],
              'content-length': body.length.toString(),
            },
            body,
          });
          res.status(r.status).json(await r.json());
        });
      } catch { res.status(500).json({ error: 'Sync failed' }); }
    });

    expressApp.get('/webview', (_req: any, res: any) => res.send(WEBVIEW_HTML));
    expressApp.get('/', (_req: any, res: any) => res.send(WEBVIEW_HTML));
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`\n🟢 KAI session started — user: ${userId}`);
    const speakerKey = userIdToSpeakerKey(userId);
    translationModeMap.set(sessionId, false);
    broadcast('session_start', { clear: true });
    broadcast('status', { state: 'ready', translation_mode: false });

    // Clear Redis conversation history so old messages don't replay
    try {
      await fetch(`${KAI_API_URL}/session/clear`, {
        method: 'POST',
        headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: userId }),
      });
      console.log('🧹 Redis session cleared');
    } catch (e) {
      console.warn('Could not clear Redis session:', e);
    }

    await session.layouts.showTextWall('KAI is ready 👋');
    setTimeout(() => session.layouts.showTextWall(''), 2000);

    // Listen for phone notifications (incoming calls, messages)
    try {
      (session.events as any).onNotification?.((notification: any) => {
        const title = String(notification?.title || '');
        const body = String(notification?.body || notification?.message || '');
        const combined = (title + ' ' + body).toLowerCase();
        console.log(`🔔 Notification: "${title}" — "${body}"`);

        // Detect incoming calls
        if (combined.includes('incoming') || combined.includes('calling') ||
            combined.includes('call from') || combined.includes('llamada')) {
          const caller = title || body;
          const msg = `📞 Incoming: ${caller}`;
          session.layouts.showTextWall(msg);
          broadcast('incoming_call', { caller, title, body });
          broadcast('reply', { text: msg });
          setTimeout(() => session.layouts.showTextWall(''), 15000);
          console.log(`📞 Incoming call: ${caller}`);
        }
      });
    } catch (e) {
      console.log('Notifications not available in this SDK version');
    }

    session.events.onTranscription(async (data) => {
      const userText = data.text?.trim();
      if (!userText || userText.length < 2) return;
      if (!data.isFinal) { session.layouts.showTextWall(`🎙️ "${userText}"`); return; }

      console.log(`\n👤 "${userText}"`);
      const intent = getIntent(userText);
      console.log(`   → ${intent.type}`);

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
          const msg = `I don't have ${intent.name} in your contacts. Add them in the Contacts tab.`;
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
          return;
        }
        const app = intent.app !== 'phone' ? intent.app : (contact.default_app as any || 'phone');
        const appNames: Record<string, string> = { phone: 'Phone', whatsapp: 'WhatsApp', facetime: 'FaceTime' };
        const msg = `📞 Calling ${contact.name}...`;
        await session.layouts.showTextWall(msg);
        // Skip overlay — go straight to native dialer (one confirmation only)
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
    });
  }
}

const app = new KaiApp();
app.start()
  .then(() => {
    console.log(`\n🚀 KAI running on port ${PORT}`);
    console.log(`📦 Package: ${PACKAGE_NAME}`);
    console.log(`🌍 Translation target: ${DEFAULT_TARGET_LANG}`);
    console.log(`🔗 Waiting for connections...\n`);
  })
  .catch(err => { console.error('Failed:', err); process.exit(1); });
