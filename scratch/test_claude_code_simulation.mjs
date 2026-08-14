/**
 * Realistic Claude Code simulation test
 * Tests streaming, tools, and all model aliases Claude Code actually sends
 * via OmniRoute → our proxy
 */

// OmniRoute endpoint (what Claude Code's settings.json points to)
const BASE_URL = 'https://api.1onlysarkar.shop/v1';
const API_KEY = 'sk-e9b9203483b16f7e-b9b338-6a8c937f';

// All models Claude Code sends (from settings.json)
const MODELS = {
    'claude-fable-5[1m]': 'Main agent model',
    'claude-haiku-4-5[1m]': 'Subagent / small fast model',
    'claude-sonnet-5[1m]': 'Sonnet model',
    'claude-opus-5[1m]': 'Opus model',
};

// Tool definition Claude Code always sends
const CLAUDE_TOOLS = [
    {
        name: 'Read',
        description: 'Read file contents',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to file' }
            },
            required: ['file_path']
        }
    },
    {
        name: 'Write',
        description: 'Write content to file',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string' },
                content: { type: 'string' }
            },
            required: ['file_path', 'content']
        }
    },
    {
        name: 'Bash',
        description: 'Run shell command',
        input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command']
        }
    }
];

async function testModel(modelName, label, useStream = true, useTools = false) {
    const start = Date.now();
    process.stdout.write(`  [${label}] stream=${useStream} tools=${useTools} model=${modelName} ... `);
    try {
        const body = {
            model: modelName,
            messages: [{ role: 'user', content: 'Reply ONLY with: PROXY-OK' }],
            max_tokens: 30,
            stream: useStream,
        };
        if (useTools) body.tools = CLAUDE_TOOLS;

        const res = await fetch(`${BASE_URL}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'interleaved-thinking-2025-05-14'
            },
            body: JSON.stringify(body)
        });

        const ms = Date.now() - start;

        if (!res.ok) {
            const errText = await res.text();
            let errJson;
            try { errJson = JSON.parse(errText); } catch { errJson = null; }
            const msg = errJson?.error?.message || errText.substring(0, 200);
            console.log(`❌ HTTP ${res.status} in ${ms}ms`);
            console.log(`     ERROR: ${msg}`);
            return { ok: false, status: res.status, error: msg };
        }

        if (useStream) {
            const rawText = await res.text();
            const lines = rawText.split('\n').filter(l => l.trim());
            const hasData = lines.some(l => l.startsWith('data:'));
            const firstData = lines.find(l => l.startsWith('data:')) || '';
            const hasStop = rawText.includes('message_stop') || rawText.includes('end_turn');
            if (!hasData) {
                console.log(`❌ STREAM 200 but no SSE data in ${ms}ms`);
                console.log(`     Raw: ${rawText.substring(0, 200)}`);
                return { ok: false, error: 'no SSE data' };
            }
            console.log(`✅ STREAM 200 OK in ${ms}ms (${lines.length} lines, stop=${hasStop})`);
            return { ok: true };
        } else {
            const json = await res.json();
            const text = json.content?.[0]?.text || json.error?.message;
            const stopReason = json.stop_reason;
            console.log(`✅ JSON 200 OK in ${ms}ms stop_reason=${stopReason} -> "${text}"`);
            return { ok: true };
        }
    } catch (e) {
        const ms = Date.now() - start;
        console.log(`❌ NETWORK ERROR in ${ms}ms: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

console.log('=== Realistic Claude Code Simulation Test ===');
console.log(`Endpoint: ${BASE_URL}`);
console.log('');

const results = {};

for (const [model, label] of Object.entries(MODELS)) {
    console.log(`\n${label} (${model}):`);
    // Test 1: Streaming without tools (what main agent sends for most calls)
    results[`${model}-stream`] = await testModel(model, 'STREAM      ', true, false);
    await new Promise(r => setTimeout(r, 800));
    // Test 2: Streaming with tools (what Claude Code always sends)  
    results[`${model}-stream-tools`] = await testModel(model, 'STREAM+TOOLS', true, true);
    await new Promise(r => setTimeout(r, 800));
    // Test 3: Non-streaming (some internal calls)
    results[`${model}-nostream`] = await testModel(model, 'NON-STREAM  ', false, false);
    await new Promise(r => setTimeout(r, 1200));
}

// Summary
console.log('\n\n=== SUMMARY ===');
const passed = Object.values(results).filter(r => r.ok).length;
const total = Object.keys(results).length;
console.log(`Passed: ${passed}/${total}`);
if (passed < total) {
    console.log('\nFailed tests:');
    for (const [key, r] of Object.entries(results)) {
        if (!r.ok) console.log(`  - ${key}: ${r.error || `HTTP ${r.status}`}`);
    }
}
