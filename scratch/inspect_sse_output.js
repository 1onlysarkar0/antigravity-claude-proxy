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
            messages: [{ role: 'user', content: 'Use the Read tool to read file "hello.txt" and output nothing else' }],
            max_tokens: 30,
            stream: true,
            tools: [
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
            ]
        })
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    console.log('--- RAW SSE CHUNKS FROM PROXY ---');
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        console.log(decoder.decode(value));
    }
}
inspect().catch(console.error);
