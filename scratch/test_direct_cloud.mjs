/**
 * Direct cloud proxy simulation test
 * Bypasses OmniRoute to test proxy directly
 */

const BASE_URL = 'https://api2.1onlysarkar.shop/v1';
const API_KEY = 'sk-e9b9203483b16f7e-b9b338-6a8c937f';

// Use direct models that our proxy targets
const MODELS = {
    'gemini-3.7-flash-tiered': 'Gemini 3.7 Flash',
    'gemini-3.6-flash-high': 'Gemini 3.6 Flash High',
    'gemini-3.5-flash-low': 'Gemini 3.5 Flash Low',
};

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
    }
];

async function testModel(modelName, label, useStream = true, useTools = false) {
    const start = Date.now();
    process.stdout.write(`  [${label}] stream=${useStream} tools=${useTools} model=${modelName} ... `);
    try {
        const body = {
            model: modelName,
            messages: [{ role: 'user', content: 'Use the Read tool to read file "hello.txt" and output nothing else' }],
            max_tokens: 30,
            stream: useStream,
        };
        if (useTools) body.tools = CLAUDE_TOOLS;

        const res = await fetch(`${BASE_URL}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY,
                'anthropic-version': '2023-06-01'
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
            const hasStop = rawText.includes('message_stop');
            if (!hasData) {
                console.log(`❌ STREAM 200 but no SSE data in ${ms}ms`);
                return { ok: false, error: 'no SSE data' };
            }
            console.log(`✅ STREAM 200 OK in ${ms}ms (${lines.length} lines, stop=${hasStop})`);
            return { ok: true };
        } else {
            const json = await res.json();
            const text = json.content?.[0]?.text || JSON.stringify(json).substring(0, 80);
            console.log(`✅ JSON 200 OK in ${ms}ms -> "${text}"`);
            return { ok: true };
        }
    } catch (e) {
        const ms = Date.now() - start;
        console.log(`❌ NETWORK ERROR in ${ms}ms: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

console.log('=== Direct Cloud Proxy Simulation Test ===');
console.log(`Endpoint: ${BASE_URL}`);
console.log('');

const results = {};

for (const [model, label] of Object.entries(MODELS)) {
    console.log(`\n${label} (${model}):`);
    results[`${model}-stream`] = await testModel(model, 'STREAM      ', true, false);
    await new Promise(r => setTimeout(r, 1000));
    results[`${model}-stream-tools`] = await testModel(model, 'STREAM+TOOLS', true, true);
    await new Promise(r => setTimeout(r, 1000));
}

// Summary
console.log('\n\n=== SUMMARY ===');
const passed = Object.values(results).filter(r => r.ok).length;
const total = Object.keys(results).length;
console.log(`Passed: ${passed}/${total}`);
