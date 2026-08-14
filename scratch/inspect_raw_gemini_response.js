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
            messages: [{ role: 'user', content: 'What is 2+2? Reply with ONLY the number.' }],
            max_tokens: 30,
            stream: false,
        })
    });

    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
}
inspect().catch(console.error);
