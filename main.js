const {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
} = require('electron');
require('dotenv').config();
const { DeepgramClient } = require('@deepgram/sdk');
const path = require('path');

let mainWindow = null;
let deepgramConnection = null;
let deepgramIsOpen = false;
let isClaudeRequestInFlight = false;
let rendererReady = false;
let conversationHistory = [];
let prospectSpeaker = null;

function validateRequiredEnvKeys() {
  const requiredKeys = ['DEEPGRAM_API_KEY', 'CLAUDE_API_KEY'];
  const missingKeys = requiredKeys.filter((key) => !process.env[key]);

  if (missingKeys.length > 0) {
    console.error(
      `[Startup] Missing required environment variables: ${missingKeys.join(', ')}`
    );
    console.error(
      '[Startup] Set the missing keys in your .env file before starting a call.'
    );
    return false;
  }

  console.log('[Startup] Required API keys loaded (DEEPGRAM_API_KEY, CLAUDE_API_KEY).');
  return true;
}

validateRequiredEnvKeys();

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.warn(`[IPC] Cannot send "${channel}": window missing or destroyed.`);
    return;
  }

  const { webContents } = mainWindow;
  const deliver = () => {
    console.log(`[IPC] Sending "${channel}" to renderer.`);
    webContents.send(channel, payload);
  };

  if (rendererReady && !webContents.isLoadingMainFrame()) {
    deliver();
    return;
  }

  console.log(
    `[IPC] Renderer not ready for "${channel}" yet. Queuing until did-finish-load.`
  );
  webContents.once('did-finish-load', () => {
    rendererReady = true;
    deliver();
  });
}

function formatConversationContext(historyEntries) {
  if (!Array.isArray(historyEntries) || historyEntries.length === 0) {
    return '(no prior conversation context)';
  }

  return historyEntries
    .map((entry, index) => `${index + 1}. ${entry.speakerLabel}: ${entry.text}`)
    .join('\n');
}

async function getObjectionSuggestionFromClaude(transcriptText, contextEntries) {
  console.log('[Claude] Analysis function triggered.');
  console.log(`[Claude] Input sentence: ${transcriptText}`);

  const claudeApiKey = process.env.CLAUDE_API_KEY;
  if (!claudeApiKey) {
    console.error(
      'Missing CLAUDE_API_KEY environment variable. Claude analysis disabled.'
    );
    return;
  }

  const formattedContext = formatConversationContext(contextEntries);

  const prompt = [
    'You are a sales call assistant.',
    'Use the recent conversation context to interpret references and follow-up questions.',
    'Analyze the following prospect sentence and classify it.',
    'Return ONLY raw valid JSON with no markdown, no code fences, and no other text.',
    'Your entire response must be parseable by JSON.parse() and nothing else.',
    'Use this exact shape: {"category":"objection|question|buying_signal|none","has_objection":boolean,"objection_type":string,"rebuttal":string}',
    'Rules:',
    '- If category is "objection": has_objection=true, set objection_type to the objection type, and rebuttal to a concise rebuttal.',
    '- If category is "question": has_objection=false, objection_type="none", and rebuttal to a clear concise answer.',
    '- If category is "buying_signal": has_objection=false, objection_type="none", and rebuttal to the best immediate next step.',
    '- If category is "none": has_objection=false, objection_type="none", rebuttal="".',
    '- rebuttal must always be a single concise sentence when category is objection/question/buying_signal.',
    '',
    'Recent conversation (last 20 exchanges):',
    formattedContext,
    '',
    `Current prospect sentence: "${transcriptText}"`,
  ].join('\n');

  const requestBody = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  };

  console.log('[Claude] Starting API request to Anthropic...');
  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    console.error('[Claude] Network/request failure while calling API.');
    console.error('[Claude] Full request error object:', error);
    console.error('[Claude] Full request error stack:', error?.stack);
    throw error;
  }

  console.log(`[Claude] API response received. status=${response.status}`);

  const rawResponseBody = await response.text();
  console.log(
    `[Claude] Raw response preview: ${rawResponseBody.slice(0, 500)}`
  );

  if (!response.ok) {
    const httpError = new Error(
      `Claude API error ${response.status}: ${rawResponseBody}`
    );
    console.error('[Claude] API returned non-2xx response.');
    console.error('[Claude] Full HTTP error object:', httpError);
    console.error('[Claude] Full HTTP error stack:', httpError.stack);
    throw httpError;
  }

  let data;
  try {
    data = JSON.parse(rawResponseBody);
  } catch (error) {
    console.error('[Claude] Failed to parse API response as JSON.');
    console.error('[Claude] Full parse error object:', error);
    console.error('[Claude] Full parse error stack:', error?.stack);
    throw error;
  }

  const textContent =
    data?.content?.find((item) => item.type === 'text')?.text?.trim() || '';

  if (!textContent) {
    throw new Error('Claude response did not include text content.');
  }

  let parsed;
  try {
    const cleanedTextContent = textContent
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    parsed = JSON.parse(cleanedTextContent);
  } catch (error) {
    throw new Error(`Claude returned non-JSON response: ${textContent}`);
  }

  const hasObjection = Boolean(parsed?.has_objection);
  const rebuttal = typeof parsed?.rebuttal === 'string' ? parsed.rebuttal : '';
  const objectionType =
    typeof parsed?.objection_type === 'string' ? parsed.objection_type : 'none';
  const category =
    typeof parsed?.category === 'string' ? parsed.category : 'none';

  console.log('[Claude] Analysis completed successfully.');
  if (category === 'none' || !rebuttal.trim()) {
    console.log('[Claude] No objection, question, or buying signal detected.');
    return;
  }

  if (category === 'objection') {
    console.log(
      `[Claude] Objection detected (${objectionType}). Suggested rebuttal: ${rebuttal}`
    );
  } else if (category === 'question') {
    console.log(`[Claude] Question detected. Suggested answer: ${rebuttal}`);
  } else if (category === 'buying_signal') {
    console.log(`[Claude] Buying signal detected. Suggested next step: ${rebuttal}`);
  } else {
    console.log(`[Claude] Category "${category}" detected. Suggested response: ${rebuttal}`);
  }

  sendToRenderer('objection-detected', {
    category,
    hasObjection,
    rebuttal,
    objectionType,
  });
}

function sendTranscriptToRenderer(text) {
  sendToRenderer('deepgram-transcript', text);
}

function getSpeakerFromDeepgramResult(resultData) {
  const words = resultData?.channel?.alternatives?.[0]?.words;
  if (!Array.isArray(words) || words.length === 0) {
    return null;
  }

  const counts = new Map();
  for (const word of words) {
    if (typeof word?.speaker !== 'number') {
      continue;
    }

    const current = counts.get(word.speaker) || 0;
    counts.set(word.speaker, current + 1);
  }

  let topSpeaker = null;
  let topCount = -1;
  for (const [speaker, count] of counts.entries()) {
    if (count > topCount) {
      topSpeaker = speaker;
      topCount = count;
    }
  }

  return topSpeaker;
}

function closeDeepgramConnection() {
  if (deepgramConnection) {
    try {
      deepgramConnection.close();
    } catch (error) {
      console.error('Error while closing Deepgram connection:', error);
    }
  }

  deepgramConnection = null;
  deepgramIsOpen = false;
  conversationHistory = [];
  prospectSpeaker = null;
}

async function startDeepgramConnection() {
  if (deepgramConnection) {
    return;
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    console.error(
      'Missing DEEPGRAM_API_KEY environment variable. Transcription disabled.'
    );
    return;
  }

  const deepgram = new DeepgramClient({ apiKey });
  conversationHistory = [];
  prospectSpeaker = null;

  deepgramConnection = await deepgram.listen.v1.connect({
    model: 'nova-2',
    language: 'en-US',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    punctuate: 'true',
    interim_results: 'false',
    endpointing: '300',
    diarize: 'true',
  });
  deepgramConnection.connect();
  await deepgramConnection.waitForOpen();
  deepgramIsOpen = true;
  console.log('Deepgram live connection opened.');

  deepgramConnection.on('message', (data) => {
    if (data?.type !== 'Results') {
      return;
    }

    const text = data?.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text) {
      return;
    }

    const speaker = getSpeakerFromDeepgramResult(data);
    const speakerLabel = speaker === null ? 'unknown' : `Speaker ${speaker}`;

    if (data.is_final) {
      sendTranscriptToRenderer({ text, speaker });
      sendToRenderer('speaker-transcript-final', { text, speaker });
      console.log(`[Deepgram] ${speakerLabel}: ${text}`);
      conversationHistory.push({ speakerLabel, text });
    }

    if (data.speech_final) {
      console.log(
        `[Claude] speech_final received from ${speakerLabel}: "${text}"`
      );
      if (speaker === 0 || speaker === null) {
        console.log(
          `[Claude] Skipping analysis for ${speakerLabel}; waiting for prospect speaker.`
        );
        return;
      }

      if (prospectSpeaker === null) {
        prospectSpeaker = speaker;
        console.log(
          `[Claude] Prospect speaker identified for this call: Speaker ${prospectSpeaker}`
        );
      }

      if (speaker !== prospectSpeaker) {
        console.log(
          `[Claude] Skipping analysis for ${speakerLabel}; active prospect is Speaker ${prospectSpeaker}.`
        );
        return;
      }

      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
      if (wordCount <= 4) {
        console.log(
          `[Claude] Skipping analysis for short segment (${wordCount} words).`
        );
        return;
      }

      if (isClaudeRequestInFlight) {
        console.log(
          '[Claude] Previous analysis still running. Skipping this sentence.'
        );
        return;
      }

      isClaudeRequestInFlight = true;
      const recentContext = conversationHistory.slice(-20);
      getObjectionSuggestionFromClaude(text, recentContext)
        .catch((error) => {
          console.error('[Claude] Objection analysis failed.');
          console.error('[Claude] Full error object:', error);
          console.error('[Claude] Full error stack:', error?.stack);
        })
        .finally(() => {
          isClaudeRequestInFlight = false;
        });
    }
  });

  deepgramConnection.on('error', (error) => {
    console.error('Deepgram live error:', error);
  });

  deepgramConnection.on('close', () => {
    console.log('Deepgram live connection closed.');
    deepgramConnection = null;
    deepgramIsOpen = false;
    prospectSpeaker = null;
  });
}

function createWindow() {
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
    console.log('[IPC] Renderer did-finish-load.');
  });

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    console.log(`[renderer:${level}] ${message}`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });
}

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
      });

      if (sources.length === 0) {
        callback({});
        return;
      }

      callback({
        video: sources[0],
        audio: 'loopback',
      });
    },
    { useSystemPicker: false }
  );

  ipcMain.on('deepgram:start', () => {
    startDeepgramConnection().catch((error) => {
      console.error('Failed to start Deepgram connection:', error);
    });
  });

  ipcMain.on('renderer-ready', () => {
    rendererReady = true;
    console.log('[IPC] Renderer declared ready via IPC.');
  });

  ipcMain.on('deepgram:audio', (_event, audioChunk) => {
    if (!deepgramConnection || !deepgramIsOpen || !audioChunk) {
      return;
    }

    deepgramConnection.sendMedia(Buffer.from(audioChunk));
  });

  ipcMain.on('deepgram:stop', () => {
    closeDeepgramConnection();
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  closeDeepgramConnection();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});