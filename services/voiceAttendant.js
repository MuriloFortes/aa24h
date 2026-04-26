import axios from "axios";
import { logger } from "../lib/logger.js";
import { conversationManager, STATES } from "../agents/conversationFlow.js";
import { processMessage } from "../agents/attendant.js";

const DEFAULT_VOICE = "方言-女性-深情";
const DEFAULT_LANGUAGE = "pt-br";

export function resolveVoxtralBaseURL() {
  return process.env.VOXTRAL_BASE_URL?.trim() || "https://api.voxtral.com";
}

export function resolveVoxtralAPIKey() {
  return process.env.VOXTRAL_API_KEY?.trim() || "";
}

export function hasVoxtralConfigured() {
  return !!resolveVoxtralAPIKey();
}

export function resolveTwilioConfig() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || "",
    authToken: process.env.TWILIO_AUTH_TOKEN?.trim() || "",
    phoneNumber: process.env.TWILIO_PHONE_NUMBER?.trim() || "",
  };
}

export function hasTwilioConfigured() {
  const cfg = resolveTwilioConfig();
  return !!(cfg.accountSid && cfg.authToken && cfg.phoneNumber);
}

export function resolveVoiceBaseURL() {
  return process.env.VOICE_BASE_URL?.trim() || process.env.SERVER_URL?.trim() || "";
}

export async function textToSpeech(text, options = {}) {
  const apiKey = resolveVoxtralAPIKey();
  if (!apiKey) {
    throw new Error("VOXTRAL_API_KEY não configurado");
  }

  const voice = options.voice || DEFAULT_VOICE;
  const language = options.language || DEFAULT_LANGUAGE;
  const speed = options.speed || 1.0;
  const baseUrl = resolveVoxtralBaseURL();

  try {
    const response = await axios.post(
      `${baseUrl}/v1/tts`,
      {
        text: text,
        voice: voice,
        language: language,
        speed: speed,
        response_format: "url",
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 30000,
      }
    );

    return response.data?.audio_url || response.data?.url || null;
  } catch (error) {
    logger.error({ error: error.message, text }, "Voxtral TTS error");
    throw error;
  }
}

export async function speechToText(audioUrl, options = {}) {
  const apiKey = resolveVoxtralAPIKey();
  if (!apiKey) {
    throw new Error("VOXTRAL_API_KEY não configurado");
  }

  const language = options.language || DEFAULT_LANGUAGE;
  const baseUrl = resolveVoxtralBaseURL();

  try {
    const response = await axios.post(
      `${baseUrl}/v1/stt`,
      {
        url: audioUrl,
        language: language,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 30000,
      }
    );

    return response.data?.text || response.data?.transcription || "";
  } catch (error) {
    logger.error({ error: error.message, audioUrl }, "Voxtral STT error");
    throw error;
  }
}

export async function textToSpeechAudio(text, options = {}) {
  const apiKey = resolveVoxtralAPIKey();
  if (!apiKey) {
    throw new Error("VOXTRAL_API_KEY não configurado");
  }

  const voice = options.voice || DEFAULT_VOICE;
  const language = options.language || DEFAULT_LANGUAGE;
  const speed = options.speed || 1.0;
  const baseUrl = resolveVoxtralBaseURL();

  try {
    const response = await axios.post(
      `${baseUrl}/v1/tts`,
      {
        text: text,
        voice: voice,
        language: language,
        speed: speed,
        response_format: "mp3",
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 30000,
        responseType: "arraybuffer",
      }
    );

    return Buffer.from(response.data);
  } catch (error) {
    logger.error({ error: error.message, text }, "Voxtral TTS audio error");
    throw error;
  }
}

export async function buildTwilioVoiceResponse(text) {
  const audioBuffer = await textToSpeechAudio(text);
  const base64Audio = audioBuffer.toString("base64");
  const baseUrl = resolveVoiceBaseURL() || "https://achiness-geometry-stimuli.ngrok-free.dev";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>data:audio/mp3;base64,${base64Audio}</Play>
  <Gather input="speech" action="${baseUrl}/api/voice/gather" method="POST" speechTimeout="5" speechModel="experimental_conversational">
  </Gather>
</Response>`;

  return twiml;
}

export async function buildTwilioGatherResponse(text, nextAction = null) {
  const audioBuffer = await textToSpeechAudio(text);
  const base64Audio = audioBuffer.toString("base64");
  const baseUrl = resolveVoiceBaseURL() || "https://achiness-geometry-stimuli.ngrok-free.dev";
  const action = nextAction || `${baseUrl}/api/voice/gather`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>data:audio/mp3;base64,${base64Audio}</Play>
  <Gather input="speech" action="${action}" method="POST" speechTimeout="5" speechModel="experimental_conversational">
  </Gather>
</Response>`;

  return twiml;
}

export async function buildTwilioHangupResponse(text) {
  const audioBuffer = await textToSpeechAudio(text);
  const base64Audio = audioBuffer.toString("base64");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>data:audio/mp3;base64,${base64Audio}</Play>
  <Say>Atendimento encerrado. Obrigado por ligar!</Say>
  <Hangup/>
</Response>`;

  return twiml;
}

export function getPhoneSessionKey(phoneNumber) {
  if (!phoneNumber) return null;
  const digits = String(phoneNumber).replace(/\D/g, "");
  return `voice:${digits}`;
}

export async function handleVoiceCall(callSid, from, to, callStatus) {
  logger.info({ callSid, from, to, callStatus }, "Voice call event");

  const sessionKey = getPhoneSessionKey(from);
  if (!sessionKey) {
    return { error: "Número inválido" };
  }

  if (callStatus === "completed" || callStatus === "busy" || callStatus === "failed") {
    conversationManager.updateState(sessionKey, STATES.CLOSED);
    return { status: "closed", sessionKey };
  }

  return { status: "active", sessionKey };
}

export async function handleVoiceGather(callSid, from, audioUrl, digits) {
  const sessionKey = getPhoneSessionKey(from);
  if (!sessionKey) {
    return { error: "Número inválido" };
  }

  let userText = digits || "";

  if (audioUrl) {
    try {
      userText = await speechToText(audioUrl);
    } catch (error) {
      logger.warn({ error: error.message, audioUrl }, "STT failed, using digits");
    }
  }

  if (!userText) {
    return { error: "Não foi possível entender a mensagem" };
  }

  const result = await processMessage(sessionKey, userText);
  const responseText = result?.response || result?.nextQuestion;
  const summary = result?.ticketData;

  let voiceResponse;
  if (responseText && !summary) {
    voiceResponse = await buildTwilioGatherResponse(responseText);
  } else if (summary) {
    voiceResponse = await buildTwilioGatherResponse(
      "Atendimento confirmado. Receba os dados no WhatsApp. Goodbye!"
    );
    conversationManager.updateState(sessionKey, STATES.TICKET_CREATED);
  } else {
    voiceResponse = await buildTwilioGatherResponse(
      "Desculpe, não entendi. Por favor, tente novamente."
    );
  }

  return {
    response: voiceResponse,
    result,
    sessionKey,
  };
}

export async function startVoiceCall(callSid, from) {
  const sessionKey = getPhoneSessionKey(from);
  if (!sessionKey) {
    return { error: "Número inválido" };
  }

  const existingSession = conversationManager.getSession(sessionKey);
  if (!existingSession) {
    conversationManager.createSession(sessionKey);
  }
  conversationManager.updateState(sessionKey, STATES.COLLECTING_INFO);

  const welcomeText =
    "Olá! Sou a assistente virtual da SGA Assistência. Como posso ajudar você hoje?";

  const voiceResponse = await buildTwilioGatherResponse(welcomeText);

  return {
    response: voiceResponse,
    sessionKey,
  };
}

export function getVoiceSessionState(phoneNumber) {
  const sessionKey = getPhoneSessionKey(phoneNumber);
  if (!sessionKey) return null;
  return conversationManager.getSession(sessionKey);
}

export async function twilioMakeCall(to, from, twimlUrl) {
  const cfg = resolveTwilioConfig();
  if (!cfg.accountSid || !cfg.authToken) {
    throw new Error("Twilio não configurado");
  }

  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");

  try {
    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`,
      new URLSearchParams({
        To: to,
        From: from,
        Url: twimlUrl,
        Method: "GET",
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    return response.data;
  } catch (error) {
    logger.error({ error: error.message, to, from }, "Twilio make call error");
    throw error;
  }
}