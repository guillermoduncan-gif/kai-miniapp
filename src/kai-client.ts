/**
 * kai-client.ts — KAI Cloud API client v2.0
 * Multi-user: speaker key derived from userId
 */

const KAI_API_URL = process.env.KAI_API_URL || 'https://kai-cloud-production.up.railway.app';
const KAI_API_KEY = process.env.KAI_API_KEY || 'kai-secret-guille-2026';

export interface KaiResponse {
  response?: string;
  text?: string;
  session_id?: string;
  lang?: string;
}

export interface TranslationResponse {
  original: string;
  translation: string;
  detected_language: string;
  target_language: string;
  is_same_language: boolean;
}

export interface DetectResponse {
  language: string;
  language_code: string;
  confidence: string;
}

export interface Contact {
  id: string;
  speaker_key: string;
  name: string;
  phone: string;
  default_app: string;
  created_at: string;
}

const headers = {
  'Content-Type': 'application/json',
  'x-api-key': KAI_API_KEY,
};

export async function callKaiAPI(userText: string, sessionId: string, userId: string): Promise<KaiResponse> {
  const speakerKey = userIdToSpeakerKey(userId);
  const res = await fetch(`${KAI_API_URL}/process`, {
    method: 'POST', headers,
    body: JSON.stringify({
      text: userText,
      session_id: sessionId,
      speaker_key: speakerKey,
      speaker_display_name: speakerKey,
    }),
  });
  if (!res.ok) throw new Error(`KAI API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<KaiResponse>;
}

export async function translateText(text: string, targetLang: string, speakerKey = 'guille'): Promise<TranslationResponse> {
  const res = await fetch(`${KAI_API_URL}/translate/`, {
    method: 'POST', headers,
    body: JSON.stringify({ text, target_lang: targetLang, speaker_key: speakerKey }),
  });
  if (!res.ok) throw new Error(`Translation error ${res.status}`);
  return res.json() as Promise<TranslationResponse>;
}

export async function detectLanguage(text: string): Promise<DetectResponse> {
  const res = await fetch(`${KAI_API_URL}/translate/detect`, {
    method: 'POST', headers,
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error('Language detection failed');
  return res.json() as Promise<DetectResponse>;
}

export async function lookupContact(speakerKey: string, name: string): Promise<Contact | null> {
  const res = await fetch(`${KAI_API_URL}/contacts/${speakerKey}/lookup?name=${encodeURIComponent(name)}`, { headers });
  if (!res.ok) return null;
  const data = await res.json() as { found: boolean; contact: Contact | null };
  return data.found ? data.contact : null;
}

export async function getContacts(speakerKey: string): Promise<Contact[]> {
  const res = await fetch(`${KAI_API_URL}/contacts/${speakerKey}`, { headers });
  if (!res.ok) return [];
  const data = await res.json() as { contacts: Contact[] };
  return data.contacts || [];
}

export async function addContact(speakerKey: string, name: string, phone: string, defaultApp = 'phone'): Promise<Contact | null> {
  const res = await fetch(`${KAI_API_URL}/contacts/${speakerKey}`, {
    method: 'POST', headers,
    body: JSON.stringify({ name, phone, default_app: defaultApp }),
  });
  if (!res.ok) throw new Error(`Add contact error ${res.status}: ${await res.text()}`);
  const data = await res.json() as { contact: Contact };
  return data.contact;
}

export async function deleteContact(speakerKey: string, contactId: string): Promise<void> {
  await fetch(`${KAI_API_URL}/contacts/${speakerKey}/${contactId}`, { method: 'DELETE', headers });
}

export async function getMemories(speakerKey: string): Promise<any[]> {
  const res = await fetch(`${KAI_API_URL}/memory/${speakerKey}`, { headers });
  if (!res.ok) return [];
  const data = await res.json() as { memories: any[] };
  return data.memories || [];
}

export async function saveMemory(speakerKey: string, content: string, category = 'general'): Promise<void> {
  await fetch(`${KAI_API_URL}/memory/${speakerKey}`, {
    method: 'POST', headers,
    body: JSON.stringify({ content, category }),
  });
}

/**
 * userIdToSpeakerKey — converts Mentra userId to a KAI speaker key.
 *
 * Multi-user strategy:
 * 1. Check hardcoded known users (fast path)
 * 2. Derive from email prefix (e.g. "john@gmail.com" → "john")
 * 3. Derive from userId hash prefix for anonymous users
 *
 * This means each Mentra account automatically gets their own
 * isolated memory, contacts, reminders, and calendar.
 */
export function userIdToSpeakerKey(userId: string): string {
  if (!userId) return 'guest';

  // Known user overrides — add yours here
  const KNOWN_USERS: Record<string, string> = {
    'guillermoduncan@gmail.com': 'guille',
    // 'friend@gmail.com': 'friend',
    // 'partner@gmail.com': 'partner',
  };

  if (KNOWN_USERS[userId]) return KNOWN_USERS[userId];

  // Derive from email prefix
  if (userId.includes('@')) {
    const prefix = userId.split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .substring(0, 20);
    return prefix || 'guest';
  }

  // Fallback: use first 12 chars of userId
  return userId.replace(/[^a-z0-9]/gi, '_').substring(0, 12).toLowerCase() || 'guest';
}
