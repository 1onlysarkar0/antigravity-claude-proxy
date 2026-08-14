import { convertAnthropicToGoogle } from '../src/format/request-converter.js';

const req = {
    model: 'gemini-3.7-flash-tiered',
    messages: [{ role: 'user', content: 'What is 2+2? Reply with ONLY the number.' }],
    max_tokens: 30,
    stream: false
};

const res = convertAnthropicToGoogle(req);
console.log(JSON.stringify(res, null, 2));
