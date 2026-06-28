export type ParsedSpokenDate = {
  isoDate: string;
  label: string;
  confidence: "explicit" | "relative" | "weekday" | "fallback";
};

export type VoiceIntent =
  | "calendar"
  | "direct-message"
  | "twitch-message"
  | "hearmeout-request"
  | "image-generation"
  | "profile-memory"
  | "flashlight"
  | "streamweaver-voice";

export type ParsedVoiceCommand = {
  intent: VoiceIntent;
  commandId: string;
  destination: "ai" | "private" | "twitch" | "discord";
  cleanedText: string;
  date?: ParsedSpokenDate;
  time?: string;
  title?: string;
  twitchChannel?: string;
  targetName?: string;
  metadata: Record<string, unknown>;
};

const weekdayIndex: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

export function parseSpokenDate(text: string, now = new Date()): ParsedSpokenDate {
  const normalized = text.toLowerCase();
  const explicit = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (explicit) return buildDate(Number(explicit[1]), Number(explicit[2]) - 1, Number(explicit[3]), explicit[0], "explicit");

  const numeric = normalized.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (numeric) {
    const year = numeric[3] ? normalizeYear(Number(numeric[3])) : now.getFullYear();
    return buildDate(year, Number(numeric[1]) - 1, Number(numeric[2]), numeric[0], "explicit");
  }

  if (/\btomorrow\b/.test(normalized)) return offsetDate(now, 1, "tomorrow", "relative");
  if (/\btoday\b/.test(normalized)) return offsetDate(now, 0, "today", "relative");
  const inDays = normalized.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDays) return offsetDate(now, Number(inDays[1]), inDays[0], "relative");

  const weekday = normalized.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekday) {
    const target = weekdayIndex[weekday[2]];
    const current = now.getDay();
    let diff = (target - current + 7) % 7;
    if (diff === 0 || weekday[1]) diff += 7;
    return offsetDate(now, diff, weekday[0], "weekday");
  }

  return offsetDate(now, 0, "today", "fallback");
}

export function formatDateForCommand(parsed: ParsedSpokenDate): string {
  return parsed.isoDate;
}

export function parseVoiceCommandForDate(text: string, now = new Date()): ParsedVoiceCommand {
  const cleanedText = text.trim();
  const lower = cleanedText.toLowerCase();
  const date = parseSpokenDate(cleanedText, now);
  const time = extractTime(cleanedText);
  const twitchChannel = extractTwitchChannel(cleanedText);
  const directMessage = extractDirectMessage(cleanedText);

  if (/\b(calendar|meeting|appointment|event|reminder|date)\b/.test(lower)) {
    return {
      intent: "calendar",
      commandId: "cmd_dsh_calendar_add_mission",
      destination: "discord",
      cleanedText,
      date,
      time,
      title: extractCalendarTitle(cleanedText),
      metadata: { missionDate: formatDateForCommand(date), missionTime: time, parser: "mountainview-mobile" }
    };
  }

  if (directMessage) {
    const targetChannel = twitchChannel || normalizeTargetChannel(directMessage.targetName);
    return {
      intent: "direct-message",
      commandId: "cmd_streamweaver_voice_commander",
      destination: /\b(discord|server)\b/.test(lower) ? "discord" : "twitch",
      cleanedText: directMessage.message,
      twitchChannel: targetChannel,
      targetName: directMessage.targetName,
      metadata: {
        channel: targetChannel,
        targetName: directMessage.targetName,
        outgoingMessage: directMessage.message,
        forceVoiceMode: "dictation",
        parser: "mountainview-mobile"
      }
    };
  }

  if (/\b(send|post|say|type)\b.*\b(twitch|chat)\b|\btwitch\b.*\bmessage\b/.test(lower)) {
    return {
      intent: "twitch-message",
      commandId: "cmd_streamweaver_voice_commander",
      destination: "twitch",
      cleanedText,
      twitchChannel,
      metadata: { channel: twitchChannel, parser: "mountainview-mobile" }
    };
  }

  if (/\b(song|audiobook|audio book|movie|watch party|queue|request)\b/.test(lower) && /\b(hearmeout|hear me out|play|queue|request)\b/.test(lower)) {
    return {
      intent: "hearmeout-request",
      commandId: lower.includes("audiobook") || lower.includes("audio book") ? "cmd_hearmeout_audiobook_request" : "cmd_hearmeout_song_request",
      destination: "ai",
      cleanedText,
      metadata: { query: cleanedText, parser: "mountainview-mobile" }
    };
  }

  if (/\b(generate|edit|change|make)\b.*\b(image|picture|photo|avatar)\b|!img\b/.test(lower)) {
    return {
      intent: "image-generation",
      commandId: "cmd_streamweaver_image_generate",
      destination: "ai",
      cleanedText,
      metadata: { prompt: cleanedText, parser: "mountainview-mobile" }
    };
  }

  if (/\b(remember|profile|birthday|boss|person|conversation)\b/.test(lower)) {
    return {
      intent: "profile-memory",
      commandId: "cmd_profile_save_person",
      destination: "private",
      cleanedText,
      date,
      time,
      metadata: { reminderDate: date.isoDate, reminderTime: time, parser: "mountainview-mobile" }
    };
  }

  if (/\b(flashlight|torch|light)\b/.test(lower)) {
    return {
      intent: "flashlight",
      commandId: "local_flashlight",
      destination: "ai",
      cleanedText,
      metadata: { parser: "mountainview-mobile" }
    };
  }

  return {
    intent: "streamweaver-voice",
    commandId: "cmd_streamweaver_voice_commander",
    destination: "ai",
    cleanedText,
    date,
    time,
    metadata: { parser: "mountainview-mobile" }
  };
}

function buildDate(year: number, month: number, day: number, label: string, confidence: ParsedSpokenDate["confidence"]): ParsedSpokenDate {
  const date = new Date(year, month, day);
  return { isoDate: toIsoDate(date), label, confidence };
}

function offsetDate(now: Date, days: number, label: string, confidence: ParsedSpokenDate["confidence"]): ParsedSpokenDate {
  const date = new Date(now);
  date.setDate(now.getDate() + days);
  return { isoDate: toIsoDate(date), label, confidence };
}

function normalizeYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function extractTime(text: string): string {
  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = match[2] ?? "00";
  const suffix = match[3]?.toLowerCase();
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function extractTwitchChannel(text: string): string {
  const url = text.match(/(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-z0-9_]{3,25})/i);
  if (url?.[1]) return url[1].toLowerCase();
  const named = text.match(/\b(?:in|to|for|watching|on)\s+@?([a-z0-9_]{3,25})(?:'s)?\s+(?:twitch\s+)?(?:chat|stream)\b/i);
  return named?.[1]?.toLowerCase() ?? "";
}

function extractDirectMessage(text: string): { targetName: string; message: string } | undefined {
  const quoted = text.match(/\b(?:send|post|type|say)\s+(?:a\s+)?message(?:\s+to\s+(.+?))?\s+(?:that\s+says|saying|with|:)\s+["“]?(.+?)["”]?\s*$/i);
  if (quoted?.[2]?.trim()) {
    return {
      targetName: cleanTargetName(quoted[1] ?? ""),
      message: quoted[2].trim()
    };
  }

  const simple = text.match(/\b(?:send|post|type)\s+["“]?(.+?)["”]?\s+(?:to|in|into)\s+(.+?)(?:\s+(?:chat|twitch|discord))?\s*$/i);
  if (simple?.[1]?.trim()) {
    return {
      targetName: cleanTargetName(simple[2] ?? ""),
      message: simple[1].trim()
    };
  }

  return undefined;
}

function cleanTargetName(value: string): string {
  return value
    .replace(/\b(?:twitch|discord|chat|channel|server|user)\b/ig, "")
    .replace(/^@/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTargetChannel(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9_]+/g, "")
    .slice(0, 25);
}

function extractCalendarTitle(text: string): string {
  return text
    .replace(/\b(add|create|put|schedule|make)\b/ig, "")
    .replace(/\b(to|on|in)\s+(my\s+)?(calendar|discord\s+stream\s+hub|discordstreamhub)\b/ig, "")
    .replace(/\b(today|tomorrow|next\s+\w+|in\s+\d+\s+days?)\b/ig, "")
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)?\b/ig, "")
    .replace(/\s+/g, " ")
    .trim() || "MountainView reminder";
}
