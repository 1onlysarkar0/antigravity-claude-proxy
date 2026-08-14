import { AccountManager } from '../src/account-manager/index.js';
import { buildCloudCodeRequest, buildHeaders } from '../src/cloudcode/request-builder.js';
import { ANTIGRAVITY_ENDPOINT_FALLBACKS } from '../src/constants.js';

async function test() {
    const accountManager = new AccountManager();
    await accountManager.reload();
    const accounts = accountManager.accounts || [];
    const account = accounts.find(a => a.enabled !== false && !a.isInvalid);
    if (!account) {
        console.error('No active accounts found!');
        return;
    }

    console.log(`Using account: ${account.email}`);
    const token = await accountManager.getTokenForAccount(account);
    const project = await accountManager.getProjectForAccount(account, token);

    const anthropicRequest = {
        model: 'gemini-3.7-flash-tiered',
        messages: [{ role: 'user', content: 'What is 2+2? Reply with ONLY the number.' }],
        max_tokens: 30,
        stream: false
    };

    const payload = buildCloudCodeRequest(anthropicRequest, project, account.email);
    const headers = buildHeaders(token, 'gemini-3.7-flash-tiered', 'application/json', payload.request.sessionId);

    // Call generateContent (non-streaming)
    const url = `${ANTIGRAVITY_ENDPOINT_FALLBACKS[1]}/v1internal:generateContent`;
    console.log(`Calling direct Google API: ${url}`);
    
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    console.log(`HTTP ${res.status}`);
    const text = await res.text();
    console.log('RAW GOOGLE RESPONSE:');
    console.log(text);
}
test().catch(console.error);
