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

async function getObjectionSuggestionFromClaude(transcriptText) {
  console.log('[Claude] Analysis function triggered.');
  console.log(`[Claude] Input sentence: ${transcriptText}`);

  const claudeApiKey = process.env.CLAUDE_API_KEY;
  if (!claudeApiKey) {
    console.error(
      'Missing CLAUDE_API_KEY environment variable. Objection analysis disabled.'
    );
    return;
  }

  const prompt = [
    'You are a sales call assistant.',
    'Analyze the following sentence and decide if it contains a sales objection.',
    'Return ONLY raw valid JSON with no markdown, no code fences, and no other text.',
    'Your entire response must be parseable by JSON.parse() and nothing else.',
    'Use this shape: {"has_objection": boolean, "objection_type": string, "rebuttal": string}',
    'If there is no objection, set rebuttal to an empty string and objection_type to "none".',
    'Keep rebuttal concise (max 1 sentence).',
    '',
    `Sentence: "${transcriptText}"`,
  ].join('\n');

  const requestBody = {
    model: 'claude-sonnet-4-6',
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
    parsed = JSON.parse(textContent);
  } catch (error) {
    throw new Error(`Claude returned non-JSON response: ${textContent}`);
  }

  const hasObjection = Boolean(parsed?.has_objection);
  const rebuttal = typeof parsed?.rebuttal === 'string' ? parsed.rebuttal : '';
  const objectionType =
    typeof parsed?.objection_type === 'string' ? parsed.objection_type : 'none';

  console.log('[Claude] Analysis completed successfully.');
  if (hasObjection && rebuttal.trim()) {
    console.log(
      `[Claude] Objection detected (${objectionType}). Suggested rebuttal: ${rebuttal}`
    );
    sendToRenderer('objection-detected', { rebuttal, objectionType });
  } else {
    console.log('[Claude] No objection detected in this sentence.');
  }
}

function sendTranscriptToRenderer(text) {
  sendToRenderer('deepgram-transcript', text);
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

  deepgramConnection = await deepgram.listen.v1.connect({
    model: 'nova-2',
    language: 'en-US',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    punctuate: 'true',
    interim_results: 'false',
    endpointing: '300',
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

    if (data.is_final) {
      sendTranscriptToRenderer(text);
    }

    if (data.speech_final) {
      console.log(`[Claude] speech_final received. Triggering analysis: "${text}"`);
      if (isClaudeRequestInFlight) {
        console.log(
          '[Claude] Previous analysis still running. Skipping this sentence.'
        );
        return;
      }

      isClaudeRequestInFlight = true;
      getObjectionSuggestionFromClaude(text)
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