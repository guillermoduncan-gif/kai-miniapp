/**
 * kai-client.ts
 * Handles all communication with your KAI Cloud API on Railway.
 */

const KAI_API_URL = process.env.KAI_API_URL || 'https://kai-cloud-production.up.railway.app';
const KAI_API_KEY = process.env.KAI_API_KEY || 'kai-secret-guille-2026';

export interface KaiResponse {
  response?: string;
  text?: string;
  session_id?: string;
  speaker_key?: string;
}

/**
 * Send a text turn to KAI and get a response.
 * Uses /process — the same endpoint that works in Phase 1.
 */
export async function callKaiAPI(
  userText: string,
  sessionId: string,
  userId: string
): Promise<KaiResponse> {

  const url = `${KAI_API_URL}/process`;

  const body = {
    text: userText,
    session_id: sessionId,
    speaker_key: userIdToSpeakerKey(userId),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': KAI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`KAI API error ${res.status}: ${errorText}`);
  }

  return res.json() as Promise<KaiResponse>;
}

/**
 * Get memories for a speaker from KAI Cloud.
 */
export async function getMemories(speakerKey: string): Promise<any[]> {
  const url = `${KAI_API_URL}/memory/${speakerKey}`;
  const res = await fetch(url, {
    headers: { 'x-api-key': KAI_API_KEY },
  });
  if (!res.ok) return [];
  const data = await res.json() as { memories: any[] };
  return data.memories || [];
}

/**
 * Save a memory for a speaker to KAI Cloud.
 */
export async function saveMemory(
  speakerKey: string,
  content: string,
  category = 'general'
): Promise<void> {
  const url = `${KAI_API_URL}/memory/${speakerKey}`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': KAI_API_KEY,
    },
    body: JSON.stringify({ content, category }),
  });
}

/**
 * Convert Mentra userId to KAI speaker_key.
 * For now maps to 'guille' — expand this for multi-user later.
 */
function userIdToSpeakerKey(userId: string): string {
  const userMap: Record<string, string> = {
    // Add entries as you add more users
    // 'mentra-user-id-here': 'guille',
  };
  return userMap[userId] || 'guille';
}
