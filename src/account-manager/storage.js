/**
 * Account Storage
 *
 * Handles loading, persisting, and auto-hydrating account configuration across local,
 * containerized, and cloud environments (Docker, Render, Railway, Fly.io, Heroku, etc.).
 */

import { readFile, writeFile, mkdir, access, rename } from 'fs/promises';
import { constants as fsConstants, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { ACCOUNT_CONFIG_PATH, DATA_DIRECTORY } from '../constants.js';
import { getAuthStatus } from '../auth/database.js';
import { logger } from '../utils/logger.js';

let writeLock = null;

/**
 * Hydrate accounts from environment variables (ACCOUNTS_JSON, ANTIGRAVITY_ACCOUNTS, REFRESH_TOKENS)
 * Designed specifically for cloud deployments where disk is ephemeral or volumes are unmounted.
 * @returns {Array|null} Array of account objects or null if no env variables set
 */
export function hydrateAccountsFromEnv() {
    const rawEnv = process.env.ACCOUNTS_JSON || process.env.ANTIGRAVITY_ACCOUNTS || process.env.ACCOUNTS_DATA;
    if (rawEnv && rawEnv.trim()) {
        try {
            let str = rawEnv.trim();
            // Support Base64 encoded JSON
            if (!str.startsWith('{') && !str.startsWith('[')) {
                try {
                    const decoded = Buffer.from(str, 'base64').toString('utf-8');
                    if (decoded.startsWith('{') || decoded.startsWith('[')) {
                        str = decoded;
                    }
                } catch {
                    // Ignore base64 decode failure
                }
            }

            const parsed = JSON.parse(str);
            let accountsList = [];
            if (Array.isArray(parsed)) {
                accountsList = parsed;
            } else if (parsed && Array.isArray(parsed.accounts)) {
                accountsList = parsed.accounts;
            }

            if (accountsList.length > 0) {
                logger.info(`[AccountManager] Auto-hydrated ${accountsList.length} account(s) from ACCOUNTS_JSON environment variable`);
                return accountsList.map((acc, idx) => ({
                    email: acc.email,
                    priority: (typeof acc.priority === 'number' && acc.priority > 0) ? acc.priority : (idx + 1),
                    source: acc.source || 'oauth',
                    enabled: acc.enabled !== false,
                    refreshToken: acc.refreshToken || acc.refresh_token,
                    apiKey: acc.apiKey || acc.api_key,
                    addedAt: acc.addedAt || new Date().toISOString(),
                    modelRateLimits: acc.modelRateLimits || {},
                    subscription: acc.subscription || { tier: 'pro', projectId: null },
                    quota: acc.quota || { models: {}, lastChecked: null }
                }));
            }
        } catch (e) {
            logger.error('[AccountManager] Failed to parse ACCOUNTS_JSON env var:', e.message);
        }
    }

    // Support comma-separated REFRESH_TOKENS: "email1:token1,email2:token2" or "token1,token2"
    const tokensEnv = process.env.REFRESH_TOKENS || process.env.GOOGLE_REFRESH_TOKENS;
    if (tokensEnv && tokensEnv.trim()) {
        try {
            const pairs = tokensEnv.split(',').map(p => p.trim()).filter(Boolean);
            const accountsList = pairs.map((pair, idx) => {
                if (pair.includes(':')) {
                    const [email, token] = pair.split(':');
                    return {
                        email: email.trim(),
                        refreshToken: token.trim(),
                        priority: idx + 1,
                        source: 'oauth',
                        enabled: true,
                        addedAt: new Date().toISOString()
                    };
                } else {
                    return {
                        email: `account_${idx + 1}@antigravity`,
                        refreshToken: pair.trim(),
                        priority: idx + 1,
                        source: 'oauth',
                        enabled: true,
                        addedAt: new Date().toISOString()
                    };
                }
            });

            if (accountsList.length > 0) {
                logger.info(`[AccountManager] Auto-hydrated ${accountsList.length} account(s) from REFRESH_TOKENS environment variable`);
                return accountsList;
            }
        } catch (e) {
            logger.error('[AccountManager] Failed to parse REFRESH_TOKENS env var:', e.message);
        }
    }

    return null;
}

/**
 * Load accounts from the config file, environment variables, or local data fallback
 *
 * @param {string} configPath - Path to the config file
 * @returns {Promise<{accounts: Array, settings: Object, activeIndex: number}>}
 */
export async function loadAccounts(configPath = ACCOUNT_CONFIG_PATH) {
    try {
        let config = null;

        // 1. Try reading from designated configPath
        try {
            await access(configPath, fsConstants.F_OK);
            const configData = await readFile(configPath, 'utf-8');
            config = JSON.parse(configData);
        } catch {
            // File does not exist yet at configPath
        }

        // 2. If no config or empty accounts, check local workspace fallbacks (./data/accounts.json or ./accounts.json)
        if (!config || !Array.isArray(config.accounts) || config.accounts.length === 0) {
            const localPaths = [
                resolve('data', 'accounts.json'),
                resolve('accounts.json')
            ];
            for (const lp of localPaths) {
                if (existsSync(lp)) {
                    try {
                        const localData = readFileSync(lp, 'utf-8');
                        const localConfig = JSON.parse(localData);
                        if (localConfig && Array.isArray(localConfig.accounts) && localConfig.accounts.length > 0) {
                            config = localConfig;
                            logger.info(`[AccountManager] Loaded ${config.accounts.length} account(s) from local fallback: ${lp}`);
                            // Auto-persist to primary configPath
                            saveAccounts(configPath, config.accounts, config.settings || {}, config.activeIndex || 0);
                            break;
                        }
                    } catch {
                        // Continue checking next fallback
                    }
                }
            }
        }

        // 3. If still no accounts, check environment variable auto-hydration (Cloud Deployments)
        if (!config || !Array.isArray(config.accounts) || config.accounts.length === 0) {
            const envAccounts = hydrateAccountsFromEnv();
            if (envAccounts && envAccounts.length > 0) {
                config = {
                    accounts: envAccounts,
                    settings: {},
                    activeIndex: 0
                };
                // Automatically write to configPath for instant cloud persistence
                saveAccounts(configPath, envAccounts, {}, 0);
            }
        }

        if (!config) {
            logger.info('[AccountManager] No config file found. Using Antigravity database (single account mode)');
            return { accounts: [], settings: {}, activeIndex: 0 };
        }

        const accounts = (config.accounts || []).map((acc, idx) => ({
            ...acc,
            priority: (typeof acc.priority === 'number' && acc.priority > 0) ? acc.priority : (idx + 1),
            lastUsed: acc.lastUsed || null,
            enabled: acc.enabled !== false, // Default to true if not specified
            isInvalid: acc.verifyUrl ? (acc.isInvalid || false) : false,
            invalidReason: acc.verifyUrl ? (acc.invalidReason || null) : null,
            verifyUrl: acc.verifyUrl || null,
            modelRateLimits: acc.modelRateLimits || {},
            subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
            quota: acc.quota || { models: {}, lastChecked: null },
            quotaThreshold: acc.quotaThreshold,
            modelQuotaThresholds: acc.modelQuotaThresholds || {}
        }));

        const settings = config.settings || {};
        let activeIndex = config.activeIndex || 0;

        if (activeIndex >= accounts.length) {
            activeIndex = 0;
        }

        logger.info(`[AccountManager] Loaded ${accounts.length} account(s) from config`);

        return { accounts, settings, activeIndex };
    } catch (error) {
        logger.error('[AccountManager] Failed to load config:', error.message);
        return { accounts: [], settings: {}, activeIndex: 0 };
    }
}

/**
 * Load the default account from Antigravity's database
 *
 * @param {string} dbPath - Optional path to the database
 * @returns {{accounts: Array, tokenCache: Map}}
 */
export function loadDefaultAccount(dbPath) {
    try {
        const authData = getAuthStatus(dbPath);
        if (authData?.apiKey) {
            const account = {
                email: authData.email || 'default@antigravity',
                source: 'database',
                lastUsed: null,
                modelRateLimits: {}
            };

            const tokenCache = new Map();
            tokenCache.set(account.email, {
                token: authData.apiKey,
                extractedAt: Date.now()
            });

            logger.info(`[AccountManager] Loaded default account: ${account.email}`);

            return { accounts: [account], tokenCache };
        }
    } catch (error) {
        logger.error('[AccountManager] Failed to load default account:', error.message);
    }

    return { accounts: [], tokenCache: new Map() };
}

/**
 * Save account configuration to disk and local data backups
 *
 * @param {string} configPath - Path to the config file
 * @param {Array} accounts - Array of account objects
 * @param {Object} settings - Settings object
 * @param {number} activeIndex - Current active account index
 */
export async function saveAccounts(configPath, accounts, settings, activeIndex) {
    // Serialize writes to prevent concurrent corruption
    const previousLock = writeLock;
    let resolve;
    writeLock = new Promise(r => { resolve = r; });

    try {
        if (previousLock) await previousLock;
    } catch {
        // Previous write failed, proceed anyway
    }

    try {
        const dir = dirname(configPath);
        await mkdir(dir, { recursive: true });

        const config = {
            accounts: accounts.map(acc => ({
                email: acc.email,
                priority: acc.priority,
                source: acc.source,
                enabled: acc.enabled !== false,
                dbPath: acc.dbPath || null,
                refreshToken: acc.source === 'oauth' ? acc.refreshToken : undefined,
                apiKey: acc.source === 'manual' ? acc.apiKey : undefined,
                projectId: acc.projectId || undefined,
                addedAt: acc.addedAt || undefined,
                isInvalid: acc.isInvalid || false,
                invalidReason: acc.invalidReason || null,
                verifyUrl: acc.verifyUrl || null,
                modelRateLimits: acc.modelRateLimits || {},
                lastUsed: acc.lastUsed,
                subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
                quota: acc.quota || { models: {}, lastChecked: null },
                quotaThreshold: acc.quotaThreshold,
                modelQuotaThresholds: Object.keys(acc.modelQuotaThresholds || {}).length > 0 ? acc.modelQuotaThresholds : undefined
            })),
            settings: settings,
            activeIndex: activeIndex
        };

        const json = JSON.stringify(config, null, 2);

        // Validate JSON before writing (prevent saving corrupt data)
        JSON.parse(json);

        // Atomic write: write to temp file then rename
        const tmpPath = configPath + '.tmp';
        await writeFile(tmpPath, json);
        await rename(tmpPath, configPath);

        // Also save a backup to ./data/accounts.json if data dir exists or in workspace
        try {
            const dataDir = resolve('data');
            await mkdir(dataDir, { recursive: true });
            const backupPath = resolve(dataDir, 'accounts.json');
            if (backupPath !== configPath) {
                await writeFile(backupPath, json);
            }
        } catch {
            // Ignore backup write failures
        }
    } catch (error) {
        logger.error('[AccountManager] Failed to save config:', error.message);
    } finally {
        resolve();
    }
}
