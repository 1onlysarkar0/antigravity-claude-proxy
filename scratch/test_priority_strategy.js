import { PriorityStrategy } from '../src/account-manager/strategies/priority-strategy.js';
import assert from 'assert';

console.log('=== Testing OmniRoute Priority Strategy ===\n');

const strategy = new PriorityStrategy();

// Test 1: Priority Ordering (Fill-First)
console.log('Test 1: Select highest priority account');
const accounts = [
    { email: 'account2@example.com', priority: 2, enabled: true, isInvalid: false },
    { email: 'account1@example.com', priority: 1, enabled: true, isInvalid: false },
    { email: 'account3@example.com', priority: 3, enabled: true, isInvalid: false }
];

let res = strategy.selectAccount(accounts, 'gemini-3.1-pro-high');
console.log('Selected:', res.account.email, '(Priority:', res.account.priority, ')');
assert.strictEqual(res.account.email, 'account1@example.com', 'Should pick Priority 1 account');
assert.strictEqual(res.waitMs, 0, 'Wait time must be 0');
console.log('✓ Test 1 Passed\n');

// Test 2: Failover when Priority 1 is rate limited
console.log('Test 2: Failover when Priority 1 is rate limited');
accounts[1].modelRateLimits = {
    'gemini-3.1-pro-high': {
        isRateLimited: true,
        resetTime: Date.now() + 60000
    }
};

res = strategy.selectAccount(accounts, 'gemini-3.1-pro-high');
console.log('Selected on failover:', res.account.email, '(Priority:', res.account.priority, ')');
assert.strictEqual(res.account.email, 'account2@example.com', 'Should failover to Priority 2 account');
console.log('✓ Test 2 Passed\n');

// Test 3: Auto-Recovery when rate limit expires
console.log('Test 3: Auto-Recovery when Priority 1 cooldown expires');
accounts[1].modelRateLimits['gemini-3.1-pro-high'].resetTime = Date.now() - 1000; // Expired

res = strategy.selectAccount(accounts, 'gemini-3.1-pro-high');
console.log('Selected after recovery:', res.account.email, '(Priority:', res.account.priority, ')');
assert.strictEqual(res.account.email, 'account1@example.com', 'Should auto-recover back to Priority 1 account');
console.log('✓ Test 3 Passed\n');

// Test 4: Single account active
console.log('Test 4: Single account active');
const singleAccountList = [
    { email: 'solo@example.com', priority: 1, enabled: true, isInvalid: false }
];
res = strategy.selectAccount(singleAccountList, 'gemini-3.1-pro-high');
console.log('Selected single account:', res.account.email);
assert.strictEqual(res.account.email, 'solo@example.com');
console.log('✓ Test 4 Passed\n');

console.log('🎉 ALL PRIORITY STRATEGY TESTS PASSED SUCCESSFULLY!');
