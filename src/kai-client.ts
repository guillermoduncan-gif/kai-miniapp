/**
 * kai-client.ts
 * Handles all communication with KAI Cloud API on Railway.
 * Phase 4: Added translation support
 */

const KAI_API_URL = process.env.KAI_API_URL || 'https://kai-cloud-production.up.railway.app';
const KAI_API_KEY = process.env.KAI_API_KEY || 'kai-secret-guille-2026';

export interface KaiResponse {
  response?: string;
  text?: string;
  session_id?: string;
  speaker_key?: string;
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

const headers = {
  'Content-Type': 'application/json',
  'x-api-key': KAI_API_KEY,
};

export async function callKaiAPI(
  userText: string,
  sessionId: string,
  userId: string
): Promise<KaiResponse> {
  const res = await fetch(`${KAI_API_URL}/process`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      text: userText,
      session_id: sessionId,
      speaker_key: userIdToSpeakerKey(userId),
    }),
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`KAI API error ${res.status}: ${errorText}`);
  }
  return res.json() as Promise<KaiResponse>;
}

export async function translateText(
  text: string,
  targetLang: string,
  speakerKey: string = 'guille'
): Promise<TranslationResponse> {
  const res = await fetch(`${KAI_API_URL}/translate/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, target_lang: targetLang, speaker_key: speakerKey }),
  });
  if (!res.ok) throw new Error(`Translation error ${res.status}`);
  return res.json() as Promise<TranslationResponse>;
}

export async function detectLanguage(text: string): Promise<DetectResponse> {
  const res = await fetch(`${KAI_API_URL}/translate/detect`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error('Language detection failed');
  return res.json() as Promise<DetectResponse>;
}

export async function getMemories(speakerKey: string): Promise<any[]> {
  const res = await fetch(`${KAI_API_URL}/memory/${speakerKey}`, { headers });
  if (!res.ok) return [];
  const data = await res.json() as { memories: any[] };
  return data.memories || [];
}

export async function saveMemory(
  speakerKey: string,
  content: string,
  category = 'general'
): Promise<void> {
  await fetch(`${KAI_API_URL}/memory/${speakerKey}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content, category }),
  });
}

export function userIdToSpeakerKey(userId: string): string {
  const userMap: Record<string, string> = {};
  return userMap[userId] || 'guille';
}
