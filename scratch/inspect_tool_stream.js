const BASE_URL = 'https://api2.1onlysarkar.shop/v1';
const API_KEY = 'sk-e9b9203483b16f7e-b9b338-6a8c937f';

async function inspect() {
    const res = await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: 'gemini-3.7-flash-tiered',
            messages: [{ role: 'user', content: 'What is the date today? Use the tool to find out.' }],
            max_tokens: 100,
            stream: true,
            tools: [
                {
                    name: 'get_current_date',
                    description: 'Get the current date',
                    input_schema: {
                        type: 'object',
                        properties: {}
                    }
                }
            ]
        })
    });

    console.log(`HTTP ${res.status}`);
    if (!res.ok) {
        console.log(await res.text());
        return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    console.log('--- RAW SSE CHUNKS FROM CLOUD PROXY ---');
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        console.log(decoder.decode(value));
    }
}
inspect().catch(console.error);
