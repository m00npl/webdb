/**
 * Custom Lightweight Golem DB SDK
 *
 * A simple, reliable SDK for Golem DB operations using direct JSON-RPC calls
 * Avoids the issues with the official SDK and provides clean CRUD operations
 */

class GolemDB {
    constructor(config = {}) {
        this.rpcUrl = config.rpcUrl || 'https://kaolin.hoodi.arkiv.network/rpc';
        this.chainId = config.chainId || 0xE0087F821; // Kaolin Holesky
        this.storageContract = config.storageContract || "0x0000000000000000000000000000000060138453";
        this.defaultGasLimit = config.gasLimit || 500000;
        this.defaultBTL = config.defaultBTL || 86400 * 100; // 100 days in blocks (2 sec/block)

        this.provider = null;
        this.signer = null;
        this.account = null;
    }

    /**
     * Initialize connection with MetaMask
     */
    async connect() {
        if (!window.ethereum) {
            throw new Error('MetaMask not available');
        }

        // Request account access
        const accounts = await window.ethereum.request({
            method: 'eth_requestAccounts'
        });

        if (accounts.length === 0) {
            throw new Error('No MetaMask accounts available');
        }

        this.account = accounts[0];
        this.provider = new ethers.BrowserProvider(window.ethereum);
        this.signer = await this.provider.getSigner();

        // Ensure we're on the correct network
        await this.ensureCorrectNetwork();

        console.log('🔗 GolemDB connected to:', this.account);
        return this.account;
    }

    /**
     * Ensure MetaMask is connected to Golem network
     */
    async ensureCorrectNetwork() {
        const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
        const expectedChainId = '0x' + this.chainId.toString(16);

        if (currentChainId !== expectedChainId) {
            console.log('🔄 Switching to Golem network...');

            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: expectedChainId }]
                });
            } catch (switchError) {
                // Network not added to MetaMask, add it
                if (switchError.code === 4902) {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [{
                            chainId: expectedChainId,
                            chainName: 'Golem Kaolin Holesky',
                            nativeCurrency: {
                                name: 'ETH',
                                symbol: 'ETH',
                                decimals: 18
                            },
                            rpcUrls: [this.rpcUrl],
                            blockExplorerUrls: ['https://explorer.https://kaolin.hoodi.arkiv.network/rpc/']
                        }]
                    });
                } else {
                    throw switchError;
                }
            }
        }
    }

    /**
     * Create a new entity in Golem DB
     */
    async createEntity(data, annotations = {}, btl = null) {
        if (!this.signer) {
            throw new Error('Not connected. Call connect() first.');
        }

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

        // Send transaction to Golem Base storage contract
        const tx = await this.signer.sendTransaction({
            to: this.storageContract,
            value: 0,
            data: "0x", // Contract handles entity creation based on call data
            gasLimit: this.defaultGasLimit
        });

        console.log('🚀 Transaction sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('✅ Transaction confirmed in block:', receipt.blockNumber);

        // Extract entity key from logs
        let entityKey = null;
        if (receipt.logs && receipt.logs.length > 0) {
            entityKey = receipt.logs[0].topics[1] || this.generateEntityKey();
        } else {
            entityKey = this.generateEntityKey();
        }

        return {
            entityKey,
            transactionHash: tx.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed
        };
    }

    /**
     * Query entities from Golem DB
     */
    async queryEntities(query = {}) {
        console.log('🔍 Querying entities:', query);

        const response = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'golembase_queryEntities',
                params: [query],
                id: Date.now()
            })
        });

        if (!response.ok) {
            throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();

        if (result.error) {
            throw new Error(`RPC error: ${result.error.message}`);
        }

        console.log('📋 Found', result.result?.length || 0, 'entities');
        return result.result || [];
    }

    /**
     * Get entity by key
     */
    async getEntity(entityKey) {
        console.log('🔍 Getting entity:', entityKey);

        const entities = await this.queryEntities({
            entityKey: entityKey
        });

        if (entities.length === 0) {
            return null;
        }

        const entity = entities[0];

        // Decode entity data if it's encoded
        if (entity.storageValue) {
            try {
                const decodedData = new TextDecoder().decode(entity.storageValue);
                entity.decodedData = decodedData;

                // Try to parse as JSON
                try {
                    entity.parsedData = JSON.parse(decodedData);
                } catch {
                    // Not JSON, keep as string
                }
            } catch (decodeError) {
                console.warn('Could not decode entity data:', decodeError);
            }
        }

        return entity;
    }

    /**
     * Update entity (create new version)
     */
    async updateEntity(entityKey, newData, annotations = {}) {
        console.log('🔄 Updating entity:', entityKey);

        // Get current entity to increment version
        const currentEntity = await this.getEntity(entityKey);
        const currentVersion = currentEntity?.parsedData?.version || 0;

        // Create new entity with incremented version
        const updateAnnotations = {
            ...annotations,
            originalEntityKey: entityKey,
            version: currentVersion + 1,
            updateTimestamp: Date.now()
        };

        return await this.createEntity(newData, updateAnnotations);
    }

    /**
     * Delete entity (mark as deleted)
     */
    async deleteEntity(entityKey, reason = 'User requested deletion') {
        console.log('🗑️ Deleting entity:', entityKey);

        const deleteAnnotations = {
            type: 'deletion',
            originalEntityKey: entityKey,
            deleteTimestamp: Date.now(),
            deleteReason: reason
        };

        const deleteData = JSON.stringify({
            action: 'delete',
            entityKey,
            timestamp: Date.now(),
            reason
        });

        return await this.createEntity(deleteData, deleteAnnotations);
    }

    /**
     * List entities by type
     */
    async listEntitiesByType(type, author = null) {
        const query = {
            stringAnnotations: [
                { key: 'type', value: type }
            ]
        };

        if (author) {
            query.stringAnnotations.push({
                key: 'author',
                value: author
            });
        }

        return await this.queryEntities(query);
    }

    /**
     * Get account info
     */
    getAccount() {
        return {
            address: this.account,
            connected: !!this.signer
        };
    }

    /**
     * Generate a unique entity key
     */
    generateEntityKey() {
        return `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
    }

    /**
     * Calculate BTL in blocks for given days
     */
    calculateBTL(days) {
        return Math.floor(days * 24 * 60 * 60 / 2); // 2 seconds per block
    }

    /**
     * Get network info
     */
    getNetworkInfo() {
        return {
            rpcUrl: this.rpcUrl,
            chainId: this.chainId,
            storageContract: this.storageContract,
            connected: !!this.signer
        };
    }
}

// Export for use in browser
if (typeof window !== 'undefined') {
    window.GolemDB = GolemDB;
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GolemDB;
}