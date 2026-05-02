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
const listeningModeMap = new Map<string, boolean>();
const listeningBufferMap = new Map<string, string[]>();
const coachIntervalMap = new Map<string, ReturnType<typeof setInterval>>();

// ── Weather conversation context ──────────────────────────────────────────
// Remembers last weather query so follow-ups like "what about next week"
// or "and in Mexico?" inherit the previous location/time
interface WeatherContext { location?: string; time_ref?: string; }
const weatherContextMap = new Map<string, WeatherContext>();

// Ambiguous city names that need country clarification
const AMBIGUOUS_CITIES: Record<string, string[]> = {
  'san jose': ['Costa Rica', 'California (USA)', 'El Salvador'],
  'san josé': ['Costa Rica', 'California (USA)', 'El Salvador'],
  'santiago': ['Chile', 'Dominican Republic', 'Spain'],
  'córdoba': ['Argentina', 'Spain'],
  'cordoba': ['Argentina', 'Spain'],
  'granada': ['Spain', 'Nicaragua'],
  'cartagena': ['Colombia', 'Spain'],
  'santa cruz': ['Bolivia', 'Argentina', 'Spain'],
  'monterrey': ['Mexico', 'Colombia'],
  'lima': ['Peru', 'Ohio (USA)'],
  'victoria': ['Australia', 'Canada', 'Mexico'],
  'springfield': ['Illinois (USA)', 'Missouri (USA)', 'Ohio (USA)'],
};

// ── Time reference extractor ───────────────────────────────────────────────
function _extractTimeRef(t: string): string {
  if (t.includes('next week') || t.includes('la próxima semana')) return 'next week';
  if (t.includes('this week') || t.includes('esta semana')) return 'this week';
  if (t.includes('this weekend') || t.includes('este fin de semana')) return 'this weekend';
  if (t.includes('day after tomorrow') || t.includes('pasado mañana')) return 'day after tomorrow';
  if (t.includes('tomorrow') || t.includes('mañana')) return 'tomorrow';
  if (t.includes('tonight') || t.includes('esta noche')) return 'tonight';
  return 'today';
}

type Intent =
  | { type: 'toggle_translation'; on: boolean }
  | { type: 'translate'; text: string }
  | { type: 'call'; name: string; app: 'phone' | 'whatsapp' | 'facetime' }
  | { type: 'test_call'; name: string }
  | { type: 'reminder'; text: string }
  | { type: 'list_reminders' }
  | { type: 'vision'; mode: string; query?: string }
  | { type: 'weather'; location?: string; time_ref?: string }
  | { type: 'navigate'; destination: string }
  | { type: 'listen_start' }
  | { type: 'listen_stop' }
  | { type: 'listen_summarize' }
  | { type: 'sports'; query: string; league?: string }
  | { type: 'song_identify' }
  | { type: 'calendar'; query: string; query_type?: string }
  | { type: 'calendar_create'; query: string }
  | { type: 'normal' };

// ── KAI prefix detection ───────────────────────────────────────────────────
function parsePrefix(text: string): { addressed: boolean; cleaned: string } {
  const raw = text.toLowerCase().trim();
  const kaiPrefix = /^(hey\s+kai|ok\s+kai|oye\s+kai|kai|hey\s+guy|ok\s+guy|guy|ky|ki|gai|kay)[,!\s]+/;
  if (kaiPrefix.test(raw)) {
    return {
      addressed: true,
      cleaned: raw.replace(kaiPrefix, '').replace(/[,!.]+/g, ' ').replace(/\s+/g, ' ').trim()
    };
  }
  return { addressed: false, cleaned: raw.replace(/[,!.]+/g, ' ').replace(/\s+/g, ' ').trim() };
}

function getIntent(text: string): Intent {
  const userOriginal = text;
  const { addressed, cleaned: t } = parsePrefix(text);

  if (addressed) {

    // ── Weather — with time reference and location ───────────────────────
    if (t.includes('weather') || t.includes('clima') || t.includes('temperatura') ||
        t.includes('temperature') || t.includes('forecast') || t.includes('pronóstico') ||
        t.includes('pronostico') || t.includes('rain') || t.includes('lluvia') ||
        t.includes('hot today') || t.includes('cold today') || t.includes('going to rain')) {
      const locMatch =
        t.match(/(?:weather|clima|forecast|pronóstico)\s+(?:in|en|for|para)\s+([a-zA-ZÀ-ÿ\s,]+?)(?:\s+(?:today|tomorrow|tonight|this|next|mañana|hoy|esta|la\s+próxima).*)?$/) ||
        t.match(/(?:in|en|para|for)\s+([a-zA-ZÀ-ÿ\s,]+?)(?:\s+(?:today|tomorrow|tonight|this|next|mañana|hoy).*)?$/);
      const timeRef = _extractTimeRef(t);
      return { type: 'weather', location: locMatch?.[1]?.trim(), time_ref: timeRef };
    }

    // ── Weather follow-up — inherit context from previous query ──────────
    // "what about next week", "and tomorrow?", "and in Mexico?", "mañana?"
    const hasTimeOnly = /^(next\s+week|tomorrow|tonight|this\s+weekend|this\s+week|mañana|la\s+próxima\s+semana|pasado\s+mañana|day\s+after\s+tomorrow)$/.test(t);
    const hasLocFollowup = t.match(/^(?:what\s+about|and|how\s+about|y(?:\s+en)?(?:\s+el)?(?:\s+la)?)\s+(?:in\s+|en\s+)?([a-zA-ZÀ-ÿ\s]+)\??$/);
    if (hasTimeOnly) return { type: 'weather', location: undefined, time_ref: t };
    if (hasLocFollowup) return { type: 'weather', location: hasLocFollowup[1].trim(), time_ref: undefined };

    // ── Navigation — explicit commands ───────────────────────────────────
    const navExplicit =
      t.match(/^(?:navigate\s+to|take\s+me\s+to|directions?\s+to|how\s+do\s+i\s+get\s+to|llevar?me\s+a|navegar\s+a|cómo\s+llego\s+a|llevame\s+a|waze\s+to)\s+(.+)$/) ||
      t.match(/^(?:open\s+waze\s+(?:to|for)\s+)(.+)$/);
    if (navExplicit) return { type: 'navigate', destination: navExplicit[1].trim() };

    // ── Navigation — natural language (hunger, need, find nearby) ────────
    // "I'm hungry take me to McDonald's", "find me a gas station", "I need a coffee"
    const navNatural =
      t.match(/(?:i'?m?\s+hungry|i\s+need\s+food|quiero\s+comer|tengo\s+hambre).*?(?:take\s+me\s+to|find(?:\s+me)?(?:\s+a|\s+the\s+nearest)?|llevarme\s+a)\s+(.+)/) ||
      t.match(/(?:find(?:\s+me)?|take\s+me\s+to)\s+(?:a\s+|the\s+nearest\s+|the\s+closest\s+)?(.+?)(?:\s+near\s+me|\s+nearby|\s+around\s+here)?$/) ||
      t.match(/(?:i\s+need|i\s+want|necesito|quiero\s+ir\s+a|busca(?:r)?(?:\s+un)?)\s+(?:a\s+|the\s+nearest\s+)?(.+?)(?:\s+near|\s+nearby)?$/) ||
      t.match(/(?:i'?m?\s+hungry|i\s+need\s+gas|i\s+need\s+a\s+bathroom)\s*[-,]?\s*(.+)/);
    if (navNatural) return { type: 'navigate', destination: navNatural[1].trim() };

    // ── Sports ───────────────────────────────────────────────────────────
    const sportsLeagues = ['nba', 'nfl', 'mlb', 'nhl', 'champions league', 'ucl', 'la liga',
      'premier league', 'epl', 'serie a', 'bundesliga', 'mls', 'mma', 'ufc', 'ligue 1'];
    const sportsKeywords = ['score', 'scores', 'game', 'match', 'standings', 'schedule',
      'next game', 'result', 'who won', 'marcador', 'resultado', 'partido', 'clasificación'];
    const hasSportsLeague = sportsLeagues.some(l => t.includes(l));
    const hasSportsKeyword = sportsKeywords.some(k => t.includes(k));
    if (hasSportsLeague || (hasSportsKeyword && (t.includes('today') || t.includes('tonight') ||
        t.includes('yesterday') || t.includes('hoy') || hasSportsLeague))) {
      const league = sportsLeagues.find(l => t.includes(l));
      return { type: 'sports', query: t, league };
    }

    // ── Song recognition ─────────────────────────────────────────────────
    if (t.includes('what song') || t.includes('what music') || t.includes('identify this song') ||
        t.includes('shazam') || t.includes('what is this song') || t.includes("what's playing") ||
        t.includes('what song is this') || t.includes('qué canción') || t.includes('que cancion') ||
        t.includes('identify the song') || t.includes('recognize this song'))
      return { type: 'song_identify' };

    // ── Calendar ─────────────────────────────────────────────────────────
    if (t.includes('add') && (t.includes('calendar') || t.includes('meeting') ||
        t.includes('appointment') || t.includes('event') || t.includes('schedule')))
      return { type: 'calendar_create', query: t };
    if (t.includes('what do i have') || t.includes('my schedule') || t.includes('my calendar') ||
        t.includes('any meetings') || t.includes('appointments') || t.includes('what\'s on') ||
        t.includes('qué tengo') || t.includes('mi agenda') || t.includes('mis citas') ||
        (t.includes('calendar') && !t.includes('add')))
      return { type: 'calendar', query: t };

    // ── Listening mode ───────────────────────────────────────────────────
    if (t.includes('listen') || t.includes('start listening') || t.includes('escucha') ||
        t.includes('empieza a escuchar') || t.includes('listening mode') || t.includes('modo escucha'))
      return { type: 'listen_start' };
    if (t.includes('stop listening') || t.includes('stop listen') ||
        t.includes('deja de escuchar') || t.includes('para de escuchar'))
      return { type: 'listen_stop' };
    if (t.includes('what did they say') || t.includes('summarize') || t.includes('what was said') ||
        t.includes('summary') || t.includes('qué dijeron') || t.includes('resumir') ||
        t.includes('qué se dijo') || t.includes('what did he say') || t.includes('what did she say') ||
        t.includes('resumen'))
      return { type: 'listen_summarize' };

    // ── Translation toggle ───────────────────────────────────────────────
    if (/^(translation|translate)\s+on$/.test(t) || t.includes('translation mode on') || t.includes('start translating'))
      return { type: 'toggle_translation', on: true };
    if (/^(translation|translate)\s+off$/.test(t) || t.includes('translation mode off') || t.includes('stop translating'))
      return { type: 'toggle_translation', on: false };

    // ── Vision commands ──────────────────────────────────────────────────
    if (t.includes('vision on') || t.includes('start vision') || t.includes('continuous vision'))
      return { type: 'vision', mode: 'continuous_on' };
    if (t.includes('vision off') || t.includes('stop vision'))
      return { type: 'vision', mode: 'continuous_off' };
    if (t.startsWith('what is this') || t.startsWith('what is that') || t.startsWith("what's that") ||
        t.startsWith('describe this') || t.startsWith('describe what') || t.startsWith('what do you see'))
      return { type: 'vision', mode: 'describe' };
    if (t.startsWith('read this') || t.startsWith('read what') || t.startsWith('what does this say') ||
        t.startsWith('lee esto'))
      return { type: 'vision', mode: 'read' };
    if (t.startsWith('translate what') || t.startsWith('translate this') || t.startsWith('translate what i see'))
      return { type: 'vision', mode: 'translate' };
    if (t.startsWith('identify') || t.startsWith('que es esto') || t.startsWith('what are these'))
      return { type: 'vision', mode: 'identify' };
    if (t.startsWith('what gesture') || t.startsWith('gesture') || t.startsWith('read my hand'))
      return { type: 'vision', mode: 'gesture' };
    if (t.startsWith('look at this') || t.startsWith('scan this') || t.startsWith('look around'))
      return { type: 'vision', mode: 'describe' };
    if (t.includes('scan qr') || t.includes('read qr') || t.includes('qr code') || t.includes('scan code'))
      return { type: 'vision', mode: 'qr' };
    if (t.includes('where can i buy') || t.includes('where to buy') || t.includes('find this online') ||
        t.includes('buy this') || t.includes('donde comprar') || t.includes('shop online'))
      return { type: 'vision', mode: 'shop' };
    if (t.includes('body language') || t.includes('how do they feel') || t.includes('are they lying') ||
        t.includes('leer lenguaje corporal'))
      return { type: 'vision', mode: 'body_language' };
    if (t.includes('who do they look like') || t.includes('look alike') || t.includes('twins') || t.includes('parecido a'))
      return { type: 'vision', mode: 'similarity' };
    const followMatch = t.match(/follow (?:player\s*)?(?:number\s*)?(.+)/) ||
      t.match(/track (?:player\s*)?(?:number\s*)?(.+)/) ||
      t.match(/seguir (?:al\s+)?(?:jugador\s*)?(.+)/);
    if (followMatch) return { type: 'vision', mode: 'follow_player', query: followMatch[1].trim() };
    if (t.includes('stop following') || t.includes('stop tracking') || t.includes('dejar de seguir'))
      return { type: 'vision', mode: 'follow_stop' };
    if (t.includes('start recording') || t.includes('record this') || t.includes('grabar'))
      return { type: 'vision', mode: 'record_start' };
    if (t.includes('stop recording') || t.includes('stop record') || t.includes('parar grabacion'))
      return { type: 'vision', mode: 'record_stop' };

    if (/^translate\s+\S+/i.test(t))
      return { type: 'translate', text: t.replace(/^translate\s+/i, '') };
  }

  // ── Prefix-free commands ─────────────────────────────────────────────────
  const tRaw = text.toLowerCase().trim().replace(/[,!.]+/g, ' ').replace(/\s+/g, ' ').trim();

  const testCallMatch = tRaw.match(/^(?:simulate|test|fake)\s+(?:call|incoming)\s+(?:from\s+)?(.+)$/);
  if (testCallMatch) return { type: 'test_call', name: testCallMatch[1].trim() };

  const waMatch = tRaw.match(/^(?:whatsapp|whats app)\s+(.+?)$/) ||
    tRaw.match(/^(?:message|text)\s+(.+?)\s+on\s+whatsapp$/);
  if (waMatch) return { type: 'call', name: waMatch[1].trim(), app: 'whatsapp' };

  const ftMatch = tRaw.match(/^facetime\s+(.+?)$/);
  if (ftMatch) return { type: 'call', name: ftMatch[1].trim(), app: 'facetime' };

  const appCallMatch = tRaw.match(/^(?:call|llama(?:\s+a)?)\s+(.+?)\s+on\s+(whatsapp|facetime|phone)$/) ||
    tRaw.match(/^(?:call|llama(?:\s+a)?)\s+(.+?)\s+(?:por|via)\s+(whatsapp|facetime|phone)$/);
  if (appCallMatch) return { type: 'call', name: appCallMatch[1].trim(), app: appCallMatch[2] as any };

  const phoneMatch = tRaw.match(/^call\s+(.+?)(?:\s+on\s+(?:phone|regular))?$/) ||
    tRaw.match(/^llama(?:r)?(?:\s+a)?\s+(.+?)$/) ||
    tRaw.match(/^(?:can you |please )?call\s+(.+?)$/);
  if (phoneMatch) return { type: 'call', name: phoneMatch[1].trim(), app: 'phone' };

  if (tRaw.includes('remind me') || tRaw.includes('recuérdame') || tRaw.includes('recordarme') ||
      tRaw.startsWith('set a reminder') || tRaw.startsWith('set reminder'))
    return { type: 'reminder', text: userOriginal };

  if (tRaw.includes('my reminders') || tRaw.includes('what are my reminders') ||
      tRaw.includes('mis recordatorios') || tRaw.startsWith('show reminders'))
    return { type: 'list_reminders' } as any;

  return { type: 'normal' };
}

class KaiApp extends AppServer {
  constructor() {
    super({ packageName: PACKAGE_NAME, apiKey: MENTRA_API_KEY, port: PORT } as any);

    const app = (this as any).app;

    const express = require('express');
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    app.get('/events', (req: any, res: any) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.flushHeaders();
      res.write(`event: session_start\ndata: ${JSON.stringify({ clear: true })}\n\n`);
      res.write(`event: status\ndata: ${JSON.stringify({ state: 'ready', translation_mode: false, listening_mode: false })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
    });

    app.get('/webview', (_req: any, res: any) => res.send(WEBVIEW_HTML));
    app.get('/', (_req: any, res: any) => res.send(WEBVIEW_HTML));

    app.get('/api/contacts', async (_req: any, res: any) => {
      try {
        const r = await fetch(`${KAI_API_URL}/contacts/guille`, { headers: { 'x-api-key': KAI_API_KEY_VAL } });
        res.json(await r.json());
      } catch { res.status(500).json({ contacts: [] }); }
    });

    app.delete('/api/contacts', async (_req: any, res: any) => {
      try {
        const r = await fetch(`${KAI_API_URL}/contacts/guille`, { method: 'DELETE', headers: { 'x-api-key': KAI_API_KEY_VAL } });
        res.status(r.status).json(await r.json());
      } catch { res.status(500).json({ error: 'Failed' }); }
    });

    app.delete('/api/contacts/:id', async (req: any, res: any) => {
      try {
        await fetch(`${KAI_API_URL}/contacts/guille/${req.params.id}`, { method: 'DELETE', headers: { 'x-api-key': KAI_API_KEY_VAL } });
        res.json({ status: 'deleted' });
      } catch { res.status(500).json({ error: 'Failed' }); }
    });

    app.post('/api/vision', async (req: any, res: any) => {
      try {
        const r = await fetch(`${KAI_API_URL}/vision/analyze`, {
          method: 'POST',
          headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        });
        res.json(await r.json());
      } catch (e) { console.error('Vision proxy error:', e); res.status(500).json({ error: 'Vision failed' }); }
    });

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
    listeningModeMap.set(sessionId, false);
    listeningBufferMap.set(sessionId, []);
    weatherContextMap.set(sessionId, {});

    // ── Load memory context for this session ──────────────────────────────
    let memoryContext = '';
    try {
      const memRes = await fetch(`${KAI_API_URL}/memory/context`, {
        method: 'POST',
        headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaker_key: speakerKey, query: 'general context', limit: 30 }),
      });
      const memData = await memRes.json() as any;
      memoryContext = memData.context || '';
      if (memoryContext) {
        console.log(`🧠 Memory loaded: ${memData.memory_count} facts`);
        // Push context to session cache so turn.py can use it
        await fetch(`${KAI_API_URL}/memory/session/set`, {
          method: 'POST',
          headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, speaker_key: speakerKey, context: memoryContext }),
        });
      }
    } catch (e) { console.warn('Memory load failed:', e); }

    // ── Session conversation buffer for learning ──────────────────────────
    const sessionMessages: Array<{role: string; content: string}> = [];
    let turnCount = 0;
    broadcast('session_start', { clear: true });
    broadcast('status', { state: 'ready', translation_mode: false, listening_mode: false });

    try {
      await fetch(`${KAI_API_URL}/session/clear`, {
        method: 'POST',
        headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch (e) { console.warn('Redis clear failed:', e); }

    await session.layouts.showTextWall('KAI is ready 👋');
    setTimeout(() => session.layouts.showTextWall(''), 2000);

    try {
      session.events.onPhoneNotifications((notification: any) => {
        const title = String(notification?.title || notification?.appName || '');
        const body = String(notification?.body || notification?.message || notification?.content || '');
        const combined = (title + ' ' + body).toLowerCase();
        const isCall = combined.includes('incoming') || combined.includes('calling') ||
          combined.includes('call from') || combined.includes('llamada') || notification?.type === 'call';
        if (isCall) {
          const caller = body || title || 'Unknown';
          session.layouts.showTextWall(`📞 ${caller}`);
          broadcast('incoming_call', { caller, title, body });
          broadcast('reply', { text: `📞 Incoming: ${caller}` });
          setTimeout(() => session.layouts.showTextWall(''), 15000);
        }
      });
    } catch (e) { console.log('⚠️ onPhoneNotifications error:', e); }

    const startContinuousVision = () => {
      const interval = setInterval(async () => {
        try {
          const photo = await (session as any).camera.requestPhoto({ size: 'small' });
          if (!photo?.data) return;
          const base64 = Buffer.isBuffer(photo.data) ? photo.data.toString('base64') : Buffer.from(photo.data).toString('base64');
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
          }
        } catch {}
      }, 30000);
      continuousModeMap.set(sessionId, interval);
    };

    // ── Real-time coaching during listening mode ─────────────────────────
    const startCoaching = () => {
      const interval = setInterval(async () => {
        const buffer = listeningBufferMap.get(sessionId) || [];
        if (buffer.length < 3) return; // need at least 3 utterances
        try {
          const recent = buffer.slice(-5);
          const res = await fetch(`${KAI_API_URL}/listen/coach`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({ speaker_key: speakerKey, recent_utterances: recent }),
          });
          const data = await res.json() as any;
          if (data.tip) {
            await session.layouts.showTextWall(`💡 ${data.tip}`);
            broadcast('coach_tip', { tip: data.tip });
            setTimeout(() => session.layouts.showTextWall(''), 6000);
            console.log(`💡 Coach tip: ${data.tip}`);
          }
        } catch {}
      }, 30000); // check every 30s
      coachIntervalMap.set(sessionId, interval);
    };

    session.events.onDisconnected?.(() => {
      const visionInterval = continuousModeMap.get(sessionId);
      if (visionInterval) { clearInterval(visionInterval); continuousModeMap.delete(sessionId); }
      const coachInterval = coachIntervalMap.get(sessionId);
      if (coachInterval) { clearInterval(coachInterval); coachIntervalMap.delete(sessionId); }
      translationModeMap.delete(sessionId);
      listeningModeMap.delete(sessionId);
      listeningBufferMap.delete(sessionId);
      weatherContextMap.delete(sessionId);
      console.log('🔴 Session ended, cleaned up');
    });

    const transcriptionHandler = async (data: any) => {
      const userText = (data.text || '').trim();
      if (!userText || userText.length < 2) return;
      if (!data.isFinal) { session.layouts.showTextWall(`🎙️ "${userText}"`); return; }

      console.log(`\n👤 "${userText}"`);

      const { addressed } = parsePrefix(userText);
      const tLow = userText.toLowerCase().trim();
      const isPrefixFreeCommand =
        /^(call|llama|llamar|whatsapp|facetime|remind me|recuérdame|set reminder|simulate|test call)/i.test(tLow) ||
        tLow.includes('remind me') || tLow.includes('my reminders');

      if (!addressed && !isPrefixFreeCommand) {
        if (listeningModeMap.get(sessionId)) {
          const buffer = listeningBufferMap.get(sessionId) || [];
          buffer.push(userText);
          listeningBufferMap.set(sessionId, buffer);
          session.layouts.showTextWall(`👂 [${buffer.length}]`);
          setTimeout(() => session.layouts.showTextWall(''), 1500);
          console.log(`   → Buffered [${buffer.length}]: "${userText}"`);
          return;
        }
        console.log(`   → Ignored ambient: "${userText}"`);
        return;
      }

      const intent = getIntent(userText);
      console.log(`   → ${intent.type}${(intent as any).mode ? ':' + (intent as any).mode : ''}`);

      // ── Test call ────────────────────────────────────────────────────
      if (intent.type === 'test_call') {
        const msg = `📞 Incoming: ${(intent as any).name}`;
        await session.layouts.showTextWall(msg);
        broadcast('incoming_call', { caller: (intent as any).name, title: (intent as any).name, body: '' });
        broadcast('reply', { text: msg });
        setTimeout(() => session.layouts.showTextWall(''), 10000);
        return;
      }

      // ── Toggle translation ────────────────────────────────────────────
      if (intent.type === 'toggle_translation') {
        translationModeMap.set(sessionId, intent.on);
        const msg = intent.on ? '🌍 Translation mode ON' : '🔇 Translation mode OFF';
        await session.layouts.showTextWall(msg);
        broadcast('user', { text: userText });
        broadcast('reply', { text: msg });
        broadcast('status', { state: 'ready', translation_mode: intent.on });
        return;
      }

      // ── Weather ───────────────────────────────────────────────────────
      if (intent.type === 'weather') {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'thinking' });

        // Get previous context for follow-up queries
        const prevCtx = weatherContextMap.get(sessionId) || {};

        // Merge: use new value if provided, else inherit from previous
        let location = (intent as any).location || prevCtx.location;
        let timeRef = (intent as any).time_ref || prevCtx.time_ref || 'today';

        // If still no location, use default
        if (!location) location = 'San José, Costa Rica';

        // Check if city is ambiguous — ask for clarification
        const locLower = location.toLowerCase().trim();
        const ambigOptions = AMBIGUOUS_CITIES[locLower];
        if (ambigOptions && !(intent as any).location?.includes(',')) {
          // Ask for clarification — don't call weather API yet
          const options = ambigOptions.map((o, i) => `${i + 1}. ${o}`).join(', ');
          const msg = `Which ${location} do you mean? ${options}`;
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
          // Save partial context so next reply completes it
          weatherContextMap.set(sessionId, { location, time_ref: timeRef });
          return;
        }

        const timeLabel = timeRef === 'today' ? '' : ` for ${timeRef}`;
        await session.layouts.showTextWall(`🌤️ Checking weather${timeLabel}...`);

        try {
          const res = await fetch(`${KAI_API_URL}/weather`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({ speaker_key: speakerKey, location, time_ref: timeRef }),
          });
          const weatherData = await res.json() as any;
          const msg = weatherData.summary || 'Could not get weather.';
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
          // Save context for follow-up queries
          weatherContextMap.set(sessionId, { location, time_ref: timeRef });
          setTimeout(() => session.layouts.showTextWall(''), 12000);
        } catch {
          const msg = 'Weather unavailable. Try again.';
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
        }
        return;
      }

      // ── Navigation / Waze ─────────────────────────────────────────────
      if (intent.type === 'navigate') {
        broadcast('user', { text: userText });
        const destination = (intent as any).destination;
        const msg = `🗺️ Opening Waze to ${destination}`;
        await session.layouts.showTextWall(msg);
        broadcast('navigate', { destination, waze_url: `waze://?q=${encodeURIComponent(destination)}&navigate=yes` });
        broadcast('reply', { text: msg });
        broadcast('status', { state: 'ready' });
        setTimeout(() => session.layouts.showTextWall(''), 5000);
        return;
      }

      // ── Sports ────────────────────────────────────────────────────────
      if (intent.type === 'sports') {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'thinking' });
        await session.layouts.showTextWall('⚽ Checking scores...');
        try {
          const res = await fetch(`${KAI_API_URL}/sports`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              speaker_key: speakerKey,
              query: (intent as any).query,
              league: (intent as any).league,
            }),
          });
          const data = await res.json() as any;
          const msg = data.summary || 'Could not get sports data.';
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
          setTimeout(() => session.layouts.showTextWall(''), 12000);
        } catch {
          await session.layouts.showTextWall('Sports data unavailable.');
          broadcast('reply', { text: 'Sports data unavailable. Try again.' });
          broadcast('status', { state: 'ready' });
        }
        return;
      }

      // ── Song recognition ──────────────────────────────────────────────
      if (intent.type === 'song_identify') {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'thinking' });
        const msg = '🎵 Listening for song... hold me near the music for 5 seconds.';
        await session.layouts.showTextWall(msg);
        broadcast('reply', { text: msg });
        // Trigger webview to record audio and send to backend
        broadcast('song_identify', { action: 'start', duration: 5000 });
        broadcast('status', { state: 'ready' });
        return;
      }

      // ── Calendar — read ───────────────────────────────────────────────
      if (intent.type === 'calendar') {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'thinking' });
        await session.layouts.showTextWall('📅 Checking calendar...');
        try {
          const res = await fetch(`${KAI_API_URL}/calendar/events`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({ speaker_key: speakerKey, query: (intent as any).query }),
          });
          const data = await res.json() as any;
          if (res.status === 401) {
            const connectMsg = '📅 Calendar not connected. Visit kai-cloud.up.railway.app/calendar/connect to authorize.';
            await session.layouts.showTextWall(connectMsg);
            broadcast('reply', { text: connectMsg });
            broadcast('status', { state: 'ready' });
            return;
          }
          const msg = data.summary || 'Could not get calendar.';
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('calendar_events', { events: data.events, label: data.label });
          broadcast('status', { state: 'ready' });
          setTimeout(() => session.layouts.showTextWall(''), 12000);
        } catch {
          await session.layouts.showTextWall('Calendar unavailable.');
          broadcast('reply', { text: 'Calendar unavailable. Try again.' });
          broadcast('status', { state: 'ready' });
        }
        return;
      }

      // ── Calendar — create ─────────────────────────────────────────────
      if (intent.type === 'calendar_create') {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'thinking' });
        await session.layouts.showTextWall('📅 Creating event...');
        try {
          const res = await fetch(`${KAI_API_URL}/calendar/parse-and-create`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({ speaker_key: speakerKey, query: (intent as any).query }),
          });
          const data = await res.json() as any;
          const msg = data.summary || 'Could not create event.';
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
          setTimeout(() => session.layouts.showTextWall(''), 8000);
        } catch {
          await session.layouts.showTextWall('Could not create event.');
          broadcast('reply', { text: 'Could not create calendar event.' });
          broadcast('status', { state: 'ready' });
        }
        return;
      }

      // ── Listening mode — START ────────────────────────────────────────
      if (intent.type === 'listen_start') {
        listeningModeMap.set(sessionId, true);
        listeningBufferMap.set(sessionId, []);
        startCoaching();
        const msg = '👂 Listening — capturing everything. Say "KAI summarize" when done.';
        await session.layouts.showTextWall(msg);
        broadcast('user', { text: userText });
        broadcast('reply', { text: msg });
        broadcast('status', { state: 'ready', listening_mode: true });
        return;
      }

      // ── Listening mode — STOP ─────────────────────────────────────────
      if (intent.type === 'listen_stop') {
        listeningModeMap.set(sessionId, false);
        const coachInterval = coachIntervalMap.get(sessionId);
        if (coachInterval) { clearInterval(coachInterval); coachIntervalMap.delete(sessionId); }
        const buffer = listeningBufferMap.get(sessionId) || [];
        const msg = buffer.length > 0
          ? `👂 Stopped. ${buffer.length} utterances captured. Say "KAI summarize" to analyze.`
          : '👂 Listening stopped. Nothing captured.';
        await session.layouts.showTextWall(msg);
        broadcast('user', { text: userText });
        broadcast('reply', { text: msg });
        broadcast('status', { state: 'ready', listening_mode: false });
        return;
      }

      // ── Listening mode — SUMMARIZE ────────────────────────────────────
      if (intent.type === 'listen_summarize') {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'thinking' });
        const buffer = listeningBufferMap.get(sessionId) || [];
        if (buffer.length === 0) {
          const msg = 'Nothing captured yet. Say "KAI listen" first.';
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
          return;
        }
        await session.layouts.showTextWall('📝 Analyzing conversation...');
        try {
          const res = await fetch(`${KAI_API_URL}/listen/summarize`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({ speaker_key: speakerKey, utterances: buffer, create_reminders: true }),
          });
          const sumData = await res.json() as any;
          const glassesText = sumData.glasses_text || sumData.summary || 'Could not summarize.';

          await session.layouts.showTextWall(glassesText);
          broadcast('reply', { text: glassesText });
          broadcast('listen_summary', sumData);
          broadcast('status', { state: 'ready' });

          // Auto-create reminders from action items
          if (sumData.suggested_reminders?.length > 0) {
            for (const reminder of sumData.suggested_reminders) {
              try {
                await fetch(`${KAI_API_URL}/reminders/`, {
                  method: 'POST',
                  headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    speaker_key: speakerKey,
                    message: reminder.message,
                    remind_at: null,
                    timezone: 'America/Costa_Rica',
                    from_conversation: true,
                  }),
                });
              } catch {}
            }
            const reminderCount = sumData.suggested_reminders.length;
            console.log(`✅ Auto-created ${reminderCount} reminder(s) from conversation`);
          }

          // Clear buffer after summarizing
          listeningBufferMap.set(sessionId, []);
          setTimeout(() => session.layouts.showTextWall(''), 15000);
        } catch {
          const msg = 'Summary failed. Try again.';
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
        }
        return;
      }

      // ── Call ──────────────────────────────────────────────────────────
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
        const callApp = intent.app !== 'phone' ? intent.app : (contact.default_app as any || 'phone');
        const msg = `📞 Calling ${contact.name}...`;
        await session.layouts.showTextWall(msg);
        broadcast('direct_call', { contact, app: callApp });
        broadcast('reply', { text: msg });
        broadcast('status', { state: 'ready' });
        return;
      }

      // ── Reminder ──────────────────────────────────────────────────────
      if (intent.type === 'reminder') {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'thinking' });
        await session.layouts.showTextWall('⏰ Setting reminder...');
        try {
          const parseRes = await fetch(`${KAI_API_URL}/reminders/parse`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({ speaker_key: speakerKey, text: (intent as any).text, timezone: 'America/Costa_Rica' }),
          });
          const parsed = await parseRes.json() as any;
          if (!parseRes.ok || !parsed.valid) {
            const msg = "I couldn't understand that reminder. Try: 'remind me to call mom at 3pm'";
            await session.layouts.showTextWall(msg);
            broadcast('reply', { text: msg });
            broadcast('status', { state: 'ready' });
            return;
          }
          await fetch(`${KAI_API_URL}/reminders/`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({ speaker_key: speakerKey, message: parsed.message, remind_at: parsed.remind_at, timezone: 'America/Costa_Rica' }),
          });
          const msg = `⏰ Got it! Reminding you to ${parsed.message} ${parsed.human_time}`;
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
          setTimeout(() => session.layouts.showTextWall(''), 8000);
        } catch {
          await session.layouts.showTextWall('Failed to set reminder.');
          broadcast('reply', { text: 'Failed to set reminder.' });
          broadcast('status', { state: 'ready' });
        }
        return;
      }

      // ── List reminders ────────────────────────────────────────────────
      if ((intent as any).type === 'list_reminders') {
        broadcast('user', { text: userText });
        try {
          const res = await fetch(`${KAI_API_URL}/reminders/${speakerKey}`, { headers: { 'x-api-key': KAI_API_KEY_VAL } });
          const data = await res.json() as any;
          const reminders = data.reminders || [];
          const msg = reminders.length === 0
            ? 'You have no upcoming reminders.'
            : `${reminders.length} reminder${reminders.length > 1 ? 's' : ''}:\n` +
              reminders.slice(0, 3).map((r: any) => `• ${r.message}`).join('\n');
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

      // ── Vision ────────────────────────────────────────────────────────
      if (intent.type === 'vision') {
        broadcast('user', { text: userText });
        broadcast('status', { state: 'thinking' });
        const modeLabels: Record<string, string> = {
          describe: '👁️ Looking...', read: '📖 Reading...', translate: '🌍 Translating...',
          identify: '🔍 Identifying...', gesture: '👋 Reading gesture...',
          qr: '📷 Scanning QR...', shop: '🛍️ Finding where to buy...',
          body_language: '🧠 Reading body language...', similarity: '👤 Analyzing features...',
          follow_player: '🎯 Tracking...', record_start: '⏺ Recording...', record_stop: '⏹ Stopping...',
        };
        await session.layouts.showTextWall(modeLabels[intent.mode] || '👁️ Analyzing...');

        if (intent.mode === 'continuous_on') {
          if (!continuousModeMap.has(sessionId)) startContinuousVision();
          await session.layouts.showTextWall('👁️ Continuous vision ON');
          broadcast('reply', { text: '👁️ Continuous vision ON' });
          broadcast('status', { state: 'ready' });
          return;
        }
        if (intent.mode === 'continuous_off') {
          const interval = continuousModeMap.get(sessionId);
          if (interval) { clearInterval(interval); continuousModeMap.delete(sessionId); }
          await session.layouts.showTextWall('👁️ Continuous vision OFF');
          broadcast('reply', { text: '👁️ Continuous vision OFF' });
          broadcast('status', { state: 'ready' });
          return;
        }
        if (intent.mode === 'record_start') {
          broadcast('vision_record', { action: 'start' });
          await session.layouts.showTextWall('⏺ Recording started');
          broadcast('reply', { text: '⏺ Recording started' });
          broadcast('status', { state: 'ready' });
          return;
        }
        if (intent.mode === 'record_stop') {
          broadcast('vision_record', { action: 'stop' });
          await session.layouts.showTextWall('⏹ Recording stopped');
          broadcast('reply', { text: '⏹ Recording stopped' });
          broadcast('status', { state: 'ready' });
          return;
        }
        if (intent.mode === 'follow_player') {
          const target = (intent as any).query || 'the target';
          broadcast('vision_record', { action: 'follow_start', target });
          await session.layouts.showTextWall(`🎯 Following ${target}`);
          broadcast('reply', { text: `🎯 Following ${target}` });
          broadcast('status', { state: 'ready' });
          return;
        }
        if (intent.mode === 'follow_stop') {
          broadcast('vision_record', { action: 'follow_stop' });
          await session.layouts.showTextWall('🎯 Stopped following');
          broadcast('reply', { text: '🎯 Stopped following' });
          broadcast('status', { state: 'ready' });
          return;
        }

        try {
          const photo = await (session as any).camera.requestPhoto({ size: 'medium' });
          if (!photo || !photo.data) {
            const msg = 'Could not capture photo.';
            await session.layouts.showTextWall(msg);
            broadcast('reply', { text: msg });
            broadcast('status', { state: 'ready' });
            return;
          }
          const base64 = Buffer.isBuffer(photo.data) ? photo.data.toString('base64') : Buffer.from(photo.data).toString('base64');
          const visionRes = await fetch(`${KAI_API_URL}/vision/analyze`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_base64: base64, mode: intent.mode, speaker_key: speakerKey }),
          });
          const visionData = await visionRes.json() as any;
          const result = visionData.result || 'Could not analyze image.';
          await session.layouts.showTextWall(result);
          broadcast('vision', { mode: intent.mode, result, qr_url: visionData.qr_url });
          broadcast('reply', { text: result });
          broadcast('status', { state: 'ready' });
          setTimeout(() => session.layouts.showTextWall(''), 12000);
        } catch (e: any) {
          const msg = e?.message?.includes('camera') ? 'Camera not available.' : 'Vision failed.';
          await session.layouts.showTextWall(msg);
          broadcast('reply', { text: msg });
          broadcast('status', { state: 'ready' });
        }
        return;
      }

      // ── Inline translate ──────────────────────────────────────────────
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

      // ── Passive translation mode ──────────────────────────────────────
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

      // ── Normal AI response ────────────────────────────────────────────
      broadcast('user', { text: userText });
      broadcast('status', { state: 'thinking' });
      await session.layouts.showTextWall('KAI is thinking...');
      try {
        // Save user message to conversation history
        sessionMessages.push({ role: 'user', content: userText });
        try {
          await fetch(`${KAI_API_URL}/memory/conversation/save`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              speaker_key: speakerKey,
              session_id: sessionId,
              role: 'user',
              content: userText,
              intent_type: 'normal',
            }),
          });
        } catch {}

        const response: KaiResponse = await callKaiAPI(userText, sessionId, userId);
        const replyText = response.text || response.response || 'Sorry, I had trouble with that.';
        await session.layouts.showTextWall(replyText);
        broadcast('reply', { text: replyText });
        broadcast('status', { state: 'ready' });
        setTimeout(() => session.layouts.showTextWall(''), 8000);

        // Save assistant response
        sessionMessages.push({ role: 'assistant', content: replyText });
        try {
          await fetch(`${KAI_API_URL}/memory/conversation/save`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              speaker_key: speakerKey,
              session_id: sessionId,
              role: 'assistant',
              content: replyText,
            }),
          });
        } catch {}

        // Trigger learning every 5 turns
        turnCount++;
        if (turnCount % 5 === 0 && sessionMessages.length >= 4) {
          fetch(`${KAI_API_URL}/memory/learn`, {
            method: 'POST',
            headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              speaker_key: speakerKey,
              session_id: sessionId,
              recent_messages: sessionMessages.slice(-10),
            }),
          }).then(async (r) => {
            const data = await r.json() as any;
            if (data.count > 0) {
              console.log(`🧠 Learned ${data.count} new facts:`, data.learned.map((f: any) => f.key));
              // Refresh memory context
              const memRes = await fetch(`${KAI_API_URL}/memory/context`, {
                method: 'POST',
                headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
                body: JSON.stringify({ speaker_key: speakerKey, query: 'general', limit: 30 }),
              });
              const memData = await memRes.json() as any;
              memoryContext = memData.context || memoryContext;
              // Push updated context to session cache
              fetch(`${KAI_API_URL}/memory/session/set`, {
                method: 'POST',
                headers: { 'x-api-key': KAI_API_KEY_VAL, 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sessionId, speaker_key: speakerKey, context: memoryContext }),
              }).catch(() => {});
            }
          }).catch(() => {});
        }
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
