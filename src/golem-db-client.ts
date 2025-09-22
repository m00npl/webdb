/**
 * Golem DB Client for Node.js
 * Adapted from golem-db-sdk.js for server-side use
 */

import { ethers } from 'ethers';

export class GolemDBClient {
    private rpcUrl: string;
    private chainId: number;
    private storageContract: string;
    private defaultGasLimit: string;
    private defaultBTL: number;
    private privateKey: string;
    private account: string;
    private wallet: ethers.Wallet;

    constructor(config: {
        rpcUrl?: string;
        chainId?: number;
        storageContract?: string;
        gasLimit?: number;
        defaultBTL?: number;
        privateKey: string;
    }) {
        this.rpcUrl = config.rpcUrl || 'https://kaolin.holesky.golemdb.io/rpc';
        this.chainId = config.chainId || 0xE0087F821; // Kaolin Holesky
        this.storageContract = config.storageContract || "0x0000000000000000000000000000000060138453";
        this.defaultGasLimit = `0x${(config.gasLimit || 500000).toString(16)}`;
        this.defaultBTL = config.defaultBTL || 86400 * 100; // 100 days in blocks
        this.privateKey = config.privateKey;

        // Create wallet from private key
        this.wallet = new ethers.Wallet(this.privateKey);
        this.account = this.wallet.address;
    }

    /**
     * Create a new entity in Golem DB
     */
    async createEntity(key: string, data: string | Uint8Array, annotations: Record<string, any> = {}, btl?: number): Promise<{
        entityKey: string;
        transactionHash: string;
        blockNumber?: number;
        gasUsed?: string;
    }> {
        console.log('📦 Creating entity in Golem DB...');

        // Prepare data
        const entityData = typeof data === 'string' ?
            new TextEncoder().encode(data) :
            data;

        // Prepare annotations array
        const annotationArray = Object.entries(annotations).map(([key, value]) => ({
            name: key,
            value: String(value)
        }));

        const effectiveBTL = btl || this.defaultBTL;

        console.log('📤 Data size:', entityData.length, 'bytes');
        console.log('🏷️ Annotations:', annotationArray);
        console.log('⏰ BTL:', effectiveBTL, 'blocks');
        console.log('🔑 Key:', key);

        // Get nonce for account
        const nonce = await this.getNonce();

        // Prepare transaction
        const txParams = {
            to: this.storageContract,
            value: '0x0',
            data: "0x", // Contract handles entity creation based on call data
            gasLimit: this.defaultGasLimit,
            gasPrice: '0x5F5E100', // 0.1 gwei
            maxFeePerGas: '0x5F5E100', // 0.1 gwei
            maxPriorityFeePerGas: '0x5F5E100', // 0.1 gwei
            nonce: nonce,
            chainId: this.chainId
        };

        console.log('🔐 Signing transaction...');

        // Sign transaction locally
        const signedTx = await this.wallet.signTransaction(txParams);

        console.log('📡 Sending raw transaction...');

        const response = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'eth_sendRawTransaction',
                params: [signedTx],
                id: Date.now(),
            }),
        });

        if (!response.ok) {
            throw new Error(`Golem DB transaction failed: ${response.statusText}`);
        }

        const result = await response.json();
        if (result.error) {
            throw new Error(`Golem DB error: ${result.error.message}`);
        }

        console.log('🚀 Transaction sent:', result.result);

        // Wait for transaction receipt to get entity ID from logs
        const receipt = await this.waitForTransaction(result.result);
        console.log('✅ Transaction confirmed in block:', receipt?.blockNumber);

        // In Golem DB, the transaction hash IS the entity ID
        let entityKey = result.result; // Use transaction hash as entity key
        console.log('🆔 Entity ID from transaction hash:', entityKey);

        return {
            entityKey: entityKey,
            transactionHash: result.result,
            blockNumber: receipt?.blockNumber
        };
    }

    /**
     * Query entities from Golem DB
     */
    async queryEntities(query: Record<string, any> = {}): Promise<any[]> {
        console.log('🔍 Querying entities:', query);

        const response = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'golembase_queryEntities',
                params: [query],
                id: Date.now(),
            }),
        });

        if (!response.ok) {
            throw new Error(`Query failed: ${response.statusText}`);
        }

        const result = await response.json();
        if (result.error) {
            throw new Error(`Query error: ${result.error.message}`);
        }

        return result.result || [];
    }

    /**
     * Get entity by key
     */
    async getEntity(entityKey: string): Promise<any | null> {
        console.log('📖 Getting entity:', entityKey);

        const entities = await this.queryEntities({
            entityKey: entityKey
        });

        if (entities.length === 0) {
            console.log(`⚠️ Entity not found: ${entityKey}`);
            return null;
        }

        return entities[0];
    }

    /**
     * Find entities created by a specific transaction
     */
    async findEntitiesByTransaction(txHash: string): Promise<any[]> {
        console.log('🔍 Finding entities created by transaction:', txHash);

        try {
            // Query entities created by this account around the transaction time
            const entities = await this.queryEntities({});

            // Filter entities that might be related to this transaction
            const filtered = entities.filter(entity => {
                // Check if entity was created by our account
                return entity.author === this.account;
            });

            console.log(`📋 Found ${filtered.length} entities by account ${this.account}`);
            return filtered;
        } catch (error) {
            console.log(`⚠️ Error finding entities by transaction:`, error);
            return [];
        }
    }

    /**
     * Get nonce for account
     */
    private async getNonce(): Promise<number> {
        const response = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'eth_getTransactionCount',
                params: [this.account, 'pending'],
                id: Date.now(),
            }),
        });

        if (!response.ok) {
            throw new Error(`Failed to get nonce: ${response.statusText}`);
        }

        const result = await response.json();
        if (result.error) {
            throw new Error(`Nonce error: ${result.error.message}`);
        }

        return parseInt(result.result, 16);
    }

    /**
     * Wait for transaction receipt
     */
    private async waitForTransaction(txHash: string): Promise<any> {
        const maxRetries = 10;
        const retryDelay = 2000; // 2 seconds

        for (let i = 0; i < maxRetries; i++) {
            try {
                const response = await fetch(this.rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'eth_getTransactionReceipt',
                        params: [txHash],
                        id: Date.now(),
                    }),
                });

                if (!response.ok) {
                    throw new Error(`Failed to get receipt: ${response.statusText}`);
                }

                const result = await response.json();
                if (result.error) {
                    throw new Error(`Receipt error: ${result.error.message}`);
                }

                if (result.result) {
                    return result.result;
                }

                // Transaction not mined yet, wait and retry
                console.log(`⏳ Waiting for transaction confirmation... (${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            } catch (error) {
                console.log(`⚠️ Error getting receipt (attempt ${i + 1}):`, error);
                if (i === maxRetries - 1) {
                    return null; // Give up after max retries
                }
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }

        return null;
    }
}