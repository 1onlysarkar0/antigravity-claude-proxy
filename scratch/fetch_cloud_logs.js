async function getLogs() {
    const res = await fetch('https://api2.1onlysarkar.shop/api/logs', {
        headers: {
            'x-webui-password': '1Onlysarkar@'
        }
    });
    const data = await res.json();
    console.log('--- LATEST CLOUD PROXY LOGS ---');
    // Print last 50 logs
    const logs = data.logs || [];
    logs.slice(-50).forEach(l => {
        console.log(`[${l.timestamp}] [${l.level}] ${l.message}`);
    });
}
getLogs().catch(console.error);
