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
const continuousModeMap = new Map<string, ReturnType<typeof setInterval>>();

type Intent =
  | { type: 'toggle_translation'; on: boolean }
  | { type: 'translate'; text: string }
  | { type: 'call'; name: string; app: 'phone' | 'whatsapp' | 'facetime' }
  | { type: 'test_call'; name: string }
  | { type: 'reminder'; text: string }
  | { type: 'list_reminders' }
  | { type: 'vision'; mode: string; query?: string }
  | { type: 'normal' };

function getIntent(text: string): Intent {
  const userOriginal = text; // keep original for reminder parsing
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
    t.match(/^(?:call|llama(?:\s+a)?)\s+(.+?)\s+(?:por|via)\s+(whatsapp|facetime|phone)$/);
  if (appCallMatch) return { type: 'call', name: appCallMatch[1].trim(), app: appCallMatch[2] as any };

  const phoneMatch = t.match(/^call\s+(.+?)(?:\s+on\s+(?:phone|regular))?$/) ||
    t.match(/^llama(?:r)?(?:\s+a)?\s+(.+?)$/) ||
    t.match(/^(?:can you |please )?call\s+(.+?)$/);
  if (phoneMatch) return { type: 'call', name: phoneMatch[1].trim(), app: 'phone' };

  // Reminder commands
  if (t.includes('remind me') || t.includes('recuérdame') || t.includes('recordarme') ||
      t.startsWith('set a reminder') || t.startsWith('set reminder'))
    return { type: 'reminder', text: userOriginal };

  // List reminders
  if (t.includes('my reminders') || t.includes('what are my reminders') ||
      t.includes('mis recordatorios') || t.includes('show reminders'))
    return { type: 'list_reminders' } as any;

  // Vision on/off
  if (t.includes('vision on') || t.includes('start vision') || t.includes('continuous vision'))
    return { type: 'vision', mode: 'continuous_on' };
  if (t.includes('vision off') || t.includes('stop vision'))
    return { type: 'vision', mode: 'continuous_off' };

  // Vision commands
  if (t.startsWith('what is this') || t.startsWith('what is that') ||
      t.startsWith("what's that") || t.startsWith('describe this') ||
      t.startsWith('describe what') || t.startsWith('what do you see'))
    return { type: 'vision', mode: 'describe' };
  if (t.startsWith('read this') || t.startsWith('read what') ||
      t.startsWith('what does this say') || t.startsWith('what does it say') ||
      t.startsWith('lee esto'))
    return { type: 'vision', mode: 'read' };
  if (t.startsWith('translate what') || t.startsWith('translate this') ||
      t.startsWith('translate what i see'))
    return { type: 'vision', mode: 'translate' };
  if (t.startsWith('identify') || t.startsWith('what is this') ||
      t.startsWith('que es esto') || t.startsWith('what are these'))
    return { type: 'vision', mode: 'identify' };
  if (t.startsWith('what gesture') || t.startsWith('gesture') ||
      t.startsWith('read my hand') || t.startsWith('que gesto'))
    return { type: 'vision', mode: 'gesture' };
  if (t.startsWith('look at this') || t.startsWith('scan this') ||
      t.startsWith('look around'))
    return { type: 'vision', mode: 'describe' };

  if (/^translate\s+\S+/i.test(t))
    return { type: 'translate', text: t.replace(/^translate\s+/i, '') };

  return { type: 'normal' };
}

class KaiApp extends AppServer {
  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: MENTRA_API_KEY,
      port: PORT,
    } as any);

    // Register routes on the built-in Express server
    const app = (this as any).app;

    // SSE
    app.get('/events', (req: any, res: any) => {
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

    // Webview
    app.get('/webview', (_req: any, res: any) => res.send(WEBVIEW_HTML));
    app.get('/', (_req: any, res: any) => res.send(WEBVIEW_HTML));

    // Contacts proxy — GET
    app.get('/api/contacts', async (_req: any, res: any) => {
      try {
        const r = await fetch(`${KAI_API_URL}/contacts/guille`, { headers: { 'x-api-key': KAI_API_KEY_VAL } });
        res.json(await r.json());
      } catch { res.status(500).json({ contacts: [] }); }
    });

    // Contacts proxy — DELETE all
    app.delete('/api/contacts', async (_req: any, res: any) => {
      try {
        const r = await fetch(`${KAI_API_URL}/contacts/guille`, { method: 'DELETE', headers: { 'x-api-key': KAI_API_KEY_VAL } });
        res.status(r.status).json(await r.json());
      } catch { res.status(500).json({ error: 'Failed' }); }
    });

    // Contacts proxy — DELETE single
    app.delete('/api/contacts/:id', async (req: any, res: any) => {
      try {
        await fetch(`${KAI_API_URL}/contacts/guille/${req.params.id}`, { method: 'DELETE', headers: { 'x-api-key': KAI_API_KEY_VAL } });
        res.json({ status: 'deleted' });
      } catch { res.status(500).json({ error: 'Failed' }); }
    });

    // Vision proxy — phone/webview camera
    app.post('/api/vision', async (req: any, res: any) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const r = await fetch(`${KAI_API_URL}/vision/analyze`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          res.json(data);
        } catch (e) { res.status(500).json({ error: 'Vision failed' }); }
      });
    });

    // Contacts proxy — vCard sync
    app.post('/api/contacts/sync', async (req: any, res: any) => {
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
          res.status(r.status).json(await r.json());
        } catch { res.status(500).json({ error: 'Sync failed' }); }
      });
    });
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`\n🟢 KAI session started — user: ${userId}`);
    const speakerKey = userIdToSpeakerKey(userId);
    translationModeMap.set(sessionId, false);
    broadcast('session_start', { clear: true });
    broadcast('status', { state: 'ready', translation_mode: false });

    // Clear Redis
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

    // ── Continuous vision mode ───────────────────────────────────────────
    // Analyzes scene every 30 seconds, only alerts on notable things
    const startContinuousVision = () => {
      const interval = setInterval(async () => {
        try {
          const photo = await (session as any).camera.requestPhoto({ size: 'small' });
          if (!photo?.data) return;
          const base64 = Buffer.isBuffer(photo.data)
            ? photo.data.toString('base64')
            : Buffer.from(photo.data).toString('base64');
          const res = await fetch(`${KAI_API_URL}/vision/analyze`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_base64: base64, mode: 'continuous', speaker_key: speakerKey }),
          });
          const data = await res.json() as any;
          if (data.is_notable && data.result !== 'NOTHING_NOTABLE') {
            await session.layouts.showTextWall(data.result);
            broadcast('vision_alert', { result: data.result });
            broadcast('reply', { text: data.result });
            setTimeout(() => session.layouts.showTextWall(''), 8000);
            console.log(`👁️ Vision alert: ${data.result}`);
          }
        } catch (e) {
          // Silent fail for continuous mode
        }
      }, 30000); // Every 30 seconds
      continuousModeMap.set(sessionId, interval);
      console.log('✅ Continuous vision started');
    };

    // Clean up on session end
    session.events.onDisconnected?.(() => {
      const interval = continuousModeMap.get(sessionId);
      if (interval) { clearInterval(interval); continuousModeMap.delete(sessionId); }
      translationModeMap.delete(sessionId);
      console.log('🔴 Session ended, cleaned up');
    });

    const transcriptionHandler = async (data: any) => {
      const userText = (data.text || '').trim();
      if (!userText || userText.length < 2) return;
      if (!data.isFinal) { session.layouts.showTextWall(`🎙️ "${userText}"`); return; }

      console.log(`\n👤 "${userText}"`);

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
        const msg = `📞 Incoming: ${(intent as any).name}`;
        await session.layouts.showTextWall(msg);
        broadcast('incoming_call', { caller: (intent as any).name, title: (intent as any).name, body: '' });
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

      // ── Reminder ────────────────────────────────────────────────────────
      if (intent.type === 'reminder') {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'thinking' });
        await session.layouts.showTextWall('⏰ Setting reminder...');
        try {
          const parseRes = await fetch(`${KAI_API_URL}/reminders/parse`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              speaker_key: speakerKey,
              text: (intent as any).text,
              timezone: 'America/Costa_Rica',
            }),
          });
          const parsed = await parseRes.json() as any;
          if (!parseRes.ok || !parsed.valid) {
            const msg = "I couldn't understand that reminder. Try: 'remind me to call mom at 3pm'";
            await session.layouts.showTextWall(msg);
            broadcast('reply', { text: msg });
            broadcast('status', { state: 'ready' });
            return;
          }
          // Save the reminder
          await fetch(`${KAI_API_URL}/reminders/`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              speaker_key: speakerKey,
              message: parsed.message,
              remind_at: parsed.remind_at,
              timezone: 'America/Costa_Rica',
            }),
          });
          const msg = `⏰ Got it! I'll remind you to ${parsed.message} ${parsed.human_time}`;
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
          setTimeout(() => session.layouts.showTextWall(''), 8000);
        } catch (e) {
          const msg = 'Failed to set reminder. Try again.';
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
        }
        return;
      }

      // ── List reminders ───────────────────────────────────────────────────
      if ((intent as any).type === 'list_reminders') {
        broadcast('user', { text: userText });
        try {
          const res = await fetch(`${KAI_API_URL}/reminders/${speakerKey}`, {
            headers: { 'x-api-key': KAI_API_KEY_VAL },
          });
          const data = await res.json() as any;
          const reminders = data.reminders || [];
          let msg = '';
          if (reminders.length === 0) {
            msg = 'You have no upcoming reminders.';
          } else {
            const items = reminders.slice(0, 3).map((r: any) => `• ${r.message}`).join('\n');
            msg = `You have ${reminders.length} reminder${reminders.length > 1 ? 's' : ''}:\n${items}`;
          }
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
          setTimeout(() => session.layouts.showTextWall(''), 10000);
        } catch {
          broadcast('reply', { text: 'Could not fetch reminders.' });
          broadcast('status', { state: 'ready' });
        }
        return;
      }

      // ── Vision ──────────────────────────────────────────────────────────
      if (intent.type === 'vision') {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'thinking' });
        const modeLabels: Record<string, string> = {
          describe: '👁️ Looking...',
          read: '📖 Reading...',
          translate: '🌍 Translating view...',
          identify: '🔍 Identifying...',
          gesture: '👋 Reading gesture...',
        };
        await session.layouts.showTextWall(modeLabels[intent.mode] || '👁️ Analyzing...');

        // Handle continuous mode toggle
        if (intent.mode === 'continuous_on') {
          if (!continuousModeMap.has(sessionId)) startContinuousVision();
          const msg = "👁️ Continuous vision ON — I'll alert you to important things";
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
          return;
        }
        if (intent.mode === 'continuous_off') {
          const interval = continuousModeMap.get(sessionId);
          if (interval) { clearInterval(interval); continuousModeMap.delete(sessionId); }
          const msg = '👁️ Continuous vision OFF';
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
          return;
        }

        try {
          // Capture photo from glasses
          const photo = await (session as any).camera.requestPhoto({ size: 'medium' });
          if (!photo || !photo.data) {
            const msg = 'Could not capture photo. Make sure camera permission is enabled.';
            await session.layouts.showTextWall(msg);
            broadcast('reply', { text: msg });
            broadcast('status', { state: 'ready' });
            return;
          }

          // Convert to base64
          const base64 = Buffer.isBuffer(photo.data)
            ? photo.data.toString('base64')
            : Buffer.from(photo.data).toString('base64');

          // Send to vision API
          const visionRes = await fetch(`${KAI_API_URL}/vision/analyze`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              image_base64: base64,
              mode: intent.mode,
              speaker_key: speakerKey,
            }),
          });

          const visionData = await visionRes.json() as any;
          const result = visionData.result || 'Could not analyze image.';

          await session.layouts.showTextWall(result);
          broadcast('vision', { mode: intent.mode, result, photo_size: photo.size });
          broadcast('reply', { text: result });
          broadcast('status', { state: 'ready' });
          setTimeout(() => session.layouts.showTextWall(''), 12000);

        } catch (e: any) {
          console.error('Vision error:', e);
          const msg = e?.message?.includes('camera') 
            ? 'Camera not available. Are you using the glasses?' 
            : 'Vision analysis failed. Try again.';
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
        }
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

const app = new KaiApp();
app.start()
  .then(() => {
    console.log(`\n🚀 KAI running on port ${PORT}`);
    console.log(`📦 Package: ${PACKAGE_NAME}`);
    console.log(`🌍 Translation target: ${DEFAULT_TARGET_LANG}`);
    console.log(`🔗 Waiting for connections...\n`);
  })
  .catch(err => { console.error('Failed:', err); process.exit(1); });
