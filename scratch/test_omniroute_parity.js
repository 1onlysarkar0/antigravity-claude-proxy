/**
 * Gemini Only Model Parity Test Suite
 * Tests ONLY Gemini models to preserve Claude quota
 */

async function runTests() {
    const baseUrl = 'http://127.0.0.1:8080';
    console.log('--- 1. Testing /v1/models ---');
    try {
        const modelsRes = await fetch(`${baseUrl}/v1/models`);
        console.log('Status:', modelsRes.status);
        const modelsData = await modelsRes.json();
        console.log('Total Models returned:', modelsData.data ? modelsData.data.length : 0);
        if (modelsData.data) {
            console.log('Sample model IDs:', modelsData.data.slice(0, 10).map(m => m.id));
        }
    } catch (err) {
        console.error('Error fetching /v1/models:', err);
    }

    console.log('\n--- 2. Testing Gemini Message Generations ---');

    const tests = [
        { name: 'Gemini 3.7 Flash (Non-Streaming)', model: 'gemini-3.7-flash', stream: false },
        { name: 'Gemini 3.7 Flash (Streaming)', model: 'gemini-3.7-flash', stream: true },
        { name: 'Gemini 3 Flash (Streaming)', model: 'gemini-3-flash', stream: true },
        { name: 'Gemini 3.6 Flash High (Streaming)', model: 'gemini-3.6-flash-high', stream: true },
        { name: 'Gemini 3.6 Flash Low (Streaming)', model: 'gemini-3.6-flash-low', stream: true },
        { name: 'Gemini 2.5 Flash (Non-Streaming)', model: 'gemini-2.5-flash', stream: false }
    ];

    for (const t of tests) {
        process.stdout.write(`Testing ${t.name} [${t.model}]... `);
        try {
            const body = {
                model: t.model,
                messages: [
                    { role: 'user', content: 'Reply in 3 words: Antigravity works' }
                ],
                max_tokens: 60,
                stream: t.stream
            };

            const res = await fetch(`${baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': 'dummy'
                },
                body: JSON.stringify(body)
            });

            if (res.ok) {
                if (t.stream) {
                    const text = await res.text();
                    const firstChunk = text.split('\n').filter(l => l.trim().length > 0)[0] || '';
                    console.log(`✅ 200 OK -> ${firstChunk.substring(0, 80)}`);
                } else {
                    const json = await res.json();
                    const text = json.content?.[0]?.text || '';
                    console.log(`✅ 200 OK -> ${text.trim()}`);
                }
            } else {
                const errText = await res.text();
                console.log(`❌ ${res.status} Error -> ${errText.substring(0, 100)}`);
            }
        } catch (err) {
            console.log(`❌ Exception -> ${err.message}`);
        }
    }
}

runTests();
