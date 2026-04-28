const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');

if (!fs.existsSync(envPath)) {
  const defaultEnv = [
    'DEEPGRAM_API_KEY=your_deepgram_api_key_here',
    'CLAUDE_API_KEY=your_claude_api_key_here',
    '',
  ].join('\n');

  fs.writeFileSync(envPath, defaultEnv, 'utf8');
  console.log('[setup] Created .env with placeholder API keys.');
} else {
  console.log('[setup] .env already exists.');
}
